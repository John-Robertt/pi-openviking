import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => (lines.push(String(chunk)), true);
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test("注册点：必需的 session lifecycle handler 已注册", () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null) });
  for (const event of ["session_start", "session_shutdown"]) {
    assert.equal(typeof pi.handlers.get(event), "function", `${event} handler 未注册`);
  }
});

test("成功链路：事件按 operation 关联，session 身份进入记录", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver({ file }) });
  await pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, fakeCtx());
  await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, fakeCtx());
  const events = readEvents(file);
  assert.deepEqual(
    events.map((e) => e.operation),
    ["session_start", "session_shutdown"],
  );
  assert.ok(events.every((e) => e.outcome === "ok" && e.session === "sid-1" && e.runId === events[0].runId));
});

test("失败链路：handler 抛错不传播，记录 error 事件并输出 stderr 诊断", async (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver({ file }) });
  const lines = await captureStderr(async () => {
    await assert.doesNotReject(() =>
      pi.handlers.get("session_start")({ type: "session_start", reason: "startup" }, throwingCtx()),
    );
  });
  const events = readEvents(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "error");
  assert.match(events[0].error, /probe failure/);
  assert.ok(lines.some((line) => line.includes("session_start failed: probe failure")));
});
