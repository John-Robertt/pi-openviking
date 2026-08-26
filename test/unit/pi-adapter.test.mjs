import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerPiAdapter } from "../../src/pi-adapter/index.ts";
import { CUES_CUSTOM_TYPE } from "../../src/contracts/cue-set.ts";
import { createObserver } from "../../src/observation/index.ts";
import { makeTmp } from "../helpers/tmp.mjs";

function fakePi() {
  const handlers = new Map();
  const appended = [];
  return {
    on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => appended.push({ customType, data }),
    handlers,
    appended,
  };
}

function entry(id, extra = {}) {
  return { id, parentId: null, timestamp: `2026-08-26T00:00:${id}`, ...extra };
}

function fakeCtx({ sessionId = "sid-1", entries = [], branch, contextEntries } = {}) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => entries,
      getBranch: () => branch ?? entries,
      buildContextEntries: () => contextEntries ?? branch ?? entries,
      getEntry: (id) => entries.find((e) => e.id === id),
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
const cueEntry = (id, data) => entry(id, { type: "custom", customType: CUES_CUSTOM_TYPE, data });
const validCueSet = { cues: ["cue-a", "cue-b"], lastUsedEntryId: "e2" };

test("注册点：必需的 lifecycle、compaction 与 context handler 已注册", () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null), active: ACTIVE });
  for (const event of ["session_start", "session_shutdown", "turn_end", "session_compact", "context"]) {
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
  const contextResult = await pi.handlers.get("context")({ type: "context", messages: [] }, fakeCtx());
  assert.equal(contextResult, undefined);
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
  registerPiAdapter(pi, {
    observer,
    active: ACTIVE,
    resolveCueSet: () => {
      throw new Error("probe failure");
    },
  });
  await assert.rejects(
    () =>
      pi.handlers.get("session_compact")(
        { type: "session_compact", compactionEntry: entry("c1"), fromExtension: false },
        fakeCtx({ entries: [entry("e1")] }),
      ),
    /probe failure/,
  );
  await observer.flush();
  const events = readEvents(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, "error");
  assert.match(events[0].error, /probe failure/);
  assert.equal(pi.appended.length, 0);
});

test("来源 entries 交付：turn_end 与 session_compact 都交付过滤后的全量快照", async () => {
  const pi = fakePi();
  const deliveries = [];
  // 排除自身 CueSet custom entry；其他扩展的 custom entry 是 Pi 已接受事实，原样保留并保持顺序。
  const entries = [
    entry("e1", { type: "message" }),
    cueEntry("cue1", validCueSet),
    entry("e2", { type: "custom", customType: "other-extension.state", data: {} }),
  ];
  registerPiAdapter(pi, {
    observer: createObserver(null),
    active: ACTIVE,
    onSourceEntries: (snapshot) => deliveries.push(snapshot),
  });
  const ctx = fakeCtx({ entries });
  await pi.handlers.get("turn_end")({ type: "turn_end" }, ctx);
  await pi.handlers.get("session_compact")(
    { type: "session_compact", compactionEntry: entry("c1"), fromExtension: false },
    ctx,
  );
  assert.equal(deliveries.length, 2);
  for (const snapshot of deliveries) assert.deepEqual(snapshot, [entries[0], entries[2]]);
});

test("来源 entries 交付：接收方缺省时不执行收集", async () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null), active: ACTIVE });
  const ctx = fakeCtx();
  ctx.sessionManager.getEntries = () => {
    throw new Error("不应被调用");
  };
  await pi.handlers.get("turn_end")({ type: "turn_end" }, ctx);
});

test("session_compact：resolveCueSet 缺省或无结果时不保存", async () => {
  const without = fakePi();
  registerPiAdapter(without, { observer: createObserver(null), active: ACTIVE });
  await without.handlers.get("session_compact")(
    { type: "session_compact", compactionEntry: entry("c1"), fromExtension: false },
    fakeCtx({ entries: [entry("e1")] }),
  );
  const empty = fakePi();
  registerPiAdapter(empty, {
    observer: createObserver(null),
    active: ACTIVE,
    resolveCueSet: () => undefined,
  });
  await empty.handlers.get("session_compact")(
    { type: "session_compact", compactionEntry: entry("c1"), fromExtension: false },
    fakeCtx({ entries: [entry("e1")] }),
  );
  assert.equal(without.appended.length, 0);
  assert.equal(empty.appended.length, 0);
});

test("session_compact：结果引用的最后一条 entry 在当前路径时才保存为 custom entry", async () => {
  const pi = fakePi();
  registerPiAdapter(pi, {
    observer: createObserver(null),
    active: ACTIVE,
    resolveCueSet: () => validCueSet,
  });
  const entries = [entry("e1"), entry("e2"), entry("c1", { type: "compaction" })];
  await pi.handlers.get("session_compact")(
    { type: "session_compact", compactionEntry: entries[2], fromExtension: false },
    fakeCtx({ entries }),
  );
  assert.deepEqual(pi.appended, [{ customType: CUES_CUSTOM_TYPE, data: validCueSet }]);
});

test("session_compact：tree 已导航（引用 entry 不在当前路径）时不保存", async () => {
  const pi = fakePi();
  registerPiAdapter(pi, {
    observer: createObserver(null),
    active: ACTIVE,
    resolveCueSet: () => validCueSet,
  });
  const entries = [entry("e1"), entry("e2"), entry("c1", { type: "compaction" })];
  await pi.handlers.get("session_compact")(
    { type: "session_compact", compactionEntry: entries[2], fromExtension: false },
    fakeCtx({ entries, branch: [entries[0], entries[2]] }),
  );
  assert.equal(pi.appended.length, 0);
});

test("context：当前路径没有 CueSet 时保持 messages 不变", async () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null), active: ACTIVE });
  const messages = [{ role: "user", content: "hi", timestamp: 1 }];
  const result = await pi.handlers.get("context")(
    { type: "context", messages },
    fakeCtx({ entries: [entry("e1", { type: "message" })] }),
  );
  assert.equal(result, undefined);
});

test("context：临时追加当前路径最后一个有效 CueSet，覆盖时间取最后用到 entry 的 timestamp", async () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null), active: ACTIVE });
  const entries = [
    entry("e1", { type: "message" }),
    entry("e2", { type: "message" }),
    cueEntry("cue-old", { cues: ["old"], lastUsedEntryId: "e1" }),
    entry("c1", { type: "compaction" }),
    cueEntry("cue-new", validCueSet),
  ];
  const messages = [{ role: "user", content: "hi", timestamp: 1 }];
  const result = await pi.handlers.get("context")(
    { type: "context", messages },
    fakeCtx({ entries }),
  );
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0], messages[0]);
  const injected = result.messages[1];
  assert.equal(injected.role, "user");
  assert.match(injected.content, /cue-a/);
  assert.doesNotMatch(injected.content, /old/);
  // e2.timestamp 是 `2026-08-26T00:00:e2`
  assert.match(injected.content, /covering up to 2026-08-26T00:00:e2/);
  assert.match(injected.content, /not complete/);
});

test("context：CueSet 数据形状不符时不投影", async () => {
  const pi = fakePi();
  registerPiAdapter(pi, { observer: createObserver(null), active: ACTIVE });
  const malformed = [cueEntry("cue1", { cues: "not-an-array", lastUsedEntryId: 42 })];
  const result = await pi.handlers.get("context")(
    { type: "context", messages: [] },
    fakeCtx({ entries: malformed }),
  );
  assert.equal(result, undefined);
});
