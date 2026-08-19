import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_MAX_FILE_BYTES,
  BATCH_MAX_OPERATIONS,
  BATCH_MAX_TOTAL_BYTES,
  ContentBusyError,
  ContentConflictError,
  ContentWriteError,
  acceptBatchResult,
  ensureDirectoryChain,
  planContentBatches,
  replaceIfHash,
  writeContentObjects,
} from "../shared/content-objects.mjs";

const ROOT = "viking://user/test/resources/.pi-openviking/archives/v1/session";

function okResponse(rootUri, { created = [], updated = [], unchanged = [] } = {}) {
  return { ok: true, status: 200, result: { root_uri: rootUri, created, updated, unchanged } };
}

test("协议限制与 OpenViking 0.4.15 Content API 一致", () => {
  assert.equal(BATCH_MAX_OPERATIONS, 128);
  assert.equal(BATCH_MAX_FILE_BYTES, 8 * 1024 * 1024);
  assert.equal(BATCH_MAX_TOTAL_BYTES, 16 * 1024 * 1024);
});

test("409 按 conflict_type 区分可重试路径占用与不可覆盖字节冲突", () => {
  const busy = {
    ok: false,
    status: 409,
    error: { code: "CONFLICT", details: { resource: `${ROOT}/a.json`, conflict_type: "path_busy", retryable: true } },
  };
  assert.throws(() => acceptBatchResult(busy, ROOT, [`${ROOT}/a.json`]), (error) =>
    error instanceof ContentBusyError && error.retryable === true && error.uri === `${ROOT}/a.json`);

  const byteConflict = {
    ok: false,
    status: 409,
    error: { code: "CONFLICT", message: "target already exists", details: { resource: `${ROOT}/a.json` } },
  };
  assert.throws(() => acceptBatchResult(byteConflict, ROOT, [`${ROOT}/a.json`]), (error) =>
    error instanceof ContentConflictError && !(error instanceof ContentBusyError) && error.uri === `${ROOT}/a.json`);
});

test("retryable 冲突即使没有 conflict_type 也不判为完整性错误", () => {
  const retryable = { ok: false, status: 409, error: { details: { resource: `${ROOT}/a.json`, retryable: true } } };
  assert.throws(() => acceptBatchResult(retryable, ROOT, [`${ROOT}/a.json`]), ContentBusyError);
});

test("非 409 失败保留 status 供上层判断 capability", () => {
  const response = { ok: false, status: 404, error: { message: "no route" } };
  assert.throws(() => acceptBatchResult(response, ROOT, [`${ROOT}/a.json`]), (error) =>
    error instanceof ContentWriteError && error.status === 404);
});

test("响应必须逐项确认请求的全部 URI，形状与重复都拒绝", () => {
  const uris = [`${ROOT}/a.json`, `${ROOT}/b.json`];
  assert.throws(() => acceptBatchResult(okResponse(ROOT, { created: [uris[0]] }), ROOT, uris), ContentWriteError);
  assert.throws(() => acceptBatchResult(okResponse("viking://other", { created: uris }), ROOT, uris), ContentWriteError);
  assert.throws(
    () => acceptBatchResult(okResponse(ROOT, { created: [uris[0]], unchanged: [uris[0]] }), ROOT, uris),
    ContentWriteError,
  );
  assert.throws(() => acceptBatchResult({ ok: true, status: 200, result: null }, ROOT, uris), ContentWriteError);

  const accepted = acceptBatchResult(okResponse(ROOT, { created: [uris[0]], updated: [uris[1]] }), ROOT, uris);
  assert.deepEqual([...accepted.created], [uris[0]]);
  assert.deepEqual([...accepted.updated], [uris[1]]);
});

test("批次按操作数和总字节拆分，单对象超出文件上限直接拒绝", () => {
  const small = Array.from({ length: 129 }, (_, index) => ({ uri: `${ROOT}/${index}`, bytes: Buffer.alloc(16) }));
  assert.deepEqual(planContentBatches(small).map((batch) => batch.length), [128, 1]);

  const large = Array.from({ length: 3 }, (_, index) => ({ uri: `${ROOT}/${index}`, bytes: Buffer.alloc(BATCH_MAX_FILE_BYTES) }));
  assert.deepEqual(planContentBatches(large).map((batch) => batch.length), [2, 1]);

  assert.throws(
    () => planContentBatches([{ uri: `${ROOT}/x`, bytes: Buffer.alloc(BATCH_MAX_FILE_BYTES + 1) }]),
    ContentWriteError,
  );
});

test("replace_if_hash 只接受 sha256 基线", () => {
  assert.deepEqual(replaceIfHash(`sha256:${"a".repeat(64)}`), { kind: "replace_if_hash", base_hash: `sha256:${"a".repeat(64)}` });
  assert.throws(() => replaceIfHash("deadbeef"), TypeError);
});

test("目录链逐层幂等建立，越界目标直接拒绝", async () => {
  const directories = new Set(["viking://user/test/resources"]);
  const created = [];
  const transport = {
    async statUri(uri) { return { ok: true, exists: directories.has(uri), isDir: directories.has(uri), status: 200 }; },
    async mkdirUri(uri) { directories.add(uri); created.push(uri); return { ok: true, status: 200, result: { uri } }; },
  };
  const cache = new Set();
  await ensureDirectoryChain(transport, "viking://user/test/resources", `${ROOT}/ab`, cache);
  assert.deepEqual(created, [
    "viking://user/test/resources/.pi-openviking",
    "viking://user/test/resources/.pi-openviking/archives",
    "viking://user/test/resources/.pi-openviking/archives/v1",
    "viking://user/test/resources/.pi-openviking/archives/v1/session",
    "viking://user/test/resources/.pi-openviking/archives/v1/session/ab",
  ]);
  await ensureDirectoryChain(transport, "viking://user/test/resources", `${ROOT}/ab`, cache);
  assert.equal(created.length, 5);

  await assert.rejects(
    () => ensureDirectoryChain(transport, "viking://user/test/resources", "viking://user/other/resources/x", new Set()),
    ContentWriteError,
  );
});

test("目录位置已是文件时按完整性冲突拒绝", async () => {
  const transport = {
    async statUri() { return { ok: true, exists: true, isDir: false, status: 200 }; },
    async mkdirUri() { return { ok: true, status: 200 }; },
  };
  await assert.rejects(
    () => ensureDirectoryChain(transport, "viking://user/test/resources", `${ROOT}/ab`, new Set()),
    ContentConflictError,
  );
});

test("写入使用调用方给定的 precondition 并合并逐批结果", async () => {
  const requests = [];
  const transport = {
    async batchWrite(request) {
      requests.push(request);
      return okResponse(ROOT, { created: request.operations.map((operation) => operation.uri) });
    },
  };
  const result = await writeContentObjects(transport, ROOT, [
    { uri: `${ROOT}/a.json`, bytes: Buffer.from("a") },
    { uri: `${ROOT}/b.json`, bytes: Buffer.from("b"), precondition: replaceIfHash(`sha256:${"0".repeat(64)}`) },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].wait, false);
  assert.deepEqual(requests[0].operations.map((operation) => operation.precondition.kind), ["create_if_absent", "replace_if_hash"]);
  assert.equal(result.created.size, 2);
});
