import { createHash } from "node:crypto";

export const TAKEOVER_ENTRY_TYPE = "ov-takeover";
export const OVERVIEW_MARKER = "[OpenViking Session Context]";

const DEFAULT_CONFIG = {
  takeoverEnabled: true,
  takeoverTokenThreshold: 20000,
  takeoverKeepRecentTurns: 3,
  takeoverRetainedTokenBudget: 30000,
  takeoverOverviewBudget: 16000,
  takeoverOverviewPollMs: 2000,
  takeoverOverviewPollMax: 15,
};

function numberOr(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function takeoverConfig(config = {}) {
  return {
    takeoverEnabled: config.takeoverEnabled !== false,
    takeoverTokenThreshold: Math.max(0, numberOr(config.takeoverTokenThreshold, DEFAULT_CONFIG.takeoverTokenThreshold)),
    takeoverKeepRecentTurns: Math.max(1, numberOr(config.takeoverKeepRecentTurns, DEFAULT_CONFIG.takeoverKeepRecentTurns)),
    takeoverRetainedTokenBudget: Math.max(1, numberOr(config.takeoverRetainedTokenBudget, DEFAULT_CONFIG.takeoverRetainedTokenBudget)),
    takeoverOverviewBudget: Math.max(1, numberOr(config.takeoverOverviewBudget, DEFAULT_CONFIG.takeoverOverviewBudget)),
    takeoverOverviewPollMs: Math.max(0, numberOr(config.takeoverOverviewPollMs, DEFAULT_CONFIG.takeoverOverviewPollMs)),
    takeoverOverviewPollMax: Math.max(1, numberOr(config.takeoverOverviewPollMax, DEFAULT_CONFIG.takeoverOverviewPollMax)),
  };
}

function asEntry(value) {
  if (!value || typeof value !== "object") return null;
  return value.entry && typeof value.entry === "object" ? value.entry : value;
}

function flattenValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flattenValue).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.input_text === "string") return value.input_text;
  if (typeof value.output_text === "string") return value.output_text;
  if (typeof value.content === "string") return value.content;
  if (Array.isArray(value.content)) return flattenValue(value.content);
  return "";
}

export function flattenContent(msg) {
  if (!msg || typeof msg !== "object") return "";
  return flattenValue(msg.content);
}

export function fingerprintMessage(msg) {
  const payload = JSON.stringify({
    role: msg?.role || "",
    content: msg?.content ?? null,
    toolCallId: msg?.toolCallId ?? null,
    toolName: msg?.toolName ?? null,
    isError: msg?.isError ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function isUserTurnStart(msg) {
  if (!msg || msg.role !== "user") return false;
  return !flattenContent(msg).startsWith(OVERVIEW_MARKER);
}

export function countUserTurns(messages) {
  let count = 0;
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (isUserTurnStart(msg)) count++;
  }
  return count;
}

export function findBoundaryIndex(messages, coveredUserTurns) {
  const target = Math.max(0, Math.floor(Number(coveredUserTurns) || 0)) + 1;
  let seen = 0;
  for (let i = 0; i < (Array.isArray(messages) ? messages.length : 0); i++) {
    if (!isUserTurnStart(messages[i])) continue;
    seen++;
    if (seen === target) return i;
  }
  return -1;
}

export function estimateTokens(text) {
  const value = String(text || "");
  if (!value) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of value) {
    if (ch.codePointAt(0) >= 0x3000) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other / 4);
}

export function truncateToTokens(text, budget) {
  const value = String(text || "");
  const limit = Math.max(0, Math.floor(Number(budget) || 0));
  if (!value || limit <= 0) return "";
  if (estimateTokens(value) <= limit) return value;

  let lo = 0;
  let hi = value.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(value.slice(0, mid)) <= limit) lo = mid;
    else hi = mid - 1;
  }
  return value.slice(0, lo);
}

function partText(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (part.type === "tool") {
    const payload = {
      name: part.tool_name,
      input: part.tool_input,
      output: part.tool_output,
      status: part.tool_status,
    };
    try {
      return JSON.stringify(payload);
    } catch {
      return String(part.tool_name || part.tool_output || "");
    }
  }
  return flattenValue(part);
}

export function estimatePayloadTokens(payload) {
  if (!payload || typeof payload !== "object") return 0;
  if (typeof payload.content === "string") return estimateTokens(payload.content);
  if (Array.isArray(payload.parts)) {
    return estimateTokens(payload.parts.map(partText).filter(Boolean).join("\n\n"));
  }
  if (Array.isArray(payload.content)) {
    return estimateTokens(payload.content.map(partText).filter(Boolean).join("\n\n"));
  }
  return 0;
}

export function buildOverviewMessage(overview, firstKeptTs = 0, budget = DEFAULT_CONFIG.takeoverOverviewBudget) {
  const raw = String(overview || "");
  const truncated = truncateToTokens(raw, budget);
  const body = truncated === raw ? raw : `${truncated}\n...(truncated)`;
  const timestamp = Number.isFinite(Number(firstKeptTs)) ? Number(firstKeptTs) - 1 : 0;
  return {
    role: "user",
    content:
      `${OVERVIEW_MARKER} Earlier conversation was archived to OpenViking and summarized below. ` +
      `Use viking_search / viking_archive_expand for details.\n\n${body}`,
    timestamp,
  };
}

export function countUndeliveredForSession(pendingEntries, sid) {
  if (!sid) return 0;
  let count = 0;
  for (const item of Array.isArray(pendingEntries) ? pendingEntries : []) {
    const entry = asEntry(item);
    if (entry?.type === "addMessage" && entry.sessionId === sid) count++;
  }
  return count;
}

function archiveIdFromUri(uri) {
  const value = typeof uri === "string" ? uri.trim().replace(/\/+$/, "") : "";
  const archiveId = value.slice(value.lastIndexOf("/") + 1);
  return /^archive_\d+$/.test(archiveId) ? archiveId : "";
}

function normalizeArchiveIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const archiveUri = typeof value.archiveUri === "string" ? value.archiveUri.trim() : "";
  const archiveId = typeof value.archiveId === "string" ? value.archiveId : archiveIdFromUri(archiveUri);
  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  if (!archiveUri || !archiveId || !taskId || archiveId !== archiveIdFromUri(archiveUri)) return null;
  return { archiveUri, archiveId, taskId };
}

function normalizePendingArchive(value) {
  if (!value || typeof value !== "object") return null;
  const taskId = typeof value.taskId === "string" ? value.taskId.trim() : "";
  const rawArchiveUri = typeof value.archiveUri === "string" ? value.archiveUri.trim() : "";
  const rawArchiveId = typeof value.archiveId === "string" ? value.archiveId : "";
  if (!taskId) return null;
  const identity = rawArchiveUri || rawArchiveId ? normalizeArchiveIdentity(value) : null;
  if ((rawArchiveUri || rawArchiveId) && !identity) return null;
  const purpose = value.purpose === "compact" || value.purpose === "archiveOnly" ? value.purpose : "advance";
  return {
    purpose,
    archiveUri: identity?.archiveUri || "",
    archiveId: identity?.archiveId || "",
    taskId,
    acceptedTokens: Math.max(0, Math.floor(Number(value.acceptedTokens) || 0)),
    targetCoveredUserTurns: Math.max(0, Math.floor(Number(value.targetCoveredUserTurns) || 0)),
    boundaryFingerprint: typeof value.boundaryFingerprint === "string" ? value.boundaryFingerprint : null,
    syncedEntryCount: Math.max(0, Math.floor(Number(value.syncedEntryCount) || 0)),
  };
}

function fingerprintAtBoundary(messages, coveredUserTurns) {
  if (coveredUserTurns <= 0) return null;
  const boundaryIdx = findBoundaryIndex(messages, coveredUserTurns);
  return boundaryIdx > 0 ? fingerprintMessage(messages[boundaryIdx - 1]) : null;
}

export class TakeoverCore {
  constructor({ config = {}, io = {} } = {}) {
    this.config = takeoverConfig(config);
    this.io = {
      flush: io.flush || (async () => true),
      commit: io.commit || (async () => null),
      checkArchive: io.checkArchive || (async () => ({ status: "pending" })),
      hasActiveCommit: io.hasActiveCommit || (async () => false),
      persistEntry: io.persistEntry || (() => {}),
      getWatermark: io.getWatermark || (() => 0),
      sleep: io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      log: io.log || (() => {}),
    };
    this.coveredUserTurns = 0;
    this.overview = "";
    this.fingerprint = null;
    this.pendingTokens = 0;
    this.lastSeenUserTurns = 0;
    this.syncedEntryCount = 0;
    this.pendingArchive = null;
    this.confirmedArchive = null;
    this.awaitingCommitDrain = false;
    this.lastMessages = [];
    this.committing = false;
    this.lastPersisted = "";
  }

  get enabled() {
    return this.config.takeoverEnabled;
  }

  get state() {
    return {
      schemaVersion: 2,
      coveredUserTurns: this.coveredUserTurns,
      overview: this.overview,
      fingerprint: this.fingerprint,
      pendingTokens: this.pendingTokens,
      lastSeenUserTurns: this.lastSeenUserTurns,
      syncedEntryCount: this.syncedEntryCount,
      pendingArchive: this.pendingArchive,
      confirmedArchive: this.confirmedArchive,
      awaitingCommitDrain: this.awaitingCommitDrain,
      committing: this.committing,
    };
  }

  restore(entries) {
    for (let i = (Array.isArray(entries) ? entries.length : 0) - 1; i >= 0; i--) {
      const entry = entries[i];
      const isTakeoverEntry =
        (entry?.type === "custom" && entry.customType === TAKEOVER_ENTRY_TYPE) ||
        entry?.customType === TAKEOVER_ENTRY_TYPE ||
        entry?.type === TAKEOVER_ENTRY_TYPE;
      const data = isTakeoverEntry ? entry.data : null;
      if (!data || typeof data !== "object") continue;

      this.pendingTokens = Math.max(0, Math.floor(Number(data.pendingTokens) || 0));
      this.lastSeenUserTurns = Math.max(0, Math.floor(Number(data.lastSeenUserTurns) || 0));
      this.syncedEntryCount = Math.max(0, Math.floor(Number(data.syncedEntryCount) || 0));
      if (Number(data.schemaVersion) === 2) {
        this.coveredUserTurns = Math.max(0, Math.floor(Number(data.coveredUserTurns) || 0));
        this.overview = typeof data.overview === "string" ? data.overview : "";
        this.fingerprint = typeof data.fingerprint === "string" ? data.fingerprint : null;
        this.pendingArchive = normalizePendingArchive(data.pendingArchive);
        this.confirmedArchive = normalizeArchiveIdentity(data.confirmedArchive);
        this.awaitingCommitDrain = data.awaitingCommitDrain === true;
        if (this.coveredUserTurns > 0 && (!this.confirmedArchive || !this.overview || !this.fingerprint)) {
          this.coveredUserTurns = 0;
          this.overview = "";
          this.fingerprint = null;
        }
      } else {
        this.coveredUserTurns = 0;
        this.overview = "";
        this.fingerprint = null;
        this.pendingArchive = null;
        this.confirmedArchive = null;
        this.awaitingCommitDrain = true;
      }
      this.lastPersisted = JSON.stringify(this.persistedState());
      this.log(`takeover: restored boundary at ${this.coveredUserTurns} user turns, ${this.pendingTokens} pending tokens`);
      return this.state;
    }
    return this.state;
  }

  transformContext(messages) {
    const list = Array.isArray(messages) ? messages : [];
    this.lastMessages = list;
    const seenUserTurns = countUserTurns(list);
    this.lastSeenUserTurns = seenUserTurns;

    if (!this.enabled) return list;
    if (this.coveredUserTurns <= 0 || !this.overview) return list;

    const boundaryIdx = findBoundaryIndex(list, this.coveredUserTurns);
    if (boundaryIdx <= 0) {
      this.resetBoundary("history shorter than boundary");
      return list;
    }

    const lastCovered = list[boundaryIdx - 1];
    const fp = fingerprintMessage(lastCovered);
    if (this.fingerprint === null) {
      this.fingerprint = fp;
    } else if (this.fingerprint !== fp) {
      this.resetBoundary("fingerprint mismatch");
      return list;
    }

    const kept = list.slice(boundaryIdx);
    const firstKeptTs = typeof kept[0]?.timestamp === "number" ? kept[0].timestamp : 1;
    return [
      buildOverviewMessage(this.overview, firstKeptTs, this.config.takeoverOverviewBudget),
      ...kept,
    ];
  }

  async onTurnSynced(estTokens) {
    if (!this.enabled) return false;
    const addedTokens = Math.max(0, Math.floor(Number(estTokens) || 0));
    this.pendingTokens += addedTokens;
    if (this.pendingArchive) {
      this.persist();
      return this.commitAndAdvance();
    }
    if (this.pendingTokens < this.config.takeoverTokenThreshold) return false;
    if (this.lastSeenUserTurns <= this.config.takeoverKeepRecentTurns) return false;
    return this.commitAndAdvance();
  }

  async waitForCommitDrain() {
    if (!this.awaitingCommitDrain) return true;
    const active = await this.io.hasActiveCommit();
    if (active) {
      this.log("takeover: waiting for unowned commit tasks to drain");
      return false;
    }
    this.awaitingCommitDrain = false;
    this.persist();
    return true;
  }

  async resumePending() {
    if (!this.pendingArchive) return false;
    return this.commitAndAdvance();
  }

  async commitAndAdvance() {
    if (!this.enabled || this.committing) return false;
    this.committing = true;
    try {
      if (this.pendingArchive) {
        const reconciled = await this.pollPendingArchive();
        return reconciled.status === "completed";
      }

      if (!(await this.waitForCommitDrain())) return false;

      const flushed = await this.io.flush();
      if (!flushed) {
        this.log("takeover: flush failed; commit postponed");
        return false;
      }

      const committed = await this.io.commit({
        queueOnFailure: false,
        keepRecentCount: 0,
        retentionMode: "turn_budget",
        keepRecentTurnCount: this.config.takeoverKeepRecentTurns,
        retainedMessageTokenBudget: this.config.takeoverRetainedTokenBudget,
        minRawTailSteps: 1,
      });
      if (!this.acceptCommit(committed, "advance")) {
        this.log("takeover: commit was not accepted with a stable archive identity");
        return false;
      }

      const reconciled = await this.pollPendingArchive();
      return reconciled.status === "completed";
    } finally {
      this.committing = false;
    }
  }

  async handleBeforeCompact(preparation = {}) {
    if (!this.enabled || this.committing) return undefined;
    if (!preparation.firstKeptEntryId) return undefined;

    this.committing = true;
    try {
      if (this.pendingArchive) {
        const pending = this.pendingArchive;
        const reconciled = await this.pollPendingArchive();
        if (reconciled.status === "pending") return undefined;
        if (
          reconciled.status === "completed" &&
          pending.purpose === "compact" &&
          Number(this.io.getWatermark()) <= pending.syncedEntryCount
        ) {
          return this.buildCompactionResult(preparation);
        }
      }
      if (!(await this.waitForCommitDrain())) return undefined;

      const flushed = await this.io.flush();
      if (!flushed) return undefined;

      const committed = await this.io.commit({ queueOnFailure: false, keepRecentCount: 0 });
      if (!this.acceptCommit(committed, "compact")) return undefined;

      const reconciled = await this.pollPendingArchive();
      if (reconciled.status !== "completed") return undefined;
      return this.buildCompactionResult(preparation);
    } finally {
      this.committing = false;
    }
  }

  buildCompactionResult(preparation) {
    this.resetBoundary("pi compaction absorbed boundary");
    this.persist();
    return {
      compaction: {
        summary: `${OVERVIEW_MARKER}\n${this.truncatedOverview()}`,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: Number(preparation.tokensBefore) || 0,
        details: { source: "openviking", archiveUri: this.confirmedArchive?.archiveUri },
      },
    };
  }

  onPiCompacted() {
    this.resetBoundary("pi compaction replaced local history");
    if (this.pendingArchive?.purpose === "advance") {
      this.pendingArchive = { ...this.pendingArchive, purpose: "archiveOnly" };
    }
    this.persist();
  }

  acceptCommit(committed, purpose) {
    if (committed?.status === "outcome_unknown") {
      this.awaitingCommitDrain = true;
      this.persist();
      this.log("takeover: commit outcome unknown; blocking new commits until active tasks drain");
      return false;
    }

    const archiveUri = typeof committed?.archive_uri === "string" ? committed.archive_uri.trim() : "";
    const archiveId = archiveIdFromUri(archiveUri);
    const taskId = typeof committed?.task_id === "string" ? committed.task_id.trim() : "";
    const identityPending = !archiveUri;
    if (
      committed?.status !== "accepted" ||
      committed?.archived !== true ||
      !taskId ||
      (!identityPending && !archiveId)
    ) {
      return false;
    }

    const targetCoveredUserTurns = purpose === "advance"
      ? Math.max(0, this.lastSeenUserTurns - this.config.takeoverKeepRecentTurns)
      : 0;
    const boundaryFingerprint = fingerprintAtBoundary(this.lastMessages, targetCoveredUserTurns);
    this.pendingArchive = {
      purpose,
      archiveUri,
      archiveId,
      taskId,
      acceptedTokens: this.pendingTokens,
      targetCoveredUserTurns,
      boundaryFingerprint,
      syncedEntryCount: Math.max(0, Math.floor(Number(this.io.getWatermark()) || 0)),
    };
    this.syncedEntryCount = this.pendingArchive.syncedEntryCount;
    this.persist();
    this.log(`takeover: commit accepted for ${archiveId}; waiting for its overview`);
    return true;
  }

  async pollPendingArchive() {
    const pending = this.pendingArchive;
    if (!pending) return { status: "none" };

    for (let i = 0; i < this.config.takeoverOverviewPollMax; i++) {
      let checked;
      try {
        checked = await this.io.checkArchive(pending);
      } catch (error) {
        this.log(`takeover: archive check failed (${error instanceof Error ? error.message : String(error)})`);
        checked = { status: "pending" };
      }

      if (checked?.status === "failed") {
        this.pendingArchive = null;
        this.persist();
        this.log(`takeover: archive ${pending.archiveId} failed; boundary unchanged`);
        return { status: "failed" };
      }

      const overview = String(checked?.overview || "").trim();
      const checkedUri = typeof checked?.archiveUri === "string" ? checked.archiveUri.trim() : pending.archiveUri;
      const checkedId = typeof checked?.archiveId === "string" ? checked.archiveId : archiveIdFromUri(checkedUri);
      if (checked?.status === "ready" && overview && checkedUri && checkedId) {
        const current = this.pendingArchive;
        if (!current || current.taskId !== pending.taskId) return { status: "pending" };
        if (
          (current.archiveUri && checkedUri !== current.archiveUri) ||
          (current.archiveId && checkedId !== current.archiveId)
        ) {
          this.pendingArchive = null;
          this.persist();
          this.log(`takeover: archive identity mismatch for ${current.archiveId || current.taskId}`);
          return { status: "failed" };
        }
        if (!current.archiveUri) {
          this.pendingArchive = { ...current, archiveUri: checkedUri, archiveId: checkedId };
          this.persist();
        }
        return this.finalizePendingArchive(this.pendingArchive, overview);
      }

      if (i < this.config.takeoverOverviewPollMax - 1 && this.config.takeoverOverviewPollMs > 0) {
        await this.io.sleep(this.config.takeoverOverviewPollMs);
      }
    }

    this.log(`takeover: archive ${pending.archiveId} is not ready; boundary unchanged`);
    return { status: "pending" };
  }

  finalizePendingArchive(pending, overview) {
    const current = this.pendingArchive;
    if (!current || current.archiveUri !== pending.archiveUri || current.taskId !== pending.taskId) {
      return { status: "pending" };
    }
    pending = current;

    this.overview = overview;
    this.confirmedArchive = {
      archiveUri: pending.archiveUri,
      archiveId: pending.archiveId,
      taskId: pending.taskId,
    };
    this.pendingArchive = null;
    this.pendingTokens = Math.max(0, this.pendingTokens - pending.acceptedTokens);
    this.syncedEntryCount = Math.max(
      pending.syncedEntryCount,
      Math.max(0, Math.floor(Number(this.io.getWatermark()) || 0)),
    );

    if (
      pending.purpose === "advance" &&
      pending.targetCoveredUserTurns > this.coveredUserTurns &&
      (pending.targetCoveredUserTurns === 0 || pending.boundaryFingerprint)
    ) {
      this.coveredUserTurns = pending.targetCoveredUserTurns;
      this.fingerprint = pending.boundaryFingerprint;
    }
    this.persist();
    this.log(`takeover: confirmed ${pending.archiveId}; boundary is ${this.coveredUserTurns} user turns`);
    return { status: "completed", overview, purpose: pending.purpose };
  }


  async shutdown() {
    if (!this.enabled) return;
    this.syncedEntryCount = Math.max(0, Math.floor(Number(this.io.getWatermark()) || 0));
    this.persist();
  }

  resetBoundary(reason = "reset") {
    if (this.coveredUserTurns !== 0 || this.fingerprint !== null) {
      this.log(`takeover: boundary reset (${reason})`);
    }
    this.coveredUserTurns = 0;
    this.fingerprint = null;
  }

  truncatedOverview() {
    const raw = String(this.overview || "");
    const truncated = truncateToTokens(raw, this.config.takeoverOverviewBudget);
    return truncated === raw ? raw : `${truncated}\n...(truncated)`;
  }

  persistedState() {
    const rawWatermark = Number(this.io.getWatermark());
    const watermark = Number.isFinite(rawWatermark)
      ? Math.max(0, Math.floor(rawWatermark))
      : this.syncedEntryCount;
    return {
      schemaVersion: 2,
      coveredUserTurns: this.coveredUserTurns,
      overview: truncateToTokens(this.overview, this.config.takeoverOverviewBudget),
      fingerprint: this.fingerprint,
      pendingTokens: this.pendingTokens,
      lastSeenUserTurns: this.lastSeenUserTurns,
      syncedEntryCount: watermark,
      pendingArchive: this.pendingArchive,
      confirmedArchive: this.confirmedArchive,
      awaitingCommitDrain: this.awaitingCommitDrain,
    };
  }

  persist() {
    try {
      const state = this.persistedState();
      const key = JSON.stringify(state);
      if (key === this.lastPersisted) return;
      this.io.persistEntry(TAKEOVER_ENTRY_TYPE, state);
      this.lastPersisted = key;
    } catch {
      // Best effort. A missed state entry only means the next process sees full history.
    }
  }


  log(message) {
    try {
      this.io.log(message);
    } catch {
      // Logging must not affect pi's context path.
    }
  }
}
