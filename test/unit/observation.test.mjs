import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("disabled：record 直接返回且不触发时钟", () => {
  const observer = createObserver(null);
  assert.equal(observer.status, "disabled");
  assert.equal(observer.now(), 0);
  assert.doesNotThrow(() => observer.record(EVENT));
});

test("active：record 不触发同步写入，flush 后追加合法 JSONL，关联字段齐全", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const observer = createObserver({ file });
  assert.equal(observer.status, "active");
  observer.record(EVENT);
  observer.record({ ...EVENT, outcome: "error", session: "s-1", error: "boom" });
  // record 只入队：返回时 sink 尚未写入，证明写入不延长产品 callback。
  assert.equal(existsSync(file), false);
  await observer.flush();
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

test("sink 失败：降级、保留首个原因、后续 record 不再写入", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "blocked");
  writeFileSync(file, "not a directory");
  const observer = createObserver({ file: join(file, "obs.jsonl") });
  observer.record(EVENT);
  await observer.flush();
  assert.equal(observer.status, "degraded");
  assert.ok(observer.failure.length > 0);
  observer.record(EVENT);
  await observer.flush();
  assert.equal(existsSync(join(file, "obs.jsonl")), false);
});

test("schema 失败：不合规事件使观察降级且不写入", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const observer = createObserver({ file });
  observer.record({ operation: "", stage: "run", outcome: "ok", durationMs: 1 });
  assert.equal(observer.status, "degraded");
  await observer.flush();
  assert.equal(existsSync(file), false);
});

test("进程退出：未 flush 的入队记录由 exit drain 同步落盘（Pi RPC 以 process.exit 结束）", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const script = `
    import { createObserver } from ${JSON.stringify(new URL("../../src/observation/index.ts", import.meta.url).href)};
    const observer = createObserver({ file: process.argv[1] });
    observer.record({ operation: "op", stage: "run", outcome: "ok", durationMs: 1 });
    observer.record({ operation: "op", stage: "end", outcome: "ok", durationMs: 1 });
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, file], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const events = readEvents(file);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.stage),
    ["run", "end"],
  );
});
