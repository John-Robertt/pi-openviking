import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";

import { OVClient } from "../client.ts";
import { RecallManager } from "../recall.ts";
import { SyncManager } from "../sync.ts";
import { OBSERVATION_STAGE_REGISTRY, createObservation, validateObservationRecord } from "../shared/observe.mjs";
import { buildPhase0LongTrace } from "./fixtures/phase0-long-trace.mjs";
import { registerTools } from "../tools.ts";
import { guardVikingUriToolCall } from "../lib/uri-guard-adapter.mjs";

const ROOT = `test/.artifacts/observability-integration-${process.pid}`;

function observationFor(name) {
  mkdirSync(ROOT, { recursive: true });
  const path = `${ROOT}/${name}.jsonl`;
  return { path, observation: createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false }) };
}

function readRun(path) {
  const raw = readFileSync(path, "utf8");
  const records = raw.trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const record of records) assert.equal(validateObservationRecord(record).ok, true, `${record.stage} schema invalid`);
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
    "context_error", "retry", "legacy_endpoint", 0,
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
  const trace = buildPhase0LongTrace();
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

test("recall 只记录来源、数量与注入结果，不记录 query、内容或 URI", async () => {
  const { path, observation } = observationFor("recall");
  const oldStateDir = process.env.OPENVIKING_STATE_DIR;
  process.env.OPENVIKING_STATE_DIR = `${ROOT}/recall-state`;
  const client = {
    memorySpace: "private-space",
    async fetchJSON(route) {
      assert.equal(route, "/api/v1/search/search");
      return {
        ok: true,
        result: {
          rendered: "private recalled body",
          digest: "safe-digest",
          entries: [{ uri: "viking://user/private-space/memories/x" }],
          stats: { rewrite: "off" },
        },
      };
    },
  };
  const recall = new RecallManager(client, {
    minQueryLength: 3,
    peerId: "",
    recallLimit: 10,
    recallMaxTokens: 1600,
    recallLimitConfigured: false,
    recallMaxTokensConfigured: false,
    recallQueryExpansionConfigured: false,
    recallQueryExpansion: "auto",
    recallDedupTurns: 5,
    recallPeerScope: "all",
    scoreThreshold: 0.35,
  }, () => "private-session", observation);
  try {
    recall.queueSearch("private user query");
    const block = await recall.searchPending();
    assert.match(block, /safe-digest/);
    const messages = [{ role: "user", content: "current prompt" }];
    const injected = recall.injectRecall(messages);
    assert.ok(injected.injectedBlock);
  } finally {
    if (oldStateDir === undefined) delete process.env.OPENVIKING_STATE_DIR;
    else process.env.OPENVIKING_STATE_DIR = oldStateDir;
    await observation.finish();
  }

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /private user query|private recalled body|private-space|current prompt|safe-digest/);
  assert.ok(records.some((record) => record.stage === "recall_request" && record.data.branch === "search"));
  assert.ok(records.some((record) => record.stage === "recall_source" && record.data.branch === "context_face" && record.data.resultCount === 1));
  assert.ok(records.some((record) => record.stage === "recall_result" && record.data.branch === "injected"));
});

test("tool 可用性和 URI 权限只记录枚举与计数，拒绝路径不发请求", async () => {
  const { path, observation } = observationFor("tools");
  const ownRoot = "viking://user/dev--pi-own";
  const outside = "viking://user/dev--pi-other/memories/secret.md";
  let reads = 0;
  let scopeReads = 0;
  const client = {
    connected: true,
    cfg: { sessionScopedMemory: true, recallMaxContentChars: 500 },
    get userRoot() { scopeReads++; return ownRoot; },
    async find() { return [{ uri: outside, score: 0.9, abstract: "private outside content" }]; },
    async readContent() { reads++; return "should not be read"; },
  };
  const tools = new Map();
  registerTools({ registerTool: (tool) => tools.set(tool.name, tool) }, client, { sessionId: "pi-own" }, observation);
  const execute = (name, params) => tools.get(name).execute("id", params, new AbortController().signal, () => {}, {});

  const denied = await execute("viking_read", { uri: outside, level: "full" });
  assert.match(denied.content[0].text, /^Refused:/);
  assert.equal(reads, 0);
  const filtered = await execute("viking_search", { query: "private", scope: outside });
  assert.equal(filtered.content[0].text, "No results found.");
  assert.equal(scopeReads, 2, "每次工具执行只读取一次产品 scope，不为观察重复求值");
  assert.equal(guardVikingUriToolCall({ toolName: "read", input: { path: outside } }, observation)?.block, true);
  await observation.finish();

  const { raw, records } = readRun(path);
  assert.doesNotMatch(raw, /dev--pi-own|dev--pi-other|secret\.md|private outside/);
  assert.ok(records.some((record) => record.stage === "tool_availability" && record.data.branch === "proceed"));
  assert.ok(records.some((record) => record.stage === "tool_uri_guard" && record.data.branch === "block"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.branch === "deny"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.branch === "clamp"));
  assert.ok(records.some((record) => record.stage === "tool_scope" && record.data.branch === "filter"));
});

test("registry 每个 active stage 在唯一 owner 中有当前调用点且无第二套观察输出", () => {
  const ownerSources = new Map();
  for (const [stage, descriptor] of Object.entries(OBSERVATION_STAGE_REGISTRY)) {
    const source = ownerSources.get(descriptor.owner) ?? readFileSync(descriptor.owner, "utf8");
    ownerSources.set(descriptor.owner, source);
    assert.match(source, new RegExp(`\\b${stage}\\b`), `${stage} 在 ${descriptor.owner} 中没有当前调用点`);
  }
  for (const [owner, source] of ownerSources) {
    if (owner === "shared/observe.mjs") continue;
    assert.doesNotMatch(source, /appendFileSync|console\.(?:log|debug)|process\.stderr\.write/,
      `${owner} 存在统一 sink 之外的运行过程输出`);
  }
});

test("发布声明与 observation 运行时依赖一致", () => {
  const recallDeclaration = readFileSync("shared/recall-core.d.mts", "utf8");
  assert.match(recallDeclaration, /observation\?: Observation/);
  const adapterDeclaration = readFileSync("shared/recorded-event-adapter.d.mts", "utf8");
  assert.match(adapterDeclaration, /observation\?: Observation/);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
