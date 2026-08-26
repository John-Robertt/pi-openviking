import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import extension from "../../src/index.ts";
import { makeTmp } from "../helpers/tmp.mjs";

function fakePi({ throwOn } = {}) {
  const handlers = new Map();
  return {
    handlers,
    on: (name, handler) => {
      if (name === throwOn) throw new Error("probe assembly failure");
      handlers.set(name, handler);
    },
  };
}

function fakeCtx(sessionId = "sid-1") {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function readEvents(file) {
  const content = readFileSync(file, "utf8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

/** observer 经 Composition Root 内部创建，测试只能轮询 sink 直到预期记录数出现。 */
async function readEventsWhen(file, count) {
  for (let i = 0; i < 200; i += 1) {
    if (existsSync(file)) {
      const events = readEvents(file);
      if (events.length >= count) return events;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`等待 ${file} 出现 ${count} 条记录超时`);
}

function withEnv(value, fn) {
  const original = process.env.PI_OPENVIKING_OBSERVE;
  if (value === undefined) delete process.env.PI_OPENVIKING_OBSERVE;
  else process.env.PI_OPENVIKING_OBSERVE = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PI_OPENVIKING_OBSERVE;
    else process.env.PI_OPENVIKING_OBSERVE = original;
  }
}

test("装配成功：handler 注册并进入 active，事件与 assembly ok 记录可关联", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  await withEnv(file, async () => {
    const pi = fakePi();
    extension(pi);
    for (const event of ["session_start", "session_shutdown"]) {
      assert.equal(typeof pi.handlers.get(event), "function", `${event} handler 未注册`);
    }
    await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, fakeCtx());
    const events = await readEventsWhen(file, 2);
    assert.deepEqual(
      events.map((e) => [e.operation, e.outcome]),
      [
        ["assembly", "ok"],
        ["session_start", "ok"],
      ],
    );
    assert.equal(events[1].session, "sid-1");
  });
});

test("装配失败：factory 不抛、记录 assembly error，已注册 handler 保持 inert", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  await withEnv(file, async () => {
    const pi = fakePi({ throwOn: "session_shutdown" });
    assert.doesNotThrow(() => extension(pi));
    assert.equal(typeof pi.handlers.get("session_start"), "function", "失败前注册的 handler 存在");
    // inert：handler 直接返回，不执行扩展工作，也不产生记录。
    await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, fakeCtx());
    const events = await readEventsWhen(file, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, "assembly");
    assert.equal(events[0].outcome, "error");
    assert.match(events[0].error, /probe assembly failure/);
  });
});
