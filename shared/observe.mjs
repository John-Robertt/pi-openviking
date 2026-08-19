import { createHash, randomUUID } from "node:crypto";
import {
  close as closeFd,
  fstatSync,
  openSync,
  write as writeFd,
  writeSync,
} from "node:fs";

import { canonicalJsonBytes } from "./canonical-json.mjs";

export const OBSERVATION_SCHEMA_VERSION = 1;
export const OBSERVATION_SESSION_DOMAIN = "pi-openviking/observation-session";
export const OBSERVATION_QUEUE_CAPACITY = 1024;

const ENUM = (values) => ({ type: "string", enum: values });
const STRING = (maxLength, pattern) => ({ type: "string", maxLength, ...(pattern ? { pattern } : {}) });
const INTEGER = (min = 0, max = Number.MAX_SAFE_INTEGER) => ({ type: "integer", min, max });
const NUMBER = (min = 0) => ({ type: "number", min });
const BOOLEAN = Object.freeze({ type: "boolean" });
const NULLABLE_HASH = { type: "string", nullable: true, pattern: "^[0-9a-f]{64}$", maxLength: 64 };
const HASH = STRING(64, "^[0-9a-f]{64}$");
const PHASE_BEGIN = ENUM(["begin"]);
const PHASE_END = ENUM(["end"]);
const MODE_SNAPSHOT = ENUM(["snapshot"]);
const MODE_CHANGE = ENUM(["change"]);

const schema = (required, optional = {}) => ({ required, optional });
const variants = (field, choices) => ({ variantField: field, variants: choices });
const stage = (owner, kind, data) => ({ owner, kind, data });

const HOOKS = [
  "session_start",
  "before_agent_start",
  "context",
  "tool_call",
  "turn_end",
  "session_compact",
  "session_tree",
  "session_info_changed",
  "model_select",
  "thinking_level_select",
  "session_shutdown",
  "agent_end",
];
const HOOK_REASONS = ["startup", "reload", "new", "resume", "fork", "quit", "manual", "threshold", "overflow", "none"];
const SYNC_TRIGGERS = [
  "session_start",
  "turn_end",
  "session_compact",
  "session_tree",
  "session_info_changed",
  "model_select",
  "thinking_level_select",
  "session_shutdown",
  "command",
];
const HTTP_ROUTES = [
  "/health",
  "/api/v1/content/abstract",
  "/api/v1/content/batch-write",
  "/api/v1/content/download",
  "/api/v1/content/overview",
  "/api/v1/content/read",
  "/api/v1/fs",
  "/api/v1/fs/ls",
  "/api/v1/fs/mkdir",
  "/api/v1/fs/stat",
  "/api/v1/resources",
  "/api/v1/search/find",
  "/api/v1/search/recall",
  "/api/v1/search/search",
  "/api/v1/sessions",
  "/api/v1/sessions/{id}/commit",
  "/api/v1/sessions/{id}/messages",
  "/api/v1/system/status",
  "other",
];
const TOOLS = [
  "viking_search",
  "viking_read",
  "viking_browse",
  "viking_remember",
  "viking_forget",
  "viking_add_resource",
  "viking_archive_expand",
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "other",
];
const ERROR_CLASSES = ["aborted", "filesystem", "http", "integrity", "protocol", "source", "timeout", "transport", "other"];
const FILESYSTEM_ERROR_CODES = new Set([
  "EACCES", "EBADF", "EEXIST", "EFBIG", "EIO", "EISDIR", "ELOOP", "EMFILE", "ENAMETOOLONG",
  "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS", "EXDEV",
]);
const TIMEOUT_ERROR_CODES = new Set([
  "ETIMEDOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
]);
const DISPOSITIONS = ["degrade", "retry", "ignore", "abort_operation"];
const FAILURE_BASE = {
  errorClass: ENUM(ERROR_CLASSES),
  errorCode: STRING(64, "^[a-z0-9_]+$"),
  disposition: ENUM(DISPOSITIONS),
  messageBytes: INTEGER(),
};
const FAILURE_OPTIONAL = { status: INTEGER(0, 599) };

export const OBSERVATION_STAGE_REGISTRY = deepFreeze({
  observe_run_start: stage("shared/observe.mjs", "state", schema({
    mode: MODE_SNAPSHOT,
    status: ENUM(["ready"]),
  })),
  observe_run_end: stage("shared/observe.mjs", "state", schema({
    mode: MODE_SNAPSHOT,
    status: ENUM(["ready"]),
    accepted: INTEGER(),
    dropped: INTEGER(),
  })),
  pi_lifecycle: stage("index.ts", "boundary", variants("phase", {
    begin: schema({ phase: PHASE_BEGIN, hook: ENUM(HOOKS), reason: ENUM(HOOK_REASONS) }),
    end: schema({
      phase: PHASE_END,
      hook: ENUM(HOOKS),
      reason: ENUM(HOOK_REASONS),
      outcome: ENUM(["success", "skipped", "error"]),
      durationMs: NUMBER(),
    }),
  })),
  pi_entry_append: stage("index.ts", "boundary", variants("phase", {
    begin: schema({
      phase: PHASE_BEGIN,
      operation: ENUM(["profile_injection", "recall_injection"]),
      entryType: ENUM(["ov-observation"]),
    }),
    end: schema({
      phase: PHASE_END,
      operation: ENUM(["profile_injection", "recall_injection"]),
      entryType: ENUM(["ov-observation"]),
      outcome: ENUM(["appended", "error"]),
      durationMs: NUMBER(),
    }),
  })),
  memory_namespace: stage("index.ts", "decision", schema({
    sessionScoped: BOOLEAN,
    configuredUser: BOOLEAN,
    branch: ENUM(["session", "shared_configured", "shared_resolved"]),
  })),
  sync_schedule: stage("index.ts", "decision", schema({
    trigger: ENUM(SYNC_TRIGGERS),
    connected: BOOLEAN,
    branch: ENUM(["sync", "observe", "skip_bypassed", "skip_disabled"]),
  })),
  profile_result: stage("index.ts", "decision", schema({
    branch: ENUM(["inject", "omit"]),
    chars: INTEGER(),
  })),
  index_failure: stage("index.ts", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["health_refresh", "observation_append", "profile_load", "sync_schedule"]),
    branch: ENUM(["continue_pi", "omit_profile"]),
  }, FAILURE_OPTIONAL)),
  tool_uri_guard: stage("lib/uri-guard-adapter.mjs", "decision", schema({
    tool: ENUM(TOOLS),
    branch: ENUM(["block"]),
  })),
  client_http: stage("client.ts", "boundary", variants("phase", {
    begin: schema({
      phase: PHASE_BEGIN,
      method: ENUM(["GET", "POST", "PUT", "DELETE", "PATCH"]),
      route: ENUM(HTTP_ROUTES),
      timeoutMs: INTEGER(0),
    }),
    end: schema({
      phase: PHASE_END,
      outcome: ENUM(["success", "http_error", "network_error", "aborted"]),
      durationMs: NUMBER(),
    }, {
      status: INTEGER(0, 599),
      traceId: STRING(128, "^[A-Za-z0-9._:-]+$"),
    }),
  })),
  client_connection: stage("client.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: BOOLEAN }),
    change: schema({ mode: MODE_CHANGE, from: BOOLEAN, to: BOOLEAN }),
  })),
  client_namespace: stage("client.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: NULLABLE_HASH, bound: BOOLEAN }),
    change: schema({ mode: MODE_CHANGE, from: NULLABLE_HASH, to: NULLABLE_HASH, bound: BOOLEAN }),
  })),
  sync_source: stage("sync.ts", "decision", schema({
    branch: ENUM(["persistent_jsonl", "in_memory"]),
    entries: INTEGER(),
  })),
  shutdown_grace: stage("sync.ts", "decision", schema({
    timeoutMs: INTEGER(),
    branch: ENUM(["drained", "deadline"]),
  })),
  sync_capability: stage("sync.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: ENUM(["unknown", "ready", "mismatch"]) }),
    change: schema({ mode: MODE_CHANGE, from: ENUM(["unknown", "ready", "mismatch"]), to: ENUM(["unknown", "ready", "mismatch"]) }),
  })),
  sync_ack: stage("sync.ts", "state", variants("mode", {
    snapshot: schema({ mode: MODE_SNAPSHOT, current: HASH, count: INTEGER(), pending: INTEGER() }),
    change: schema({
      mode: MODE_CHANGE,
      from: HASH,
      to: HASH,
      fromCount: INTEGER(),
      toCount: INTEGER(),
      fromPending: INTEGER(),
      toPending: INTEGER(),
    }),
  })),
  sync_ack_advance: stage("sync.ts", "decision", schema({
    projected: INTEGER(),
    accepted: INTEGER(),
    capabilityVerified: BOOLEAN,
    branch: ENUM(["advance"]),
  })),
  sync_failure: stage("sync.ts", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["ack_persist", "ack_read", "capability", "delivery", "not_initialized", "projection", "source"]),
    branch: ENUM(["pending_replay", "replay_all"]),
    added: INTEGER(),
    pending: INTEGER(),
  }, FAILURE_OPTIONAL)),
  event_representation: stage("shared/recorded-event-adapter.mjs", "decision", schema({
    direct: INTEGER(),
    chunked: INTEGER(),
    branch: ENUM(["direct", "chunked", "mixed", "empty"]),
  })),
  recall_request: stage("recall.ts", "decision", schema({
    queryChars: INTEGER(),
    branch: ENUM(["cache", "skip_short", "search"]),
  })),
  recall_source: stage("shared/recall-core.mjs", "decision", schema({
    branch: ENUM(["context_face", "legacy_endpoint", "raw_find"]),
    resultCount: INTEGER(),
  })),
  recall_result: stage("recall.ts", "decision", schema({
    operation: ENUM(["search", "inject"]),
    branch: ENUM(["available", "empty", "injected", "unchanged"]),
    chars: INTEGER(),
  })),
  recall_failure: stage("shared/recall-core.mjs", "failure", schema({
    ...FAILURE_BASE,
    errorCode: ENUM(["context_error", "context_unsupported", "endpoint_error", "peer_scope_unsupported"]),
    branch: ENUM(["legacy_endpoint", "raw_find", "same_without_peer"]),
  }, FAILURE_OPTIONAL)),
  tool_availability: stage("tools.ts", "decision", schema({
    tool: ENUM(TOOLS),
    connected: BOOLEAN,
    branch: ENUM(["proceed", "unavailable"]),
  })),
  tool_scope: stage("tools.ts", "decision", schema({
    tool: ENUM(TOOLS),
    operation: ENUM(["archive", "browse", "delete", "read", "search_request", "search_result"]),
    scoped: BOOLEAN,
    branch: ENUM(["allow", "deny", "clamp", "filter"]),
    accepted: INTEGER(),
    rejected: INTEGER(),
  })),
});

const ENCODERS = Object.freeze({
  observe_run_start: () => ({ mode: "snapshot", status: "ready" }),
  observe_run_end: (accepted, dropped) => ({ mode: "snapshot", status: "ready", accepted, dropped }),
  pi_lifecycle: {
    begin: (hook, reason = "none") => ({ phase: "begin", hook, reason: normalizeHookReason(reason) }),
    end: (hook, reason = "none", outcome = "success", durationMs = 0) => ({
      phase: "end", hook, reason: normalizeHookReason(reason), outcome, durationMs,
    }),
  },
  pi_entry_append: {
    begin: (kind) => ({
      phase: "begin",
      operation: kind === "profile-injection" ? "profile_injection" : "recall_injection",
      entryType: "ov-observation",
    }),
    end: (kind, outcome, durationMs) => ({
      phase: "end",
      operation: kind === "profile-injection" ? "profile_injection" : "recall_injection",
      entryType: "ov-observation",
      outcome,
      durationMs,
    }),
  },
  memory_namespace: (sessionScoped, configuredUser) => ({
    sessionScoped: Boolean(sessionScoped),
    configuredUser: Boolean(configuredUser),
    branch: sessionScoped ? "session" : configuredUser ? "shared_configured" : "shared_resolved",
  }),
  sync_schedule: (trigger, connected, branch) => ({
    trigger,
    connected: Boolean(connected),
    branch: branch ?? (connected ? "sync" : "observe"),
  }),
  profile_result: (value) => ({ branch: value ? "inject" : "omit", chars: safeLength(value) }),
  index_failure: (error, errorCode, disposition, branch) => failureData(error, errorCode, disposition, branch),
  tool_uri_guard: (tool) => ({ tool: normalizeTool(tool), branch: "block" }),
  client_http: {
    begin: (path, method = "GET", timeoutMs = 0) => ({
      phase: "begin",
      method: normalizeMethod(method),
      route: routeTemplate(path),
      timeoutMs: safeInteger(timeoutMs),
    }),
    end: (outcome, status, traceId, durationMs) => ({
      phase: "end",
      outcome,
      durationMs,
      ...(Number.isInteger(status) && status >= 0 && status <= 599 ? { status } : {}),
      ...(validTraceId(traceId) ? { traceId } : {}),
    }),
  },
  client_connection: (mode, from, to) => mode === "snapshot"
    ? { mode, current: Boolean(from) }
    : { mode, from: Boolean(from), to: Boolean(to) },
  client_namespace: (mode, from, to) => mode === "snapshot"
    ? { mode, current: namespaceHash(from), bound: Boolean(from) }
    : { mode, from: namespaceHash(from), to: namespaceHash(to), bound: Boolean(to) },
  sync_source: (branch, entries) => ({ branch, entries: safeInteger(entries) }),
  shutdown_grace: (timeoutMs, drained) => ({ timeoutMs: safeInteger(timeoutMs), branch: drained ? "drained" : "deadline" }),
  sync_capability: (mode, from, to) => mode === "snapshot"
    ? { mode, current: from }
    : { mode, from, to },
  sync_ack: (mode, from, to, fromPending, toPending) => mode === "snapshot"
    ? { mode, current: ackHash(from), count: leafCount(from), pending: safeInteger(fromPending) }
    : {
        mode,
        from: ackHash(from),
        to: ackHash(to),
        fromCount: leafCount(from),
        toCount: leafCount(to),
        fromPending: safeInteger(fromPending),
        toPending: safeInteger(toPending),
      },
  sync_ack_advance: (projected, accepted, capabilityVerified) => ({
    projected: safeInteger(projected),
    accepted: safeInteger(accepted),
    capabilityVerified: Boolean(capabilityVerified),
    branch: "advance",
  }),
  sync_failure: (error, errorCode, disposition, branch, added, pending) => ({
    ...failureData(error, errorCode, disposition, branch),
    added: safeInteger(added),
    pending: safeInteger(pending),
  }),
  event_representation: (direct, chunked) => {
    const directCount = safeInteger(direct?.length);
    const chunkedCount = safeInteger(chunked?.length);
    const branch = directCount > 0 && chunkedCount > 0 ? "mixed"
      : directCount > 0 ? "direct"
        : chunkedCount > 0 ? "chunked"
          : "empty";
    return { direct: directCount, chunked: chunkedCount, branch };
  },
  recall_request: (branch, query) => ({ branch, queryChars: safeLength(query) }),
  recall_source: (branch, resultCount) => ({ branch, resultCount: safeInteger(resultCount) }),
  recall_result: (operation, state, value) => ({
    operation,
    branch: operation === "search"
      ? state ? "available" : "empty"
      : state ? "injected" : "unchanged",
    chars: safeLength(operation === "search" ? state : value),
  }),
  recall_failure: (error, errorCode, disposition, branch, status) => ({
    ...failureData(error ?? (Number.isInteger(status) ? { status } : null), errorCode, disposition, branch),
  }),
  tool_availability: (tool, connected) => ({
    tool: normalizeTool(tool),
    connected: Boolean(connected),
    branch: connected ? "proceed" : "unavailable",
  }),
  tool_scope: (tool, operation, scoped, branch, accepted = 0, rejected = 0) => ({
    tool: normalizeTool(tool),
    operation,
    scoped: Boolean(scoped),
    branch,
    accepted: safeInteger(accepted),
    rejected: safeInteger(rejected),
  }),
});

const DISABLED_STATUS = Object.freeze({
  state: "disabled",
  reason: "not_requested",
  run: null,
  accepted: 0,
  dropped: 0,
});

const DISABLED_OBSERVATION = Object.freeze({
  emit() {},
  begin() { return 0; },
  end() {},
  bindSession() {},
  abandon() {},
  getStatus() { return DISABLED_STATUS; },
  beginDrainDeadline() { return 0; },
  finishRemaining() { return Promise.resolve(); },
  finish() { return Promise.resolve(); },
});

function incompleteObservation(reason) {
  const status = Object.freeze({ state: "incomplete", reason, run: null, accepted: 0, dropped: 0 });
  return Object.freeze({
    emit() {},
    begin() { return 0; },
    end() {},
    bindSession() {},
    abandon() {},
    getStatus() { return status; },
    beginDrainDeadline() { return 0; },
    finishRemaining() { return Promise.resolve(); },
    finish() { return Promise.resolve(); },
  });
}

export function createObservation(options = {}) {
  const env = options.env ?? process.env;
  const pathConfigured = Object.prototype.hasOwnProperty.call(env, "OV_OBSERVE");
  const fdConfigured = Object.prototype.hasOwnProperty.call(env, "OV_OBSERVE_FD");
  if (!pathConfigured && !fdConfigured) return DISABLED_OBSERVATION;
  if (pathConfigured && fdConfigured) return incompleteObservation("env_conflict");

  const deps = dependencies(options.dependencies);
  let fd;
  try {
    if (pathConfigured) {
      const path = String(env.OV_OBSERVE ?? "");
      if (!path) return incompleteObservation("invalid_path");
      fd = deps.open(path, "wx", 0o600);
      const stat = deps.fstat(fd);
      if (!validPrivateFile(stat, deps.uid())) {
        safeCloseSync(fd, deps);
        return incompleteObservation("invalid_path");
      }
    } else {
      const raw = String(env.OV_OBSERVE_FD ?? "");
      if (!/^[0-9]+$/.test(raw)) return incompleteObservation("invalid_fd");
      fd = Number(raw);
      if (!Number.isSafeInteger(fd) || fd < 3) return incompleteObservation("invalid_fd");
      const stat = deps.fstat(fd);
      if (!validPrivateFile(stat, deps.uid())) return incompleteObservation("invalid_fd");
      deps.probeWritable(fd);
    }
  } catch {
    if (pathConfigured && fd !== undefined) safeCloseSync(fd, deps);
    return incompleteObservation(pathConfigured ? "open_failed" : "invalid_fd");
  }

  try {
    return new ObservationRuntime(fd, deps, {
      autoFinalize: options.autoFinalize !== false,
      queueCapacity: options.queueCapacity ?? OBSERVATION_QUEUE_CAPACITY,
    });
  } catch {
    safeCloseSync(fd, deps);
    return incompleteObservation("initialization_failed");
  }
}

class ObservationRuntime {
  constructor(fd, deps, { autoFinalize, queueCapacity }) {
    this.fd = fd;
    this.deps = deps;
    this.capacity = Math.max(1, safeInteger(queueCapacity));
    this.run = deps.uuid();
    this.session = null;
    this.seq = 0;
    this.nextOp = 1;
    this.accepted = 0;
    this.dropped = 0;
    this.state = "ready";
    this.reason = "ready";
    this.sinkWritable = true;
    this.queue = [];
    this.writing = false;
    this.openOperations = new Map();
    this.waiters = [];
    this.finishPromise = null;
    this.closed = false;
    this.#enqueue("state", "observe_run_start", ENCODERS.observe_run_start());
    if (autoFinalize) {
      this.beforeExit = () => { void this.finish(); };
      process.once("beforeExit", this.beforeExit);
    }
  }

  emit(stageName, ...values) {
    if (this.closed) return;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return;
    }
    const descriptor = OBSERVATION_STAGE_REGISTRY[stageName];
    const encoder = ENCODERS[stageName];
    if (!descriptor || descriptor.kind === "boundary" || typeof encoder !== "function") {
      this.reject("schema_rejected");
      return;
    }
    try {
      this.#enqueue(descriptor.kind, stageName, encoder(...values));
    } catch {
      this.reject("schema_rejected");
    }
  }

  begin(stageName, ...values) {
    if (this.closed) return 0;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return 0;
    }
    const descriptor = OBSERVATION_STAGE_REGISTRY[stageName];
    const encoder = ENCODERS[stageName];
    if (!descriptor || descriptor.kind !== "boundary" || typeof encoder?.begin !== "function") {
      this.reject("schema_rejected");
      return 0;
    }
    try {
      const op = this.nextOp++;
      const started = this.deps.monotonicNow();
      const session = this.session;
      const data = encoder.begin(...values);
      if (!this.#enqueue("boundary", stageName, data, { op, session })) return 0;
      this.openOperations.set(op, { stageName, started, session, values });
      return op;
    } catch {
      this.reject("schema_rejected");
      return 0;
    }
  }

  end(stageName, op, ...values) {
    if (!op) return;
    if (this.closed) return;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return;
    }
    const opened = this.openOperations.get(op);
    const encoder = ENCODERS[stageName];
    if (!opened || opened.stageName !== stageName || typeof encoder?.end !== "function") {
      this.reject("operation_mismatch");
      return;
    }
    this.openOperations.delete(op);
    try {
      const durationMs = Math.max(0, this.deps.monotonicNow() - opened.started);
      const data = encoder.end(...values, durationMs);
      this.#enqueue("boundary", stageName, data, { op, session: opened.session });
    } catch {
      this.reject("schema_rejected");
    }
  }

  #enqueue(kind, stageName, data, relation = {}) {
    if (this.closed) return false;
    if (this.state !== "ready") {
      if (this.run) this.dropped++;
      return false;
    }
    if (this.pendingCount() >= this.capacity) {
      this.reject("queue_full");
      return false;
    }
    const candidate = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      ts: new Date(this.deps.wallNow()).toISOString(),
      run: this.run,
      seq: this.seq + 1,
      session: Object.prototype.hasOwnProperty.call(relation, "session") ? relation.session : this.session,
      kind,
      stage: stageName,
      ...(relation.op ? { op: relation.op } : {}),
      data,
    };
    const checked = validateObservationRecord(candidate);
    if (!checked.ok) {
      this.reject("schema_rejected");
      return false;
    }
    let bytes;
    try {
      bytes = Buffer.concat([canonicalJsonBytes(candidate), Buffer.from("\n")]);
    } catch {
      this.reject("serialization_failed");
      return false;
    }
    this.seq++;
    this.accepted++;
    this.queue.push(bytes);
    this.pump();
    return true;
  }

  bindSession(piSessionId) {
    if (this.state !== "ready" || this.closed) return;
    if (piSessionId === null || piSessionId === undefined || piSessionId === "") {
      this.session = null;
      return;
    }
    try {
      this.session = this.deps.sessionHash(String(piSessionId));
    } catch {
      this.reject("session_hash_failed");
    }
  }

  abandon() {
    if (this.state === "ready" && !this.closed) this.markIncomplete("producer_deadline");
  }

  getStatus() {
    return Object.freeze({
      state: this.state,
      reason: this.reason,
      run: this.run,
      accepted: this.accepted,
      dropped: this.dropped,
    });
  }

  #flush() {
    if (!this.writing && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  beginDrainDeadline(timeoutMs) {
    if (this.state !== "ready" || this.closed) return 0;
    return this.deps.monotonicNow() + Math.max(0, safeInteger(timeoutMs));
  }

  finishRemaining(deadline) {
    const absoluteDeadline = Number.isFinite(deadline) && deadline > 0
      ? deadline
      : this.deps.monotonicNow();
    return this.finish({ deadline: absoluteDeadline });
  }

  finish(budget) {
    if (this.finishPromise) return this.finishPromise;
    if (this.beforeExit) {
      process.removeListener("beforeExit", this.beforeExit);
      this.beforeExit = null;
    }
    this.finishPromise = this.finishNow(budget);
    return this.finishPromise;
  }

  async finishNow(budget) {
    const deadline = Number.isFinite(budget?.deadline)
      ? budget.deadline
      : Number.isFinite(budget) && budget >= 0
        ? this.deps.monotonicNow() + budget
        : null;
    if (this.state === "ready" && this.openOperations.size > 0) {
      this.markIncomplete("operation_unfinished");
    } else if (this.state === "ready" && !this.closed) {
      this.#enqueue("state", "observe_run_end", ENCODERS.observe_run_end(this.accepted, this.dropped));
    }
    const flushed = await this.#waitUntil(this.#flush(), deadline);
    if (!flushed || this.writing || this.queue.length > 0) this.markIncomplete("flush_timeout", false);
    const closed = await this.#waitUntil(this.#closeSink(), deadline);
    if (!closed) this.markIncomplete("close_timeout", false);
  }

  async #waitUntil(promise, deadline) {
    if (deadline === null) {
      await promise;
      return true;
    }
    const remaining = Math.max(0, deadline - this.deps.monotonicNow());
    if (remaining === 0) return false;
    let timer;
    const completed = await Promise.race([
      promise.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
    ]);
    if (timer) clearTimeout(timer);
    return completed;
  }

  pendingCount() {
    return this.queue.length + (this.writing ? 1 : 0);
  }

  pump() {
    if (this.writing || !this.sinkWritable || this.queue.length === 0) {
      this.resolveWaitersIfIdle();
      return;
    }
    const bytes = this.queue.shift();
    this.writing = true;
    this.deps.write(this.fd, bytes, (error, written) => {
      this.writing = false;
      if (error) {
        this.markIncomplete("write_failed", false);
        return;
      }
      if (written !== bytes.length) {
        this.markIncomplete("partial_write", false);
        return;
      }
      this.pump();
    });
  }

  reject(reason) {
    this.dropped++;
    this.markIncomplete(reason);
  }

  markIncomplete(reason, sinkUsable = true) {
    if (this.state !== "incomplete") {
      this.state = "incomplete";
      this.reason = reason;
    }
    if (!sinkUsable) {
      this.sinkWritable = false;
      this.queue.length = 0;
    } else {
      this.pump();
    }
    this.resolveWaitersIfIdle();
  }

  resolveWaitersIfIdle() {
    if (this.writing || this.queue.length > 0) return;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  #closeSink() {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve) => {
      try {
        this.deps.close(this.fd, (error) => {
          if (error) this.markIncomplete("close_failed");
          resolve();
        });
      } catch {
        this.markIncomplete("close_failed");
        resolve();
      }
    });
  }
}

export function validateObservationRecord(record) {
  try {
    if (!plainObject(record)) return invalid("record_type");
    const top = new Set(["schemaVersion", "ts", "run", "seq", "session", "kind", "stage", "op", "data"]);
    if (Object.keys(record).some((key) => !top.has(key))) return invalid("unknown_top_field");
    if (record.schemaVersion !== OBSERVATION_SCHEMA_VERSION) return invalid("schema_version");
    if (typeof record.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.ts)) return invalid("timestamp");
    if (typeof record.run !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.run)) return invalid("run");
    if (!Number.isSafeInteger(record.seq) || record.seq < 1) return invalid("seq");
    if (record.session !== null && (typeof record.session !== "string" || !/^[0-9a-f]{64}$/.test(record.session))) return invalid("session");
    const descriptor = OBSERVATION_STAGE_REGISTRY[record.stage];
    if (!descriptor || record.kind !== descriptor.kind) return invalid("stage_kind");
    if (record.kind === "boundary") {
      if (!Number.isSafeInteger(record.op) || record.op < 1) return invalid("op");
    } else if (record.op !== undefined && (!Number.isSafeInteger(record.op) || record.op < 1)) {
      return invalid("op");
    }
    const selected = selectSchema(descriptor.data, record.data);
    if (!selected) return invalid("data_variant");
    return validateData(selected, record.data);
  } catch {
    return invalid("validation_error");
  }
}

function validateData(definition, data) {
  if (!plainObject(data)) return invalid("data_type");
  const required = definition.required || {};
  const optional = definition.optional || {};
  const allowed = new Set([...Object.keys(required), ...Object.keys(optional)]);
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) return invalid("unknown_data_field");
  }
  for (const [key, rule] of Object.entries(required)) {
    if (!Object.prototype.hasOwnProperty.call(data, key) || !validValue(data[key], rule)) return invalid("required_data_field");
  }
  for (const [key, rule] of Object.entries(optional)) {
    if (Object.prototype.hasOwnProperty.call(data, key) && !validValue(data[key], rule)) return invalid("optional_data_field");
  }
  return { ok: true, reason: null };
}

function validValue(value, rule) {
  if (value === null) return rule.nullable === true;
  if (rule.type === "boolean") return typeof value === "boolean";
  if (rule.type === "integer") return Number.isSafeInteger(value) && value >= rule.min && value <= rule.max;
  if (rule.type === "number") return typeof value === "number" && Number.isFinite(value) && value >= rule.min;
  if (rule.type !== "string" || typeof value !== "string") return false;
  if (rule.maxLength !== undefined && value.length > rule.maxLength) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  return !rule.pattern || new RegExp(rule.pattern).test(value);
}

function selectSchema(definition, data) {
  if (!definition.variantField) return definition;
  if (!plainObject(data)) return null;
  return definition.variants[data[definition.variantField]] || null;
}

function dependencies(overrides = {}) {
  return {
    open: overrides.open ?? openSync,
    fstat: overrides.fstat ?? fstatSync,
    probeWritable: overrides.probeWritable ?? ((fd) => { writeSync(fd, Buffer.alloc(0)); }),
    write: overrides.write ?? ((fd, bytes, callback) => writeFd(fd, bytes, 0, bytes.length, null, callback)),
    close: overrides.close ?? closeFd,
    closeSync: overrides.closeSync,
    uuid: overrides.uuid ?? randomUUID,
    wallNow: overrides.wallNow ?? Date.now,
    monotonicNow: overrides.monotonicNow ?? (() => Number(process.hrtime.bigint()) / 1_000_000),
    uid: overrides.uid ?? (() => typeof process.getuid === "function" ? process.getuid() : null),
    sessionHash: overrides.sessionHash ?? observationSessionHash,
  };
}

export function observationSessionHash(piSessionId) {
  return createHash("sha256")
    .update(canonicalJsonBytes([OBSERVATION_SESSION_DOMAIN, 1, String(piSessionId)]))
    .digest("hex");
}

function namespaceHash(value) {
  if (!value) return null;
  return createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/observation-namespace", 1, String(value)]))
    .digest("hex");
}

function ackHash(value) {
  const leaves = Array.isArray(value?.acknowledgedLeaves) ? value.acknowledgedLeaves : [];
  return createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/observation-ack", 1, leaves]))
    .digest("hex");
}

function leafCount(value) {
  return Array.isArray(value?.acknowledgedLeaves) ? value.acknowledgedLeaves.length : 0;
}

function failureData(error, errorCode, disposition, branch) {
  const status = Number(error?.status || 0);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return {
    errorClass: classifyError(error, status),
    errorCode,
    disposition,
    branch,
    messageBytes: Buffer.byteLength(message),
    ...(Number.isInteger(status) && status > 0 && status <= 599 ? { status } : {}),
  };
}

function classifyError(error, status) {
  const name = String(error?.name || "").toLowerCase();
  const code = String(error?.code || "").toUpperCase();
  if (name.includes("abort") || code === "ABORT_ERR" || code === "UND_ERR_ABORTED") return "aborted";
  if (name.includes("timeout") || TIMEOUT_ERROR_CODES.has(code)) return "timeout";
  if (name.includes("conflict") || status === 409) return "integrity";
  if (status >= 400) return "http";
  if (name.includes("recordedeventsync")) return "protocol";
  if (name.includes("syntax") || name.includes("type")) return "source";
  if (FILESYSTEM_ERROR_CODES.has(code)) return "filesystem";
  if (error) return "transport";
  return "other";
}

function routeTemplate(path) {
  const raw = String(path || "");
  const pathname = raw.split("?", 1)[0] || "";
  if (/^\/api\/v1\/sessions\/[^/]+\/messages$/.test(pathname)) return "/api/v1/sessions/{id}/messages";
  if (/^\/api\/v1\/sessions\/[^/]+\/commit$/.test(pathname)) return "/api/v1/sessions/{id}/commit";
  return HTTP_ROUTES.includes(pathname) ? pathname : "other";
}

function normalizeMethod(value) {
  const method = String(value || "GET").toUpperCase();
  return ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method) ? method : "GET";
}

function normalizeHookReason(value) {
  const reason = String(value || "none");
  return HOOK_REASONS.includes(reason) ? reason : "none";
}

function normalizeTool(value) {
  const tool = String(value || "").trim().toLowerCase();
  return TOOLS.includes(tool) ? tool : "other";
}

function validTraceId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function safeInteger(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function safeLength(value) {
  return typeof value === "string" || Array.isArray(value) ? value.length : 0;
}

function validPrivateFile(stat, uid) {
  return Boolean(stat?.isFile?.()) && stat.size === 0 && (stat.mode & 0o077) === 0 && (uid === null || stat.uid === uid);
}

function safeCloseSync(fd, deps) {
  try {
    if (typeof deps.closeSync === "function") deps.closeSync(fd);
    else closeFd(fd, () => {});
  } catch { /* observation setup failure is diagnostic-only */ }
}

function invalid(reason) {
  return { ok: false, reason };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const PROCESS_OBSERVATION = Symbol.for("pi-openviking.observation.v1");
export const observation = globalThis[PROCESS_OBSERVATION] ||= createObservation();
