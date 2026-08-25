// verify:takeover:live — 上下文切换与 Pi compaction fail-open 真实验收门禁。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateContextTokens, SessionManager } from "@earendil-works/pi-coding-agent";

import { readActiveContext } from "../../shared/active-context.mjs";
import { describeArchives } from "../../shared/archive.mjs";
import { checkpointEventIdFor, checkpointId as checkpointIdFor, parseCheckpointEventById } from "../../shared/checkpoint.mjs";
import { eventTokenWeight } from "../../shared/context-weight.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries } from "../../shared/recorded-event.mjs";
import { RecordedEventAdapter } from "../../shared/recorded-event-adapter.mjs";
import {
  activeContextPathFor,
  branchSource,
  collectObjectUris,
  collectTaskResources,
  establishArchives,
  produceCheckpoint,
  providerInput,
  providerPayloads,
  providerVisibleInput,
  recordWrittenObjects,
  vikingActiveContext,
  writeExtensionConfig,
} from "./context-live.mjs";
import {
  COMPACTION_PADDING_PROMPT,
  LIVE_REPO as REPO,
  assertRunHealthy,
  runLiveGate,
  runPi,
  summarizeRun,
} from "./live-support.mjs";
import { parseObservationRun } from "./observation-evidence.mjs";

const CHECKPOINT_ID = /chk_[0-9a-f]{64}/;
const LARGE_MARKER = "TAKEOVER_CAPACITY_ATOMIC_MARKER";
const OVERSIZED_MARKER = "TAKEOVER_OVERSIZED_ATOMIC_MARKER";

function seededText(seed, length) {
  let text = "";
  let digest = createHash("sha256").update(seed).digest("base64url");
  while (text.length < length) {
    text += digest;
    digest = createHash("sha256").update(digest).digest("base64url");
  }
  return text.slice(0, length);
}

function stablePrefixLength(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && JSON.stringify(left[index]) === JSON.stringify(right[index])) index++;
  return index;
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

function explicitCacheFields(payload) {
  return Object.fromEntries(Object.entries(payload ?? {}).filter(([key]) => /cache/i.test(key)));
}

function assistantUsages(run) {
  return run.events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message.usage ?? {});
}

function setCheckpointIdentity(ctx, descriptor) {
  ctx.checkpointArchiveId = descriptor.manifest.archiveId;
  ctx.checkpointArchiveHash = descriptor.manifest.contentHash;
}

async function establishActiveContext(log, ctx, inputs) {
  writeExtensionConfig(ctx);
  const established = await establishArchives(log, ctx, inputs);
  const descriptor = established.archives[0];
  if (!descriptor) return null;
  setCheckpointIdentity(ctx, descriptor);
  const archivedEvents = established.branch.slice(descriptor.startIndex, descriptor.endIndex + 1);
  const archivedContent = archivedEvents
    .map((event) => event?.payload?.part?.value)
    .find((value) => value !== undefined && JSON.stringify(value).includes(inputs.A1));
  if (!archivedContent) throw new Error("Archive fixture lacks the expected assistant marker");
  ctx.archivedMarker = inputs.A1;
  ctx.anchorMarker = inputs.P1;
  const markerArchived = archivedEvents.some((event) => JSON.stringify(event.payload).includes(ctx.archivedMarker));
  log.check(ctx.workloadId, "archived-non-anchor-marker", true, markerArchived, markerArchived);
  const checkpointId = await produceCheckpoint(log, ctx, descriptor);
  const formation = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 2,
    endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: checkpointId },
    ],
  });
  assertRunHealthy(log, ctx, formation, { requireCapture: false });
  const active = await readActiveContext(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "active-context-ready", checkpointId, active?.checkpointId,
    Boolean(active) && active.checkpointId === checkpointId,
    String(formation.actions.at(-1)?.notifyEvent?.message ?? ""));
  ctx.runs.push(summarizeRun(formation));
  return { ...established, descriptor, checkpointId, formation, active };
}

function assertPayloadUsesCheckpoint(log, ctx, payload, checkpointId, archivedMarker, label, anchorMarker = ctx.anchorMarker) {
  const serialized = JSON.stringify(payload);
  log.check(ctx.workloadId, `${label}.checkpoint`, checkpointId,
    serialized.match(CHECKPOINT_ID)?.[0] ?? null, serialized.includes(checkpointId));
  const visible = providerVisibleInput(payload, checkpointId);
  log.check(ctx.workloadId, `${label}.anchor-preserved`, true,
    visible.includes(anchorMarker), visible.includes(anchorMarker));
  log.check(ctx.workloadId, `${label}.archived-non-anchor-removed`, false,
    visible.includes(archivedMarker), !visible.includes(archivedMarker));
}

function appendUserPressure(sessionFile, marker, seed, chars) {
  const manager = SessionManager.open(sessionFile);
  const content = `${marker}\n${seededText(seed, chars)}`;
  manager.appendMessage({
    role: "user",
    content,
    timestamp: Date.now(),
  });
  return content;
}

function seedCompactionPressure(ctx, sessionFile) {
  appendUserPressure(
    sessionFile, "TAKEOVER_COMPACTION_PRESSURE", ctx.sessionId, ctx.manifest.environment.compactionChars,
  );
}

function sourceTailTokens(sessionFile, sessionId, rawTailStartEventId) {
  const branch = SessionManager.open(sessionFile).getBranch();
  const events = projectPiEntries(sessionId, branch);
  const start = events.findIndex((event) => event.eventId === rawTailStartEventId);
  if (start < 0) throw new Error("ActiveContext raw tail start is not on the seeded branch");
  return events.slice(start).reduce((total, event) => total + eventTokenWeight(event), 0);
}

function seedEpochAdvancePressure(ctx, sessionFile, rawTailStartEventId, minimumTokens) {
  const currentTokens = sourceTailTokens(sessionFile, ctx.sessionId, rawTailStartEventId);
  const requiredChars = Math.max(
    ctx.manifest.environment.epochAdvanceChars,
    Math.max(0, minimumTokens - currentTokens + 1000) * 4,
  );
  appendUserPressure(
    sessionFile, "TAKEOVER_EPOCH_ADVANCE_PRESSURE", `${ctx.sessionId}/epoch-advance`, requiredChars,
  );
  return sourceTailTokens(sessionFile, ctx.sessionId, rawTailStartEventId);
}

async function w1(log, ctx) {
  const established = await establishActiveContext(log, ctx, ctx.workload.inputs);
  if (!established?.active) return;
  const calibrationConfig = structuredClone(ctx.manifest.environment.extensionConfig.compaction);
  calibrationConfig.takeover.contextTokenThreshold = 1_000_000;
  writeExtensionConfig(ctx, calibrationConfig);
  seedCompactionPressure(ctx, established.formation.sessionFile);
  const calibration = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 3,
    endpoint: ctx.endpoint,
    actions: [
      { prompt: "TAKEOVER_EPOCH_CALIBRATION：请只回复 READY，不要调用工具。" },
      { command: "/viking sync" },
      { command: "/viking" },
    ],
  });
  assertRunHealthy(log, ctx, calibration, { requireCapture: true });
  const calibrationStatus = vikingActiveContext(calibration);
  const fullContextTokens = calculateContextTokens(assistantUsages(calibration).at(-1) ?? {});
  const candidateTokens = Number(calibrationStatus.payloadTokens);
  const epochHighWater = Math.floor((candidateTokens + fullContextTokens) / 2);
  log.check(ctx.workloadId, "epoch.threshold-window", `${candidateTokens}<threshold<${fullContextTokens}`,
    epochHighWater, Number.isFinite(candidateTokens) && candidateTokens < epochHighWater && epochHighWater < fullContextTokens);
  const stableConfig = structuredClone(ctx.manifest.environment.extensionConfig.content);
  stableConfig.takeover.contextTokenThreshold = epochHighWater;
  writeExtensionConfig(ctx, stableConfig);
  const bytesBefore = readFileSync(activeContextPathFor(ctx));
  const growth = seededText(`${ctx.sessionId}/epoch-growth`, ctx.manifest.environment.epochGrowthChars);
  const run = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 4,
    endpoint: ctx.endpoint,
    actions: [
      { prompt: `${ctx.workload.inputs.P2}\n${growth}` },
      { command: "/viking sync" },
      // 后台 checkpoint 是异步 VLM 消费，固定等待不可靠：轮询 /viking 直到“最近 checkpoint”不再是上一代。
      { command: "/viking", untilNotifyExcludes: `最近 ${established.checkpointId}` },
      { prompt: ctx.workload.inputs.P3 },
    ],
  });
  assertRunHealthy(log, ctx, run, { requireCapture: true });
  const latestSource = await branchSource(ctx, run.sessionFile);
  recordWrittenObjects(ctx, latestSource.branch, describeArchives(ctx.sessionId, latestSource.branch, stableConfig.archive));
  const checkpointMessage = String(run.actions[2]?.notifyEvent?.message ?? "");
  const backgroundCheckpointId = checkpointMessage.match(/Checkpoint：[^\n]*最近 (chk_[0-9a-f]{64})/)?.[1] ?? null;
  log.check(ctx.workloadId, "epoch.background-checkpoint-ready", "new checkpoint before second request",
    backgroundCheckpointId, Boolean(backgroundCheckpointId) && backgroundCheckpointId !== established.checkpointId);
  const payloads = providerPayloads(run);
  log.check(ctx.workloadId, "takeover.capture-count", 2, payloads.length, payloads.length === 2,
    "自定义 compaction 不得产生第二份摘要模型请求");
  if (payloads.length < 2) return;
  assertPayloadUsesCheckpoint(log, ctx, payloads[0], established.checkpointId, ctx.archivedMarker, "takeover.first");
  assertPayloadUsesCheckpoint(log, ctx, payloads[1], established.checkpointId, ctx.archivedMarker, "takeover.second");

  const firstInput = providerInput(payloads[0]);
  const secondInput = providerInput(payloads[1]);
  log.check(ctx.workloadId, "provider.input-shape", "array", `${Array.isArray(firstInput)}/${Array.isArray(secondInput)}`,
    Array.isArray(firstInput) && Array.isArray(secondInput));
  if (firstInput && secondInput) {
    const normalizedFirst = withoutRecallBlocks(firstInput);
    const normalizedSecond = withoutRecallBlocks(secondInput);
    const stable = stablePrefixLength(normalizedFirst, normalizedSecond);
    const firstCheckpointIndex = normalizedFirst.findIndex((item) => JSON.stringify(item).includes(established.checkpointId));
    const firstAnchorIndex = normalizedFirst.findIndex((item) => JSON.stringify(item).includes(ctx.anchorMarker));
    const secondCheckpointIndex = normalizedSecond.findIndex((item) => JSON.stringify(item).includes(established.checkpointId));
    const secondAnchorIndex = normalizedSecond.findIndex((item) => JSON.stringify(item).includes(ctx.anchorMarker));
    const expectedStable = Math.max(firstCheckpointIndex, firstAnchorIndex) + 1;
    log.check(ctx.workloadId, "provider.stable-prefix", `>=${expectedStable}`, stable,
      firstCheckpointIndex >= 0 && firstCheckpointIndex < firstAnchorIndex &&
        secondCheckpointIndex === firstCheckpointIndex && secondAnchorIndex === firstAnchorIndex && stable >= expectedStable,
      "checkpoint 与原始指令 anchor 构成稳定结构前缀；其后的 omission/raw-tail 只按精确来源事实重算");
    log.check(ctx.workloadId, "provider.current-prompts", "P2/P3 visible",
      `${JSON.stringify(normalizedFirst).includes(ctx.workload.inputs.P2)}/${JSON.stringify(normalizedSecond).includes(ctx.workload.inputs.P3)}`,
      JSON.stringify(normalizedFirst).includes(ctx.workload.inputs.P2) &&
        JSON.stringify(normalizedSecond).includes(ctx.workload.inputs.P3));
  }
  log.check(ctx.workloadId, "provider.instructions-stable", "byte-equal", "compared",
    JSON.stringify(payloads[0].instructions ?? null) === JSON.stringify(payloads[1].instructions ?? null));
  log.check(ctx.workloadId, "provider.tools-stable", "byte-equal", "compared",
    JSON.stringify(payloads[0].tools ?? null) === JSON.stringify(payloads[1].tools ?? null));

  const firstCache = explicitCacheFields(payloads[0]);
  const secondCache = explicitCacheFields(payloads[1]);
  log.check(ctx.workloadId, "provider.cache-key-stable", JSON.stringify(firstCache), JSON.stringify(secondCache),
    JSON.stringify(firstCache) === JSON.stringify(secondCache));
  const usages = assistantUsages(run);
  const usageShape = usages.length === 2 && usages.every((usage) =>
    Number.isFinite(usage.cacheRead) && Number.isFinite(usage.cacheWrite)) && usages[1].cacheRead > 0;
  log.check(ctx.workloadId, "provider.cache-usage-observed", "second cacheRead > 0",
    usages.length === 2 ? usages[1].cacheRead : null, usageShape);

  if (!backgroundCheckpointId) return;
  const bytesBeforeAdvance = readFileSync(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "epoch.active-context-held", "byte-identical A", `${bytesBeforeAdvance.length}B`,
    bytesBefore.equals(bytesBeforeAdvance));
  const activeBeforeAdvance = await readActiveContext(activeContextPathFor(ctx));
  const sourcePressureTokens = seedEpochAdvancePressure(
    ctx, run.sessionFile, activeBeforeAdvance.rawTailStartEventId, epochHighWater,
  );
  const advanceRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 5,
    endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: backgroundCheckpointId },
      { prompt: ctx.workload.inputs.P4 },
    ],
  });
  assertRunHealthy(log, ctx, advanceRun, { requireCapture: true });
  log.check(ctx.workloadId, "epoch.advance-pressure", `source raw tail >=${epochHighWater}`,
    sourcePressureTokens, sourcePressureTokens >= epochHighWater);
  let advancePayloads = providerPayloads(advanceRun);
  log.check(ctx.workloadId, "epoch.advance-capture-count", 1, advancePayloads.length, advancePayloads.length === 1);
  if (advancePayloads.length !== 1) return;
  let effectiveAdvanceRun = advanceRun;
  let activeAfterAdvance = await readActiveContext(activeContextPathFor(ctx));
  const advanceRuns = [advanceRun];
  if (activeAfterAdvance?.checkpointId === established.checkpointId) {
    const followup = await runPi(ctx, {
      workloadId: ctx.workloadId,
      turn: 6,
      endpoint: ctx.endpoint,
      actions: [
        { command: "/viking sync" },
        {
          command: "/viking",
          untilNotifyIncludes: "Checkpoint：已赶上",
          untilNotifyExcludes: `最近 ${backgroundCheckpointId}`,
        },
        { prompt: ctx.workload.inputs.P5 },
      ],
    });
    assertRunHealthy(log, ctx, followup, { requireCapture: true });
    advanceRuns.push(followup);
    effectiveAdvanceRun = followup;
    advancePayloads = providerPayloads(followup);
    log.check(ctx.workloadId, "epoch.followup-capture-count", 1, advancePayloads.length, advancePayloads.length === 1);
    if (advancePayloads.length !== 1) return;
    activeAfterAdvance = await readActiveContext(activeContextPathFor(ctx));
  }
  const bytesAfterAdvance = readFileSync(activeContextPathFor(ctx));
  const advancedCheckpointId = activeAfterAdvance?.checkpointId ?? null;
  log.check(ctx.workloadId, "epoch.active-context-advanced", "checkpoint newer than A", advancedCheckpointId,
    typeof advancedCheckpointId === "string" && CHECKPOINT_ID.test(advancedCheckpointId) &&
      advancedCheckpointId !== established.checkpointId && !bytesBeforeAdvance.equals(bytesAfterAdvance));
  if (!advancedCheckpointId || advancedCheckpointId === established.checkpointId) return;
  const advanceAnchorMarker = effectiveAdvanceRun === advanceRun ? ctx.workload.inputs.P4 : ctx.workload.inputs.P5;
  assertPayloadUsesCheckpoint(
    log, ctx, advancePayloads[0], advancedCheckpointId, ctx.archivedMarker, "takeover.advance",
    advanceAnchorMarker,
  );
  const advanceSource = await branchSource(ctx, effectiveAdvanceRun.sessionFile);
  recordWrittenObjects(ctx, advanceSource.branch, describeArchives(ctx.sessionId, advanceSource.branch, stableConfig.archive));
  const checkpointAdapter = new RecordedEventAdapter(ctx.client, { userRoot: ctx.userRoot });
  const storedAdvancedCheckpoint = await checkpointAdapter.readEvent(
    ctx.sessionId, checkpointEventIdFor(advancedCheckpointId),
  );
  const advancedCheckpoint = parseCheckpointEventById(storedAdvancedCheckpoint.event, advancedCheckpointId);
  const advancedCheckpointHash = storedAdvancedCheckpoint.event.contentHash;

  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.compaction);
  seedCompactionPressure(ctx, run.sessionFile);
  const compactionRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: effectiveAdvanceRun.turn + 1,
    endpoint: ctx.endpoint,
    capture: "observation",
    actions: [
      { rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs },
      { command: "/viking sync" },
    ],
  });
  log.check(ctx.workloadId, "compaction.run-exit", 0, compactionRun.exitCode, compactionRun.exitCode === 0);
  const compactionErrors = compactionRun.events.filter((event) => event.type === "extension_error");
  log.check(ctx.workloadId, "compaction.extension-errors", 0, compactionErrors.length, compactionErrors.length === 0);
  const observation = parseObservationRun(readFileSync(compactionRun.observationPath));
  log.check(ctx.workloadId, "compaction.observation-complete", true, observation.summary.complete,
    observation.summary.complete, observation.errors.join(","));
  const decision = observation.records.find((record) =>
    record.stage === "active_context_compaction" && record.data?.branch === "provide_context");
  log.check(ctx.workloadId, "compaction.observed", "provide_context", decision?.data?.branch ?? null, Boolean(decision));

  const compact = compactionRun.actions[0]?.response?.data;
  const manager = SessionManager.open(compactionRun.sessionFile);
  const compactionEntry = manager.getBranch().findLast((entry) => entry.type === "compaction");
  log.check(ctx.workloadId, "compaction.from-hook", true, compactionEntry?.fromHook,
    compactionEntry?.fromHook === true && compact?.details?.type === "openviking-active-context");
  log.check(ctx.workloadId, "compaction.identity", advancedCheckpointId,
    compact?.details?.checkpointId ?? null,
    compact?.details?.checkpointId === advancedCheckpointId &&
      compact.details.checkpointHash === advancedCheckpointHash &&
      compact.details.checkpointHash === compactionEntry?.details?.checkpointHash &&
      compact.details.sourceArchiveId === advancedCheckpoint.sourceArchiveId &&
      compact.details.sourceArchiveHash === advancedCheckpoint.sourceArchiveHash &&
      compact.details.rawTailStartEventId === activeAfterAdvance.rawTailStartEventId);
  log.check(ctx.workloadId, "active-context-stable", "byte-identical", `${readFileSync(activeContextPathFor(ctx)).length}B`,
    bytesAfterAdvance.equals(readFileSync(activeContextPathFor(ctx))));

  ctx.providerEvidence = {
    topLevelKeys: Object.keys(payloads[0] ?? {}).sort(),
    inputLengths: [firstInput?.length ?? null, secondInput?.length ?? null, providerInput(advancePayloads[0])?.length ?? null],
    checkpointEpochs: [established.checkpointId, backgroundCheckpointId, advancedCheckpointId],
    explicitCacheKeys: Object.keys(firstCache).sort(),
    cacheUsage: usages.map((usage) => ({ cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, input: usage.input })),
  };
  ctx.workload.providerEvidence = ctx.providerEvidence;
  ctx.runs.push(summarizeRun(calibration), summarizeRun(run), ...advanceRuns.map(summarizeRun), {
    turn: compactionRun.turn,
    ms: compactionRun.ms,
    exitCode: compactionRun.exitCode,
    observation: observation.summary,
    observationPath: compactionRun.observationPath,
  });
  const source = await branchSource(ctx, compactionRun.sessionFile);
  recordWrittenObjects(ctx, source.branch, describeArchives(ctx.sessionId, source.branch, ctx.manifest.environment.extensionConfig.content.archive));
}

async function w2(log, ctx) {
  const established = await establishActiveContext(log, ctx, ctx.workload.inputs);
  if (!established?.active) return;
  const first = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 3, endpoint: ctx.endpoint,
    actions: [{ prompt: ctx.workload.inputs.P2 }],
  });
  assertRunHealthy(log, ctx, first, { requireCapture: true });
  const firstPayload = providerPayloads(first)[0];
  assertPayloadUsesCheckpoint(log, ctx, firstPayload, established.checkpointId, ctx.archivedMarker, "restart.first");
  const activeBytes = readFileSync(activeContextPathFor(ctx));

  const restarted = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 4, endpoint: ctx.endpoint,
    actions: [{ prompt: ctx.workload.inputs.P3 }],
  });
  assertRunHealthy(log, ctx, restarted, { requireCapture: true });
  const restartedPayload = providerPayloads(restarted)[0];
  assertPayloadUsesCheckpoint(log, ctx, restartedPayload, established.checkpointId, ctx.archivedMarker, "restart.second");
  log.check(ctx.workloadId, "restart.active-context-bytes", "byte-identical",
    `${readFileSync(activeContextPathFor(ctx)).length}B`, activeBytes.equals(readFileSync(activeContextPathFor(ctx))));

  const disconnected = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 5, endpoint: "http://127.0.0.1:1",
    actions: [{ prompt: "OPENVIKING_DEGRADED_FULL_CONTEXT：请只回复 SAFE。" }],
  });
  assertRunHealthy(log, ctx, disconnected, { requireCapture: true });
  const disconnectedText = JSON.stringify(providerPayloads(disconnected)[0]);
  log.check(ctx.workloadId, "disconnected.full-context", true, disconnectedText.includes(ctx.archivedMarker),
    disconnectedText.includes(ctx.archivedMarker) && !disconnectedText.includes(established.checkpointId));

  const manager = SessionManager.open(disconnected.sessionFile);
  manager.resetLeaf();
  manager.appendMessage({ role: "user", content: ctx.workload.inputs.P4, timestamp: Date.now() });
  const switched = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 6, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { prompt: ctx.workload.inputs.P4 }],
  });
  assertRunHealthy(log, ctx, switched, { requireCapture: true });
  const switchedText = JSON.stringify(providerPayloads(switched)[0]);
  log.check(ctx.workloadId, "branch.old-checkpoint-removed", false, switchedText.includes(established.checkpointId),
    !switchedText.includes(established.checkpointId) && switchedText.includes(ctx.workload.inputs.P4));
  log.check(ctx.workloadId, "branch.active-context-cleared", null,
    await readActiveContext(activeContextPathFor(ctx)), (await readActiveContext(activeContextPathFor(ctx))) === null);

  ctx.runs.push(summarizeRun(first), summarizeRun(restarted), summarizeRun(disconnected), summarizeRun(switched));
  const source = await branchSource(ctx, switched.sessionFile);
  recordWrittenObjects(ctx, source.branch, describeArchives(ctx.sessionId, source.branch, ctx.manifest.environment.extensionConfig.content.archive));
}

function seedCapacityMismatch(ctx, sessionFile) {
  const manager = SessionManager.open(sessionFile);
  manager.appendMessage({
    role: "user",
    content: `${LARGE_MARKER}\n${"x".repeat(ctx.manifest.environment.capacityMismatchChars)}`,
    timestamp: Date.now(),
  });
}

async function w3(log, ctx) {
  const established = await establishActiveContext(log, ctx, ctx.workload.inputs);
  if (!established?.active) return;
  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.checkpointOverBudget);
  const overBudget = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 3, endpoint: ctx.endpoint,
    actions: [{ prompt: ctx.workload.inputs.P3 }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, overBudget, { requireCapture: true });
  const overBudgetStatus = vikingActiveContext(overBudget);
  log.check(ctx.workloadId, "checkpoint-budget.status", "checkpoint 超出配置预算", overBudgetStatus.reason,
    overBudgetStatus.reason === "checkpoint 超出配置预算");
  const overBudgetPayload = JSON.stringify(providerPayloads(overBudget)[0]);
  const referenceContext = overBudgetPayload.includes("openviking-checkpoint-reference") &&
    overBudgetPayload.includes(established.checkpointId) &&
    overBudgetPayload.includes(established.descriptor.manifest.archiveId) &&
    !overBudgetPayload.includes(ctx.archivedMarker);
  log.check(ctx.workloadId, "checkpoint-budget.reference-context", true, referenceContext, referenceContext);

  // 先用观察运行证明超预算 checkpoint 选择有界引用；它只完成一个小 turn，不先执行 compaction。
  // 随后追加不可归档的大 user entry，在无 provider 请求的状态检查后只执行一次 Pi 原生压缩。
  const observed = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 4, endpoint: ctx.endpoint, capture: "observation",
    actions: [{ prompt: ctx.workload.inputs.P2 }],
  });
  log.check(ctx.workloadId, "checkpoint-budget.observation-exit", 0, observed.exitCode, observed.exitCode === 0);
  const observedErrors = observed.events.filter((event) => event.type === "extension_error");
  log.check(ctx.workloadId, "checkpoint-budget.observation-errors", 0, observedErrors.length, observedErrors.length === 0);
  const overBudgetObservation = parseObservationRun(readFileSync(observed.observationPath));
  log.check(ctx.workloadId, "checkpoint-budget.observation-complete", true, overBudgetObservation.summary.complete,
    overBudgetObservation.summary.complete, overBudgetObservation.errors.join(","));
  const takeoverRecord = overBudgetObservation.records.find((record) =>
    record.stage === "active_context_takeover" && record.data?.branch === "reference_context" &&
      record.data?.eligibility === "checkpoint_over_budget");
  log.check(ctx.workloadId, "checkpoint-budget.takeover-observed", "reference_context/checkpoint_over_budget",
    takeoverRecord ? `${takeoverRecord.data.branch}/${takeoverRecord.data.eligibility}` : null, Boolean(takeoverRecord));
  // 引用 fallback 的观察证据：provider payload 必须确实收缩，pressure 与容量在场。
  log.check(ctx.workloadId, "checkpoint-budget.reference-payload-shrinks", "selectedPayload < previousPayload",
    takeoverRecord ? `${takeoverRecord.data.previousPayload}→${takeoverRecord.data.selectedPayload}` : null,
    Number.isInteger(takeoverRecord?.data?.previousPayload) &&
      Number.isInteger(takeoverRecord?.data?.selectedPayload) &&
      takeoverRecord.data.selectedPayload > 0 &&
      takeoverRecord.data.selectedPayload < takeoverRecord.data.previousPayload &&
      Number.isInteger(takeoverRecord?.data?.pressure) && Number.isInteger(takeoverRecord?.data?.capacity));

  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.capacityMismatch);
  seedCapacityMismatch(ctx, established.formation.sessionFile);
  const capacity = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 5, endpoint: ctx.endpoint,
    actions: [{ command: "/viking" }],
  });
  assertRunHealthy(log, ctx, capacity, { requireCapture: true, expectedCaptureCount: 0 });
  const capacityPayloads = providerPayloads(capacity);
  log.check(ctx.workloadId, "capacity.provider-not-invoked", 0, capacityPayloads.length,
    capacityPayloads.length === 0);

  const native = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 6, endpoint: ctx.endpoint, capture: "observation",
    actions: [{ rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs }],
  });
  log.check(ctx.workloadId, "capacity.observation-exit", 0, native.exitCode, native.exitCode === 0);
  const nativeErrors = native.events.filter((event) => event.type === "extension_error");
  log.check(ctx.workloadId, "capacity.observation-errors", 0, nativeErrors.length, nativeErrors.length === 0);
  const nativeObservation = parseObservationRun(readFileSync(native.observationPath));
  log.check(ctx.workloadId, "capacity.observation-complete", true, nativeObservation.summary.complete,
    nativeObservation.summary.complete, nativeObservation.errors.join(","));
  const mismatchRecord = nativeObservation.records.find((record) =>
    record.stage === "active_context_eligibility" && record.data?.branch === "capacity_mismatch" &&
      Number.isInteger(record.data?.payload) && Number.isInteger(record.data?.usable) &&
      record.data.payload >= record.data.usable);
  log.check(ctx.workloadId, "capacity.mismatch", "capacity_mismatch with payload >= usable",
    mismatchRecord ? `${mismatchRecord.data.branch}: ${mismatchRecord.data.payload} >= ${mismatchRecord.data.usable}` : null,
    Boolean(mismatchRecord));
  const compactionRecord = nativeObservation.records.find((record) =>
    record.stage === "active_context_compaction" && record.data?.branch === "native_compaction" &&
      record.data?.eligibility === "capacity_mismatch");
  log.check(ctx.workloadId, "capacity.compaction-observed", "native_compaction/capacity_mismatch",
    compactionRecord ? `${compactionRecord.data.branch}/${compactionRecord.data.eligibility}` : null,
    Boolean(compactionRecord));
  const manager = SessionManager.open(native.sessionFile);
  const entry = manager.getBranch().findLast((candidate) => candidate.type === "compaction");
  const result = native.actions[0]?.response?.data;
  log.check(ctx.workloadId, "compaction.native", false, entry?.fromHook ?? false,
    entry?.fromHook !== true && result?.details?.type !== "openviking-active-context" && Boolean(result?.usage));

  ctx.runs.push(summarizeRun(overBudget), {
    turn: observed.turn, ms: observed.ms, exitCode: observed.exitCode,
    observation: overBudgetObservation.summary, observationPath: observed.observationPath,
  }, summarizeRun(capacity), {
    turn: native.turn, ms: native.ms, exitCode: native.exitCode,
    observation: nativeObservation.summary, observationPath: native.observationPath,
  });
  const parsed = parsePiSessionJsonl(await readFile(native.sessionFile, "utf8"), { sessionId: ctx.sessionId });
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  const onBranch = new Set(parsed.branch.map((branchEntry) => branchEntry.id));
  const branch = events.filter((event) => onBranch.has(event.source.entryId));
  recordWrittenObjects(ctx, branch, describeArchives(ctx.sessionId, branch, ctx.manifest.environment.extensionConfig.content.archive));
}

// w4：单条超过 rawTail 预算的原子事件经真实 archive → VLM checkpoint 管线后，takeover 必须
// 正常接管（不回退容量不匹配）；接管的 checkpoint 块必须携带恢复指引；随后的原生压缩必须在
// 下一轮请求注入一次性恢复指针且只注入一次。
async function w4(log, ctx) {
  const established = await establishActiveContext(log, ctx, ctx.workload.inputs);
  if (!established?.active) return;

  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.content);
  const oversizedContent = appendUserPressure(
    established.formation.sessionFile, OVERSIZED_MARKER,
    `${ctx.sessionId}/w4-oversized`, ctx.manifest.environment.oversizedAtomicChars,
  );
  // 归档边界必须在大原子 entry 之后保留完整 raw tail；追加两倍预算的独立 entry，
  // 使压力轴跨过下一个 chunk 边界并留下所需 tail，而不是假设超预算 entry 会立即归档。
  appendUserPressure(
    established.formation.sessionFile, "TAKEOVER_OVERSIZED_TRAILING_PRESSURE",
    `${ctx.sessionId}/w4-trailing`,
    ctx.manifest.environment.extensionConfig.content.archive.rawTailTokenBudget * 8,
  );
  const syncRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 3, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, syncRun, { requireCapture: false });

  // 独立重算分支与 Archive 计划，按事件范围定位覆盖大事件的 Archive；身份可确定性推导。
  const source = await branchSource(ctx, syncRun.sessionFile);
  const archives = describeArchives(ctx.sessionId, source.branch, ctx.manifest.environment.extensionConfig.content.archive);
  const oversizedArchive = archives.find((archive) => source.branch.slice(archive.startIndex, archive.endIndex + 1)
    .some((event) => JSON.stringify(event.payload).includes(OVERSIZED_MARKER)));
  const oversizedArchived = Boolean(oversizedArchive);
  log.check(ctx.workloadId, "oversized.archived", true, oversizedArchived, oversizedArchived,
    "超过 rawTail 预算的原子事件必须在保留后续 raw tail 后完整进入 Archive");
  if (!oversizedArchive) return;
  const expectedCheckpointId = checkpointIdFor(oversizedArchive.manifest);

  const waitRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 4, endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { command: "/viking", untilNotifyIncludes: expectedCheckpointId },
    ],
  });
  assertRunHealthy(log, ctx, waitRun, { requireCapture: false });
  ctx.runs.push(summarizeRun(syncRun), summarizeRun(waitRun));

  const takeoverRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 5, endpoint: ctx.endpoint,
    actions: [{ prompt: ctx.workload.inputs.P2 }],
  });
  assertRunHealthy(log, ctx, takeoverRun, { requireCapture: true });
  const active = await readActiveContext(activeContextPathFor(ctx));
  log.check(ctx.workloadId, "oversized.active-context", expectedCheckpointId, active?.checkpointId,
    Boolean(active) && active.checkpointId === expectedCheckpointId,
    "最新 checkpoint 必须在下一次真实 context hook 中原子推进为 ActiveContext");
  const payloads = providerPayloads(takeoverRun);
  log.check(ctx.workloadId, "takeover.capture-count", 1, payloads.length, payloads.length === 1);
  if (payloads.length !== 1) return;
  const payloadText = JSON.stringify(payloads[0]);
  log.check(ctx.workloadId, "takeover.checkpoint-used", expectedCheckpointId,
    payloadText.match(CHECKPOINT_ID)?.[0] ?? null, payloadText.includes(expectedCheckpointId),
    "大事件经 checkpoint 消费后 takeover 不得回退为容量不匹配");
  log.check(ctx.workloadId, "takeover.oversized-removed", false,
    payloadText.includes(oversizedContent), !payloadText.includes(oversizedContent),
    "takeover 可以保留 checkpoint 提炼的 marker，但不得保留完整 30K 原始事件正文");
  log.check(ctx.workloadId, "takeover.recovery-guidance", true,
    payloadText.includes("recover details with viking_search"),
    payloadText.includes("recover details with viking_search"),
    "接管 payload 的 checkpoint 块必须携带归档恢复指引");
  ctx.runs.push(summarizeRun(takeoverRun));

  // checkpoint 超预算使 compaction 走原生路径；原生压缩后的下一个请求必须携带一次性恢复指针。
  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.checkpointOverBudget);
  const compactRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 6, endpoint: ctx.endpoint,
    actions: [
      { rpc: { type: "set_auto_compaction", enabled: false } },
      { prompt: COMPACTION_PADDING_PROMPT },
      { rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs },
      { prompt: ctx.workload.inputs.P3 },
      { prompt: ctx.workload.inputs.P4 },
    ],
  });
  assertRunHealthy(log, ctx, compactRun, { requireCapture: true });
  const compactManager = SessionManager.open(compactRun.sessionFile);
  const compactEntry = compactManager.getBranch().findLast((candidate) => candidate.type === "compaction");
  const compactResult = compactRun.actions[2]?.response?.data;
  log.check(ctx.workloadId, "compaction.native", false, compactEntry?.fromHook ?? false,
    compactEntry?.fromHook !== true && compactResult?.details?.type !== "openviking-active-context" &&
      Boolean(compactResult?.usage));
  const compactPayloads = providerPayloads(compactRun);
  const p3 = compactPayloads.find((payload) => JSON.stringify(payload).includes("POINTER_FIRST"));
  const p4 = compactPayloads.find((payload) => JSON.stringify(payload).includes("POINTER_SECOND"));
  log.check(ctx.workloadId, "compaction.pointer-injected", true,
    Boolean(p3) && JSON.stringify(p3).includes("<openviking-compaction>"),
    Boolean(p3) && JSON.stringify(p3).includes("<openviking-compaction>") &&
      JSON.stringify(p3).includes(oversizedArchive.manifest.archiveId),
    "原生压缩后的下一个请求必须注入一次性恢复指针");
  log.check(ctx.workloadId, "compaction.pointer-oneshot", true,
    Boolean(p4) && !JSON.stringify(p4).includes("<openviking-compaction>"),
    Boolean(p4) && !JSON.stringify(p4).includes("<openviking-compaction>"),
    "恢复指针只注入一次，后续请求不得重复携带");
  ctx.runs.push(summarizeRun(compactRun));

  const parsed = parsePiSessionJsonl(await readFile(compactRun.sessionFile, "utf8"), { sessionId: ctx.sessionId });
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  const onBranch = new Set(parsed.branch.map((branchEntry) => branchEntry.id));
  const branch = events.filter((event) => onBranch.has(event.source.entryId));
  recordWrittenObjects(ctx, branch, describeArchives(ctx.sessionId, branch, ctx.manifest.environment.extensionConfig.content.archive));
}

const WORKLOAD_RUNNERS = {
  "w1-takeover-stable-prefix": w1,
  "w2-restart-branch-fail-open": w2,
  "w3-capacity-compaction-fail-open": w3,
  "w4-oversized-checkpoint-recovery": w4,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "takeover",
    manifestPath: join(REPO, "test/live/takeover.workloads.json"),
    manifestHashPath: join(REPO, "test/live/takeover.workloads.sha256"),
    runners: WORKLOAD_RUNNERS,
    collectObjectUris,
    collectTaskResources,
    summaryExtra: async (ctx) => ({
      providerEvidence: Object.fromEntries(ctx.manifest.workloads
        .filter((workload) => workload.summary?.sessionId)
        .map((workload) => [workload.id, workload.providerEvidence ?? null])),
    }),
  }).catch((error) => {
    process.stderr.write(`✗ verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
