import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function readEvents(file) {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
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

test("装配成功：注册 handler 并记录 assembly ok 事件", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  withEnv(file, () => {
    const pi = fakePi();
    extension(pi);
    assert.deepEqual([...pi.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
    const events = readEvents(file);
    assert.equal(events.length, 1);
    assert.deepEqual(
      { operation: events[0].operation, stage: events[0].stage, outcome: events[0].outcome },
      { operation: "assembly", stage: "compose", outcome: "ok" },
    );
  });
});

test("装配失败：factory 不抛、部分注册保留、记录 assembly error 事件", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  withEnv(file, () => {
    const pi = fakePi({ throwOn: "session_shutdown" });
    assert.doesNotThrow(() => extension(pi));
    assert.deepEqual([...pi.handlers.keys()], ["session_start"]);
    const events = readEvents(file);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "error");
    assert.match(events[0].error, /probe assembly failure/);
  });
});

test("未请求观察：装配不产生观察文件", (t) => {
  const dir = makeTmp(t);
  const file = join(dir, "obs.jsonl");
  withEnv(undefined, () => {
    extension(fakePi());
    assert.throws(() => readEvents(file), /ENOENT/);
  });
});
