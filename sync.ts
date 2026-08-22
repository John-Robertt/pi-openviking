import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OVClient } from "./client.js";
import {
  ActiveContextManager,
  activeContextFileKey,
  type ActiveContextStatus,
} from "./shared/active-context.mjs";
import { describeArchives, type ArchiveDescriptor } from "./shared/archive.mjs";
import { ArchiveManager } from "./shared/archive-store.mjs";
import { CheckpointManager, type CheckpointStatus } from "./shared/checkpoint-store.mjs";
import { parsePiSessionJsonl } from "./shared/pi-session-source.mjs";
import { observation, type Observation } from "./shared/observe.mjs";
import { RecordedEventAdapter } from "./shared/recorded-event-adapter.mjs";
import type { PiRecordedEventV1 } from "./shared/recorded-event.mjs";
import { projectPiEntries } from "./shared/recorded-event.mjs";
import { deriveHarnessSessionId } from "./shared/session-model.mjs";
import type { PiTaskModelContextFacts } from "./shared/task-model-context.mjs";
import {
  advanceSyncAck,
  isEntryAcknowledged,
  readSyncAck,
  syncAckFileKey,
  writeSyncAck,
  type SyncAck,
} from "./shared/sync-ack.mjs";

export interface SyncBranchResult {
  added: number;
  allDelivered: boolean;
  pending: number;
  failure: string | null;
}

export interface ArchiveStatus {
  committed: number;
  lastArchiveId: string | null;
  pending: number;
  lastFailure: string | null;
}

export interface SyncStatus {
  source: "persistent-jsonl" | "in-memory" | "none";
  capability: "unknown" | "ready" | "mismatch";
  acknowledgedLeaves: string[];
  pendingEntries: number;
  lastFailure: string | null;
  archive: ArchiveStatus;
  checkpoint: CheckpointStatus;
  activeContext: ActiveContextStatus;
}

/** Pi 生命周期读取并传入的任务模型上下文事实。 */
export type TaskModelContext = PiTaskModelContextFacts;

interface SyncManagerOptions {
  ackPathForSession?: (sessionId: string) => string | null;
  activeContextPathForSession?: (sessionId: string) => string | null;
  adapterFactory?: (client: OVClient, userRoot: string) => RecordedEventAdapter;
  observation?: Observation;
  notify?: (message: string, level: "info" | "warning") => void;
}


function defaultAckPath(
  sessionId: string,
  target: { endpoint: string; account: string; user: string },
): string {
  const key = syncAckFileKey(target, sessionId);
  return join(homedir(), ".pi", "openviking", "sync-ack", `${key}.json`);
}

function defaultActiveContextPath(
  sessionId: string,
  target: { endpoint: string; account: string; user: string },
): string {
  const key = activeContextFileKey(target, sessionId);
  return join(homedir(), ".pi", "openviking", "active-context", `${key}.json`);
}

function branchContinuesFrom(
  parentById: Map<string, string | null>,
  leafId: string | null,
  previousLeafId: string,
): boolean {
  let cursor = leafId;
  while (cursor !== null) {
    if (cursor === previousLeafId) return true;
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
}

export class SyncManager {
  private client: OVClient;
  private options: SyncManagerOptions;
  private observe: Observation;
  private ovSessionId: string | null = null;
  private piSessionId: string | null = null;
  private adapter: RecordedEventAdapter | null = null;
  private archives: ArchiveManager | null = null;
  private checkpoints: CheckpointManager | null = null;
  private activeContext: ActiveContextManager | null = null;
  private ack: SyncAck = { acknowledgedLeaves: [] };
  private ackPath: string | null = null;
  private knownParents = new Map<string, string | null>();
  private checkpointBranchLeafId: string | null = null;
  private committedArchives: ArchiveDescriptor[] = [];
  private derivedStateVersion = 0;
  private operationTail: Promise<void> = Promise.resolve();
  private syncStatus: SyncStatus = {
    source: "none",
    capability: "unknown",
    acknowledgedLeaves: [],
    pendingEntries: 0,
    lastFailure: null,
    archive: { committed: 0, lastArchiveId: null, pending: 0, lastFailure: null },
    checkpoint: {
      mode: "caught_up", consumed: 0, pending: 0, backlogTokens: 0,
      lastCheckpointId: null, currentArchiveId: null, lastFailure: null,
    },
    activeContext: {
      checkpointId: null, rawTailStartEventId: null, rawTailEvents: 0,
      eligibility: "no_context",
      capacityTokens: null, reserveTokens: null, usableTokens: null,
      payloadTokens: null, headroomTokens: null, lastFailure: null,
    },
  };

  constructor(client: OVClient, options: SyncManagerOptions = {}) {
    this.client = client;
    this.options = options;
    this.observe = options.observation ?? observation;
  }

  get sessionId(): string | null { return this.ovSessionId; }

  get status(): SyncStatus {
    return {
      ...this.syncStatus,
      acknowledgedLeaves: [...this.syncStatus.acknowledgedLeaves],
      archive: this.archives ? this.archives.status : { ...this.syncStatus.archive },
      checkpoint: this.checkpoints ? this.checkpoints.status : { ...this.syncStatus.checkpoint },
      activeContext: this.activeContext ? this.activeContext.status : { ...this.syncStatus.activeContext },
    };
  }

  sourceIsCurrent(sessionManager: any): boolean {
    if (!this.piSessionId || typeof sessionManager?.getLeafId !== "function") return false;
    return sessionManager.getLeafId() === this.checkpointBranchLeafId;
  }

  async takeoverMessages(sessionManager: any, taskModel: TaskModelContext | null = null, allowAdvance = true): Promise<any[] | null> {
    return this.serialize(async () => {
      if (!this.piSessionId || !this.activeContext || this.activeContext.status.eligibility !== "eligible") return null;
      try {
        const { entries, branch } = await this.sessionSource(sessionManager);
        const events = projectPiEntries(this.piSessionId, entries);
        const onBranch = new Set(branch.map((entry) => entry.id));
        const branchEvents = events.filter((event) => onBranch.has(event.source.entryId));
        return await this.activeContext.takeoverMessages(branchEvents, {
          archives: this.committedArchives,
          lastCheckpointId: this.checkpoints?.status.lastCheckpointId ?? null,
          capacity: taskModel?.capacity ?? null,
          factsAvailable: taskModel?.factsAvailable === true,
          allowAdvance,
          systemPrompt: taskModel?.systemPrompt ?? "",
          toolDefinitions: taskModel?.toolDefinitions ?? "",
        });
      } catch (error: any) {
        this.observe.emit("active_context_failure", error, "materialize", "degrade", "keep_full_context");
        return null;
      }
    });
  }

  async activeContextCompaction(sessionManager: any, tokensBefore: number): Promise<any | null> {
    return this.serialize(async () => {
      if (!this.piSessionId || !this.activeContext) return null;
      try {
        const { entries, branch } = await this.sessionSource(sessionManager);
        const events = projectPiEntries(this.piSessionId, entries);
        const onBranch = new Set(branch.map((entry) => entry.id));
        const branchEvents = events.filter((event) => onBranch.has(event.source.entryId));
        return await this.activeContext.compaction(branchEvents, tokensBefore);
      } catch (error: any) {
        this.observe.emit("active_context_failure", error, "compaction", "degrade", "native_compaction");
        return null;
      }
    });
  }

  observeFinalState(): void {
    this.observe.emit("sync_capability", "snapshot", this.syncStatus.capability);
    this.observe.emit("sync_ack", "snapshot", this.ack, null, this.syncStatus.pendingEntries);
    this.archives?.observeFinalState();
    this.checkpoints?.observeFinalState();
    this.activeContext?.observeFinalState();
  }

  /**
   * 展开本会话的一个 Archive。
   *
   * Archive 位置由当前 Pi session 推导，因此调用方无法寻址其他会话的 Archive——
   * 会话边界来自命名空间本身，不依赖调用方传入的标识。
   */
  async expandArchive(archiveId: string): Promise<{ manifest: ArchiveManifestV1; events: PiRecordedEventV1[] }> {
    if (!this.archives || !this.piSessionId) throw new Error("archive expansion is not initialized");
    return this.archives.expand(this.piSessionId, archiveId);
  }

  async ensureSession(piSessionId: string): Promise<boolean> {
    if (this.piSessionId === piSessionId && this.adapter) return true;
    if (this.checkpoints) await this.checkpoints.stop();
    // in-memory 父子映射只描述当前会话的 entry 树，换会话即失效。
    if (this.piSessionId !== piSessionId) {
      this.knownParents.clear();
      this.checkpointBranchLeafId = null;
      this.committedArchives = [];
      this.derivedStateVersion = 0;
    }
    this.piSessionId = piSessionId;
    this.observe.bindSession(piSessionId);
    this.ovSessionId = deriveHarnessSessionId("pi-", piSessionId);

    let userRoot = this.client.userRoot;
    if (!userRoot) {
      this.client.bindUser(await this.client.resolveUserSpace());
      userRoot = this.client.userRoot;
    }
    this.adapter = this.options.adapterFactory
      ? this.options.adapterFactory(this.client, userRoot)
      : new RecordedEventAdapter(this.client, { userRoot, observation: this.observe });
    this.archives = new ArchiveManager(this.client, {
      userRoot,
      adapter: this.adapter,
      budgets: this.client.cfg.archive,
      observation: this.observe,
    });
    this.checkpoints = new CheckpointManager(this.client, {
      adapter: this.adapter,
      archiveManager: this.archives,
      observation: this.observe,
      notify: this.options.notify,
    });
    this.activeContext = new ActiveContextManager({
      path: this.options.activeContextPathForSession
        ? this.options.activeContextPathForSession(piSessionId)
        : defaultActiveContextPath(piSessionId, this.client.recordedEventTarget),
      adapter: this.adapter,
      takeover: this.client.cfg.takeover,
      observation: this.observe,
    });

    this.ackPath = this.options.ackPathForSession
      ? this.options.ackPathForSession(piSessionId)
      : defaultAckPath(piSessionId, this.client.recordedEventTarget);
    try {
      this.ack = this.ackPath ? await readSyncAck(this.ackPath) : { acknowledgedLeaves: [] };
    } catch (error: any) {
      this.ack = { acknowledgedLeaves: [] };
      this.syncStatus.lastFailure = error?.message || String(error);
      this.observe.emit("sync_failure", error, "ack_read", "degrade", "replay_all", 0, 0);
    }
    this.publishStatus();
    this.observe.emit("sync_capability", "snapshot", this.syncStatus.capability);
    this.observe.emit("sync_ack", "snapshot", this.ack, null, this.syncStatus.pendingEntries);
    return true;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async waitForIdle(timeoutMs = 500): Promise<boolean> {
    const pending = this.operationTail;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
      this.observe.emit("shutdown_grace", timeoutMs, drained);
      return drained;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async stopBackground(): Promise<void> {
    await this.checkpoints?.stop();
  }

  private async sessionSource(sessionManager: any): Promise<{
    entries: any[];
    branch: any[];
    parentById: Map<string, string | null>;
    source: SyncStatus["source"];
  }> {
    const persisted = typeof sessionManager?.isPersisted === "function" && sessionManager.isPersisted();
    const sessionFile = typeof sessionManager?.getSessionFile === "function" ? sessionManager.getSessionFile() : null;
    if (persisted && sessionFile) {
      const parsed = parsePiSessionJsonl(await readFile(sessionFile, "utf8"), {
        sessionId: this.piSessionId || undefined,
        leafId: typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : null,
      });
      this.observe.emit("sync_source", "persistent_jsonl", parsed.entries.length);
      return { entries: parsed.entries, branch: parsed.branch, parentById: parsed.parentById, source: "persistent-jsonl" };
    }

    const entries = typeof sessionManager?.getEntries === "function"
      ? sessionManager.getEntries()
      : typeof sessionManager?.getBranch === "function"
        ? sessionManager.getBranch()
        : [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.id === "string") this.knownParents.set(entry.id, entry.parentId ?? null);
    }
    this.observe.emit("sync_source", "in_memory", Array.isArray(entries) ? entries.length : 0);
    // `getEntries()` 是整棵树，同步需要它；Archive 需要的是当前 leaf 的祖先链，只能由
    // `getBranch()` 给出。两者混用会让 Archive 收录到已放弃分支上的事件。
    const branch = typeof sessionManager?.getBranch === "function" ? sessionManager.getBranch() : [];
    return {
      entries: Array.isArray(entries) ? entries : [],
      branch: Array.isArray(branch) ? branch : [],
      parentById: this.knownParents,
      source: "in-memory",
    };
  }

  async observeSession(sessionManager: any, failure = "OpenViking unavailable"): Promise<SyncBranchResult> {
    return this.serialize(() => this.observeSessionNow(sessionManager, failure));
  }

  private async observeSessionNow(sessionManager: any, failure: string): Promise<SyncBranchResult> {
    if (!this.piSessionId || !this.adapter) return this.uninitializedResult();
    try {
      const { entries, parentById, source } = await this.sessionSource(sessionManager);
      const pending = entries.filter((entry) => !isEntryAcknowledged(this.ack, entry.id, parentById)).length;
      const previousPending = this.syncStatus.pendingEntries;
      this.syncStatus = {
        ...this.syncStatus,
        source,
        acknowledgedLeaves: [...this.ack.acknowledgedLeaves],
        pendingEntries: pending,
        lastFailure: pending > 0 ? failure : null,
      };
      if (previousPending !== pending) {
        this.observe.emit("sync_ack", "change", this.ack, this.ack, previousPending, pending);
      }
      return { added: 0, allDelivered: pending === 0, pending, failure: pending > 0 ? failure : null };
    } catch (error: any) {
      this.observe.emit("sync_failure", error, "source", "abort_operation", "pending_replay", 0, this.syncStatus.pendingEntries);
      return this.failResult(error?.message || String(error));
    }
  }

  async syncSession(sessionManager: any, taskModel: TaskModelContext | null = null): Promise<SyncBranchResult> {
    return this.serialize(() => this.syncSessionNow(sessionManager, taskModel));
  }

  private async syncSessionNow(sessionManager: any, taskModel: TaskModelContext | null): Promise<SyncBranchResult> {
    if (!this.piSessionId || !this.adapter) return this.uninitializedResult();
    try {
      const { entries, branch, parentById, source } = await this.sessionSource(sessionManager);
      return await this.syncSource(entries, branch, parentById, source, taskModel);
    } catch (error: any) {
      this.observe.emit("sync_failure", error, "source", "abort_operation", "pending_replay", 0, this.syncStatus.pendingEntries);
      return this.failResult(error?.message || String(error));
    }
  }

  private async syncSource(
    entries: any[],
    branch: any[],
    parentById: Map<string, string | null>,
    source: SyncStatus["source"],
    taskModel: TaskModelContext | null,
  ): Promise<SyncBranchResult> {
    if (!this.piSessionId || !this.adapter) return this.uninitializedResult();

    let events: any[];
    try {
      events = projectPiEntries(this.piSessionId, entries);
    } catch (error: any) {
      this.observe.emit("sync_failure", error, "projection", "abort_operation", "pending_replay", 0, entries.length);
      return this.failResult(error?.message || String(error), source);
    }
    const eventsByEntry = new Map<string, any[]>();
    for (const event of events) {
      const entryEvents = eventsByEntry.get(event.source.entryId) || [];
      entryEvents.push(event);
      eventsByEntry.set(event.source.entryId, entryEvents);
    }
    const pendingEntries = entries.filter((entry) => !isEntryAcknowledged(this.ack, entry.id, parentById));
    const previousPending = this.syncStatus.pendingEntries;
    this.syncStatus = {
      ...this.syncStatus,
      source,
      acknowledgedLeaves: [...this.ack.acknowledgedLeaves],
      pendingEntries: pendingEntries.length,
      lastFailure: null,
    };
    if (previousPending !== pendingEntries.length) {
      this.observe.emit("sync_ack", "change", this.ack, this.ack, previousPending, pendingEntries.length);
    }

    let added = 0;
    for (const entry of pendingEntries) {
      const entryEvents = eventsByEntry.get(entry.id) || [];
      let failureCode: "ack_persist" | "capability" | "delivery" = "delivery";
      try {
        const result = await this.adapter.writeEvents(this.piSessionId, entryEvents);
        if (result.acceptedEventIds.length !== entryEvents.length) {
          throw new Error(`OpenViking did not confirm every event for Pi entry ${entry.id}`);
        }
        if (!result.capabilityVerified) {
          failureCode = "capability";
          throw new Error("OpenViking Content capability was not byte-verified");
        }
        this.setCapability("ready");
        const previousAck = this.ack;
        const previousPending = this.syncStatus.pendingEntries;
        const nextAck = advanceSyncAck(previousAck, entry.id, parentById);
        failureCode = "ack_persist";
        if (this.ackPath) await writeSyncAck(this.ackPath, nextAck);
        this.ack = nextAck;
        added++;
        this.syncStatus.pendingEntries--;
        this.observe.emit("sync_ack_advance", entryEvents.length, result.acceptedEventIds.length, result.capabilityVerified);
        this.observe.emit("sync_ack", "change", previousAck, nextAck, previousPending, this.syncStatus.pendingEntries);
        this.publishStatus();
      } catch (error: any) {
        const status = Number(error?.status || 0);
        const capabilityMismatch = [404, 405, 422].includes(status) || /invalid result|did not confirm/.test(error?.message || "");
        if (capabilityMismatch) this.setCapability("mismatch");
        const failure = `${error?.name || "Error"}: ${error?.message || String(error)}${error?.uri ? ` — ${error.uri}` : ""}`;
        this.syncStatus.lastFailure = failure;
        this.publishStatus();
        this.observe.emit(
          "sync_failure",
          error,
          capabilityMismatch ? "capability" : failureCode,
          "abort_operation",
          "pending_replay",
          added,
          this.syncStatus.pendingEntries,
        );
        // 已确认前缀的 Archive 不依赖后面这个 entry：某个事件的永久完整性冲突不应让
        // 整个会话此后不再产生任何 Archive。
        await this.advanceDerivedState(branch, parentById, events, taskModel);
        return { added, allDelivered: false, pending: this.syncStatus.pendingEntries, failure };
      }
    }

    await this.advanceDerivedState(branch, parentById, events, taskModel);
    this.publishStatus();
    return { added, allDelivered: true, pending: 0, failure: null };
  }

  private checkpointArchiveChains(
    branch: any[],
    parentById: Map<string, string | null>,
    events: any[],
  ): ArchiveDescriptor[][] {
    if (!this.piSessionId) return [];
    const parents = new Set([...parentById.values()].filter((id): id is string => id !== null));
    const leaves = [...parentById.keys()].filter((id) => !parents.has(id));
    const currentLeafId = branch.at(-1)?.id;
    if (currentLeafId && !leaves.includes(currentLeafId)) leaves.push(currentLeafId);

    const chains = [];
    const seen = new Set<string>();
    for (const leafId of leaves) {
      const reversed = [];
      let cursor: string | null = leafId;
      while (cursor !== null) {
        reversed.push(cursor);
        cursor = parentById.get(cursor) ?? null;
      }
      const acknowledged = new Set<string>();
      for (const entryId of reversed.reverse()) {
        if (!isEntryAcknowledged(this.ack, entryId, parentById)) break;
        acknowledged.add(entryId);
      }
      const branchEvents = events.filter((event) => acknowledged.has(event.source.entryId));
      const descriptors = describeArchives(this.piSessionId, branchEvents, this.client.cfg.archive);
      const key = descriptors.map((descriptor) => descriptor.manifest.archiveId).join(",");
      if (descriptors.length > 0 && !seen.has(key)) {
        seen.add(key);
        chains.push(descriptors);
      }
    }
    return chains;
  }

  /**
   * 推进当前分支上的派生状态：先形成 Archive，再据此固定活动上下文。
   *
   * 顺序不能颠倒——活动上下文选择的是"最后一个已消费 Archive 之后"的边界，因此必须在本轮
   * Archive 规划完成之后才有正确的输入。
   *
   * 活动上下文消费的是当前分支的**全部**事件，而不是 Archive 使用的已确认前缀：接管替换的
   * 只是已归档前缀，尚未确认的最新事件仍然在任务模型上下文里，必须留在 raw tail 内；同时，
   * "raw tail 起点是否还在分支上"因此只反映真实的分支变化，不会被 ACK 丢失或传输失败误判成
   * 分支切换而丢掉已固定的边界。
   */
  private async advanceDerivedState(
    branch: any[],
    parentById: Map<string, string | null>,
    events: any[],
    taskModel: TaskModelContext | null,
  ): Promise<void> {
    // 结果用对象包住 checkpoint 消费的 promise：直接返回 promise 会被 await 展开，
    // 同步就会等待异步 VLM 消费完成。
    const version = ++this.derivedStateVersion;
    const sessionId = this.piSessionId;
    const { consumption } = await this.formArchives(branch, parentById, events);
    const onBranch = new Set(branch.map((entry) => entry.id));
    const branchEvents = events.filter((event) => onBranch.has(event.source.entryId));
    await this.updateActiveContext(branchEvents, taskModel);
    // checkpoint 消费是异步的：它完成后立即用新的消费状态再收敛一次活动上下文，使边界在
    // 同一轮同步内固定，而不是等到下一轮。收敛排在同一操作队列上，因此 shutdown grace 覆盖它。
    // 后续同步或会话切换会产生更新的分支快照；旧 consumption 完成后不得用旧 branchEvents
    // 混合当前 checkpoint 状态来覆盖新分支的 ActiveContext。
    if (consumption) {
      // consumption 的失败由 checkpoint 协调者记录，收敛本身的降级由 updateActiveContext 记录；
      // 这里只防止 fire-and-forget 链把未处理的 rejection 变成进程级失败。
      void consumption
        .then(() => this.serialize(async () => {
          if (this.piSessionId !== sessionId || this.derivedStateVersion !== version) return;
          await this.updateActiveContext(branchEvents, taskModel);
        }))
        .catch(() => {});
    }
  }

  /** 活动上下文只服务接管：它的失败不改变事件、ACK、Archive 或 checkpoint。 */
  private async updateActiveContext(branchEvents: any[], taskModel: TaskModelContext | null): Promise<void> {
    if (!this.activeContext || !this.piSessionId) return;
    try {
      await this.activeContext.update(this.piSessionId, {
        branchEvents,
        archives: this.committedArchives,
        lastCheckpointId: this.checkpoints?.status.lastCheckpointId ?? null,
        capacity: taskModel?.capacity ?? null,
        factsAvailable: taskModel?.factsAvailable === true,
        systemPrompt: taskModel?.systemPrompt ?? "",
        toolDefinitions: taskModel?.toolDefinitions ?? "",
      });
    } catch (error: any) {
      this.observe.emit("active_context_failure", error, "materialize", "degrade", "keep_full_context");
    }
  }

  /**
   * 在当前分支已确认的事件前缀上形成 Archive。
   *
   * 只取分支而不是整棵树：Archive 表达任务模型走过的一条上下文，跨 sibling branch 的
   * 范围没有对应的上下文。Archive 失败不改变 ACK，也不使同步结果失败——事件已经是
   * 事实源，Archive 在下一次同步重试。
   */
  private async formArchives(
    branch: any[],
    parentById: Map<string, string | null>,
    events: any[],
  ): Promise<{ consumption: Promise<void> | null }> {
    if (!this.archives || !this.piSessionId) return { consumption: null };
    const branchLeafId = branch.at(-1)?.id ?? null;
    const previousLeafId = this.checkpointBranchLeafId;
    if (previousLeafId !== null && !branchContinuesFrom(parentById, branchLeafId, previousLeafId)) {
      // Invalidate the abandoned branch before Archive reads: a completed old VLM result must not
      // start an append while the new branch is still being revalidated.
      void this.checkpoints?.schedule(this.piSessionId, []);
    }
    this.checkpointBranchLeafId = branchLeafId;

    const archiveChains = this.checkpointArchiveChains(branch, parentById, events);

    const acknowledged = new Set<string>();
    for (const entry of branch) {
      if (!isEntryAcknowledged(this.ack, entry.id, parentById)) break;
      acknowledged.add(entry.id);
    }
    const acknowledgedEvents = events.filter((event) => acknowledged.has(event.source.entryId));
    const result = await this.archives.formArchives(this.piSessionId, acknowledgedEvents);
    // 只有完整走完本轮计划，结果才足以替换消费范围。暂时性传输失败保留上一范围；
    // 分支切换已在 I/O 前失效旧范围，因而不会继续消费已放弃分支。
    if (!result.reconciled) return { consumption: null };
    this.committedArchives = result.archives;
    return { consumption: this.checkpoints?.schedule(this.piSessionId, result.archives, archiveChains) ?? null };
  }

  private setCapability(next: SyncStatus["capability"]): void {
    const previous = this.syncStatus.capability;
    this.syncStatus.capability = next;
    if (previous !== next) this.observe.emit("sync_capability", "change", previous, next);
  }

  private uninitializedResult(): SyncBranchResult {
    const failure = "sync session is not initialized";
    this.observe.emit("sync_failure", failure, "not_initialized", "abort_operation", "pending_replay", 0, this.syncStatus.pendingEntries);
    return this.emptyResult(failure);
  }

  private publishStatus(): void {
    this.syncStatus.acknowledgedLeaves = [...this.ack.acknowledgedLeaves];
  }

  private emptyResult(failure: string): SyncBranchResult {
    return { added: 0, allDelivered: false, pending: this.syncStatus.pendingEntries, failure };
  }

  private failResult(failure: string, source: SyncStatus["source"] = "none"): SyncBranchResult {
    this.syncStatus.source = source;
    this.syncStatus.lastFailure = failure;
    this.publishStatus();
    return this.emptyResult(failure);
  }

}
