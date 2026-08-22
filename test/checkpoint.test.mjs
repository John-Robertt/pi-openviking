import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCheckpointEvent,
  buildCheckpointFailureEvent,
  buildCheckpointRequestEvent,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointFromOverview,
  checkpointId,
  checkpointRequestEventId,
  checkpointTaskId,
  embeddedImages,
  parseCheckpointEvent,
  parseCheckpointFailureEvent,
  renderCheckpointInput,
  validateCheckpointOverview,
} from "../shared/checkpoint.mjs";
import { ArchiveManager } from "../shared/archive-store.mjs";
import { CheckpointManager } from "../shared/checkpoint-store.mjs";
import { RecordedEventAdapter } from "../shared/recorded-event-adapter.mjs";
import { buildProducedRecordedEvent, projectPiEntries, recordedEventId } from "../shared/recorded-event.mjs";
import {
  ARCHIVE_USER_ROOT,
  MemoryContentTransport,
  archiveEvents,
} from "./fixtures/archive-fixtures.mjs";
import { CHECKPOINT_IMAGE_PNG_BASE64 } from "./fixtures/checkpoint-fixtures.mjs";

const SESSION = "checkpoint-session";

test("多模态 live fixture 是可辨识尺寸的 PNG", () => {
  const png = Buffer.from(CHECKPOINT_IMAGE_PNG_BASE64, "base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 128);
  assert.equal(png.readUInt32BE(20), 128);
});

const OVERVIEW = `# Working Memory

## Session Title
Checkpoint implementation

## Task & Goals
- Implement restart-safe checkpoint recovery
- Verify the live VLM boundary

## Current State
The Archive is verified and checkpoint production is active.

## Key Facts & Decisions
- Preserve source-backed facts and unfinished obligations
- Request and checkpoint facts are append-only
- Archive contentHash binds the source

## Files & Context
- shared/checkpoint.mjs
- shared/checkpoint-store.mjs

## Errors & Corrections
None.

## Open Issues
- Confirm backlog notifications

## Next Action
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
  assert.equal(checkpoint.narrative, validateCheckpointOverview(OVERVIEW));
  assert.doesNotMatch(checkpoint.narrative, /Session Title/);
  assert.deepEqual(Object.keys(checkpoint).sort(), [
    "checkpointId", "model", "narrative", "promptVersion", "sourceArchiveHash", "sourceArchiveId",
  ]);
});

test("每代 checkpoint 只保存当前统一状态，退化局部摘要不可消费", async () => {
  const { descriptors } = await archiveFixture();
  checkpointFromOverview(descriptors[0].manifest, OVERVIEW);
  const updated = OVERVIEW
    .replace("- Implement restart-safe checkpoint recovery\n", "")
    .replace("- Preserve source-backed facts and unfinished obligations\n", "")
    .replace("The Archive is verified", "The next Archive is verified");
  const normalized = validateCheckpointOverview(updated);
  assert.match(normalized, /The next Archive is verified/);
  assert.doesNotMatch(normalized, /Implement restart-safe checkpoint recovery/);
  assert.doesNotMatch(normalized, /Preserve source-backed facts and unfinished obligations/);
  assert.throws(
    () => validateCheckpointOverview("# Session Summary\n\n**Overview**: 1 turns, 1 messages"),
    /missing Working Memory root/,
  );
  assert.throws(
    () => validateCheckpointOverview(`# Working Memory

## Task & Goals
- None

## Current State
- 1 session, 3 messages

## Key Facts & Decisions
- None

## Open Issues
- None

## Files & Context
- None

## Errors & Corrections
- None`),
    /no continuation content in Task & Goals/,
  );
  assert.throws(
    () => validateCheckpointOverview(OVERVIEW.replace("- Confirm backlog notifications", "- 2 messages")),
    /no continuation content in Open Issues/,
  );
  assert.throws(
    () => validateCheckpointOverview(`${OVERVIEW}\n\n## Open Issues\n- A competing issue`),
    /repeats Open Issues/,
  );
  assert.equal(validateCheckpointOverview(OVERVIEW.replaceAll("\n", "\r\n")), validateCheckpointOverview(OVERVIEW));
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
  assert.doesNotMatch(rendered, /"eventId"|"sessionId"|"schemaVersion"/);
});

test("checkpoint 输入保留可见工作但不消费内部注入正文", async () => {
  const { descriptors } = await archiveFixture();
  const events = projectPiEntries("internal-provenance", [
    {
      id: "observation", parentId: null, timestamp: "2026-08-20T00:00:00.000Z",
      type: "custom", customType: "ov-observation",
      data: { schemaVersion: 1, kind: "recall-injection", content: "private recalled block" },
    },
    {
      id: "user", parentId: "observation", timestamp: "2026-08-20T00:00:01.000Z",
      type: "message", message: { role: "user", content: "visible user work" },
    },
  ]);
  const input = renderCheckpointInput(descriptors[0].manifest, events, null);
  assert.match(input, /visible user work/);
  assert.doesNotMatch(input, /private recalled block|recall-injection/);

  const previous = checkpointFromOverview(descriptors[0].manifest, OVERVIEW);
  const updated = JSON.parse(renderCheckpointInput(descriptors[0].manifest, events, previous));
  assert.deepEqual(updated.unifiedContinuation.priorUnifiedState, {
    checkpointId: previous.checkpointId,
    narrative: previous.narrative,
  });
  assert.equal(updated.unifiedContinuation.newContext.entries[0].message.content, "visible user work");
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

test("checkpoint 状态在临时任务清理完成前发布，派生消费者无需等待清理", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  let releaseCleanup;
  const cleanupBlocked = new Promise((resolve) => { releaseCleanup = resolve; });
  let resolvePublished;
  const published = new Promise((resolve) => { resolvePublished = resolve; });
  let scheduleSettled = false;
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    processor: {
      async advance() { return { status: "completed", overview: OVERVIEW }; },
      async cleanup() { await cleanupBlocked; return true; },
    },
    now: clock(),
    onStateChange(status) {
      if (status.mode === "caught_up" && status.lastCheckpointId) resolvePublished();
    },
  });
  const scheduled = manager.schedule(SESSION, [descriptors[0]]).then(() => { scheduleSettled = true; });
  await published;
  assert.equal(manager.status.mode, "caught_up");
  assert.equal(scheduleSettled, false, "状态发布不得等待临时任务清理");
  releaseCleanup();
  await scheduled;
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

test("范围在 checkpoint 写入开始前变化时丢弃旧 VLM 结果并清理临时状态", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  let releaseAdvance;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseAdvance = resolve; });
  let cleanupCalls = 0;
  const observed = [];
  const manager = new CheckpointManager({}, {
    adapter,
    archiveManager: archives,
    observation: { emit: (...args) => observed.push(args) },
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
  assert.equal(
    await adapter.readEventIfExists(SESSION, checkpointEventId(descriptors[0].manifest)),
    null,
    "已离开当前分支的 VLM 结果不得写成 checkpoint 事实",
  );
  assert.ok(observed.some(([stage, branch]) => stage === "checkpoint_request" && branch === "obsolete"));
  assert.equal(cleanupCalls, 2);
  assert.equal(manager.status.mode, "caught_up");
  await manager.stop();
});

test("obsolete request 的清理义务可从 Archive 链跨重启恢复", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  const descriptor = descriptors[1];
  const chain = descriptors.slice(0, 2);
  let releaseAdvance;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const blocked = new Promise((resolve) => { releaseAdvance = resolve; });
  let failedCleanups = 0;
  const first = new CheckpointManager({}, {
    adapter, archiveManager: archives,
    processor: {
      async advance() { markEntered(); await blocked; return { status: "completed", overview: OVERVIEW }; },
      async cleanup() { failedCleanups++; return false; },
    },
    pollIntervalMs: 60_000, now: clock(),
  });
  const processing = first.schedule(SESSION, [descriptor], [chain]);
  await entered;
  void first.schedule(SESSION, [], [chain]);
  releaseAdvance();
  await processing;
  await first.stop();
  assert.ok(failedCleanups >= 1);
  const request1 = await adapter.readEventIfExists(
    SESSION, checkpointRequestEventId(descriptor.manifest, null, 1),
  );
  assert.ok(request1);

  const cleaned = [];
  const restarted = new CheckpointManager({}, {
    adapter, archiveManager: archives,
    processor: {
      async advance() { throw new Error("obsolete request must not resume"); },
      async cleanup(taskId) { cleaned.push(taskId); return true; },
    },
    pollIntervalMs: 60_000, now: clock(),
  });
  await restarted.schedule(SESSION, [], [chain]);
  assert.deepEqual(cleaned, [checkpointTaskId(descriptor.manifest, null, 1)]);

  const failure1 = buildCheckpointFailureEvent({
    requestEvent: request1.event,
    failedAt: "2026-08-20T00:01:00.000Z",
    error: { errorClass: "provider", errorCode: "task_failed", message: "task failed" },
  });
  const request2 = buildCheckpointRequestEvent({
    manifest: descriptor.manifest, previousCheckpointId: null, attempt: 2,
    submittedAt: "2026-08-20T00:02:00.000Z",
  });
  await adapter.writeEvents(SESSION, [failure1, request2]);
  await restarted.schedule(SESSION, [], [chain]);
  assert.deepEqual(cleaned, [
    checkpointTaskId(descriptor.manifest, null, 1),
    checkpointTaskId(descriptor.manifest, null, 2),
  ], "同一候选 scope 的晚到 request 仍会形成清理义务");
  assert.equal(restarted.status.mode, "caught_up");
  assert.equal(restarted.status.lastFailure, null);
  await restarted.stop();
});

test("当前 Archive 列表只追加时不使在途 checkpoint 失效", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  let releaseFirst;
  let markFirst;
  const firstEntered = new Promise((resolve) => { markFirst = resolve; });
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let advances = 0;
  const observed = [];
  const manager = new CheckpointManager({}, {
    adapter, archiveManager: archives,
    observation: { emit: (...args) => observed.push(args) },
    processor: {
      async advance() {
        advances++;
        if (advances === 1) { markFirst(); await firstBlocked; }
        return { status: "completed", overview: OVERVIEW };
      },
      async cleanup() { return true; },
    },
    pollIntervalMs: 60_000, now: clock(),
  });

  const initial = manager.schedule(SESSION, [descriptors[0]]);
  await firstEntered;
  const extended = manager.schedule(SESSION, descriptors.slice(0, 2));
  releaseFirst();
  await initial;
  await extended;
  await manager.schedule(SESSION, descriptors.slice(0, 2));

  assert.ok(await adapter.readEventIfExists(SESSION, checkpointEventId(descriptors[0].manifest)));
  assert.ok(await adapter.readEventIfExists(SESSION, checkpointEventId(descriptors[1].manifest)));
  assert.ok(!observed.some(([stage, branch]) => stage === "checkpoint_request" && branch === "obsolete"));
  await manager.stop();
});

test("checkpoint 写入已开始后范围变化允许首写完成但当前状态只取新范围", async () => {
  const { adapter, archives, descriptors } = await archiveFixture();
  let releaseWrite;
  let markWriteStarted;
  const writeStarted = new Promise((resolve) => { markWriteStarted = resolve; });
  const blockedWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const racingAdapter = {
    readEvent: adapter.readEvent.bind(adapter),
    readEventIfExists: adapter.readEventIfExists.bind(adapter),
    async writeEvents(sessionId, events) {
      if (events[0]?.payload?.type === "checkpoint") {
        markWriteStarted();
        await blockedWrite;
      }
      return adapter.writeEvents(sessionId, events);
    },
  };
  const manager = new CheckpointManager({}, {
    adapter: racingAdapter, archiveManager: archives,
    processor: {
      async advance() { return { status: "completed", overview: OVERVIEW }; },
      async cleanup() { return true; },
    },
    pollIntervalMs: 60_000, now: clock(),
  });

  const processing = manager.schedule(SESSION, [descriptors[0]]);
  await writeStarted;
  void manager.schedule(SESSION, []);
  releaseWrite();
  await processing;
  await manager.schedule(SESSION, []);

  assert.ok(await adapter.readEventIfExists(SESSION, checkpointEventId(descriptors[0].manifest)));
  assert.equal(manager.status.mode, "caught_up");
  assert.equal(manager.status.currentArchiveId, null);
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
