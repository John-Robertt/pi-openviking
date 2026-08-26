import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerPiAdapter } from "../../src/pi-adapter/index.ts";
import { createObserver } from "../../src/observation/index.ts";
import { makeTmp } from "../helpers/tmp.mjs";

function fakePi() {
  const handlers = new Map();
  return { on: (name, handler) => handlers.set(name, handler), handlers };
}

function fakeCtx(sessionId = "sid-1") {
  return { sessionManager: { getSessionId: () => sessionId } };
}

function throwingCtx() {
  return {
    sessionManager: {
      getSessionId: () => {
        throw new Error("probe failure");
      },
    },
  };
}

function readEvents(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

const ACTIVE = () => true;

test("注册点：必需的 session lifecycle handler 已注册", () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null), active: ACTIVE });
  for (const event of ["session_start", "session_shutdown"]) {
    assert.equal(typeof pi.handlers.get(event), "function", `${event} handler 未注册`);
  }
});

test("inert：active 为 false 时 handler 直接返回，不产生观察记录", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const pi = fakePi();
  const observer = createObserver({ file });
  registerPiAdapter(pi, { observer, active: () => false });
  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, fakeCtx());
  await observer.flush();
  assert.equal(existsSync(file), false);
});

test("成功链路：事件按 operation 关联，session 身份进入记录", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const pi = fakePi();
  const observer = createObserver({ file });
  registerPiAdapter(pi, { observer, active: ACTIVE });
  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, fakeCtx());
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, fakeCtx());
  await observer.flush();
  const events = readEvents(file);
  assert.deepEqual(
    events.map((e) => e.operation),
    ["session_start", "session_shutdown"],
  );
  assert.ok(events.every((e) => e.outcome === "ok" && e.session === "sid-1" && e.runId === events[0].runId));
});

test("失败链路：handler 异常沿调用方（Pi 原生错误路径）传播，并记录 error 事件", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const pi = fakePi();
  const observer = createObserver({ file });
  registerPiAdapter(pi, { observer, active: ACTIVE });
  await assert.rejects(
    () => pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, throwingCtx()),
    /probe failure/,
  );
  await observer.flush();
  const events = readEvents(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "error");
  assert.match(events[0].error, /probe failure/);
});
