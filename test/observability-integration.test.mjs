import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";

import { OVClient } from "../client.ts";
import { RecallManager } from "../recall.ts";
import { SyncManager } from "../sync.ts";
import { ActiveContextManager } from "../shared/active-context.mjs";
import { archiveManifestBytes, buildArchiveManifest, describeArchives, planArchives } from "../shared/archive.mjs";
import { ContentBusyError } from "../shared/content-objects.mjs";
import { ArchiveManager, archiveStorageLocation } from "../shared/archive-store.mjs";
import { buildCheckpointEvent, buildCheckpointRequestEvent, checkpointId } from "../shared/checkpoint.mjs";
import { OpenVikingCheckpointProcessor } from "../shared/checkpoint-processor.mjs";
import { CheckpointManager } from "../shared/checkpoint-store.mjs";
import { OBSERVATION_STAGE_REGISTRY, createObservation, validateObservationRecord } from "../shared/observe.mjs";
import { RecordedEventAdapter } from "../shared/recorded-event-adapter.mjs";
import { ARCHIVE_USER_ROOT, MemoryContentTransport, archiveEvents } from "./fixtures/archive-fixtures.mjs";
import { checkpointOverview } from "./fixtures/checkpoint-fixtures.mjs";
import { buildLongToolLoopTrace } from "./fixtures/long-tool-loop-trace.mjs";
import { registerTools } from "../tools.ts";
import { guardVikingUriToolCall } from "../lib/uri-guard-adapter.mjs";

const ROOT = `test/.artifacts/observability-integration-${process.pid}`;

const coveredStages = new Set();

function observationFor(name) {
  mkdirSync(ROOT, { recursive: true });
  const path = `${ROOT}/${name}.jsonl`;
  return { path, observation: createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false }) };
}

function readRun(path) {
  const raw = readFileSync(path, "utf8");
  const records = raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const record of records) {
    assert.equal(validateObservationRecord(record).ok, true, `${record.stage} schema invalid`);
    coveredStages.add(record.stage);
  }
  return { raw, records };
}

function config(endpoint) {
  return {
    endpoint,
    apiKey: "private-api-key",
    account: "dev",
    user: "private-user",
    peerId: "",
    userAgent: "test",
  };
}

test("client HTTP/connection/namespace 观察不改变 transport 结果且只输出 route 模板", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", result: { healthy: true, trace_id: "trace-safe" } }));
      return;
    }
    response.writeHead(503);
    response.end(JSON.stringify({ status: "error", error: { message: "private external failure", trace_id: "bad trace value" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const { path, observation } = observationFor("client");
  const client = new OVClient(config(endpoint), observation);
  try {
    assert.equal(await client.health(), true);
    const failed = await client.fetchJSON("/private/path?credential=secret", undefined, 1000);
    assert.equal(failed.ok, false);
    assert.equal(failed.status, 503);
    client.bindUser("another-private-user");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
    await observation.finish();
  }

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private-api-key|private-user|another-private-user|credential|external failure|bad trace value/);
  const http = records.filter((record) => record.stage === "client_http");
  assert.ok(http.length >= 4);
  for (const begin of http.filter((record) => record.data.phase === "begin")) {
    assert.equal(http.filter((record) => record.op === begin.op && record.data.phase === "end").length, 1);
  }
  assert.ok(http.some((record) => record.data.route === "/health" && record.data.phase === "begin"));
  const otherBegin = http.find((record) => record.data.route === "other" && record.data.phase === "begin");
  assert.ok(otherBegin);
  assert.ok(http.some((record) => record.op === otherBegin.op && record.data.outcome === "http_error"));
  assert.ok(http.some((record) => record.data.traceId === "trace-safe"));
  assert.ok(records.some((record) => record.stage === "client_connection" && record.data.mode === "change" && record.data.to === true));
  assert.equal(records.at(-1).stage, "observe_run_end");
});

test("观察配置与 sink 失败不改变 client 返回值、状态或请求顺序", async () => {
  let requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(JSON.stringify({ status: "ok", result: { healthy: true } }));
      return;
    }
    response.end(JSON.stringify({ status: "ok", result: { exists: false, is_dir: false, size: 0 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const execute = async (observation) => {
    requests = [];
    const client = new OVClient(config(endpoint), observation);
    const healthy = await client.health();
    const stat = await client.statUri("viking://user/private/secret");
    client.bindUser("private-next-user");
    await client.close();
    await observation.finish();
    return { product: { healthy, stat }, requests: [...requests] };
  };

  try {
    const baseline = await execute(createObservation({ env: {} }));
    const configFailure = createObservation({
      env: { OV_OBSERVE: `${ROOT}/unused.jsonl`, OV_OBSERVE_FD: "3" },
      autoFinalize: false,
    });
    assert.deepEqual(await execute(configFailure), baseline);
    assert.equal(configFailure.getStatus().reason, "env_conflict");

    const sinkFailure = createObservation({
      env: { OV_OBSERVE: `${ROOT}/write-failure.jsonl` },
      autoFinalize: false,
      dependencies: {
        write: (_fd, _bytes, callback) => queueMicrotask(() => callback(Object.assign(new Error("secret"), { code: "EIO" }))),
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sinkFailure.getStatus().reason, "write_failed");
    assert.deepEqual(await execute(sinkFailure), baseline);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("owner failure stage 生成脱敏记录并按白名单区分 transport、timeout 与 filesystem", async () => {
  const { path, observation } = observationFor("failure-classification");
  observation.emit(
    "index_failure",
    Object.assign(new Error("private refused detail"), { code: "ECONNREFUSED" }),
    "observation_append", "ignore", "continue_pi",
  );
  observation.emit(
    "recall_failure",
    Object.assign(new Error("private timeout detail"), { name: "TimeoutError", code: "ETIMEDOUT" }),
    "context_error", "retry", "raw_find", 0,
  );
  observation.emit(
    "index_failure",
    Object.assign(new Error("private file detail"), { code: "EIO" }),
    "health_refresh", "degrade", "continue_pi",
  );
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private refused|private timeout|private file/);
  assert.ok(records.some((record) => record.stage === "index_failure" && record.data.errorClass === "transport"));
  assert.ok(records.some((record) => record.stage === "recall_failure" && record.data.errorClass === "timeout"));
  assert.ok(records.some((record) => record.stage === "index_failure" && record.data.errorClass === "filesystem"));
});

test("sync 成功推进与失败保持待重放由同一责任模块解释，产品结果保持原语义", async () => {
  const { path, observation } = observationFor("sync");
  const trace = buildLongToolLoopTrace();
  let calls = 0;
  const adapter = {
    async writeEvents(_sessionId, events) {
      calls++;
      if (calls > 1) throw Object.assign(new Error("private sync failure viking://user/secret"), { status: 503 });
      return { acceptedEventIds: events.map((event) => event.eventId), capabilityVerified: true };
    },
  };
  const client = {
    userRoot: "viking://user/private",
    cfg: { archive: { chunkTokenBudget: 20000, rawTailTokenBudget: 30000 } },
    recordedEventTarget: { endpoint: "https://private.invalid", account: "dev", user: "private" },
    resolveUserSpace: async () => "private",
    bindUser() {},
  };
  const sync = new SyncManager(client, {
    observation,
    ackPathForSession: () => null,
    adapterFactory: () => adapter,
  });
  await sync.ensureSession(trace.sessionId);
  const result = await sync.syncSession({
    isPersisted: () => false,
    getEntries: () => trace.shorter,
  });
  assert.equal(result.added, 1);
  assert.equal(result.allDelivered, false);
  assert.ok(result.pending > 0);
  assert.match(result.failure, /private sync failure/);
  sync.observeFinalState();
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private sync failure|viking:\/\/user\/secret|https:\/\/private/);
  assert.ok(records.some((record) => record.stage === "sync_source" && record.data.branch === "in_memory"));
  assert.ok(records.some((record) => record.stage === "sync_ack_advance"));
  assert.ok(records.some((record) => record.stage === "sync_failure" && record.data.branch === "pending_replay"));
  assert.ok(records.some((record) => record.stage === "sync_capability" && record.data.to === "ready"));
  assert.equal(records.at(-1).data.dropped, 0);
});

test("busy 争用的操作内重试按 retry 降级记录，恢复后不残留失败状态", async () => {
  const { path, observation } = observationFor("sync-busy-retry");
  const trace = buildLongToolLoopTrace();
  let calls = 0;
  const adapter = {
    async writeEvents(_sessionId, events) {
      calls++;
      if (calls === 1) throw new ContentBusyError(
        "OpenViking path is busy; retry the same request", "viking://user/private/resources/.pi-openviking/recorded-events/v1/ab/cd/.evt_x.json",
      );
      return { acceptedEventIds: events.map((event) => event.eventId), capabilityVerified: true };
    },
  };
  const client = {
    userRoot: "viking://user/private",
    cfg: { archive: { chunkTokenBudget: 20000, rawTailTokenBudget: 30000 } },
    recordedEventTarget: { endpoint: "https://private.invalid", account: "dev", user: "private" },
    resolveUserSpace: async () => "private",
    bindUser() {},
  };
  const sync = new SyncManager(client, {
    observation,
    ackPathForSession: () => null,
    adapterFactory: () => adapter,
  });
  await sync.ensureSession(trace.sessionId);
  const result = await sync.syncSession({
    isPersisted: () => false,
    getEntries: () => trace.shorter,
  });
  assert.equal(result.allDelivered, true);
  assert.equal(sync.status.lastFailure, null);
  sync.observeFinalState();
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /viking:\/\/user\/private|https:\/\/private/);
  assert.ok(records.some((record) => record.stage === "sync_failure" && record.data.disposition === "retry" &&
    record.data.errorCode === "delivery" && record.data.branch === "pending_replay"));
  assert.ok(records.some((record) => record.stage === "sync_ack_advance"));
  assert.equal(records.at(-1).data.dropped, 0);
});

test("Archive 提交与失败由同一责任模块解释，只记录分支、计数与协议 hash", async () => {
  const { path, observation } = observationFor("archive");
  const sessionId = "observability-archive-session";
  const events = archiveEvents(sessionId);
  const transport = new MemoryContentTransport();
  const adapter = new RecordedEventAdapter(transport, { userRoot: ARCHIVE_USER_ROOT, observation });
  await adapter.writeEvents(sessionId, events);
  const manager = new ArchiveManager(transport, {
    userRoot: ARCHIVE_USER_ROOT,
    adapter,
    budgets: { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 },
    observation,
  });

  const committed = await manager.formArchives(sessionId, events);
  assert.equal(committed.committed, 3);

  const conflicting = new ArchiveManager(transport, {
    userRoot: ARCHIVE_USER_ROOT,
    adapter,
    budgets: { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 },
    observation,
  });
  const first = planArchives(events, { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 })[0];
  const range = events.slice(first.startIndex, first.endIndex + 1);
  const location = archiveStorageLocation(ARCHIVE_USER_ROOT, sessionId, buildArchiveManifest(sessionId, range).archiveId);
  transport.files.set(location.manifestUri, archiveManifestBytes({
    ...buildArchiveManifest(sessionId, range),
    contentHash: `sha256:${"c".repeat(64)}`,
  }));
  const failed = await conflicting.formArchives(sessionId, events);
  // 冲突只停下它自己的那一个 Archive，其余独立 Archive 照常提交。
  assert.equal(failed.pending, 1);
  manager.observeFinalState();
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, new RegExp(sessionId));
  assert.doesNotMatch(raw, /viking:\/\//);
  assert.ok(records.some((record) => record.stage === "archive_plan" && record.data.branch === "form"));
  assert.ok(records.some((record) => record.stage === "archive_commit" && record.data.branch === "created"));
  assert.ok(records.some((record) => record.stage === "archive_state" && record.data.mode === "change"));
  const snapshot = records.find((record) => record.stage === "archive_state" && record.data.mode === "snapshot");
  assert.equal(snapshot.data.committed, 3);
  assert.match(snapshot.data.current, /^[0-9a-f]{64}$/);
  const failure = records.find((record) => record.stage === "archive_failure");
  assert.equal(failure.data.errorCode, "manifest_integrity");
  assert.equal(failure.data.errorClass, "integrity");
  assert.equal(failure.data.branch, "skip_archive");
});

test("recall 只记录来源、数量与注入结果，不记录 query、内容或 URI", async () => {
  const { path, observation } = observationFor("recall");
  const client = {
    memorySpace: "private-space",
    async fetchJSON(route) {
      assert.equal(route, "/api/v1/search/search");
      return {
        ok: true,
        result: {
          rendered: "private recalled body",
          digest: "safe-digest",
          entries: [{
            uri: "viking://user/private-space/memories/x",
            category: "memories",
            score: 0.9,
            text: "source-backed recalled fact",
          }],
          stats: { rewrite: "off" },
        },
      };
    },
  };
  const recall = new RecallManager(client, {
    minQueryLength: 3,
    peerId: "",
    recallLimit: 10,
    recallLimitConfigured: false,
    recallQueryExpansionConfigured: false,
    recallQueryExpansion: "auto",
    recallPeerScope: "all",
    scoreThreshold: 0.35,
  }, () => "private-session", observation);
  recall.queueSearch("private user query");
  const block = await recall.searchPending();
  assert.match(block, /source-backed recalled fact/);
  const messages = [{ role: "user", content: "current prompt" }];
  const injected = recall.injectRecall(messages);
  assert.ok(injected.injectedBlock);
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private user query|private recalled body|private-space|current prompt|safe-digest|source-backed recalled fact/);
  assert.ok(records.some((record) => record.stage === "recall_request" && record.data.branch === "search"));
  assert.ok(records.some((record) => record.stage === "recall_source" && record.data.branch === "context_face" && record.data.resultCount === 1));
  assert.ok(records.some((record) => record.stage === "recall_filter" && record.data.branch === "safe"));
  assert.ok(records.some((record) => record.stage === "recall_result" && record.data.branch === "injected"));
});

test("tool 可用性和 URI 权限只记录枚举与计数，拒绝路径不发请求", async () => {
  const { path, observation } = observationFor("tools");
  const ownRoot = "viking://user/dev--pi-own";
  const outside = "viking://user/dev--pi-other/memories/secret.md";
  let reads = 0;
  let deletes = 0;
  let scopeReads = 0;
  let resourceAdds = 0;
  const client = {
    connected: true,
    cfg: { sessionScopedMemory: true, recallMaxContentChars: 500 },
    get userRoot() { scopeReads++; return ownRoot; },
    async find() { return [{ uri: outside, score: 0.9, abstract: "private outside content" }]; },
    async readContent() { reads++; return "should not be read"; },
    async delete() { deletes++; return true; },
    async addResource() { resourceAdds++; return { root_uri: "viking://resources/imported" }; },
  };
  const tools = new Map();
  registerTools({ registerTool: (tool) => tools.set(tool.name, tool) }, client, { sessionId: "pi-own" }, observation);
  const execute = (name, params) => tools.get(name).execute("id", params, new AbortController().signal, () => {}, {});

  const denied = await execute("viking_read", { uri: outside, level: "full" });
  assert.match(denied.content[0].text, /^Refused:/);
  assert.equal(reads, 0);
  const filtered = await execute("viking_search", { query: "private", scope: outside });
  assert.equal(filtered.content[0].text, "No results found.");
  const internal = `${ownRoot}/resources/.pi-openviking/recorded-events/v1/private/.event.json`;
  const protectedDelete = await execute("viking_forget", { uri: internal });
  assert.match(protectedDelete.content[0].text, /^Refused:/);
  assert.equal(deletes, 0);
  const resource = await execute("viking_add_resource", { url: "https://outside.test" });
  assert.match(resource.content[0].text, /^Refused:/);
  assert.equal(resourceAdds, 0);
  assert.equal(scopeReads, 4, "每次工具执行只读取一次产品 scope，不为观察重复求值");
  assert.equal(guardVikingUriToolCall({ toolName: "read", input: { path: outside } }, observation)?.block, true);
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /dev--pi-own|dev--pi-other|secret\.md|private outside/);
  assert.ok(records.some((record) => record.stage === "tool_availability" && record.data.branch === "proceed"));
  assert.ok(records.some((record) => record.stage === "tool_uri_guard" && record.data.branch === "block"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.branch === "deny"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.operation === "resource_add" && record.data.branch === "deny"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.branch === "clamp"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.branch === "filter"));
});

test("checkpoint 请求、VLM 边界、状态与失败只记录安全计数和协议 hash", async () => {
  const { path, observation } = observationFor("checkpoint");
  const sessionId = "private-checkpoint-session";
  const events = archiveEvents(sessionId, [{ role: "user", chars: 4000 }, { role: "user", chars: 4000 }]);
  const transport = new MemoryContentTransport();
  const adapter = new RecordedEventAdapter(transport, { userRoot: ARCHIVE_USER_ROOT, observation });
  await adapter.writeEvents(sessionId, events);
  const archives = new ArchiveManager(transport, {
    userRoot: ARCHIVE_USER_ROOT, adapter,
    budgets: { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 }, observation,
  });
  const formed = await archives.formArchives(sessionId, events);
  const descriptor = formed.archives[0];
  const taskId = `cptask_${"d".repeat(64)}`;

  const boundaryProcessor = new OpenVikingCheckpointProcessor({
    userRoot: ARCHIVE_USER_ROOT,
    async getSession() { return { ok: true, result: { message_count: 0, commit_count: 0 } }; },
    async addMessage() { return true; },
    async commitSession() { return { ok: true, result: { task_id: "provider-task" } }; },
    async getTask() { return { ok: true, result: { status: "completed", result: { token_usage: { llm: { total_tokens: 1 } } } } }; },
    async getSessionContext() { return { ok: true, result: { latest_archive_overview: checkpointOverview() } }; },
  }, { observation });
  const expanded = await archives.expand(sessionId, descriptor.manifest.archiveId);
  assert.equal((await boundaryProcessor.advance({
    taskId, manifest: descriptor.manifest, loadEvents: async () => expanded.events, previousCheckpoint: null,
  })).status, "completed");

  let first = true;
  let tick = 0;
  const manager = new CheckpointManager(transport, {
    adapter, archiveManager: archives, observation, pollIntervalMs: 1,
    now: () => `2026-08-20T00:00:${String(tick++).padStart(2, "0")}.000Z`,
    processor: {
      async advance() {
        if (first) {
          first = false;
          return { status: "failed", error: { errorClass: "protocol", errorCode: "task_failed", message: "private provider failure" } };
        }
        return { status: "completed", overview: checkpointOverview() };
      },
      async cleanup() { return true; },
    },
  });
  await manager.schedule(sessionId, [descriptor]);
  manager.observeFinalState();
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private-checkpoint-session|private provider failure|provider-task/);
  assert.ok(records.some((record) => record.stage === "checkpoint_request" && record.data.branch === "submit"));
  assert.ok(records.some((record) => record.stage === "checkpoint_process" && record.data.outcome === "completed"));
  assert.ok(records.some((record) => record.stage === "checkpoint_state" && record.data.status === "caught_up"));
  assert.ok(records.some((record) => record.stage === "checkpoint_failure" && record.data.errorCode === "task_failed"));
});

test("活动上下文的选择、容量判定与降级只记录枚举、计数与协议 hash", async () => {
  const { path, observation } = observationFor("active-context");
  const sessionId = "private-active-context-session";
  const events = archiveEvents(sessionId, [
    { role: "user", chars: 4000 },
    { role: "assistant", chars: 4000 },
    { role: "assistant", chars: 4000 },
  ]);
  const budgets = { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 };
  const descriptors = describeArchives(sessionId, events, budgets);
  const consumed = descriptors[0];
  const checkpointEvent = buildCheckpointEvent({
    manifest: consumed.manifest,
    requestEvent: buildCheckpointRequestEvent({
      manifest: consumed.manifest, previousCheckpointId: null, attempt: 1, submittedAt: "2026-08-21T00:00:00.000Z",
    }),
    overview: checkpointOverview("private checkpoint narrative"),
    completedAt: "2026-08-21T00:00:10.000Z",
  });
  let available = true;
  const adapter = {
    async readEvent() {
      if (!available) throw new Error("private OpenViking failure");
      return { event: checkpointEvent, bytes: Buffer.from("{}") };
    },
  };
  const input = {
    branchEvents: events,
    archives: descriptors,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: { contextWindow: 272000, maxTokens: 128000 },
    systemPrompt: "private system prompt",
  };

  mkdirSync(`${ROOT}/active-context`, { recursive: true });
  writeFileSync(`${ROOT}/active-context/blocker`, "", { mode: 0o600 });
  const manager = new ActiveContextManager({
    path: `${ROOT}/active-context/context.json`, adapter, observation,
    takeover: { enabled: true, contextTokenThreshold: 0 },
  });
  assert.equal((await manager.update(sessionId, input)).eligibility, "eligible");
  assert.equal((await manager.update(sessionId, { ...input, branchEvents: events.slice(0, 1), archives: [], lastCheckpointId: null })).eligibility, "no_context");

  // 容量不匹配、持久化失败与来源事实不可读分别降级，产品继续使用完整 Pi 上下文。
  const mismatch = new ActiveContextManager({
    path: null, adapter, observation, takeover: { enabled: true, contextTokenThreshold: 0 },
  });
  const capped = await mismatch.update(sessionId, { ...input, capacity: { contextWindow: 10000, maxTokens: 9000 } });
  assert.equal(capped.eligibility, "capacity_mismatch");
  const overBudget = new ActiveContextManager({
    path: null, adapter, observation,
    takeover: { enabled: true, contextTokenThreshold: 0, checkpointTokenBudget: 1 },
  });
  const overBudgetStatus = await overBudget.update(sessionId, input);
  assert.equal(overBudgetStatus.eligibility, "checkpoint_over_budget");
  assert.equal(await overBudget.takeoverMessages(events, { capacity: input.capacity }), null);
  assert.equal(await overBudget.compaction(events, 1000), null);
  const blocked = new ActiveContextManager({
    path: `${ROOT}/active-context/blocker/context.json`, adapter, observation,
    takeover: { enabled: true, contextTokenThreshold: 0 },
  });
  assert.equal((await blocked.update(sessionId, input)).eligibility, "facts_unavailable");
  available = false;
  const cold = new ActiveContextManager({
    path: null, adapter, observation, takeover: { enabled: true, contextTokenThreshold: 0 },
  });
  const degraded = await cold.update(sessionId, input);
  assert.equal(degraded.eligibility, "facts_unavailable");
  manager.observeFinalState();
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private-active-context-session|private checkpoint narrative|private system prompt|private OpenViking failure/);
  assert.ok(records.some((record) => record.stage === "active_context_select" && record.data.branch === "selected"));
  assert.ok(records.some((record) => record.stage === "active_context_select" && record.data.branch === "invalidated"));
  assert.ok(records.some((record) => record.stage === "active_context_eligibility" && record.data.branch === "eligible"));
  assert.ok(records.some((record) => record.stage === "active_context_eligibility" && record.data.branch === "capacity_mismatch"));
  assert.ok(records.some((record) => record.stage === "active_context_eligibility" && record.data.branch === "checkpoint_over_budget"));
  assert.ok(records.some((record) => record.stage === "active_context_eligibility" && record.data.branch === "facts_unavailable"));
  assert.ok(records.some((record) => record.stage === "active_context_state" && record.data.mode === "change"));
  assert.ok(records.some((record) => record.stage === "active_context_failure" && record.data.errorCode === "persist"));
  assert.ok(records.some((record) => record.stage === "active_context_failure" && record.data.errorCode === "materialize"));
  const headroom = records.find((record) => record.stage === "active_context_eligibility" && record.data.branch === "capacity_mismatch");
  assert.ok(headroom.data.headroom < 0, "容量不匹配的余量必须可读为负值");
});

test.after(() => {
  try {
    const manifest = JSON.parse(readFileSync("test/live/observability.workloads.json", "utf8"));
    const liveStages = new Set([
      "observe_run_start",
      "observe_run_end",
      ...manifest.workloads.flatMap((workload) => workload.expectedRecords.map((expected) => expected.stage)),
    ]);
    const requiredDeterministicStages = Object.keys(OBSERVATION_STAGE_REGISTRY)
      .filter((stage) => !liveStages.has(stage));
    assert.deepEqual(
      [...manifest.deterministicStages].sort(),
      [...requiredDeterministicStages].sort(),
      "manifest 必须显式登记所有非 live stage",
    );
    assert.deepEqual(
      requiredDeterministicStages.filter((stage) => !coveredStages.has(stage)),
      [],
      "非 live stage 必须由实际 deterministic 记录覆盖",
    );
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
});
