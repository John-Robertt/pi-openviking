import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckpointEvent,
  buildCheckpointFailureEvent,
  buildCheckpointRequestEvent,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointId,
  checkpointRequestEventId,
  checkpointTaskId,
  embeddedImages,
  parseCheckpointEvent,
  parseCheckpointFailureEvent,
  renderCheckpointInput,
} from "../shared/checkpoint.mjs";
import { ArchiveManager } from "../shared/archive-store.mjs";
import { CheckpointManager } from "../shared/checkpoint-store.mjs";
import { RecordedEventAdapter } from "../shared/recorded-event-adapter.mjs";
import { buildProducedRecordedEvent, recordedEventId } from "../shared/recorded-event.mjs";
import {
  ARCHIVE_USER_ROOT,
  MemoryContentTransport,
  archiveEvents,
} from "./fixtures/archive-fixtures.mjs";

const SESSION = "checkpoint-session";
const OVERVIEW = `# Working Memory

## Session Title
Checkpoint implementation

## Current State
The Archive is verified and checkpoint production is active.

## Task & Goals
- Implement restart-safe checkpoint recovery
- Verify the live VLM boundary

## Key Facts & Decisions
- Request and checkpoint facts are append-only
- Archive contentHash binds the source

## Files & Context
- shared/checkpoint.mjs
- shared/checkpoint-store.mjs

## Errors & Corrections
None.

## Open Issues
- Confirm backlog notifications`;

async function archiveFixture() {
  const events = archiveEvents(SESSION);
  const transport = new MemoryContentTransport();
  const adapter = new RecordedEventAdapter(transport, { userRoot: ARCHIVE_USER_ROOT });
  await adapter.writeEvents(SESSION, events);
  const archives = new ArchiveManager(transport, {
    userRoot: ARCHIVE_USER_ROOT,
    adapter,
    budgets: { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 },
  });
  const formed = await archives.formArchives(SESSION, events);
  return { events, transport, adapter, archives, descriptors: formed.archives };
}

function clock() {
  let second = 0;
  return () => `2026-08-20T00:00:${String(second++).padStart(2, "0")}.000Z`;
}

test("自产事件身份按 source system/id/type 确定且保持规范字节", () => {
  const source = { system: "pi-openviking", sourceId: "task-1", sourceType: "checkpoint-request" };
  const event = buildProducedRecordedEvent({
    ...source,
    parentId: null,
    occurredAt: "2026-08-20T00:00:00.000Z",
    payload: { ok: true },
  });
  assert.equal(event.eventId, recordedEventId(source));
  assert.match(event.eventId, /^evt_[0-9a-f]{64}$/);
  assert.notEqual(event.eventId, recordedEventId({ ...source, sourceType: "checkpoint-failure" }));
});

test("checkpoint、task 与事件身份绑定 Archive/hash/model/prompt/attempt", async () => {
  const { descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const id = checkpointId(manifest);
  assert.match(id, /^chk_[0-9a-f]{64}$/);
  assert.notEqual(checkpointTaskId(manifest, null, 1), checkpointTaskId(manifest, null, 2));
  assert.match(checkpointEventId(manifest), /^evt_[0-9a-f]{64}$/);
  assert.notEqual(checkpointRequestEventId(manifest, null, 1), checkpointFailureEventId(manifest, null, 1));
});

test("Working Memory 正向投影为结构化 checkpoint 并保持来源自证", async () => {
  const { descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const request = buildCheckpointRequestEvent({ manifest, attempt: 1, submittedAt: "2026-08-20T00:00:00.000Z" });
  const event = buildCheckpointEvent({ manifest, requestEvent: request, overview: OVERVIEW, completedAt: "2026-08-20T00:01:00.000Z" });
  const checkpoint = parseCheckpointEvent(event, manifest);
  assert.equal(checkpoint.sourceArchiveId, manifest.archiveId);
  assert.equal(checkpoint.sourceArchiveHash, manifest.contentHash);
  assert.deepEqual(checkpoint.completed, [
    "Request and checkpoint facts are append-only",
    "Archive contentHash binds the source",
  ]);
  assert.deepEqual(checkpoint.openItems, ["Confirm backlog notifications"]);
  assert.equal(checkpoint.nextEntry, "Implement restart-safe checkpoint recovery");
  assert.deepEqual(checkpoint.retrievalCues, [
    "shared/checkpoint.mjs",
    "shared/checkpoint-store.mjs",
    "Checkpoint implementation",
  ]);
});

test("checkpoint-failure 只持久化代码拥有的错误分类与消息", async () => {
  const { descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const request = buildCheckpointRequestEvent({ manifest, attempt: 1, submittedAt: "2026-08-20T00:00:00.000Z" });
  const event = buildCheckpointFailureEvent({
    requestEvent: request,
    failedAt: "2026-08-20T00:01:00.000Z",
    error: { errorClass: "provider", errorCode: "task_failed", message: "Authorization: Bearer sk-review-secret" },
  });
  const failure = parseCheckpointFailureEvent(event);
  assert.deepEqual(failure.error, {
    errorClass: "protocol",
    errorCode: "task_failed",
    message: "checkpoint VLM task failed",
  });
});

test("多模态输入用内容 hash 与语义摘要替换 base64，不复制图片正文到 VLM 文本", async () => {
  const { descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const imageEvents = archiveEvents("image-session", [{ role: "user", chars: 10 }]);
  imageEvents[0].source.partType = "image";
  imageEvents[0].payload.part = {
    container: "message.content",
    form: "array",
    count: 1,
    value: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  };
  const images = embeddedImages(imageEvents);
  assert.equal(images.length, 1);
  const rendered = renderCheckpointInput(manifest, imageEvents, null, [{
    eventId: images[0].eventId,
    mimeType: images[0].mimeType,
    byteLength: images[0].bytes.length,
    contentHash: images[0].contentHash,
    abstract: "a small image",
  }]);
  assert.doesNotMatch(rendered, /aGVsbG8=/);
  assert.match(rendered, /a small image/);
  assert.match(rendered, /sha256:/);
});

test("失败重试、积压恢复与重放只产生一个有效 checkpoint", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  const calls = [];
  const notifications = [];
  const attempts = new Map();
  const processor = {
    async advance(input) {
      calls.push(input.taskId);
      const count = (attempts.get(input.manifest.archiveId) ?? 0) + 1;
      attempts.set(input.manifest.archiveId, count);
      if (input.manifest.archiveId === descriptors[0].manifest.archiveId && count === 1) {
        return { status: "failed", error: { errorClass: "protocol", errorCode: "task_failed", message: "sanitized failure" } };
      }
      return { status: "completed", overview: OVERVIEW };
    },
    async cleanup() { return true; },
  };
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor,
    notify: (message, level) => notifications.push({ message, level }),
    pollIntervalMs: 1,
    now: clock(),
  });
  await manager.schedule(SESSION, descriptors);
  assert.equal(manager.status.mode, "caught_up");
  assert.equal(manager.status.pending, 0);
  assert.equal(manager.status.consumed, descriptors.length);
  assert.equal(calls.length, descriptors.length + 1);
  assert.ok(notifications.some((item) => item.message.includes("消费落后")));
  assert.ok(notifications.some((item) => item.message.includes("失败")));
  assert.ok(notifications.some((item) => item.message.includes("已恢复")));

  const first = descriptors[0].manifest;
  assert.ok(await adapter.readEventIfExists(SESSION, checkpointFailureEventId(first, null, 1)));
  assert.ok(await adapter.readEventIfExists(SESSION, checkpointEventId(first)));

  const replay = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: { async advance() { throw new Error("must not rerun VLM"); }, async cleanup() { return true; } },
    pollIntervalMs: 1,
    now: clock(),
  });
  await replay.schedule(SESSION, descriptors);
  assert.equal(replay.status.mode, "caught_up");
  assert.equal(replay.status.consumed, descriptors.length);
});

test("进程重启从 request 事实恢复同一 task 并完成 checkpoint", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const taskIds = [];
  const first = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance(input) { taskIds.push(input.taskId); return { status: "processing" }; },
      async cleanup() { return true; },
    },
    pollIntervalMs: 60000,
    now: clock(),
  });
  await first.schedule(SESSION, [descriptors[0]]);
  assert.equal(first.status.mode, "processing");
  await first.stop();

  const second = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance(input) { taskIds.push(input.taskId); return { status: "completed", overview: OVERVIEW }; },
      async cleanup() { return true; },
    },
    pollIntervalMs: 1,
    now: clock(),
  });
  await second.schedule(SESSION, [descriptors[0]]);
  assert.equal(second.status.mode, "caught_up");
  assert.equal(taskIds.length, 2);
  assert.equal(taskIds[0], taskIds[1]);
  assert.ok(await adapter.readEventIfExists(SESSION, checkpointEventId(manifest)));
});

test("没有 request 事实链的 checkpoint 不会被接受为已消费", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const request = buildCheckpointRequestEvent({ manifest, attempt: 1, submittedAt: "2026-08-20T00:00:00.000Z" });
  const checkpoint = buildCheckpointEvent({
    manifest,
    requestEvent: request,
    overview: OVERVIEW,
    completedAt: "2026-08-20T00:01:00.000Z",
  });
  await adapter.writeEvents(SESSION, [checkpoint]);
  let advances = 0;
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: { async advance() { advances++; return { status: "completed", overview: OVERVIEW }; }, async cleanup() { return true; } },
    pollIntervalMs: 60_000,
    now: clock(),
  });
  await manager.schedule(SESSION, [descriptors[0]]);
  assert.equal(manager.status.consumed, 0);
  assert.equal(advances, 0);
  assert.match(manager.status.lastFailure, /request|chain/);
  await manager.stop();
});

test("多个 Archive 各自重试到第三次后仍在一次调度中顺序追平", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  assert.ok(descriptors.length >= 3);
  const selected = descriptors.slice(0, 3);
  const attempts = new Map();
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance({ manifest }) {
        const count = (attempts.get(manifest.archiveId) ?? 0) + 1;
        attempts.set(manifest.archiveId, count);
        return count < 3
          ? { status: "failed", error: { errorClass: "protocol", errorCode: "task_failed", message: "external detail" } }
          : { status: "completed", overview: OVERVIEW };
      },
      async cleanup() { return true; },
    },
    pollIntervalMs: 60_000,
    now: clock(),
  });
  await manager.schedule(SESSION, selected);
  assert.equal(manager.status.mode, "caught_up");
  assert.equal(manager.status.consumed, 3);
  assert.deepEqual(selected.map(({ manifest }) => attempts.get(manifest.archiveId)), [3, 3, 3]);
  await manager.stop();
});

test("并发事实首写采用已提交的 request/checkpoint 而不是永久冲突", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  const selected = [descriptors[0]];
  const gates = new Map();
  const meet = async (type) => {
    let gate = gates.get(type);
    if (!gate) {
      let release;
      gate = { calls: 0, done: false, promise: new Promise((resolve) => { release = resolve; }), release };
      gates.set(type, gate);
    }
    if (gate.done) return;
    gate.calls++;
    if (gate.calls === 2) { gate.done = true; gate.release(); return; }
    await gate.promise;
  };
  const racingAdapter = {
    readEvent: adapter.readEvent.bind(adapter),
    readEventIfExists: adapter.readEventIfExists.bind(adapter),
    async writeEvents(sessionId, events) {
      const type = events.length === 1 ? events[0]?.payload?.type : null;
      if (type === "checkpoint-request") await meet(type);
      return adapter.writeEvents(sessionId, events);
    },
  };
  const makeManager = (timestamp) => new CheckpointManager({}, {
    adapter: racingAdapter,
    archiveManager: archives,
    processor: { async advance() { return { status: "completed", overview: OVERVIEW }; }, async cleanup() { return true; } },
    pollIntervalMs: 60_000,
    now: () => timestamp,
  });
  const first = makeManager("2026-08-20T00:10:00.000Z");
  const second = makeManager("2026-08-20T00:20:00.000Z");
  await Promise.all([first.schedule(SESSION, selected), second.schedule(SESSION, selected)]);
  assert.equal(first.status.consumed, 1);
  assert.equal(second.status.consumed, 1);
  assert.equal(first.status.lastCheckpointId, second.status.lastCheckpointId);
  await Promise.all([first.stop(), second.stop()]);
});

test("恢复时从终态事实重新派生并完成临时状态清理", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  const manifest = descriptors[0].manifest;
  const request = buildCheckpointRequestEvent({ manifest, attempt: 1, submittedAt: "2026-08-20T00:00:00.000Z" });
  const checkpoint = buildCheckpointEvent({
    manifest,
    requestEvent: request,
    overview: OVERVIEW,
    completedAt: "2026-08-20T00:01:00.000Z",
  });
  await adapter.writeEvents(SESSION, [request, checkpoint]);
  const cleaned = [];
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance() { throw new Error("terminal fact must not rerun VLM"); },
      async cleanup(taskId) { cleaned.push(taskId); return true; },
    },
    pollIntervalMs: 60_000,
    now: clock(),
  });
  await manager.schedule(SESSION, [descriptors[0]]);
  assert.deepEqual(cleaned, [checkpointTaskId(manifest, null, 1)]);
  assert.equal(manager.status.mode, "caught_up");
  await manager.stop();
});

test("当前分支在途处理完成后切换范围仍会重试终态临时清理", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  let releaseAdvance;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseAdvance = resolve; });
  let cleanupCalls = 0;
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance() { markEntered(); await blocked; return { status: "completed", overview: OVERVIEW }; },
      async cleanup() { cleanupCalls++; return cleanupCalls > 1; },
    },
    pollIntervalMs: 60_000,
    now: clock(),
  });
  const processing = manager.schedule(SESSION, [descriptors[0]]);
  await entered;
  void manager.schedule(SESSION, []);
  releaseAdvance();
  await processing;
  await manager.schedule(SESSION, []);
  assert.equal(cleanupCalls, 2);
  assert.equal(manager.status.mode, "caught_up");
  await manager.stop();
});

test("重试耗尽进入 failed，不宣称恢复且最后一次不再提示将重试", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  assert.ok(descriptors.length >= 2);
  const notifications = [];
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance() { return { status: "failed", error: { errorClass: "protocol", errorCode: "task_failed", message: "external detail" } }; },
      async cleanup() { return true; },
    },
    notify: (message) => notifications.push(message),
    pollIntervalMs: 60_000,
    now: clock(),
  });
  await manager.schedule(SESSION, descriptors.slice(0, 2));
  assert.equal(manager.status.mode, "failed");
  assert.ok(notifications.some((message) => message.includes("重试已耗尽")));
  assert.ok(!notifications.some((message) => message.includes("消费已恢复")));
  await manager.stop();
});
