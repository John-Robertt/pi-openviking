// verify:context:live — 活动上下文构造真实验收门禁。
//
// 在真实 Pi lifecycle、受管 OpenViking 0.4.15 与开发模型身份上执行
// test/live/context.workloads.json 声明的三个 workload，机器断言 ActiveContext 的选择、
// 持久化、跨重启复用与分支失效，断言 dry-run 候选 payload 可由源事件逐项重算，并断言
// Pi 报告的容量在 eligibility 两侧分别 fit/mismatch。真实接管在本阶段保持 inactive，
// 因此同时用真实 provider payload 证明任务模型仍然看到完整 Pi 上下文。
//
// manifest 字节 hash 固定于 test/live/context.workloads.sha256；不匹配即拒绝运行。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { OVClient } from "../../client.ts";
import {
  ActiveContextManager,
  activeContextFileKey,
  anchorEvents,
  payloadSegment,
  readActiveContext,
  selectActiveContext,
} from "../../shared/active-context.mjs";
import { describeArchives } from "../../shared/archive.mjs";
import { ArchiveManager, archiveStorageLocation } from "../../shared/archive-store.mjs";
import {
  CHECKPOINT_MAX_ATTEMPTS,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointId,
  checkpointRequestEventId,
  checkpointTaskId,
  parseCheckpointEventById,
} from "../../shared/checkpoint.mjs";
import { CheckpointManager } from "../../shared/checkpoint-store.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { RecordedEventAdapter, recordedEventStorageLocation } from "../../shared/recorded-event-adapter.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { isEntryAcknowledged, readSyncAck } from "../../shared/sync-ack.mjs";
import {
  LIVE_REPO as REPO,
  ackFileKey,
  assertRunHealthy,
  runLiveGate,
  runPi,
  summarizeRun,
} from "./live-support.mjs";

// ---------------------------------------------------------------------------
// 会话准备与来源对应
// ---------------------------------------------------------------------------

/** 归档与接管预算是用户策略：只写进 run 私有 HOME，不触碰用户环境。 */
export function writeExtensionConfig(ctx, content = ctx.manifest.environment.extensionConfig.content) {
  const path = join(ctx.runDir, "home", ".pi", "pi-openviking.jsonc");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, { mode: 0o600 });
}

const budgets = (ctx) => ctx.manifest.environment.extensionConfig.content.archive;

/**
 * 通过真实 SessionManager 追加一个跨事件 step。
 *
 * 归档压力来自事件自身的上下文重量，真实"回复 OK"的轮次无法越过任何预算；注入走 Pi 自己的
 * 持久化路径，因此 Archive 与 raw tail 仍然只由真实存在的事件构成。该 step 完整落在 raw tail
 * 内，使"raw tail 起点不拆 step"成为可证伪断言。
 */
function seedPressure(ctx, sessionFile) {
  const { toolResults, blobChars } = ctx.manifest.environment.pressureSource;
  const manager = SessionManager.open(sessionFile);
  const filler = (seed, length) => {
    let text = "";
    let digest = createHash("sha256").update(`${ctx.sessionId}/${seed}`).digest("base64url");
    while (text.length < length) {
      text += digest;
      digest = createHash("sha256").update(digest).digest("base64url");
    }
    return text.slice(0, length);
  };
  const callId = `ov-context-call-${ctx.sessionId.slice(0, 8)}`;
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: filler("step-text", blobChars) },
      { type: "toolCall", id: callId, name: "ov_live_probe", arguments: { seeded: true } },
    ],
  });
  for (let index = 0; index < toolResults; index++) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName: "ov_live_probe",
      content: [{ type: "text", text: filler(`step-result-${index}`, blobChars) }],
    });
  }
}

export async function branchSource(ctx, sessionFile) {
  const parsed = parsePiSessionJsonl(await readFile(sessionFile, "utf8"), { sessionId: ctx.sessionId });
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  const onBranch = new Set(parsed.branch.map((entry) => entry.id));
  return { parsed, branch: events.filter((event) => onBranch.has(event.source.entryId)) };
}

function ackPathFor(ctx) {
  const ov = ctx.manifest.identities.openviking;
  return join(ctx.runDir, "home", ".pi", "openviking", "sync-ack",
    `${ackFileKey(ctx.endpoint, ov.account, ctx.storageUser, ctx.sessionId)}.json`);
}

export function activeContextPathFor(ctx) {
  const ov = ctx.manifest.identities.openviking;
  const key = activeContextFileKey(
    { endpoint: ctx.endpoint, account: ov.account, user: ctx.storageUser },
    ctx.sessionId,
  );
  return join(ctx.runDir, "home", ".pi", "openviking", "active-context", `${key}.json`);
}

function productClient(ctx) {
  const ov = ctx.manifest.identities.openviking;
  return new OVClient({
    endpoint: ctx.endpoint, apiKey: "", account: ov.account, user: ctx.storageUser,
    peerId: "context-live", userAgent: "pi-openviking/context-live",
  });
}

/** 记录本 workload 已写入远端的对象，供持久删除核验。 */
export function recordWrittenObjects(ctx, branch, archives) {
  ctx.knownEventIds = [...new Set([...(ctx.knownEventIds ?? []), ...branch.map((event) => event.eventId)])];
  ctx.knownArchiveManifests = [...new Map([
    ...(ctx.knownArchiveManifests ?? []).map((manifest) => [manifest.archiveId, manifest]),
    ...archives.map((descriptor) => [descriptor.manifest.archiveId, descriptor.manifest]),
  ]).values()];
}

/**
 * 真实 Pi 会话形成已确认事件与已提交 Archive。
 *
 * 返回当前分支事件与从 Pi JSONL 独立重算的 Archive descriptor：ActiveContext 的候选必须与
 * 这份独立重算一致，而不是与被测实现自己的中间状态一致。
 */
export async function establishArchives(log, ctx, inputs) {
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA, { requireCapture: false });
  seedPressure(ctx, runA.sessionFile);

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runB, { requireCapture: false });

  const { parsed, branch } = await branchSource(ctx, runB.sessionFile);
  const ack = existsSync(ackPathFor(ctx)) ? await readSyncAck(ackPathFor(ctx)) : { acknowledgedLeaves: [] };
  const uncovered = parsed.entries.filter((entry) => !isEntryAcknowledged(ack, entry.id, parsed.parentById));
  log.check(ctx.workloadId, "ack-covers-tree", 0, uncovered.length, uncovered.length === 0,
    uncovered.map((entry) => entry.id).join(","));

  const archives = describeArchives(ctx.sessionId, branch, budgets(ctx));
  const expected = ctx.manifest.environment.pressureSource.expectedArchives;
  log.check(ctx.workloadId, "archives-formed", expected, archives.length, archives.length === expected,
    "压力源必须确定性地形成声明数量的 Archive");
  const committed = [];
  for (const descriptor of archives) {
    const uri = archiveStorageLocation(ctx.userRoot, ctx.sessionId, descriptor.manifest.archiveId).manifestUri;
    const download = await ctx.client.downloadBytes(uri);
    if (download.ok && Buffer.isBuffer(download.bytes)) committed.push(descriptor);
  }
  log.check(ctx.workloadId, "archives-committed", archives.length, committed.length,
    committed.length === archives.length, "每个独立重算的 Archive 都必须已经在远端提交");
  recordWrittenObjects(ctx, branch, archives);
  ctx.runs.push(summarizeRun(runA), summarizeRun(runB));
  return { runA, runB, branch, parsed, archives: committed };
}

/** 由生产 CheckpointManager 与受管 OpenViking VLM 真实消费第一个 Archive。 */
export async function produceCheckpoint(log, ctx, descriptor) {
  const client = productClient(ctx);
  const adapter = new RecordedEventAdapter(client, { userRoot: ctx.userRoot });
  const archives = new ArchiveManager(client, { userRoot: ctx.userRoot, adapter, budgets: budgets(ctx) });
  const manager = new CheckpointManager(client, {
    adapter, archiveManager: archives, pollIntervalMs: ctx.manifest.thresholds.pollMs,
  });
  const started = Date.now();
  try {
    await manager.schedule(ctx.sessionId, [descriptor]);
    const deadline = Date.now() + ctx.manifest.thresholds.checkpointWallMs;
    while (Date.now() < deadline && manager.status.pending !== 0) {
      await new Promise((wait) => setTimeout(wait, 250));
    }
    const settled = manager.status.pending === 0 && manager.status.mode === "caught_up";
    log.check(ctx.workloadId, "checkpoint-produced", "caught_up/0",
      `${manager.status.mode}/${manager.status.pending}`, settled, manager.status.lastFailure ?? undefined);
    ctx.checkpointWallMs = Date.now() - started;
    return manager.status.lastCheckpointId;
  } finally {
    await manager.stop();
    await client.close(true);
  }
}

// ---------------------------------------------------------------------------
// ActiveContext 断言
// ---------------------------------------------------------------------------

const VIKING_CONTEXT = /活动上下文：([^\n]*)/;
const VIKING_CAPACITY = /上下文容量：Pi 报告 (\d+)，输出预留 (\d+)，可用 (\d+)，候选需要 (\d+)/;

export function vikingActiveContext(run) {
  const message = String(run.actions.at(-1)?.notifyEvent?.message ?? "");
  const line = message.match(VIKING_CONTEXT)?.[1] ?? "";
  const capacity = message.match(VIKING_CAPACITY);
  return {
    message,
    line,
    checkpointId: line.match(/checkpoint (chk_[0-9a-f]{64})/)?.[1] ?? null,
    rawTailStartEventId: line.match(/raw tail 起点 (evt_[0-9a-f]{64})/)?.[1] ?? null,
    eligible: line.startsWith("可接管"),
    reason: line.match(/inactive：([^，]*)/)?.[1] ?? null,
    capacityTokens: capacity ? Number(capacity[1]) : null,
    reserveTokens: capacity ? Number(capacity[2]) : null,
    usableTokens: capacity ? Number(capacity[3]) : null,
    payloadTokens: capacity ? Number(capacity[4]) : null,
  };
}

export function providerPayloads(run) {
  const text = readFileSync(run.segmentPath, "utf8").trim();
  return text ? text.split("\n").filter(Boolean).map(JSON.parse)
    .filter((record) => record.kind === "providerPayload").map((record) => record.payload) : [];
}

export function providerInput(payload) {
  if (Array.isArray(payload?.input)) return payload.input;
  if (Array.isArray(payload?.messages)) return payload.messages;
  return [];
}

function withoutRecallBlocks(value) {
  if (typeof value === "string") {
    return value.replace(/<openviking-context>[\s\S]*?<\/openviking-context>\n?/g, "");
  }
  if (Array.isArray(value)) return value.map(withoutRecallBlocks);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutRecallBlocks(item)]));
  }
  return value;
}

export function providerVisibleInput(payload, checkpointId) {
  const visible = providerInput(payload).filter((item) => !JSON.stringify(item).includes(checkpointId));
  return JSON.stringify(withoutRecallBlocks(visible));
}

/**
 * 独立重算候选：从 Pi JSONL、Archive manifest 与已消费 checkpoint 事实推导应有的
 * ActiveContext，并与真实 Pi 进程持久化的文件逐字段比对。
 */
async function assertPersistedContext(log, ctx, branch, archives, lastCheckpointId) {
  const persisted = await readActiveContext(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "active-context-persisted", "checkpointId+rawTailStartEventId",
    persisted ? Object.keys(persisted).sort().join(",") : "missing",
    Boolean(persisted) && Object.keys(persisted).sort().join(",") === "checkpointId,rawTailStartEventId");
  if (!persisted) return null;

  const expected = selectActiveContext(branch, archives, persisted.checkpointId);
  log.check(ctx.workloadId, "active-context-recomputed", JSON.stringify(expected), JSON.stringify(persisted),
    JSON.stringify(expected) === JSON.stringify(persisted),
    "持久化边界必须等于从源事件与 Archive manifest 独立重算的候选");
  log.check(ctx.workloadId, "active-context-checkpoint-consumed", lastCheckpointId, persisted.checkpointId,
    persisted.checkpointId === lastCheckpointId, "活动上下文只能引用当前分支上已消费的 checkpoint");
  return persisted;
}

/** dry-run：materialize 候选 payload 并逐项对照源事件。 */
async function assertDryRunPayload(log, ctx, branch, archives, context, run) {
  const w = ctx.workloadId;
  const client = productClient(ctx);
  const adapter = new RecordedEventAdapter(client, { userRoot: ctx.userRoot });
  const manager = new ActiveContextManager({ path: null, adapter, takeover: { enabled: true, contextTokenThreshold: 0 } });
  let payload = null;
  try {
    await manager.update(ctx.sessionId, {
      branchEvents: branch, archives, lastCheckpointId: context.checkpointId,
      capacity: { contextWindow: 1, maxTokens: 0 },
    });
    payload = await manager.materialize(branch, { systemPrompt: "", toolDefinitions: "" });
  } finally {
    await client.close(true);
  }
  log.check(w, "dry-run.materialized", true, Boolean(payload), Boolean(payload));
  if (!payload) return null;

  log.check(w, "dry-run.segments", "system,checkpoint,anchor,raw-tail",
    payload.segments.map((segment) => segment.kind).join(","),
    payload.segments.map((segment) => segment.kind).join(",") === "system,checkpoint,anchor,raw-tail");

  const startIndex = branch.findIndex((event) => event.eventId === context.rawTailStartEventId);
  const rawTail = payloadSegment(payload, "raw-tail").events;
  const byteMismatch = rawTail.filter((event, index) =>
    !recordedEventBytes(event).equals(recordedEventBytes(branch[startIndex + index])));
  log.check(w, "dry-run.raw-tail-bytes", 0, byteMismatch.length,
    rawTail.length === branch.length - startIndex && byteMismatch.length === 0,
    "raw tail 必须逐字节等于源事件");

  const archivedIds = new Set(archives.flatMap((descriptor) =>
    branch.slice(descriptor.startIndex, descriptor.endIndex + 1).map((event) => event.eventId)));
  const unarchived = branch.filter((event) => !archivedIds.has(event.eventId));
  const tailIds = new Set(rawTail.map((event) => event.eventId));
  const missing = unarchived.filter((event) => !tailIds.has(event.eventId));
  log.check(w, "dry-run.unarchived-covered", `${unarchived.length} events`, `${unarchived.length - missing.length}`,
    unarchived.length > 0 && missing.length === 0, "全部未归档事件必须在 raw tail 内");

  const anchor = payloadSegment(payload, "anchor").events;
  const expectedAnchor = anchorEvents(branch, context.rawTailStartEventId);
  const anchorEntry = anchor[0]?.source?.entryId ?? null;
  log.check(w, "dry-run.anchor", expectedAnchor.map((event) => event.eventId).join(","),
    anchor.map((event) => event.eventId).join(","),
    anchor.length > 0 && anchor.length === expectedAnchor.length &&
      anchor.every((event, index) => event.eventId === expectedAnchor[index].eventId));
  const anchorEntryType = anchor[0] ? branch.find((event) => event.source.entryId === anchorEntry)?.payload?.entry?.message?.role : null;
  log.check(w, "dry-run.anchor-is-user-turn", "user", anchorEntryType, anchorEntryType === "user",
    "anchor 必须是建立 raw tail 所属 turn 的 user entry");
  log.check(w, "dry-run.anchor-turn", branch[startIndex].turnId, anchor[0]?.turnId,
    anchor[0]?.turnId === branch[startIndex].turnId);

  // step 原子性：raw tail 起点前一个事件不得与起点同属一个 step，且分支确实存在跨事件 step。
  const previous = branch[startIndex - 1];
  const splits = Boolean(previous) && typeof branch[startIndex].stepId === "string" &&
    previous.stepId === branch[startIndex].stepId;
  log.check(w, "dry-run.step-atomic", false, splits, !splits, "raw tail 起点不得落在跨事件 step 内部");
  const stepSizes = new Map();
  for (const event of rawTail) {
    if (typeof event.stepId === "string") stepSizes.set(event.stepId, (stepSizes.get(event.stepId) ?? 0) + 1);
  }
  const multiEventSteps = [...stepSizes.values()].filter((size) => size > 1).length;
  log.check(w, "dry-run.multi-event-step-present", ">=1", multiEventSteps, multiEventSteps >= 1,
    "raw tail 必须含跨事件 step，否则 step 原子断言恒真");

  // checkpoint 段来自远端事实，且不含来源事件正文。
  const checkpointText = payloadSegment(payload, "checkpoint").text;
  log.check(w, "dry-run.checkpoint-block", context.checkpointId,
    checkpointText.match(/id="(chk_[0-9a-f]{64})"/)?.[1], checkpointText.includes(context.checkpointId));

  const status = vikingActiveContext(run);
  log.check(w, "viking-reports-context", `${context.checkpointId}/${context.rawTailStartEventId}`,
    `${status.checkpointId}/${status.rawTailStartEventId}`,
    status.checkpointId === context.checkpointId && status.rawTailStartEventId === context.rawTailStartEventId,
    status.message.slice(0, 300));
  return { payload, status };
}

/** 真实 provider payload 必须仍是完整 Pi 上下文：接管在本阶段保持 inactive。 */
function assertTakeoverInactive(log, ctx, run, narrativeMarker) {
  const raw = readFileSync(run.segmentPath, "utf8");
  const payloads = raw.trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((record) => record.kind === "providerPayload");
  log.check(ctx.workloadId, "provider-payload-captured", ">=1", payloads.length, payloads.length >= 1);
  const serialized = payloads.map((record) => JSON.stringify(record.payload)).join("\n");
  log.check(ctx.workloadId, "provider-payload-has-archived-prefix", true, serialized.includes(ctx.archivedMarker),
    serialized.includes(ctx.archivedMarker), "归档前缀原文必须仍在 provider 上下文中");
  log.check(ctx.workloadId, "provider-payload-without-checkpoint", false, serialized.includes(narrativeMarker),
    !serialized.includes(narrativeMarker), "接管保持 inactive：checkpoint 正文不得进入 provider 上下文");
}

async function checkpointNarrative(ctx, checkpointIdValue) {
  const client = productClient(ctx);
  const adapter = new RecordedEventAdapter(client, { userRoot: ctx.userRoot });
  try {
    const stored = await adapter.readEvent(ctx.sessionId, checkpointEventId({
      archiveId: ctx.checkpointArchiveId, contentHash: ctx.checkpointArchiveHash,
    }));
    return parseCheckpointEventById(stored.event, checkpointIdValue).narrative;
  } finally {
    await client.close(true);
  }
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

async function w1(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const established = await establishArchives(log, ctx, inputs);
  const descriptor = established.archives[0];
  if (!descriptor) return;
  ctx.checkpointArchiveId = descriptor.manifest.archiveId;
  ctx.checkpointArchiveHash = descriptor.manifest.contentHash;
  // 归档前缀里的真实用户指令原文：接管保持 inactive 时它必须仍在 provider 上下文中。
  ctx.archivedMarker = inputs.P1;
  const archivedIds = new Set(established.branch
    .slice(descriptor.startIndex, descriptor.endIndex + 1).map((event) => event.eventId));
  const markerArchived = established.branch.some((event) =>
    archivedIds.has(event.eventId) && JSON.stringify(event.payload).includes(inputs.P1));
  log.check(ctx.workloadId, "archived-prefix-contains-prompt", true, markerArchived, markerArchived,
    "provider payload 断言的原文必须确实位于已归档范围内");
  const lastCheckpointId = await produceCheckpoint(log, ctx, descriptor);
  log.check(ctx.workloadId, "checkpoint-identity", checkpointId(descriptor.manifest), lastCheckpointId,
    lastCheckpointId === checkpointId(descriptor.manifest));

  const run = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [
      { prompt: inputs.P2 },
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: lastCheckpointId },
    ],
  });
  assertRunHealthy(log, ctx, run, { requireCapture: true });
  ctx.runs.push(summarizeRun(run));

  const { branch } = await branchSource(ctx, run.sessionFile);
  const archives = describeArchives(ctx.sessionId, branch, budgets(ctx));
  recordWrittenObjects(ctx, branch, archives);
  const context = await assertPersistedContext(log, ctx, branch, archives, lastCheckpointId);
  if (!context) return;
  const dryRun = await assertDryRunPayload(log, ctx, branch, archives, context, run);
  assertTakeoverInactive(log, ctx, run, (await checkpointNarrative(ctx, context.checkpointId)).slice(0, 80));
  ctx.runs.push({
    label: "dry-run",
    checkpointWallMs: ctx.checkpointWallMs,
    rawTailEvents: dryRun ? payloadSegment(dryRun.payload, "raw-tail").events.length : null,
    anchorEvents: dryRun ? payloadSegment(dryRun.payload, "anchor").events.length : null,
    tokens: dryRun?.payload.tokens ?? null,
  });
}

async function w2(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const established = await establishArchives(log, ctx, inputs);
  const descriptor = established.archives[0];
  if (!descriptor) return;
  ctx.checkpointArchiveId = descriptor.manifest.archiveId;
  ctx.checkpointArchiveHash = descriptor.manifest.contentHash;
  const lastCheckpointId = await produceCheckpoint(log, ctx, descriptor);

  const formation = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: lastCheckpointId },
    ],
  });
  assertRunHealthy(log, ctx, formation, { requireCapture: false });
  const branchBefore = (await branchSource(ctx, formation.sessionFile)).branch;
  const archivesBefore = describeArchives(ctx.sessionId, branchBefore, budgets(ctx));
  const context = await assertPersistedContext(log, ctx, branchBefore, archivesBefore, lastCheckpointId);
  if (!context) return;
  const bytesBefore = readFileSync(activeContextPathFor(ctx));

  const restarted = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 3, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, restarted, { requireCapture: false });
  const bytesAfter = readFileSync(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "restart-reuse", "byte-identical", `${bytesAfter.length}B`,
    bytesBefore.equals(bytesAfter), "跨重启必须复用同一活动上下文，而不是重新选择");
  const restartedStatus = vikingActiveContext(restarted);
  log.check(ctx.workloadId, "restart-status", context.checkpointId, restartedStatus.checkpointId,
    restartedStatus.checkpointId === context.checkpointId);

  // 切到不含来源边界的 sibling 分支：从归档前缀的最后一个 entry 分叉。
  const boundaryEntryId = branchBefore.find((event) => event.eventId === descriptor.manifest.lastEventId).source.entryId;
  const manager = SessionManager.open(restarted.sessionFile);
  manager.branch(boundaryEntryId);
  manager.appendMessage({ role: "user", content: inputs.P3 });
  const siblingLeafId = manager.getLeafId();

  const switched = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 4, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, switched, { requireCapture: false });
  const { parsed, branch: siblingBranch } = await branchSource(ctx, switched.sessionFile);
  log.check(ctx.workloadId, "sibling-branch-active", siblingLeafId, parsed.branch.at(-1)?.id,
    parsed.branch.at(-1)?.id === siblingLeafId, "分支切换必须真实发生在 Pi JSONL 上");
  const stillOnBranch = siblingBranch.some((event) => event.eventId === context.rawTailStartEventId);
  log.check(ctx.workloadId, "source-boundary-left-branch", false, stillOnBranch, !stillOnBranch);
  const afterSwitch = await readActiveContext(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "invalidated-not-reused", null, afterSwitch ? afterSwitch.checkpointId : null,
    afterSwitch === null, "来源边界离开祖先链后不得继续复用该活动上下文");
  const switchedStatus = vikingActiveContext(switched);
  log.check(ctx.workloadId, "invalidated-status", "尚未形成", switchedStatus.line,
    switchedStatus.checkpointId === null, switchedStatus.message.slice(0, 200));

  // 事实对象在分支切换前后不变。
  const client = productClient(ctx);
  const adapter = new RecordedEventAdapter(client, { userRoot: ctx.userRoot });
  try {
    const manifestUri = archiveStorageLocation(ctx.userRoot, ctx.sessionId, descriptor.manifest.archiveId).manifestUri;
    const manifestBytes = await client.downloadBytes(manifestUri);
    log.check(ctx.workloadId, "archive-unchanged", true, manifestBytes.ok, manifestBytes.ok);
    const stored = await adapter.readEventIfExists(ctx.sessionId, checkpointEventId(descriptor.manifest));
    log.check(ctx.workloadId, "checkpoint-unchanged", true, Boolean(stored), Boolean(stored));
  } finally {
    await client.close(true);
  }
  recordWrittenObjects(ctx, siblingBranch, describeArchives(ctx.sessionId, siblingBranch, budgets(ctx)));
  ctx.runs.push(summarizeRun(formation), summarizeRun(restarted), summarizeRun(switched));
}

async function w3(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const established = await establishArchives(log, ctx, inputs);
  const descriptor = established.archives[0];
  if (!descriptor) return;
  ctx.checkpointArchiveId = descriptor.manifest.archiveId;
  ctx.checkpointArchiveHash = descriptor.manifest.contentHash;
  const lastCheckpointId = await produceCheckpoint(log, ctx, descriptor);

  const formation = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: lastCheckpointId },
    ],
  });
  assertRunHealthy(log, ctx, formation, { requireCapture: false });

  // 形成进程只观测异步 checkpoint→ActiveContext 收敛；容量对照从下一进程开始，避免形成期
  // 的状态通知与模型事实刷新污染基线。两个对照进程读取同一持久 session，也不需要额外 prompt。
  const fitRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 3, endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: "上下文容量：Pi 报告" },
    ],
  });
  assertRunHealthy(log, ctx, fitRun, { requireCapture: false });
  const branch = (await branchSource(ctx, fitRun.sessionFile)).branch;
  const archives = describeArchives(ctx.sessionId, branch, budgets(ctx));
  recordWrittenObjects(ctx, branch, archives);
  const context = await assertPersistedContext(log, ctx, branch, archives, lastCheckpointId);
  if (!context) return;

  const fit = vikingActiveContext(fitRun);
  log.check(ctx.workloadId, "fit.eligible", true, fit.eligible, fit.eligible, fit.message.slice(0, 300));
  log.check(ctx.workloadId, "fit.usable-from-pi-capacity", fit.capacityTokens - fit.reserveTokens, fit.usableTokens,
    Number.isInteger(fit.capacityTokens) && Number.isInteger(fit.reserveTokens) &&
      fit.usableTokens === fit.capacityTokens - fit.reserveTokens,
    "可用容量必须等于 Pi 报告容量减去输出预留");
  log.check(ctx.workloadId, "fit.headroom-positive", ">0", fit.usableTokens - fit.payloadTokens,
    fit.usableTokens - fit.payloadTokens > 0);

  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.highWaterOverride);
  const thresholdRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 4, endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: "上下文容量：Pi 报告" },
    ],
  });
  assertRunHealthy(log, ctx, thresholdRun, { requireCapture: false });
  const thresholded = vikingActiveContext(thresholdRun);
  log.check(ctx.workloadId, "threshold.eligible", true, thresholded.eligible, thresholded.eligible,
    thresholded.message.slice(0, 300));
  log.check(ctx.workloadId, "threshold.capacity-stable",
    `${fit.capacityTokens}/${fit.reserveTokens}/${fit.usableTokens}`,
    `${thresholded.capacityTokens}/${thresholded.reserveTokens}/${thresholded.usableTokens}`,
    thresholded.capacityTokens === fit.capacityTokens &&
      thresholded.reserveTokens === fit.reserveTokens && thresholded.usableTokens === fit.usableTokens,
    "高水位不得改变 Pi 报告容量或输出预留");
  log.check(ctx.workloadId, "threshold.payload-stable", `${fit.payloadTokens}/${fit.usableTokens - fit.payloadTokens}`,
    `${thresholded.payloadTokens}/${thresholded.usableTokens - thresholded.payloadTokens}`,
    thresholded.payloadTokens === fit.payloadTokens &&
      thresholded.usableTokens - thresholded.payloadTokens === fit.usableTokens - fit.payloadTokens);
  log.check(ctx.workloadId, "threshold.identity-stable", context.checkpointId, thresholded.checkpointId,
    thresholded.checkpointId === context.checkpointId && thresholded.rawTailStartEventId === context.rawTailStartEventId,
    "高水位策略不得改变已固定的活动上下文身份");
  const persisted = await readActiveContext(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "threshold.context-retained", context.checkpointId, persisted?.checkpointId,
    persisted?.checkpointId === context.checkpointId);
  ctx.runs.push(summarizeRun(formation), summarizeRun(fitRun), summarizeRun(thresholdRun), {
    label: "eligibility",
    checkpointWallMs: ctx.checkpointWallMs,
    automatic: {
      capacity: fit.capacityTokens, reserve: fit.reserveTokens, usable: fit.usableTokens,
      payload: fit.payloadTokens, headroom: fit.usableTokens - fit.payloadTokens,
    },
    explicitHighWater: {
      capacity: thresholded.capacityTokens, reserve: thresholded.reserveTokens, usable: thresholded.usableTokens,
      payload: thresholded.payloadTokens, headroom: thresholded.usableTokens - thresholded.payloadTokens,
    },
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function collectObjectUris(ctx) {
  const uris = ctx.markerUri ? [ctx.markerUri] : [];
  for (const eventId of ctx.knownEventIds ?? []) {
    uris.push(recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri);
  }
  for (const manifest of ctx.knownArchiveManifests ?? []) {
    uris.push(archiveStorageLocation(ctx.userRoot, ctx.sessionId, manifest.archiveId).manifestUri);
    for (const eventId of [
      checkpointEventId(manifest),
      ...Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, index) => checkpointRequestEventId(manifest, null, index + 1)),
      ...Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, index) => checkpointFailureEventId(manifest, null, index + 1)),
    ]) {
      const uri = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri;
      const status = await ctx.client.statUri(uri);
      if (!status.ok) throw new Error(`checkpoint fact stat failed: ${status.status}`);
      if (status.exists) uris.push(uri);
    }
  }
  return [...new Set(uris)];
}

/** 本 workload 可能创建的 VLM task 身份：由 Archive manifest 与 attempt 链确定性派生。 */
export function collectTaskResources(ctx) {
  return (ctx.knownArchiveManifests ?? []).flatMap((manifest) =>
    Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, index) => checkpointTaskId(manifest, null, index + 1)));
}

const WORKLOAD_RUNNERS = {
  "w1-context-formation": w1,
  "w2-restart-branch-reuse": w2,
  "w3-capacity-boundary": w3,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "context",
    manifestPath: join(REPO, "test/live/context.workloads.json"),
    manifestHashPath: join(REPO, "test/live/context.workloads.sha256"),
    runners: WORKLOAD_RUNNERS,
    collectObjectUris,
    collectTaskResources,
  }).catch((error) => {
    process.stderr.write(`✗ verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
