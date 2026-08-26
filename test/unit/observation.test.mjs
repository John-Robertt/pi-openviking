import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createObserver } from "../../src/observation/index.ts";
import { makeTmp } from "../helpers/tmp.mjs";

const EVENT = { operation: "op", stage: "run", outcome: "ok", durationMs: 3 };

function readEvents(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("disabled：record 无副作用、不触发时钟与文件系统", (t) => {
  const dir = makeTmp(t);
  const observer = createObserver(null);
  assert.equal(observer.status, "disabled");
  assert.equal(observer.now(), 0);
  observer.record(EVENT);
  assert.equal(existsSync(join(dir, "anything.jsonl")), false);
});

test("active：record 追加合法 JSONL，关联字段齐全", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const observer = createObserver({ file });
  assert.equal(observer.status, "active");
  observer.record(EVENT);
  observer.record({ ...EVENT, outcome: "error", session: "s-1", error: "boom" });
  const [first, second] = readEvents(file);
  assert.equal(first.runId, second.runId);
  assert.equal(typeof first.runId, "string");
  assert.ok(first.ts <= second.ts);
  assert.deepEqual(
    Object.keys(first).sort(),
    ["durationMs", "operation", "outcome", "runId", "stage", "ts"].sort(),
  );
  assert.equal(second.session, "s-1");
  assert.equal(second.error, "boom");
});

test("sink 失败：降级、保留首个原因、后续 record 无副作用", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "blocked");
  writeFileSync(file, "not a directory");
  const observer = createObserver({ file: join(file, "obs.jsonl") });
  observer.record(EVENT);
  assert.equal(observer.status, "degraded");
  assert.ok(observer.failure.length > 0);
  observer.record(EVENT);
  assert.equal(observer.failure.length > 0, true);
});

test("schema 失败：不合规事件使观察降级且不写入", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const observer = createObserver({ file });
  observer.record({ operation: "", stage: "run", outcome: "ok", durationMs: 1 });
  assert.equal(observer.status, "degraded");
  assert.equal(existsSync(file), false);
});
