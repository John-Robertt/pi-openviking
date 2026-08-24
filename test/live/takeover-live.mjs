// verify:takeover:live — 上下文切换与 Pi compaction fail-open 真实验收门禁。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { calculateContextTokens, SessionManager } from "@earendil-works/pi-coding-agent";

import { readActiveContext } from "../../shared/active-context.mjs";
import { describeArchives } from "../../shared/archive.mjs";
import { checkpointEventIdFor, parseCheckpointEventById } from "../../shared/checkpoint.mjs";
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
  LIVE_REPO as REPO,
  assertRunHealthy,
  runLiveGate,
  runPi,
  summarizeRun,
} from "./live-support.mjs";
import { parseObservationRun } from "./observation-evidence.mjs";

const CHECKPOINT_ID = /chk_[0-9a-f]{64}/;
const LARGE_MARKER = "TAKEOVER_CAPACITY_ATOMIC_MARKER";

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
  manager.appendMessage({
    role: "user",
    content: `${marker}\n${seededText(seed, chars)}`,
    timestamp: Date.now(),
  });
}

function seedCompactionPressure(ctx, sessionFile) {
  appendUserPressure(
    sessionFile, "TAKEOVER_COMPACTION_PRESSURE", ctx.sessionId, ctx.manifest.environment.compactionChars,
  );
}

function seedEpochAdvancePressure(ctx, sessionFile) {
  appendUserPressure(
    sessionFile, "TAKEOVER_EPOCH_ADVANCE_PRESSURE", `${ctx.sessionId}/epoch-advance`,
    ctx.manifest.environment.epochAdvanceChars,
  );
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
      { delayMs: ctx.manifest.environment.epochCheckpointWaitMs },
      { command: "/viking" },
      { prompt: ctx.workload.inputs.P3 },
    ],
  });
  assertRunHealthy(log, ctx, run, { requireCapture: true });
  const latestSource = await branchSource(ctx, run.sessionFile);
  recordWrittenObjects(ctx, latestSource.branch, describeArchives(ctx.sessionId, latestSource.branch, stableConfig.archive));
  const checkpointMessage = String(run.actions[3]?.notifyEvent?.message ?? "");
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
    const stable = stablePrefixLength(firstInput, secondInput);
    const expectedStable = Math.max(0, firstInput.length - 1);
    log.check(ctx.workloadId, "provider.stable-prefix", `>=${expectedStable}`, stable,
      stable >= expectedStable && secondInput.length > firstInput.length,
      "当前 user message 可携带一次性 recall；其前全部 provider input 必须稳定，后续消息只追加在其后");
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
  seedEpochAdvancePressure(ctx, run.sessionFile);
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
  const advanceStatus = vikingActiveContext({ actions: [advanceRun.actions[1]] });
  log.check(ctx.workloadId, "epoch.advance-pressure", `>=${epochHighWater}`,
    advanceStatus.payloadTokens,
    Number.isFinite(advanceStatus.payloadTokens) && advanceStatus.payloadTokens >= epochHighWater,
    advanceStatus.message);
  const advancePayloads = providerPayloads(advanceRun);
  log.check(ctx.workloadId, "epoch.advance-capture-count", 1, advancePayloads.length, advancePayloads.length === 1);
  if (advancePayloads.length !== 1) return;
  const activeAfterAdvance = await readActiveContext(activeContextPathFor(ctx));
  const bytesAfterAdvance = readFileSync(activeContextPathFor(ctx));
  const advancedCheckpointId = activeAfterAdvance?.checkpointId ?? null;
  log.check(ctx.workloadId, "epoch.active-context-advanced", "checkpoint newer than A", advancedCheckpointId,
    typeof advancedCheckpointId === "string" && CHECKPOINT_ID.test(advancedCheckpointId) &&
      advancedCheckpointId !== established.checkpointId && !bytesBeforeAdvance.equals(bytesAfterAdvance));
  if (!advancedCheckpointId || advancedCheckpointId === established.checkpointId) return;
  assertPayloadUsesCheckpoint(
    log, ctx, advancePayloads[0], advancedCheckpointId, ctx.archivedMarker, "takeover.advance",
    "TAKEOVER_EPOCH_ADVANCE_PRESSURE",
  );
  const advanceSource = await branchSource(ctx, advanceRun.sessionFile);
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
    turn: 6,
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
  ctx.runs.push(summarizeRun(calibration), summarizeRun(run), summarizeRun(advanceRun), {
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
  log.check(ctx.workloadId, "checkpoint-budget.full-context", true, overBudgetPayload.includes(ctx.archivedMarker),
    overBudgetPayload.includes(ctx.archivedMarker) && !overBudgetPayload.includes(established.checkpointId));

  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.capacityMismatch);
  seedCapacityMismatch(ctx, established.formation.sessionFile);
  const capacity = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 4, endpoint: ctx.endpoint,
    actions: [
      { command: "/viking sync" },
      { rpc: { type: "set_auto_compaction", enabled: false } },
      { prompt: ctx.workload.inputs.P2 },
      { command: "/viking" },
    ],
  });
  assertRunHealthy(log, ctx, capacity, { requireCapture: true });
  const status = vikingActiveContext(capacity);
  log.check(ctx.workloadId, "capacity.mismatch", "容量不匹配", status.reason,
    status.reason === "容量不匹配" && status.payloadTokens >= status.usableTokens);
  const payloadText = JSON.stringify(providerPayloads(capacity)[0]);
  log.check(ctx.workloadId, "capacity.full-context", true, payloadText.includes(LARGE_MARKER),
    payloadText.includes(LARGE_MARKER) && !payloadText.includes(established.checkpointId));

  const native = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 5, endpoint: ctx.endpoint,
    actions: [{ rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs }],
  });
  assertRunHealthy(log, ctx, native, { requireCapture: true, expectedCaptureCount: 0 });
  const manager = SessionManager.open(native.sessionFile);
  const entry = manager.getBranch().findLast((candidate) => candidate.type === "compaction");
  const result = native.actions[0]?.response?.data;
  log.check(ctx.workloadId, "compaction.native", false, entry?.fromHook ?? false,
    entry?.fromHook !== true && result?.details?.type !== "openviking-active-context" && Boolean(result?.usage));

  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig.checkpointOverBudget);
  const observed = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 6, endpoint: ctx.endpoint, capture: "observation",
    actions: [
      { rpc: { type: "set_auto_compaction", enabled: false } },
      { prompt: ctx.workload.inputs.P3 },
      { rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs },
    ],
  });
  log.check(ctx.workloadId, "checkpoint-budget.observation-exit", 0, observed.exitCode, observed.exitCode === 0);
  const observedErrors = observed.events.filter((event) => event.type === "extension_error");
  log.check(ctx.workloadId, "checkpoint-budget.observation-errors", 0, observedErrors.length, observedErrors.length === 0);
  const overBudgetObservation = parseObservationRun(readFileSync(observed.observationPath));
  log.check(ctx.workloadId, "checkpoint-budget.observation-complete", true, overBudgetObservation.summary.complete,
    overBudgetObservation.summary.complete, overBudgetObservation.errors.join(","));
  const takeoverRecord = overBudgetObservation.records.find((record) =>
    record.stage === "active_context_takeover" && record.data?.branch === "keep_full_context" &&
      record.data?.eligibility === "checkpoint_over_budget");
  log.check(ctx.workloadId, "checkpoint-budget.takeover-observed", "keep_full_context/checkpoint_over_budget",
    takeoverRecord ? `${takeoverRecord.data.branch}/${takeoverRecord.data.eligibility}` : null, Boolean(takeoverRecord));
  const compactionRecord = overBudgetObservation.records.find((record) =>
    record.stage === "active_context_compaction" && record.data?.branch === "native_compaction" &&
      record.data?.eligibility === "checkpoint_over_budget");
  log.check(ctx.workloadId, "checkpoint-budget.compaction-observed", "native_compaction/checkpoint_over_budget",
    compactionRecord ? `${compactionRecord.data.branch}/${compactionRecord.data.eligibility}` : null, Boolean(compactionRecord));
  const observedManager = SessionManager.open(observed.sessionFile);
  const observedEntry = observedManager.getBranch().findLast((candidate) => candidate.type === "compaction");
  const observedCompaction = observed.actions[2]?.response?.data;
  log.check(ctx.workloadId, "checkpoint-budget.compaction-native", false, observedEntry?.fromHook ?? false,
    observedEntry?.fromHook !== true && observedCompaction?.details?.type !== "openviking-active-context" &&
      Boolean(observedCompaction?.usage));

  ctx.runs.push(summarizeRun(overBudget), summarizeRun(capacity), summarizeRun(native), {
    turn: observed.turn, ms: observed.ms, exitCode: observed.exitCode,
    observation: overBudgetObservation.summary, observationPath: observed.observationPath,
  });
  const parsed = parsePiSessionJsonl(await readFile(observed.sessionFile, "utf8"), { sessionId: ctx.sessionId });
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  const onBranch = new Set(parsed.branch.map((branchEntry) => branchEntry.id));
  const branch = events.filter((event) => onBranch.has(event.source.entryId));
  recordWrittenObjects(ctx, branch, describeArchives(ctx.sessionId, branch, ctx.manifest.environment.extensionConfig.content.archive));
}

const WORKLOAD_RUNNERS = {
  "w1-takeover-stable-prefix": w1,
  "w2-restart-branch-fail-open": w2,
  "w3-capacity-compaction-fail-open": w3,
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
