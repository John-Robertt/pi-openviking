import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { SyncManager } from "../sync.ts";
import { buildArchiveManifest, planArchives } from "../shared/archive.mjs";
import { archiveStorageLocation } from "../shared/archive-store.mjs";
import { recordedEventStorageLocation } from "../shared/recorded-event-adapter.mjs";
import { projectPiEntries } from "../shared/recorded-event.mjs";
import { ARCHIVE_USER_ROOT, MemoryContentTransport, archiveEntryChain } from "./fixtures/archive-fixtures.mjs";
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
      { name: "ContentConflictError", uri: "viking://user/dev--pi-x/resources/.pi-openviking/recorded-events/v1/ab/cd/.evt_x.json" },
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


// --- sync → Archive 接线 -----------------------------------------------------
//
// 这里不注入 adapter：让 SyncManager 构造真实的 RecordedEventAdapter 与 ArchiveManager，
// 由内存 Content 边界承担传输，从而覆盖整条接线而不是它的替身。

const ARCHIVE_BUDGETS = { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 };

function contentClient(transport) {
  return {
    connected: true,
    userRoot: ARCHIVE_USER_ROOT,
    cfg: { archive: ARCHIVE_BUDGETS },
    resolveUserSpace: async () => "test",
    statUri: (uri) => transport.statUri(uri),
    mkdirUri: (uri) => transport.mkdirUri(uri),
    batchWrite: (request) => transport.batchWrite(request),
    downloadBytes: (uri) => transport.downloadBytes(uri),
  };
}

/** 共同前缀 A→B，其后分叉出 main 与 sibling 两条链。 */
function forkedTree(sessionId) {
  const shape = Array.from({ length: 5 }, () => ({ role: "assistant", chars: 4000 }));
  const base = archiveEntryChain(shape);
  const main = base.map((entry, index) => (index < 2 ? entry : {
    ...entry, id: `m-${entry.id}`, parentId: index === 2 ? base[1].id : `m-${base[index - 1].id}`,
  }));
  const sibling = base.slice(2).map((entry, index) => ({
    ...entry, id: `s-${entry.id}`, parentId: index === 0 ? base[1].id : `s-${base[index + 1].id}`,
  }));
  return { main, sibling, tree: [...main, ...sibling] };
}

function archivedIds(sessionId, branch, transport) {
  const events = projectPiEntries(sessionId, branch);
  return planArchives(events, ARCHIVE_BUDGETS)
    .map((plan) => buildArchiveManifest(sessionId, events.slice(plan.startIndex, plan.endIndex + 1)).archiveId)
    .filter((id) => transport.files.has(archiveStorageLocation(ARCHIVE_USER_ROOT, sessionId, id).manifestUri));
}

test("进程内来源的 Archive 只覆盖当前 leaf 的祖先链，不收录 sibling 分支", async () => {
  const sessionId = "in-memory-fork";
  const { main, sibling, tree } = forkedTree(sessionId);
  const transport = new MemoryContentTransport();
  const sync = new SyncManager(contentClient(transport), { ackPathForSession: () => null });
  await sync.ensureSession(sessionId);

  const result = await sync.syncSession({
    isPersisted: () => false,
    getEntries: () => tree,
    getBranch: () => main,
  });
  assert.equal(result.allDelivered, true, result.failure ?? "");
  assert.equal(sync.status.archive.lastFailure, null, "整棵树被当作分支时会产生不连续错误");

  const onMain = archivedIds(sessionId, main, transport);
  assert.ok(onMain.length > 0);
  assert.equal(sync.status.archive.committed, onMain.length);
  assert.equal(sync.status.archive.pending, 0);
  // sibling 上独有的事件不得出现在任何已提交 Archive 的范围内。
  const siblingOnly = new Set(projectPiEntries(sessionId, [...main.slice(0, 2), ...sibling])
    .filter((event) => event.source.entryId.startsWith("s-")).map((event) => event.eventId));
  for (const id of onMain) {
    const manifest = JSON.parse(transport.files.get(archiveStorageLocation(ARCHIVE_USER_ROOT, sessionId, id).manifestUri).toString("utf8"));
    assert.equal(siblingOnly.has(manifest.firstEventId) || siblingOnly.has(manifest.lastEventId), false);
  }
});

test("持久 JSONL 切换到较短 sibling leaf 后，Archive 描述新分支且复用共同前缀身份", async () => {
  const sessionId = "jsonl-fork";
  const { main, sibling, tree } = forkedTree(sessionId);
  const transport = new MemoryContentTransport();
  const root = "test/.artifacts/sync-manager-archive-fork";
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    const file = `${root}/session.jsonl`;
    await writeFile(file, [
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-20T00:00:00.000Z", cwd: "/w" }),
      ...tree.map((entry) => JSON.stringify(entry)),
      "",
    ].join("\n"));
    const sync = new SyncManager(contentClient(transport), { ackPathForSession: () => `${root}/ack.json` });
    await sync.ensureSession(sessionId);

    const onMainLeaf = { isPersisted: () => true, getSessionFile: () => file, getLeafId: () => main.at(-1).id };
    assert.equal((await sync.syncSession(onMainLeaf)).allDelivered, true);
    const mainIds = archivedIds(sessionId, main, transport);
    assert.equal(sync.status.archive.committed, mainIds.length);

    const onSiblingLeaf = { isPersisted: () => true, getSessionFile: () => file, getLeafId: () => sibling.at(-1).id };
    assert.equal((await sync.syncSession(onSiblingLeaf)).allDelivered, true);
    const siblingBranch = [...main.slice(0, 2), ...sibling];
    const siblingIds = archivedIds(sessionId, siblingBranch, transport);
    assert.equal(sync.status.archive.committed, siblingIds.length, "计数必须描述当前分支");
    assert.equal(sync.status.archive.lastFailure, null);
    // 共同前缀上的 Archive 身份不变，因此只有分叉之后的部分是新对象。
    assert.ok(siblingIds.some((id) => mainIds.includes(id)), "共同前缀的 archiveId 应当复用");
    assert.ok(siblingIds.some((id) => !mainIds.includes(id)), "分叉之后应当产生新 Archive");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Archive 失败不阻断事件同步与 ACK 推进", async () => {
  const sessionId = "archive-failure-isolated";
  const { main } = forkedTree(sessionId);
  const transport = new MemoryContentTransport();
  const client = contentClient(transport);
  // Archive 命名空间不可达；事件命名空间照常工作。
  client.mkdirUri = async (uri) => (uri.includes("/archives/") ? { ok: false, status: 503 } : transport.mkdirUri(uri));
  const sync = new SyncManager(client, { ackPathForSession: () => null });
  await sync.ensureSession(sessionId);

  const result = await sync.syncSession({ isPersisted: () => false, getEntries: () => main, getBranch: () => main });
  assert.equal(result.allDelivered, true);
  assert.equal(result.failure, null);
  assert.equal(sync.status.pendingEntries, 0);
  assert.equal(sync.status.acknowledgedLeaves.length, 1);
  assert.ok(sync.status.archive.lastFailure, "Archive 失败必须可诊断");
  assert.equal(sync.status.archive.committed, 0);
  const events = projectPiEntries(sessionId, main);
  for (const event of events) {
    assert.ok(transport.files.has(recordedEventStorageLocation(ARCHIVE_USER_ROOT, sessionId, event.eventId).directUri));
  }
});


test("某个 entry 永久无法同步时，已确认前缀仍然形成 Archive", async () => {
  const sessionId = "blocked-entry";
  const shape = Array.from({ length: 6 }, () => ({ role: "assistant", chars: 4000 }));
  const branch = archiveEntryChain(shape);
  const transport = new MemoryContentTransport();
  const client = contentClient(transport);
  const blocked = branch.at(-1).id;
  // 最后一个 entry 的事件对象已被外部写入不同字节：这是 SPEC 定义的永久完整性冲突。
  const blockedEvent = projectPiEntries(sessionId, branch).find((event) => event.source.entryId === blocked);
  transport.files.set(
    recordedEventStorageLocation(ARCHIVE_USER_ROOT, sessionId, blockedEvent.eventId).directUri,
    Buffer.from("foreign bytes"),
  );

  const sync = new SyncManager(client, { ackPathForSession: () => null });
  await sync.ensureSession(sessionId);
  const result = await sync.syncSession({ isPersisted: () => false, getEntries: () => branch, getBranch: () => branch });
  assert.equal(result.allDelivered, false, "冲突 entry 必须停止 ACK 推进");
  assert.ok(result.pending > 0);
  assert.ok(sync.status.archive.committed > 0, "已确认前缀的 Archive 不得被下游 entry 的冲突阻断");
  assert.equal(sync.status.archive.lastFailure, null);
});
