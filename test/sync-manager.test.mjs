import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { SyncManager } from "../sync.ts";
import { buildPhase0LongTrace } from "./fixtures/phase0-long-trace.mjs";

class MemoryEventStore {
  constructor() {
    this.events = new Map();
    this.failNext = false;
    this.delayMs = 0;
    this.failureMessage = "injected unavailable";
  }

  async writeEvents(_sessionId, events) {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failNext) {
      this.failNext = false;
      if (this.failureError) throw this.failureError;
      const error = new Error(this.failureMessage);
      if (this.failureStatus) error.status = this.failureStatus;
      throw error;
    }
    for (const event of events) {
      const bytes = JSON.stringify(event);
      const existing = this.events.get(event.eventId);
      if (existing !== undefined && existing !== bytes) throw new Error("integrity conflict");
      this.events.set(event.eventId, bytes);
    }
    return { acceptedEventIds: events.map((event) => event.eventId), capabilityVerified: true };
  }
}

function client() {
  return {
    connected: true,
    userRoot: "viking://user/test",
    cfg: { archive: { chunkTokenBudget: 20000, rawTailTokenBudget: 30000 } },
    resolveUserSpace: async () => "test",
    fetchJSON: async () => ({ ok: true, result: {} }),
  };
}

function manager(store, ackPath) {
  return new SyncManager(client(), {
    ackPathForSession: () => ackPath,
    adapterFactory: () => store,
  });
}

function syncBranch(sync, branch) {
  return sync.syncSession({
    isPersisted: () => false,
    getBranch: () => branch,
  });
}

function sessionJsonl(trace, entries) {
  return [
    JSON.stringify({ type: "session", version: 3, id: trace.sessionId, timestamp: "2026-08-17T00:00:00.000Z", cwd: "/workspace" }),
    ...entries.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
}

test("SyncManager 用 entry ACK 处理等长替换、短分支和 ACK 丢失重放", async () => {
  const root = "test/.artifacts/sync-manager";
  const ackPath = `${root}/ack.json`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const trace = buildPhase0LongTrace();
    const store = new MemoryEventStore();
    const first = manager(store, ackPath);
    await first.ensureSession(trace.sessionId);

    const initial = await syncBranch(first, trace.main);
    assert.equal(initial.added, trace.main.length);
    assert.equal(initial.allDelivered, true);
    const initialEventCount = store.events.size;

    const replacement = await syncBranch(first, trace.equalReplacement);
    assert.equal(replacement.added, 4);
    assert.ok(store.events.size > initialEventCount);
    assert.equal((await syncBranch(first, trace.shorter)).added, 0);
    assert.deepEqual(first.status.acknowledgedLeaves, ["entry-assistant-long", "entry-replacement-final"]);

    const restarted = manager(store, ackPath);
    await restarted.ensureSession(trace.sessionId);
    assert.equal((await syncBranch(restarted, trace.main)).added, 0);

    await rm(ackPath);
    const lostAck = manager(store, ackPath);
    await lostAck.ensureSession(trace.sessionId);
    const replay = await syncBranch(lostAck, trace.main);
    assert.equal(replay.added, trace.main.length);
    assert.equal(replay.allDelivered, true);
    assert.equal(store.events.size >= initialEventCount, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("并发同步按 session 串行化且只推进一次 ACK", async () => {
  const root = "test/.artifacts/sync-manager-concurrent";
  const ackPath = `${root}/ack.json`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const trace = buildPhase0LongTrace();
    const store = new MemoryEventStore();
    const sync = manager(store, ackPath);
    await sync.ensureSession(trace.sessionId);
    const results = await Promise.all([syncBranch(sync, trace.main), syncBranch(sync, trace.main)]);
    assert.equal(results.reduce((sum, result) => sum + result.added, 0), trace.main.length);
    assert.deepEqual(sync.status.acknowledgedLeaves, ["entry-assistant-long"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shutdown grace 只等待固定期限内的同步", async () => {
  const root = "test/.artifacts/sync-manager-grace";
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const trace = buildPhase0LongTrace();
    const fastStore = new MemoryEventStore();
    fastStore.delayMs = 5;
    const fast = manager(fastStore, `${root}/fast.json`);
    await fast.ensureSession(trace.sessionId);
    const fastOperation = syncBranch(fast, trace.shorter);
    assert.equal(await fast.waitForIdle(500), true);
    await fastOperation;

    const slowStore = new MemoryEventStore();
    slowStore.delayMs = 25;
    const slow = manager(slowStore, `${root}/slow.json`);
    await slow.ensureSession(`${trace.sessionId}-slow`);
    const slowEntries = structuredClone(trace.shorter);
    const slowOperation = syncBranch(slow, slowEntries);
    assert.equal(await slow.waitForIdle(1), false);
    await slowOperation;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ACK 持久化失败时不推进内存 frontier，修复后通过 unchanged 重放", async () => {
  const root = "test/.artifacts/sync-manager-ack-failure";
  const ackPath = `${root}/ack.json`;
  await rm(root, { recursive: true, force: true });
  await mkdir(ackPath, { recursive: true });
  try {
    const trace = buildPhase0LongTrace();
    const store = new MemoryEventStore();
    const sync = manager(store, ackPath);
    await sync.ensureSession(trace.sessionId);
    const failed = await syncBranch(sync, trace.shorter);
    assert.equal(failed.allDelivered, false);
    assert.deepEqual(sync.status.acknowledgedLeaves, []);
    assert.ok(store.events.size > 0);

    await rm(ackPath, { recursive: true, force: true });
    const recovered = await syncBranch(sync, trace.shorter);
    assert.equal(recovered.allDelivered, true);
    assert.equal(recovered.added, trace.shorter.length);
    assert.deepEqual(sync.status.acknowledgedLeaves, ["entry-tool-error"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SyncManager 从持久 JSONL 读取当前 leaf，失败时不推进 ACK 且 fail-open", async () => {
  const root = "test/.artifacts/sync-manager-persisted";
  const ackPath = `${root}/ack.json`;
  const sessionPath = `${root}/session.jsonl`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const trace = buildPhase0LongTrace();
    const allEntries = [...trace.main, ...trace.equalReplacement.slice(4)];
    await writeFile(sessionPath, sessionJsonl(trace, allEntries));
    const store = new MemoryEventStore();
    store.failNext = true;
    const sync = manager(store, ackPath);
    await sync.ensureSession(trace.sessionId);

    const sessionManager = {
      isPersisted: () => true,
      getSessionFile: () => sessionPath,
      getLeafId: () => trace.equalReplacement.at(-1).id,
    };
    const observed = await sync.observeSession(sessionManager);
    assert.equal(observed.allDelivered, false);
    assert.equal(observed.pending, allEntries.length);
    assert.equal(store.events.size, 0);

    const failed = await sync.syncSession(sessionManager);
    assert.equal(failed.allDelivered, false);
    assert.equal(failed.added, 0);
    assert.equal(sync.status.source, "persistent-jsonl");
    assert.match(sync.status.lastFailure, /injected unavailable/);

    const recovered = await sync.syncSession(sessionManager);
    assert.equal(recovered.allDelivered, true);
    assert.equal(recovered.added, allEntries.length);
    assert.deepEqual(sync.status.acknowledgedLeaves, ["entry-assistant-long", "entry-replacement-final"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Content API capability 不匹配时保持待重放并进入可诊断状态", async () => {
  const root = "test/.artifacts/sync-manager-capability";
  const ackPath = `${root}/ack.json`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const trace = buildPhase0LongTrace();
    const store = new MemoryEventStore();
    store.failNext = true;
    store.failureStatus = 404;
    const sync = manager(store, ackPath);
    await sync.ensureSession(trace.sessionId);
    const result = await syncBranch(sync, trace.shorter);
    assert.equal(result.allDelivered, false);
    assert.equal(result.pending, trace.shorter.length);
    assert.equal(sync.status.capability, "mismatch");
    assert.deepEqual(sync.status.acknowledgedLeaves, []);

    const verificationStore = new MemoryEventStore();
    verificationStore.failNext = true;
    verificationStore.failureMessage = "OpenViking direct byte verification failed";
    const verificationSync = manager(verificationStore, `${root}/verification.json`);
    await verificationSync.ensureSession(`${trace.sessionId}-verification`);
    await syncBranch(verificationSync, trace.shorter);
    // 字节核验失败是完整性问题而非 capability 问题：不得误标 mismatch，ACK 保持冻结。
    assert.equal(verificationSync.status.capability, "unknown");
    assert.deepEqual(verificationSync.status.acknowledgedLeaves, []);
    assert.match(verificationSync.status.lastFailure, /verification failed/);

    // 完整性冲突的诊断必须携带冲突对象 URI，支撑 raw download 排障。
    const conflictStore = new MemoryEventStore();
    conflictStore.failNext = true;
    conflictStore.failureError = Object.assign(
      new Error("RecordedEvent bytes conflict with an existing OpenViking object"),
      { name: "RecordedEventConflictError", uri: "viking://user/dev--pi-x/resources/.pi-openviking/recorded-events/v1/ab/cd/.evt_x.json" },
    );
    const conflictSync = manager(conflictStore, `${root}/conflict.json`);
    await conflictSync.ensureSession(`${trace.sessionId}-conflict`);
    await syncBranch(conflictSync, trace.shorter);
    assert.match(conflictSync.status.lastFailure, /viking:\/\/user\/dev--pi-x.*\.evt_x\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未配置用户时把解析空间同时绑定到 URI、header 和 ACK target", async () => {
  const store = new MemoryEventStore();
  const resolvingClient = {
    userRoot: "",
    cfg: { archive: { chunkTokenBudget: 20000, rawTailTokenBudget: 30000 } },
    recordedEventTarget: { endpoint: "https://example.test", account: "account", user: "" },
    resolveUserSpace: async () => "resolved-user",
    bindUser(user) {
      this.userRoot = `viking://user/${user}`;
      this.recordedEventTarget = { ...this.recordedEventTarget, user };
    },
  };
  let adapterRoot = "";
  const sync = new SyncManager(resolvingClient, {
    ackPathForSession: () => null,
    adapterFactory: (_client, userRoot) => {
      adapterRoot = userRoot;
      return store;
    },
  });
  await sync.ensureSession("resolved-session");
  assert.equal(adapterRoot, "viking://user/resolved-user");
  assert.equal(resolvingClient.recordedEventTarget.user, "resolved-user");
});
