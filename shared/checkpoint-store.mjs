import {
  CHECKPOINT_MAX_ATTEMPTS,
  buildCheckpointEvent,
  buildCheckpointFailureEvent,
  buildCheckpointRequestEvent,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointRequestEventId,
  parseCheckpointEvent,
  parseCheckpointFailureEvent,
  parseCheckpointRequestEvent,
} from "./checkpoint.mjs";
import { ContentConflictError } from "./content-objects.mjs";
import { OpenVikingCheckpointProcessor } from "./checkpoint-processor.mjs";
import { observation as processObservation } from "./observe.mjs";

const initialState = () => ({
  mode: "caught_up",
  consumed: 0,
  pending: 0,
  backlogTokens: 0,
  lastCheckpointId: null,
  currentArchiveId: null,
  lastFailure: null,
});

const errorMessage = (error) => `${error?.name || "Error"}: ${error?.message || String(error)}`;

export class CheckpointManager {
  constructor(client, {
    adapter,
    archiveManager,
    processor = null,
    observation = processObservation,
    notify = () => {},
    pollIntervalMs = 2000,
    now = () => new Date().toISOString(),
  }) {
    this.adapter = adapter;
    this.archiveManager = archiveManager;
    this.processor = processor ?? new OpenVikingCheckpointProcessor(client, { observation });
    this.observe = observation;
    this.notify = notify;
    this.pollIntervalMs = pollIntervalMs;
    this.now = now;
    this.sessionId = null;
    this.archives = [];
    this.cleanedTaskIds = new Set();
    this.pendingCleanupTaskIds = new Set();
    this.state = initialState();
    this.current = null;
    this.timer = null;
    this.dirty = false;
    this.stopped = false;
    this.observe.emit("checkpoint_state", "snapshot", this.state, null);
  }

  get status() {
    return { ...this.state };
  }

  schedule(sessionId, archives) {
    if (this.stopped) return Promise.resolve();
    this.sessionId = sessionId;
    const byId = new Map();
    for (const descriptor of archives ?? []) {
      if (descriptor?.manifest?.archiveId) byId.set(descriptor.manifest.archiveId, descriptor);
    }
    this.archives = [...byId.values()];
    this.dirty = true;
    return this.kick();
  }

  observeFinalState() {
    this.observe.emit("checkpoint_state", "snapshot", this.state, null);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { await this.current; } catch { /* status already records the failure */ }
  }


  kick() {
    if (this.current) return this.current;
    this.dirty = false;
    this.current = this.reconcile()
      .catch((error) => this.recordOperationalFailure(error, "reconcile", "pending_retry"))
      .finally(() => {
        this.current = null;
        if (!this.stopped && this.dirty) queueMicrotask(() => this.kick());
      });
    return this.current;
  }

  schedulePoll() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async reconcile() {
    if (this.stopped || !this.sessionId) return;
    while (!this.stopped) {
      const scan = await this.scanFacts();
      this.publishState(scan);
      if (!await this.cleanupTerminalAttempts(scan.terminalTaskIds)) return;
      if (!scan.current || scan.exhausted) return;

      const { manifest } = scan.current.descriptor;
      const expanded = await this.archiveManager.expand(this.sessionId, manifest.archiveId);
      if (expanded.manifest.contentHash !== manifest.contentHash) {
        throw new Error("checkpoint source Archive changed after scheduling");
      }

      let requestEvent = scan.current.requestEvent;
      let requestBranch = "resume";
      if (!requestEvent) {
        requestEvent = buildCheckpointRequestEvent({
          manifest: expanded.manifest,
          previousCheckpointId: scan.previousCheckpoint?.checkpointId ?? null,
          attempt: scan.current.attempt,
          submittedAt: this.now(),
        });
        requestEvent = await this.writeFact(requestEvent);
        requestBranch = "submit";
      }
      this.observe.emit("checkpoint_request", requestBranch, scan.current.attempt, scan.pending.length);

      const request = this.validateRequestEvent(
        requestEvent,
        scan.current.descriptor,
        scan.previousCheckpoint?.checkpointId ?? null,
        scan.current.attempt,
      );
      const result = await this.processor.advance({
        taskId: request.taskId,
        manifest: expanded.manifest,
        events: expanded.events,
        previousCheckpoint: scan.previousCheckpoint,
      });
      if (result.status === "processing" || result.status === "pending") {
        if (result.error) this.recordOperationalFailure(result.error, result.error.errorCode, "pending_retry");
        this.schedulePoll();
        return;
      }

      if (result.status === "failed") {
        const failureEvent = buildCheckpointFailureEvent({
          requestEvent,
          failedAt: this.now(),
          error: result.error,
        });
        const storedFailure = await this.writeFact(failureEvent);
        const failure = this.validateFailureEvent(storedFailure, requestEvent);
        const retrying = request.attempt < CHECKPOINT_MAX_ATTEMPTS;
        this.observe.emit(
          "checkpoint_failure",
          failure.error,
          failure.error.errorCode,
          retrying ? "retry" : "abort_operation",
          retrying ? "retry_attempt" : "retry_exhausted",
          scan.pending.length,
          scan.backlogTokens,
        );
        const action = retrying ? "将重试" : "重试已耗尽";
        this.notify(`OpenViking checkpoint 失败，${action}（Archive ${manifest.archiveId.slice(0, 12)}…）`, "warning");
        this.pendingCleanupTaskIds.add(request.taskId);
        if (!await this.cleanupAttempt(request.taskId)) return;
        continue;
      }

      const checkpointEvent = buildCheckpointEvent({
        manifest: expanded.manifest,
        requestEvent,
        overview: result.overview,
        completedAt: this.now(),
      });
      const storedCheckpoint = await this.writeFact(checkpointEvent);
      this.validateCheckpointEvent(storedCheckpoint, scan.current.descriptor, requestEvent);
      this.observe.emit("checkpoint_request", "complete", request.attempt, Math.max(0, scan.pending.length - 1));
      this.pendingCleanupTaskIds.add(request.taskId);
      if (!await this.cleanupAttempt(request.taskId)) return;
    }
  }

  async writeFact(event) {
    try {
      const result = await this.adapter.writeEvents(this.sessionId, [event]);
      if (result.acceptedEventIds.length !== 1 || result.acceptedEventIds[0] !== event.eventId) {
        throw new Error("OpenViking did not accept the checkpoint fact");
      }
    } catch (error) {
      if (!(error instanceof ContentConflictError)) throw error;
      const raced = await this.adapter.readEventIfExists(this.sessionId, event.eventId);
      if (!raced) throw error;
      return raced.event;
    }
    const stored = await this.adapter.readEvent(this.sessionId, event.eventId);
    if (!stored.bytes || stored.event.eventId !== event.eventId) {
      throw new Error("checkpoint fact read-back failed");
    }
    return stored.event;
  }

  async cleanupAttempt(taskId) {
    if (this.cleanedTaskIds.has(taskId)) return true;
    try {
      const cleaned = await this.processor.cleanup(taskId);
      if (cleaned) {
        this.cleanedTaskIds.add(taskId);
        this.pendingCleanupTaskIds.delete(taskId);
        return true;
      }
      this.recordOperationalFailure(new Error("checkpoint temporary state remains"), "cleanup", "retain_fact");
    } catch (error) {
      this.recordOperationalFailure(error, "cleanup", "retain_fact");
    }
    return false;
  }

  async cleanupTerminalAttempts(taskIds) {
    let complete = true;
    for (const taskId of new Set([...this.pendingCleanupTaskIds, ...taskIds])) {
      if (!await this.cleanupAttempt(taskId)) complete = false;
    }
    return complete;
  }

  validateRequestEvent(event, descriptor, previousCheckpointId, attempt) {
    const request = parseCheckpointRequestEvent(event);
    const manifest = descriptor.manifest;
    if (event.parentId !== manifest.lastEventId || request.archiveId !== manifest.archiveId ||
        request.archiveHash !== manifest.contentHash || request.previousCheckpointId !== previousCheckpointId ||
        request.attempt !== attempt) {
      throw new Error("checkpoint request does not match the current Archive chain");
    }
    return request;
  }

  validateFailureEvent(event, requestEvent) {
    const failure = parseCheckpointFailureEvent(event);
    const request = parseCheckpointRequestEvent(requestEvent);
    if (event.parentId !== requestEvent.eventId || failure.taskId !== request.taskId ||
        failure.archiveId !== request.archiveId || failure.archiveHash !== request.archiveHash ||
        failure.attempt !== request.attempt) {
      throw new Error("checkpoint failure does not match its request");
    }
    return failure;
  }

  validateCheckpointEvent(event, descriptor, requestEvent) {
    const checkpoint = parseCheckpointEvent(event, descriptor.manifest);
    if (event.parentId !== requestEvent.eventId) {
      throw new Error("checkpoint does not match its request");
    }
    return checkpoint;
  }

  async validateStoredCheckpoint(descriptor, previousCheckpoint, checkpointEvent) {
    const previousId = previousCheckpoint?.checkpointId ?? null;
    const terminalTaskIds = [];
    let gap = false;
    let matchedRequest = null;
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      const [requestStored, failureStored] = await Promise.all([
        this.adapter.readEventIfExists(
          this.sessionId,
          checkpointRequestEventId(descriptor.manifest, previousId, attempt),
        ),
        this.adapter.readEventIfExists(
          this.sessionId,
          checkpointFailureEventId(descriptor.manifest, previousId, attempt),
        ),
      ]);
      if (!requestStored) {
        if (failureStored) throw new Error("checkpoint failure exists without its request");
        gap = true;
        continue;
      }
      if (gap || matchedRequest) throw new Error("checkpoint request chain is not contiguous");
      const request = this.validateRequestEvent(requestStored.event, descriptor, previousId, attempt);
      if (failureStored) {
        this.validateFailureEvent(failureStored.event, requestStored.event);
        terminalTaskIds.push(request.taskId);
        continue;
      }
      if (checkpointEvent.parentId !== requestStored.event.eventId) {
        throw new Error("checkpoint has no matching request chain");
      }
      matchedRequest = requestStored.event;
      terminalTaskIds.push(request.taskId);
    }
    if (!matchedRequest) throw new Error("checkpoint has no matching request chain");
    return {
      checkpoint: this.validateCheckpointEvent(checkpointEvent, descriptor, matchedRequest),
      terminalTaskIds,
    };
  }
  async scanFacts() {
    const consumed = [];
    const pending = [];
    const terminalTaskIds = [];
    let previousCheckpoint = null;
    let sawPending = false;
    for (const descriptor of this.archives) {
      const stored = await this.adapter.readEventIfExists(this.sessionId, checkpointEventId(descriptor.manifest));
      if (stored) {
        if (sawPending) throw new Error("checkpoint chain contains a consumed Archive after an unconsumed gap");
        const validated = await this.validateStoredCheckpoint(descriptor, previousCheckpoint, stored.event);
        terminalTaskIds.push(...validated.terminalTaskIds);
        previousCheckpoint = validated.checkpoint;
        consumed.push({ descriptor, checkpoint: validated.checkpoint });
      } else {
        sawPending = true;
        pending.push(descriptor);
      }
    }

    const backlogTokens = pending.reduce((sum, descriptor) => sum + Math.max(0, Number(descriptor.tokenCount) || 0), 0);
    if (pending.length === 0) {
      return { consumed, pending, previousCheckpoint, backlogTokens, current: null, exhausted: false, lastFailure: null, terminalTaskIds };
    }

    const descriptor = pending[0];
    const previousId = previousCheckpoint?.checkpointId ?? null;
    let current = null;
    let lastFailure = null;
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      const [requestStored, failureStored] = await Promise.all([
        this.adapter.readEventIfExists(
          this.sessionId,
          checkpointRequestEventId(descriptor.manifest, previousId, attempt),
        ),
        this.adapter.readEventIfExists(
          this.sessionId,
          checkpointFailureEventId(descriptor.manifest, previousId, attempt),
        ),
      ]);
      if (!requestStored) {
        if (failureStored) throw new Error("checkpoint failure exists without its request");
        current = { descriptor, attempt, requestEvent: null };
        break;
      }
      const request = this.validateRequestEvent(requestStored.event, descriptor, previousId, attempt);
      if (!failureStored) {
        current = { descriptor, attempt, requestEvent: requestStored.event };
        break;
      }
      const failure = this.validateFailureEvent(failureStored.event, requestStored.event);
      terminalTaskIds.push(request.taskId);
      lastFailure = failure.error.message;
    }
    return {
      consumed,
      pending,
      previousCheckpoint,
      backlogTokens,
      current,
      exhausted: current === null,
      lastFailure,
      terminalTaskIds,
    };
  }

  publishState(scan) {
    const previous = this.state;
    const mode = scan.pending.length === 0 ? "caught_up"
      : scan.exhausted ? "failed"
        : scan.pending.length >= 2 ? "lagging" : "processing";
    const next = {
      mode,
      consumed: scan.consumed.length,
      pending: scan.pending.length,
      backlogTokens: scan.backlogTokens,
      lastCheckpointId: scan.previousCheckpoint?.checkpointId ?? null,
      currentArchiveId: scan.current?.descriptor?.manifest?.archiveId ?? scan.pending[0]?.manifest?.archiveId ?? null,
      lastFailure: scan.lastFailure,
    };
    this.state = next;
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      this.observe.emit("checkpoint_state", "change", previous, next);
      if (previous.mode !== "lagging" && next.mode === "lagging") {
        this.notify(`OpenViking checkpoint 消费落后：${next.pending} 个 Archive，约 ${next.backlogTokens} tokens`, "warning");
      } else if (previous.mode === "lagging" && (next.mode === "processing" || next.mode === "caught_up")) {
        this.notify("OpenViking checkpoint 消费已恢复", "info");
      }
    }
  }

  recordOperationalFailure(error, errorCode, branch) {
    const previous = this.state;
    this.state = { ...this.state, lastFailure: errorMessage(error) };
    this.observe.emit(
      "checkpoint_failure",
      error,
      String(errorCode || "reconcile").replace(/[^a-z0-9_]/g, "_").slice(0, 64),
      branch === "retain_fact" ? "ignore" : "retry",
      branch,
      this.state.pending,
      this.state.backlogTokens,
    );
    if (previous.lastFailure !== this.state.lastFailure) {
      this.observe.emit("checkpoint_state", "change", previous, this.state);
    }
    this.schedulePoll();
  }
}
