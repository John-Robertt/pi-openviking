import assert from "node:assert/strict";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import test from "node:test";

import {
  OBSERVATION_SCHEMA_VERSION,
  OBSERVATION_STAGE_REGISTRY,
  createObservation,
  observationSessionHash,
  validateObservationRecord,
} from "../shared/observe.mjs";

const ROOT = `test/.artifacts/observe-${process.pid}`;
const FIXED_RUN = "11111111-1111-4111-8111-111111111111";

function resetRoot() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
}

function fixedDependencies(extra = {}) {
  let monotonic = 100;
  return {
    uuid: () => FIXED_RUN,
    wallNow: () => Date.parse("2026-08-19T00:00:00.000Z"),
    monotonicNow: () => (monotonic += 5),
    ...extra,
  };
}

function parseJsonl(path) {
  const raw = readFileSync(path, "utf8");
  return {
    raw,
    records: raw.trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

async function writeRepresentativeRun(observer) {
  observer.bindSession("raw-session-id-must-not-leak");
  observer.emit("client_namespace", "snapshot", "private-user", null);
  const op = observer.begin("client_http", "/api/v1/content/read?uri=viking%3A%2F%2Fsecret", "GET", 1234);
  observer.end("client_http", op, "success", 200, "trace-safe");
  observer.emit("sync_source", "persistent_jsonl", 3);
  observer.emit("sync_source", "pending_persistence", 0);
  await observer.finish();
}

test("active stage registry 是冻结且每个 stage 只有一个 owner/kind/schema", () => {
  assert.ok(Object.isFrozen(OBSERVATION_STAGE_REGISTRY));
  assert.ok(Object.keys(OBSERVATION_STAGE_REGISTRY).length > 0);
  for (const [name, descriptor] of Object.entries(OBSERVATION_STAGE_REGISTRY)) {
    assert.match(name, /^[a-z][a-z0-9_]+$/);
    assert.equal(typeof descriptor.owner, "string");
    assert.ok(["boundary", "decision", "state", "failure"].includes(descriptor.kind));
    assert.equal(typeof descriptor.data, "object");
    assert.ok(Object.isFrozen(descriptor));
  }
});

test("未请求观察时只返回固定 no-op，依赖与逐记录转换均不执行", async () => {
  const calls = [];
  const fail = (name) => () => { calls.push(name); throw new Error(name); };
  const observer = createObservation({
    env: {},
    dependencies: {
      open: fail("open"),
      fstat: fail("fstat"),
      probeWritable: fail("probeWritable"),
      write: fail("write"),
      close: fail("close"),
      uuid: fail("uuid"),
      wallNow: fail("wallNow"),
      monotonicNow: fail("monotonicNow"),
      sessionHash: fail("sessionHash"),
    },
  });
  observer.bindSession("secret");
  observer.abandon();
  observer.emit("sync_source", "persistent_jsonl", 1);
  assert.equal(observer.begin("client_http", "/secret", "GET", 1), 0);
  observer.end("client_http", 0, "success", 200, "trace");
  const deadline = observer.beginDrainDeadline(500);
  assert.equal(deadline, 0);
  await observer.finishRemaining(deadline);
  await observer.finish();
  assert.deepEqual(calls, []);
  assert.deepEqual(observer.getStatus(), {
    state: "disabled", reason: "not_requested", run: null, accepted: 0, dropped: 0,
  });
});

test("路径与继承 FD 对固定输入写出逐字节相同且不泄露原始身份或 URI", async () => {
  resetRoot();
  const pathFile = `${ROOT}/path.jsonl`;
  const fdFile = `${ROOT}/fd.jsonl`;
  const pathObserver = createObservation({
    env: { OV_OBSERVE: pathFile },
    autoFinalize: false,
    dependencies: fixedDependencies(),
  });
  await writeRepresentativeRun(pathObserver);

  const fd = openSync(fdFile, "wx", 0o600);
  const fdObserver = createObservation({
    env: { OV_OBSERVE_FD: String(fd) },
    autoFinalize: false,
    dependencies: fixedDependencies(),
  });
  await writeRepresentativeRun(fdObserver);

  const a = parseJsonl(pathFile);
  const b = parseJsonl(fdFile);
  assert.equal(a.raw, b.raw);
  assert.doesNotMatch(a.raw, /raw-session-id|private-user|viking%3A|secret/);
  assert.equal(statSync(pathFile).mode & 0o077, 0);
  assert.equal(statSync(fdFile).mode & 0o077, 0);

  const records = a.records;
  assert.equal(records[0].stage, "observe_run_start");
  assert.equal(records.at(-1).stage, "observe_run_end");
  assert.deepEqual(records.map((record) => record.seq), records.map((_, index) => index + 1));
  assert.equal(records.at(-1).data.accepted, records.at(-1).seq - 1);
  assert.equal(records.at(-1).data.dropped, 0);
  assert.equal(records.find((record) => record.stage === "client_http" && record.data.phase === "begin").data.route,
    "/api/v1/content/read");
  assert.equal(records.filter((record) => record.stage === "client_http")[1].data.durationMs, 5);
  for (const record of records) assert.equal(validateObservationRecord(record).ok, true);
});

test("boundary 在 begin 捕获 session，重绑定不改变 end 归属", async () => {
  resetRoot();
  const path = `${ROOT}/boundary-session.jsonl`;
  const observer = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  observer.bindSession("old-session");
  const op = observer.begin("client_http", "/health", "GET", 100);
  observer.bindSession("new-session");
  observer.end("client_http", op, "success", 200, "trace");
  await observer.finish();
  const boundary = parseJsonl(path).records.filter((record) => record.op === op);
  assert.equal(boundary.length, 2);
  assert.equal(boundary[0].session, observationSessionHash("old-session"));
  assert.equal(boundary[1].session, boundary[0].session);
});

test("session producer 隔离交错归属，最后一个 producer 代表进程 owner 封存 run", async () => {
  resetRoot();
  const path = `${ROOT}/multi-session.jsonl`;
  const observer = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  const main = observer.createProducer();
  const child = observer.createProducer();
  main.bindSession("main-session");
  child.bindSession("child-session");

  const mainOp = main.begin("client_http", "/health", "GET", 100);
  child.emit("sync_source", "persistent_jsonl", 1);
  await child.finishRemaining(child.beginDrainDeadline(500));
  child.emit("sync_source", "persistent_jsonl", 2);
  main.emit("sync_source", "persistent_jsonl", 3);
  main.end("client_http", mainOp, "success", 200, "trace");

  assert.equal(observer.getStatus().state, "ready");
  await main.finishRemaining(main.beginDrainDeadline(500));
  const records = parseJsonl(path).records;
  assert.equal(records.filter((record) => record.stage === "observe_run_end").length, 1);
  assert.equal(records.at(-1).stage, "observe_run_end");

  const childRecord = records.find((record) => record.stage === "sync_source" && record.data.entries === 1);
  const mainRecords = records.filter((record) =>
    (record.stage === "sync_source" && record.data.entries === 3) || record.op === mainOp);
  assert.equal(childRecord.session, observationSessionHash("child-session"));
  assert.ok(mainRecords.length > 0);
  assert.ok(mainRecords.every((record) => record.session === observationSessionHash("main-session")));
  assert.equal(records.some((record) => record.stage === "sync_source" && record.data.entries === 2), false);
});

test("非终止会话替换注销旧 producer，并由新扩展实例继续同一进程 run", async () => {
  resetRoot();
  const path = `${ROOT}/session-replacement.jsonl`;
  const observer = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  const previous = observer.createProducer();
  previous.bindSession("previous-session");
  previous.emit("sync_source", "persistent_jsonl", 1);
  previous.release();
  previous.emit("sync_source", "persistent_jsonl", 2);

  const replacement = observer.createProducer();
  replacement.bindSession("replacement-session");
  replacement.emit("sync_source", "persistent_jsonl", 3);
  assert.equal(observer.getStatus().state, "ready");
  await replacement.finishRemaining(replacement.beginDrainDeadline(500));

  const records = parseJsonl(path).records;
  assert.equal(records.filter((record) => record.stage === "observe_run_end").length, 1);
  assert.equal(records.some((record) => record.stage === "sync_source" && record.data.entries === 2), false);
  assert.equal(records.find((record) => record.stage === "sync_source" && record.data.entries === 1).session,
    observationSessionHash("previous-session"));
  assert.equal(records.find((record) => record.stage === "sync_source" && record.data.entries === 3).session,
    observationSessionHash("replacement-session"));
});


test("队列满、部分写和 close 错误只改变观察状态且不抛出", async (t) => {
  await t.test("queue full", async () => {
    resetRoot();
    const path = `${ROOT}/queue.jsonl`;
    let pendingWrite;
    const observer = createObservation({
      env: { OV_OBSERVE: path },
      autoFinalize: false,
      queueCapacity: 1,
      dependencies: fixedDependencies({
        write: (_fd, _bytes, callback) => { pendingWrite = callback; },
        close: (fd, callback) => { closeSync(fd); callback(null); },
      }),
    });
    assert.doesNotThrow(() => observer.emit("sync_source", "in_memory", 1));
    assert.equal(observer.getStatus().reason, "queue_full");
    pendingWrite(null, 1);
    await observer.finish(0);
    assert.equal(observer.getStatus().state, "incomplete");
  });

  await t.test("partial write", async () => {
    resetRoot();
    const path = `${ROOT}/partial.jsonl`;
    const observer = createObservation({
      env: { OV_OBSERVE: path },
      autoFinalize: false,
      dependencies: fixedDependencies({
        write: (_fd, bytes, callback) => queueMicrotask(() => callback(null, bytes.length - 1)),
      }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observer.getStatus().reason, "partial_write");
    await observer.finish();
  });

  await t.test("close error", async () => {
    resetRoot();
    const path = `${ROOT}/close.jsonl`;
    const observer = createObservation({
      env: { OV_OBSERVE: path },
      autoFinalize: false,
      dependencies: fixedDependencies({
        close: (fd, callback) => { closeSync(fd); callback(Object.assign(new Error("close failed secret"), { code: "EIO" })); },
      }),
    });
    await observer.finish();
    assert.equal(observer.getStatus().reason, "close_failed");
    assert.doesNotMatch(JSON.stringify(observer.getStatus()), /secret/);
  });
});

test("shutdown 只使用既有剩余期限，stalled writer 超时后 fail-open 并只关闭一次", async () => {
  resetRoot();
  const path = `${ROOT}/drain-timeout.jsonl`;
  let closeCalls = 0;
  const observer = createObservation({
    env: { OV_OBSERVE: path },
    autoFinalize: false,
    dependencies: fixedDependencies({
      write() {},
      close: (fd, callback) => { closeCalls++; closeSync(fd); callback(null); },
    }),
  });
  const deadline = observer.beginDrainDeadline(25);
  const started = Date.now();
  await observer.finishRemaining(deadline);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `finishRemaining 不应新增等待预算：${elapsed}ms`);
  assert.equal(observer.getStatus().state, "incomplete");
  assert.equal(observer.getStatus().reason, "flush_timeout");
  assert.equal(closeCalls, 1);
  await observer.finish();
  assert.equal(closeCalls, 1);
});

test("shutdown 剩余期限同时约束 stalled close", async () => {
  resetRoot();
  const path = `${ROOT}/close-timeout.jsonl`;
  let closeCalls = 0;
  let stalledFd;
  const observer = createObservation({
    env: { OV_OBSERVE: path },
    autoFinalize: false,
    dependencies: fixedDependencies({
      write: (_fd, bytes, callback) => queueMicrotask(() => callback(null, bytes.length)),
      close: (fd) => { closeCalls++; stalledFd = fd; },
    }),
  });
  const deadline = observer.beginDrainDeadline(25);
  const started = Date.now();
  await observer.finishRemaining(deadline);
  assert.ok(Date.now() - started < 200);
  assert.equal(observer.getStatus().state, "incomplete");
  assert.equal(observer.getStatus().reason, "close_timeout");
  assert.equal(closeCalls, 1);
  closeSync(stalledFd);
});

test("finish 完成后调用位于 run 边界之外，不改变已封存证据", async () => {
  resetRoot();
  const path = `${ROOT}/post-finish.jsonl`;
  const observer = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  observer.emit("sync_source", "in_memory", 1);
  await observer.finish();
  const status = observer.getStatus();
  observer.emit("sync_source", "in_memory", 2);
  assert.equal(observer.begin("client_http", "/health", "GET", 100), 0);
  observer.end("client_http", 1, "success", 200, "trace");
  assert.deepEqual(observer.getStatus(), status);
  const records = parseJsonl(path).records;
  assert.equal(records.at(-1).stage, "observe_run_end");
  assert.equal(records.at(-1).data.dropped, 0);
});

test("非法配置不抛出、不回退且不创建 run", () => {
  const conflict = createObservation({ env: { OV_OBSERVE: "x", OV_OBSERVE_FD: "3" }, autoFinalize: false });
  assert.deepEqual(conflict.getStatus(), {
    state: "incomplete", reason: "env_conflict", run: null, accepted: 0, dropped: 0,
  });
  const invalidFd = createObservation({ env: { OV_OBSERVE_FD: "2" }, autoFinalize: false });
  assert.equal(invalidFd.getStatus().reason, "invalid_fd");
});

test("未结束 boundary 使 run 不完整且不写 observe_run_end", async () => {
  resetRoot();
  const path = `${ROOT}/unfinished.jsonl`;
  const observer = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  observer.begin("client_http", "/health", "GET", 1000);
  await observer.finish();
  const { records } = parseJsonl(path);
  assert.equal(observer.getStatus().reason, "operation_unfinished");
  assert.equal(records.at(-1).stage, "client_http");
  assert.notEqual(records.at(-1).stage, "observe_run_end");
});

test("producer deadline 放弃完整性，不写 run_end", async () => {
  resetRoot();
  const path = `${ROOT}/producer-deadline.jsonl`;
  const observer = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  observer.emit("shutdown_grace", 500, false);
  observer.abandon();
  observer.emit("sync_source", "in_memory", 1);
  await observer.finish();
  const records = parseJsonl(path).records;
  assert.equal(observer.getStatus().state, "incomplete");
  assert.equal(observer.getStatus().reason, "producer_deadline");
  assert.notEqual(records.at(-1).stage, "observe_run_end");
});

test("记录校验拒绝不兼容版本、未知顶层字段和非法 traceId", () => {
  const base = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    ts: "2026-08-19T00:00:00.000Z",
    run: FIXED_RUN,
    seq: 1,
    session: observationSessionHash("s"),
    kind: "boundary",
    stage: "client_http",
    op: 1,
    data: { phase: "end", outcome: "success", durationMs: 1, status: 200 },
  };
  assert.equal(validateObservationRecord(base).ok, true);
  assert.equal(validateObservationRecord({ ...base, schemaVersion: 2 }).ok, false);
  assert.equal(validateObservationRecord({ ...base, credential: "secret" }).ok, false);
  assert.equal(validateObservationRecord({ ...base, data: { ...base.data, traceId: "bad trace" } }).ok, false);
  assert.equal(validateObservationRecord({ ...base, data: { ...base.data, uri: "viking://user/private" } }).ok, false);
  assert.equal(validateObservationRecord({ ...base, parentOp: 1 }).ok, false);
});

test("pi_entry_append 白名单接受 compaction_pointer 并拒绝未知名种", () => {
  const base = {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    ts: "2026-08-19T00:00:00.000Z",
    run: FIXED_RUN,
    seq: 1,
    session: observationSessionHash("s"),
    kind: "boundary",
    stage: "pi_entry_append",
    op: 1,
    data: { phase: "begin", operation: "compaction_pointer", entryType: "ov-observation" },
  };
  assert.equal(validateObservationRecord(base).ok, true);
  assert.equal(
    validateObservationRecord({ ...base, data: { ...base.data, operation: "unknown_injection" } }).ok,
    false,
  );
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
