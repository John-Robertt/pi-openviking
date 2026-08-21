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
  materializeActiveContext,
  normalizeActiveContext,
  payloadSegment,
  readActiveContext,
  selectActiveContext,
  writeActiveContext,
} from "../shared/active-context.mjs";
import { describeArchives } from "../shared/archive.mjs";
import {
  buildCheckpointEvent,
  buildCheckpointRequestEvent,
  checkpointEventIdFor,
  checkpointId,
} from "../shared/checkpoint.mjs";
import { eventTokenWeight } from "../shared/context-weight.mjs";
import { recordedEventBytes } from "../shared/recorded-event.mjs";
import { ARCHIVE_LINEAR_CHAIN, archiveEvents } from "./fixtures/archive-fixtures.mjs";

const SESSION = "active-context-session";
const BUDGETS = { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 };
const TAKEOVER = { enabled: true, contextTokenThreshold: 0 };
const CAPACITY = { contextWindow: 272000, maxTokens: 128000 };
const OVERVIEW = "## Task & Goals\n- close the active context exit\n## Key Facts & Decisions\n- archive prefix is replaced by the checkpoint";

function fixture(specs = ARCHIVE_LINEAR_CHAIN) {
  const events = archiveEvents(SESSION, specs);
  const archives = describeArchives(SESSION, events, BUDGETS);
  return { events, archives };
}

function checkpointEventFor(manifest, previousCheckpointId = null) {
  const requestEvent = buildCheckpointRequestEvent({
    manifest,
    previousCheckpointId,
    attempt: 1,
    submittedAt: "2026-08-21T00:00:00.000Z",
  });
  return buildCheckpointEvent({
    manifest,
    requestEvent,
    overview: OVERVIEW,
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

test("eligibility 使用 Pi 报告的容量与安全余量，阈值只能压低可用窗口", () => {
  const fit = evaluateEligibility({ capacity: CAPACITY, takeover: TAKEOVER, payloadTokens: 10481 });
  assert.equal(fit.eligibility, "eligible");
  
  assert.equal(fit.capacityTokens, CAPACITY.contextWindow);
  assert.equal(fit.reserveTokens, CAPACITY.maxTokens);
  assert.equal(fit.usableTokens, CAPACITY.contextWindow - CAPACITY.maxTokens);
  assert.equal(fit.headroomTokens, fit.usableTokens - 10481);

  const capped = evaluateEligibility({
    capacity: CAPACITY,
    takeover: { enabled: true, contextTokenThreshold: 1000 },
    payloadTokens: 10481,
  });
  assert.equal(capped.eligibility, "capacity_mismatch");
  
  assert.equal(capped.usableTokens, 1000);
  assert.equal(capped.headroomTokens, 1000 - 10481);

  const raised = evaluateEligibility({
    capacity: CAPACITY,
    takeover: { enabled: true, contextTokenThreshold: 1_000_000 },
    payloadTokens: 10481,
  });
  assert.equal(raised.usableTokens, CAPACITY.contextWindow - CAPACITY.maxTokens, "阈值不得超过模型实际容量");

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

  // 更新的 checkpoint 不会推进已固定的活动上下文：替换是接管时的原子动作。
  const frozen = await manager.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(later.manifest),
    capacity: CAPACITY,
  });
  assert.equal(frozen.checkpointId, first.checkpointId);
  assert.deepEqual(await readActiveContext(path), persisted);

  // 新进程从文件恢复同一边界。
  const restarted = new ActiveContextManager({ path, adapter, takeover: TAKEOVER });
  const recovered = await restarted.update(SESSION, {
    branchEvents: events,
    archives,
    lastCheckpointId: checkpointId(consumed.manifest),
    capacity: CAPACITY,
  });
  assert.equal(recovered.checkpointId, first.checkpointId);
  assert.equal(recovered.rawTailStartEventId, first.rawTailStartEventId);
  assert.deepEqual(restarted.current, persisted);
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
