import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  ActiveContextManager,
  activeContextFileKey,
  activeContextOnBranch,
  anchorEvents,
  clearActiveContext,
  evaluateEligibility,
  evaluateTakeoverTrigger,
  materializeActiveContext,
  renderActiveContextMessages,
  normalizeActiveContext,
  payloadSegment,
  readActiveContext,
  selectActiveContext,
  writeActiveContext,
} from "../shared/active-context.mjs";
import { readTaskModelContext } from "../shared/task-model-context.mjs";
import { describeArchives } from "../shared/archive.mjs";
import {
  buildCheckpointEvent,
  buildCheckpointRequestEvent,
  checkpointEventIdFor,
  checkpointId,
  parseCheckpointEventById,
} from "../shared/checkpoint.mjs";
import { eventTokenWeight } from "../shared/context-weight.mjs";
import { projectPiEntries, recordedEventBytes } from "../shared/recorded-event.mjs";
import { ARCHIVE_LINEAR_CHAIN, archiveEvents } from "./fixtures/archive-fixtures.mjs";
import { checkpointOverview } from "./fixtures/checkpoint-fixtures.mjs";

const SESSION = "active-context-session";
const BUDGETS = { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 };
const TAKEOVER = { enabled: true, contextTokenThreshold: 0 };
const CAPACITY = { contextWindow: 272000, maxTokens: 128000 };
const OVERVIEW = checkpointOverview("close the active context exit");

function fixture(specs = ARCHIVE_LINEAR_CHAIN) {
  const events = archiveEvents(SESSION, specs);
  const archives = describeArchives(SESSION, events, BUDGETS);
  return { events, archives };
}

function checkpointEventFor(manifest, previousCheckpointId = null, overview = OVERVIEW) {
  const requestEvent = buildCheckpointRequestEvent({
    manifest,
    previousCheckpointId,
    attempt: 1,
    submittedAt: "2026-08-21T00:00:00.000Z",
  });
  return buildCheckpointEvent({
    manifest,
    requestEvent,
    overview,
    completedAt: "2026-08-21T00:00:10.000Z",
  });
}

/** 只提供 ActiveContext 需要的读路径：按 event ID 返回已存事实。 */
function adapterFor(events) {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  return {
    failNext: null,
    async readEvent(_sessionId, eventId) {
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = null;
        throw error;
      }
      const event = byId.get(eventId);
      if (!event) throw new Error(`event is missing: ${eventId}`);
      return { event, bytes: recordedEventBytes(event) };
    },
  };
}

async function temporaryDir(t) {
  const root = join("test", ".artifacts", "active-context");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `${process.pid}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("ActiveContext 文件身份按端点、账号、用户与会话确定性绑定", () => {
  const target = { endpoint: "https://example.test", account: "dev", user: "dev--pi-1" };
  const key = activeContextFileKey(target, SESSION);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(key, activeContextFileKey({ ...target }, SESSION));
  assert.notEqual(key, activeContextFileKey({ ...target, user: "dev--pi-2" }, SESSION));
  assert.notEqual(key, activeContextFileKey(target, "other-session"));
});

test("持久化内容只接受两个字段，其余一律视为没有活动上下文", async (t) => {
  const dir = await temporaryDir(t);
  const path = join(dir, "active-context.json");
  const context = {
    checkpointId: `chk_${"a".repeat(64)}`,
    rawTailStartEventId: `evt_${"b".repeat(64)}`,
  };
  assert.deepEqual(normalizeActiveContext(context), context);
  assert.equal(normalizeActiveContext({ ...context, anchorEventId: `evt_${"c".repeat(64)}` }), null);
  assert.equal(normalizeActiveContext({ checkpointId: context.checkpointId }), null);
  assert.equal(normalizeActiveContext({ ...context, checkpointId: "chk_short" }), null);

  assert.equal(await readActiveContext(path), null);
  await writeActiveContext(path, context);
  assert.deepEqual(await readActiveContext(path), context);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), context);
  assert.deepEqual(await readdir(dir), ["active-context.json"], "临时文件必须被清理");

  await writeFile(path, "{ not json", "utf8");
  assert.equal(await readActiveContext(path), null, "损坏内容等价于没有活动上下文");
  await clearActiveContext(path);
  assert.deepEqual(await readdir(dir), []);
});

test("候选来自最后一个已消费 Archive，raw tail 从其边界的下一个事件开始", () => {
  const { events, archives } = fixture();
  assert.equal(archives.length, 3);
  const consumed = archives[1];
  const context = selectActiveContext(events, archives, checkpointId(consumed.manifest));
  const boundaryIndex = events.findIndex((event) => event.eventId === consumed.manifest.lastEventId);
  assert.deepEqual(context, {
    checkpointId: checkpointId(consumed.manifest),
    rawTailStartEventId: events[boundaryIndex + 1].eventId,
  });
  assert.equal(selectActiveContext(events, archives, null), null);
  assert.equal(selectActiveContext(events, archives, `chk_${"f".repeat(64)}`), null);
  // 归档前缀之后还没有事件时没有可接管的上下文。
  const last = archives.at(-1);
  const truncated = events.slice(0, events.findIndex((event) => event.eventId === last.manifest.lastEventId) + 1);
  assert.equal(selectActiveContext(truncated, archives, checkpointId(last.manifest)), null);
});

test("复用条件是 raw tail 起点仍在当前分支的事件链上", () => {
  const { events } = fixture();
  const context = { checkpointId: `chk_${"a".repeat(64)}`, rawTailStartEventId: events[3].eventId };
  assert.equal(activeContextOnBranch(context, events), true);
  assert.equal(activeContextOnBranch(context, events.slice(0, 3)), false);
  assert.equal(activeContextOnBranch(null, events), false);
});

test("anchor 是建立 raw tail 所属 turn 的 user entry 的全部事件", () => {
  const { events } = fixture();
  const anchor = anchorEvents(events, events[3].eventId);
  assert.deepEqual(anchor.map((event) => event.eventId), [events[0].eventId]);
  assert.equal(anchor[0].turnId, events[3].turnId);
  // anchor 本身就是 raw tail 的头部时不重复注入。
  assert.deepEqual(anchorEvents(events, events[0].eventId), []);
  // 不属于当前分支的起点没有 anchor。
  assert.deepEqual(anchorEvents(events, `evt_${"0".repeat(64)}`), []);
});

test("dry-run payload 的每一段都能由源事件逐项重算，且不拆开 step", () => {
  const { events, archives } = fixture();
  const consumed = archives[1];
  const context = selectActiveContext(events, archives, checkpointId(consumed.manifest));
  const checkpoint = checkpointEventFor(consumed.manifest).payload.checkpoint;
  const payload = materializeActiveContext({
    context,
    checkpoint,
    branchEvents: events,
    systemPrompt: "system prompt",
    toolDefinitions: '[{"name":"viking_search"}]',
  });

  assert.deepEqual(payload.segments.map((segment) => segment.kind), ["system", "checkpoint", "anchor", "raw-tail"]);
  const rawTail = payloadSegment(payload, "raw-tail").events;
  const startIndex = events.findIndex((event) => event.eventId === context.rawTailStartEventId);
  assert.deepEqual(rawTail.map((event) => event.eventId), events.slice(startIndex).map((event) => event.eventId));
  for (const [index, event] of rawTail.entries()) {
    assert.ok(recordedEventBytes(event).equals(recordedEventBytes(events[startIndex + index])));
  }
  // 未归档事件（最后一个 Archive 之后）全部落在 raw tail 内。
  const archivedIds = new Set(archives.flatMap((descriptor) =>
    events.slice(descriptor.startIndex, descriptor.endIndex + 1).map((event) => event.eventId)));
  const unarchived = events.filter((event) => !archivedIds.has(event.eventId)).map((event) => event.eventId);
  assert.ok(unarchived.length > 0);
  for (const eventId of unarchived) assert.ok(rawTail.some((event) => event.eventId === eventId));
  // raw tail 起点不落在跨事件 step 内部。前置条件：起点之前那个 step 确实跨多个事件，
  // 否则"没有拆开 step"是恒真断言。
  const previous = events[startIndex - 1];
  const stepSize = events.filter((event) => event.stepId === previous.stepId).length;
  assert.ok(typeof previous.stepId === "string" && stepSize > 1, "fixture 必须让边界前是跨事件 step");
  assert.ok(typeof rawTail[0].stepId === "string");
  assert.notEqual(previous.stepId, rawTail[0].stepId);

  assert.ok(payloadSegment(payload, "checkpoint").text.includes(checkpoint.narrative));
  assert.ok(payloadSegment(payload, "checkpoint").text.includes(checkpoint.checkpointId));
  assert.equal(payload.tokens.rawTail, rawTail.reduce((sum, event) => sum + eventTokenWeight(event), 0));
  assert.equal(payload.tokens.anchor, eventTokenWeight(events[0]));
  assert.equal(
    payload.tokens.payload,
    payload.tokens.system + payload.tokens.tools + payload.tokens.checkpoint + payload.tokens.anchor + payload.tokens.rawTail,
  );
  assert.equal(payloadSegment(payload, "anchor").events.length, 1);
});

test("takeover messages 渲染 checkpoint、anchor 和完整 raw tail，且不保留已归档前缀", async () => {
  const { events, archives } = fixture();
  const consumed = archives[1];
  const context = selectActiveContext(events, archives, checkpointId(consumed.manifest));
  const checkpoint = checkpointEventFor(consumed.manifest).payload.checkpoint;
  const payload = materializeActiveContext({ context, checkpoint, branchEvents: events });
  assert.deepEqual(renderActiveContextMessages(payload).slice(2).map((message) => message.role), ["assistant", "assistant"]);

  const takeover = new ActiveContextManager({
    path: null,
    adapter: adapterFor([checkpointEventFor(consumed.manifest)]),
    takeover: TAKEOVER,
  });
  await takeover.update(SESSION, { branchEvents: events, archives, lastCheckpointId: checkpointId(consumed.manifest), capacity: CAPACITY });
  const rendered = await takeover.takeoverMessages(events, { capacity: CAPACITY });
  assert.equal(rendered[0].role, "custom");
  assert.equal(rendered[0].customType, "openviking-checkpoint");
  assert.match(rendered[0].content, /<openviking-checkpoint/);
  assert.match(rendered[0].content, /close the active context exit/);
  assert.equal(rendered.some((message) => JSON.stringify(message).includes(events[0].payload.part.value)), true, "anchor 保留原始用户指令");
  assert.equal(rendered.some((message) => JSON.stringify(message).includes(events[1].payload.part.value)), false, "已归档前缀不进入接管消息");
});

test("takeover 渲染遇到不完整 entry 时 fail-open", () => {
  const [first] = projectPiEntries(SESSION, [{
    id: "multi-user",
    parentId: null,
    timestamp: "2026-08-21T00:00:00.000Z",
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
  }]);
  assert.throws(() => renderActiveContextMessages({
    segments: [
      { kind: "system", text: "" },
      { kind: "checkpoint", text: "checkpoint" },
      { kind: "anchor", events: [] },
      { kind: "raw-tail", events: [first] },
    ],
    tokens: { system: 0, tools: 0, checkpoint: 1, anchor: 0, rawTail: 1, payload: 2 },
  }), /split outside/);
});

test("takeover 复用 Pi 的 entry→message 语义并跳过 custom 状态 entry", () => {
  const events = projectPiEntries(SESSION, [
    {
      id: "observation-entry", parentId: null, timestamp: "2026-08-21T00:00:00.000Z",
      type: "custom", customType: "ov-observation", data: { kind: "recall-injection" },
    },
    {
      id: "custom-message", parentId: "observation-entry", timestamp: "2026-08-21T00:00:01.000Z",
      type: "custom_message", customType: "fixture", content: "visible", display: false, details: { kept: true },
    },
    {
      id: "null-user", parentId: "custom-message", timestamp: "2026-08-21T00:00:02.000Z",
      type: "message", message: { role: "user", content: null },
    },
  ]);
  const rendered = renderActiveContextMessages({
    segments: [
      { kind: "system", text: "" },
      { kind: "checkpoint", text: "checkpoint" },
      { kind: "anchor", events: [] },
      { kind: "raw-tail", events },
    ],
    tokens: { system: 0, tools: 0, checkpoint: 1, anchor: 0, rawTail: 1, payload: 2 },
  });
  assert.deepEqual(rendered.map((message) => message.customType), ["openviking-checkpoint", "fixture", undefined]);
  assert.deepEqual(rendered[1].details, { kept: true });
  assert.deepEqual(rendered[2].content, []);

  const payload = materializeActiveContext({
    context: {
      checkpointId: `chk_${"a".repeat(64)}`,
      rawTailStartEventId: events[0].eventId,
    },
    checkpoint: {
      checkpointId: `chk_${"a".repeat(64)}`,
      sourceArchiveId: `arc_${"b".repeat(64)}`,
      narrative: "visible checkpoint",
    },
    branchEvents: events,
  });
  assert.equal(payload.tokens.rawTail, events.slice(1).reduce(
    (total, event) => total + eventTokenWeight(event), 0,
  ), "候选权重必须排除 provider 不会看到的 custom 状态 entry");
});

test("checkpoint 只可完整装载，预算不足时接管与 compaction 都 fail-open", async () => {
  const { events, archives } = fixture();
  const consumed = archives[1];
  const checkpointEvent = checkpointEventFor(consumed.manifest, null, `${OVERVIEW}\n${"长期事实".repeat(2000)}`);
  const manager = new ActiveContextManager({
    path: null,
    adapter: adapterFor([checkpointEvent]),
    takeover: { ...TAKEOVER, checkpointTokenBudget: 100 },
  });
  const status = await manager.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  });
  assert.equal(status.eligibility, "facts_unavailable");
  assert.match(status.lastFailure, /complete checkpoint exceeds checkpointTokenBudget/);
  await assert.rejects(() => manager.materialize(events), /complete checkpoint exceeds checkpointTokenBudget/);
  assert.equal(await manager.takeoverMessages(events, { capacity: CAPACITY }), null);
  assert.equal(await manager.compaction(events, 12345), null);
});

test("eligibility 使用 Pi 报告的容量与安全余量，接管高水位不改变容量判定", () => {
  const fit = evaluateEligibility({ capacity: CAPACITY, takeover: TAKEOVER, payloadTokens: 10481 });
  assert.equal(fit.eligibility, "eligible");
  
  assert.equal(fit.capacityTokens, CAPACITY.contextWindow);
  assert.equal(fit.reserveTokens, CAPACITY.maxTokens);
  assert.equal(fit.usableTokens, CAPACITY.contextWindow - CAPACITY.maxTokens);
  assert.equal(fit.headroomTokens, fit.usableTokens - 10481);

  const thresholded = evaluateEligibility({
    capacity: CAPACITY,
    takeover: { enabled: true, contextTokenThreshold: 1000 },
    payloadTokens: 10481,
  });
  assert.equal(thresholded.eligibility, "eligible");
  assert.equal(thresholded.usableTokens, CAPACITY.contextWindow - CAPACITY.maxTokens);
  assert.equal(thresholded.headroomTokens, thresholded.usableTokens - 10481);
  const exact = evaluateEligibility({
    capacity: { contextWindow: 200, maxTokens: 100 },
    takeover: TAKEOVER,
    payloadTokens: 100,
  });
  assert.equal(exact.headroomTokens, 0);
  assert.equal(exact.eligibility, "capacity_mismatch", "余量为零不足以装载后续事件");

  const impossibleReserve = evaluateEligibility({
    capacity: { contextWindow: 100, maxTokens: 200 },
    takeover: TAKEOVER,
    payloadTokens: 1,
  });
  assert.equal(impossibleReserve.usableTokens, 0);
  assert.equal(impossibleReserve.eligibility, "capacity_mismatch");

  assert.equal(evaluateEligibility({ capacity: null, takeover: TAKEOVER, payloadTokens: 1 }).eligibility, "capacity_unknown");
  assert.equal(evaluateEligibility({ capacity: CAPACITY, takeover: TAKEOVER, payloadTokens: null }).eligibility, "no_context");
  assert.equal(
    evaluateEligibility({ capacity: CAPACITY, takeover: { enabled: false, contextTokenThreshold: 0 }, payloadTokens: 1 }).eligibility,
    "takeover_disabled",
  );
});

test("provider epoch 建立后持续复用，只有活动 payload 再越过高水位才允许推进", () => {
  const initial = evaluateTakeoverTrigger({
    enabled: true, eligibility: "eligible", currentCheckpointId: "chk_a", appliedCheckpointId: null,
    piUsageTokens: 120, payloadTokens: 20, highWaterTokens: 100,
  });
  assert.deepEqual(initial, { render: true, allowAdvance: true, epochActive: false, usageTokens: 120, highWaterTokens: 100 });

  const stable = evaluateTakeoverTrigger({
    enabled: true, eligibility: "eligible", currentCheckpointId: "chk_a", appliedCheckpointId: "chk_a",
    piUsageTokens: 1000, payloadTokens: 20, highWaterTokens: 100,
  });
  assert.deepEqual(stable, { render: true, allowAdvance: false, epochActive: true, usageTokens: 20, highWaterTokens: 100 });

  const nextEpoch = evaluateTakeoverTrigger({
    enabled: true, eligibility: "eligible", currentCheckpointId: "chk_a", appliedCheckpointId: "chk_a",
    piUsageTokens: 1000, payloadTokens: 100, highWaterTokens: 100,
  });
  assert.equal(nextEpoch.allowAdvance, true);

  const automaticEpoch = evaluateTakeoverTrigger({
    enabled: true, eligibility: "eligible", currentCheckpointId: "chk_a", appliedCheckpointId: "chk_a",
    piUsageTokens: 180000, payloadTokens: 74639, highWaterTokens: 69361, activeHighWaterTokens: 144000,
  });
  assert.deepEqual(automaticEpoch, {
    render: true, allowAdvance: false, epochActive: true, usageTokens: 74639, highWaterTokens: 144000,
  });

  const recovered = evaluateTakeoverTrigger({
    enabled: true, eligibility: "capacity_mismatch", currentCheckpointId: "chk_a", nextCheckpointId: "chk_b",
    appliedCheckpointId: null, piUsageTokens: 1000, payloadTokens: 200, highWaterTokens: null,
  });
  assert.equal(recovered.render, true);
  assert.equal(recovered.allowAdvance, true);
  assert.equal(evaluateTakeoverTrigger({
    enabled: true, eligibility: "capacity_mismatch", currentCheckpointId: "chk_a", nextCheckpointId: "chk_a",
    appliedCheckpointId: null, piUsageTokens: 1000, payloadTokens: 200, highWaterTokens: null,
  }).render, false);
  for (const [enabled, eligibility] of [[false, "capacity_mismatch"], [true, "capacity_unknown"], [true, "facts_unavailable"]]) {
    assert.equal(evaluateTakeoverTrigger({
      enabled, eligibility, currentCheckpointId: "chk_a", nextCheckpointId: "chk_b", appliedCheckpointId: null,
      piUsageTokens: 1000, payloadTokens: 200, highWaterTokens: null,
    }).render, false);
  }
});

test("Pi system/tools API 任一不可读时显式标记任务模型事实不可用", () => {
  const ctx = {
    model: CAPACITY,
    getSystemPrompt: () => "system",
  };
  const pi = {
    getActiveTools: () => ["a"],
    getAllTools: () => [{ name: "a", description: "tool" }, { name: "b" }],
  };
  assert.deepEqual(readTaskModelContext(pi, ctx), {
    capacity: CAPACITY, factsAvailable: true, systemPrompt: "system",
    toolDefinitions: JSON.stringify([{ name: "a", description: "tool" }]),
  });

  for (const [brokenPi, brokenCtx] of [
    [pi, { ...ctx, getSystemPrompt: () => { throw new Error("system unavailable"); } }],
    [{ ...pi, getActiveTools: () => { throw new Error("active unavailable"); } }, ctx],
    [{ ...pi, getAllTools: () => { throw new Error("tools unavailable"); } }, ctx],
    [pi, { model: CAPACITY }],
  ]) {
    const errors = [];
    const result = readTaskModelContext(brokenPi, brokenCtx, (error) => errors.push(error));
    assert.equal(result.factsAvailable, false);
    assert.equal(result.systemPrompt, "");
    assert.equal(result.toolDefinitions, "");
    assert.equal(errors.length, 1);
  }
});

test("system/tools 事实不可用时拒绝渲染且不推进 ActiveContext", async () => {
  const { events, archives } = fixture();
  const consumed = archives[1];
  const manager = new ActiveContextManager({
    path: null, adapter: adapterFor([checkpointEventFor(consumed.manifest)]), takeover: TAKEOVER,
  });
  await manager.update(SESSION, {
    branchEvents: events, archives, lastCheckpointId: checkpointId(consumed.manifest), capacity: CAPACITY,
  });
  const before = manager.current;
  const messages = await manager.takeoverMessages(events, {
    archives, lastCheckpointId: checkpointId(consumed.manifest), capacity: CAPACITY, factsAvailable: false,
  });
  assert.equal(messages, null);
  assert.deepEqual(manager.current, before);
  assert.equal(manager.status.eligibility, "facts_unavailable");
});

test("活动上下文形成后跨重启复用同一边界，并保持固定直到来源边界离开分支", async (t) => {
  const dir = await temporaryDir(t);
  const path = join(dir, "active-context.json");
  const { events, archives } = fixture();
  const consumed = archives[1];
  const later = archives[2];
  const adapter = adapterFor([checkpointEventFor(consumed.manifest), checkpointEventFor(later.manifest)]);

  const manager = new ActiveContextManager({ path, adapter, takeover: TAKEOVER });
  const first = await manager.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
    systemPrompt: "system",
  });
  assert.equal(first.checkpointId, checkpointId(consumed.manifest));
  assert.equal(first.eligibility, "eligible");
  assert.ok(first.headroomTokens > 0);
  const persisted = await readActiveContext(path);
  assert.deepEqual(persisted, {
    checkpointId: first.checkpointId,
    rawTailStartEventId: first.rawTailStartEventId,
  });

  // 同步只更新候选事实；已固定边界直到高水位接管才原子推进。
  const frozen = await manager.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(later.manifest),
    capacity: CAPACITY,
  });
  assert.equal(frozen.checkpointId, first.checkpointId);
  assert.deepEqual(await readActiveContext(path), persisted);

  const stableMessages = await manager.takeoverMessages(events, {
    archives,
    lastCheckpointId: checkpointId(later.manifest),
    capacity: CAPACITY,
    allowAdvance: false,
  });
  assert.ok(stableMessages);
  assert.deepEqual(manager.current, persisted, "当前 epoch 未越过高水位时不得消费后台新 checkpoint");

  const advancedMessages = await manager.takeoverMessages(events, {
    archives,
    lastCheckpointId: checkpointId(later.manifest),
    capacity: CAPACITY,
  });
  const advanced = selectActiveContext(events, archives, checkpointId(later.manifest));
  assert.ok(advancedMessages);
  assert.deepEqual(manager.current, advanced);
  assert.deepEqual(await readActiveContext(path), advanced);

  // 新进程从文件恢复已经完成原子替换的边界。
  const restarted = new ActiveContextManager({ path, adapter, takeover: TAKEOVER });
  const recovered = await restarted.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(later.manifest),
    capacity: CAPACITY,
  });
  assert.equal(recovered.checkpointId, advanced.checkpointId);
  assert.equal(recovered.rawTailStartEventId, advanced.rawTailStartEventId);
  assert.deepEqual(restarted.current, advanced);
});

test("活动 epoch 用当前分支 payload 判定高水位，不受上一次状态快照滞后影响", async () => {
  const { events, archives } = fixture();
  const consumed = archives[1];
  const later = archives[2];
  const consumedId = checkpointId(consumed.manifest);
  const laterId = checkpointId(later.manifest);
  const consumedEvent = checkpointEventFor(consumed.manifest);
  const laterEvent = checkpointEventFor(later.manifest, consumedId);
  const manager = new ActiveContextManager({
    path: null,
    adapter: adapterFor([consumedEvent, laterEvent]),
    takeover: TAKEOVER,
  });

  const previousBranch = events.slice(0, -1);
  await manager.update(SESSION, {
    branchEvents: previousBranch,
    archives,
    lastCheckpointId: consumedId,
    capacity: CAPACITY,
  });
  const previousTokens = manager.status.payloadTokens;
  const currentPayload = materializeActiveContext({
    context: manager.current,
    checkpoint: parseCheckpointEventById(consumedEvent, consumedId),
    branchEvents: events,
  });
  assert.ok(currentPayload.tokens.payload > previousTokens);
  const highWater = Math.floor((previousTokens + currentPayload.tokens.payload) / 2);

  const messages = await manager.takeoverMessages(events, {
    archives,
    lastCheckpointId: laterId,
    capacity: CAPACITY,
    allowAdvance: false,
    advanceHighWaterTokens: highWater,
  });
  assert.ok(messages);
  assert.equal(manager.current.checkpointId, laterId);
});

test("旧候选容量失配时可用更新 checkpoint 原子推进并恢复接管", async () => {
  const { events, archives } = fixture();
  const consumed = archives[1];
  const later = archives[2];
  const consumedId = checkpointId(consumed.manifest);
  const laterId = checkpointId(later.manifest);
  const consumedEvent = checkpointEventFor(consumed.manifest);
  const laterEvent = checkpointEventFor(later.manifest, consumedId);
  const oldContext = selectActiveContext(events, archives, consumedId);
  const latestContext = selectActiveContext(events, archives, laterId);
  const oldPayload = materializeActiveContext({
    context: oldContext, checkpoint: parseCheckpointEventById(consumedEvent, consumedId), branchEvents: events,
  });
  const latestPayload = materializeActiveContext({
    context: latestContext, checkpoint: parseCheckpointEventById(laterEvent, laterId), branchEvents: events,
  });
  assert.ok(oldPayload.tokens.payload > latestPayload.tokens.payload);
  const usableTokens = Math.floor((oldPayload.tokens.payload + latestPayload.tokens.payload) / 2);
  const recoveryCapacity = { contextWindow: usableTokens, maxTokens: 0 };

  const manager = new ActiveContextManager({
    path: null, adapter: adapterFor([consumedEvent, laterEvent]), takeover: TAKEOVER,
  });
  await manager.update(SESSION, {
    branchEvents: events, archives, lastCheckpointId: consumedId, capacity: CAPACITY,
  });
  const mismatched = await manager.update(SESSION, {
    branchEvents: events, archives, lastCheckpointId: laterId, capacity: recoveryCapacity,
  });
  assert.equal(mismatched.checkpointId, consumedId);
  assert.equal(mismatched.eligibility, "capacity_mismatch");

  const messages = await manager.takeoverMessages(events, {
    archives, lastCheckpointId: laterId, capacity: recoveryCapacity, allowAdvance: true,
  });
  assert.ok(messages);
  assert.deepEqual(manager.current, latestContext);
  assert.equal(manager.status.checkpointId, laterId);
  assert.equal(manager.status.eligibility, "eligible");
});

test("来源边界离开当前分支后不再复用，且没有可用 checkpoint 时清除持久化选择", async (t) => {
  const dir = await temporaryDir(t);
  const path = join(dir, "active-context.json");
  const { events, archives } = fixture();
  const consumed = archives[1];
  const adapter = adapterFor([checkpointEventFor(consumed.manifest)]);
  const manager = new ActiveContextManager({ path, adapter, takeover: TAKEOVER });
  await manager.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  });
  assert.ok(await readActiveContext(path));

  // 切到不含来源边界的 sibling 分支：既没有该边界，也没有已消费 Archive。
  const sibling = events.slice(0, 1);
  const status = await manager.update(SESSION, {
    branchEvents: sibling,
    archives: describeArchives(SESSION, sibling, BUDGETS),
    lastCheckpointId: null,
    capacity: CAPACITY,
  });
  assert.equal(status.checkpointId, null);
  assert.equal(status.eligibility, "no_context");
  assert.equal(manager.current, null);
  assert.equal(await readActiveContext(path), null);
});

test("来源事实暂时不可读时保留已选定边界，并保持 Pi 完整上下文", async (t) => {
  const dir = await temporaryDir(t);
  const path = join(dir, "active-context.json");
  const { events, archives } = fixture();
  const consumed = archives[1];
  const adapter = adapterFor([checkpointEventFor(consumed.manifest)]);
  const manager = new ActiveContextManager({ path, adapter, takeover: TAKEOVER });
  await manager.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  });

  // 重启后 checkpoint 正文尚未读入，且此时 OpenViking 不可读。
  const restarted = new ActiveContextManager({ path, adapter, takeover: TAKEOVER });
  adapter.failNext = new Error("OpenViking unavailable");
  const degraded = await restarted.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  });
  assert.equal(degraded.eligibility, "facts_unavailable");
  assert.equal(degraded.checkpointId, checkpointId(consumed.manifest), "降级不得销毁已选定边界");
  assert.match(degraded.lastFailure, /OpenViking unavailable/);
  assert.ok(await readActiveContext(path));

  const recovered = await restarted.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  });
  assert.equal(recovered.eligibility, "eligible");
  assert.equal(recovered.lastFailure, null);
});

test("checkpoint 事件按身份自证读取，同一身份只读取一次", async (t) => {
  const dir = await temporaryDir(t);
  const { events, archives } = fixture();
  const consumed = archives[1];
  const checkpointEvent = checkpointEventFor(consumed.manifest);
  const reads = [];
  const adapter = {
    async readEvent(_sessionId, eventId) {
      reads.push(eventId);
      return { event: checkpointEvent, bytes: recordedEventBytes(checkpointEvent) };
    },
  };
  const manager = new ActiveContextManager({ path: join(dir, "active-context.json"), adapter, takeover: TAKEOVER });
  const input = {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  };
  await manager.update(SESSION, input);
  await manager.update(SESSION, input);
  assert.deepEqual(reads, [checkpointEventIdFor(checkpointId(consumed.manifest))]);

  const payload = await manager.materialize(events, { systemPrompt: "system" });
  const block = payloadSegment(payload, "checkpoint").text;
  assert.ok(block.includes(checkpointId(consumed.manifest)) && block.includes(consumed.manifest.archiveId));
});
