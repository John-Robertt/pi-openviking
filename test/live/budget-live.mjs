#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { calculateContextTokens, SessionManager } from "@earendil-works/pi-coding-agent";

import { OVClient } from "../../client.ts";
import {
  materializeActiveContext,
  payloadSegment,
  readActiveContext,
  renderActiveContextMessages,
  selectActiveContext,
} from "../../shared/active-context.mjs";
import { archiveManifestBytes, describeArchives } from "../../shared/archive.mjs";
import { ArchiveManager, archiveStorageLocation } from "../../shared/archive-store.mjs";
import {
  CHECKPOINT_MAX_ATTEMPTS,
  checkpointEventId,
  checkpointEventIdFor,
  checkpointFailureEventId,
  checkpointId,
  checkpointRequestEventId,
  checkpointTaskId,
  parseCheckpointEventById,
} from "../../shared/checkpoint.mjs";
import { CheckpointManager } from "../../shared/checkpoint-store.mjs";
import { eventTokenWeight } from "../../shared/context-weight.mjs";
import { recordedEventBytes } from "../../shared/recorded-event.mjs";
import {
  RecordedEventAdapter,
  recordedEventStorageLocation,
} from "../../shared/recorded-event-adapter.mjs";
import {
  activeContextPathFor,
  branchSource,
  providerPayloads,
  providerVisibleInput,
  recordWrittenObjects,
  vikingActiveContext,
  writeExtensionConfig,
} from "./context-live.mjs";
import {
  LIVE_REPO,
  assertRunHealthy,
  runLiveGate,
  runPi,
  summarizeRun,
} from "./live-support.mjs";
import { parseObservationRun } from "./observation-evidence.mjs";

const ARCHIVED_MARKER = "BUDGET_ARCHIVED_PREFIX";
const TAIL_MARKER = "BUDGET_RAW_TAIL";

function seededText(seed, length) {
  const tag = createHash("sha256").update(seed).digest("hex").slice(0, 12);
  let out = "";
  let index = 0;
  while (out.length < length) {
    out += `const budget_${tag}_${String(index++).padStart(6, "0")} = "archive checkpoint raw tail tool result";\n`;
  }
  return out.slice(0, length);
}

function appendInitialPressure(ctx, sessionFile) {
  const manager = SessionManager.open(sessionFile);
  const { initialChars, initialParts } = ctx.manifest.environment.pressure;
  const partChars = Math.floor(initialChars / initialParts);
  for (let index = 0; index < initialParts; index++) {
    manager.appendMessage({
      role: "assistant",
      content: `${index === 0 ? ARCHIVED_MARKER : "BUDGET_INITIAL"}_${index}\n${seededText(`${ctx.sessionId}/initial/${index}`, partChars)}`,
    });
  }
}

function appendToolLoop(ctx, sessionFile) {
  const manager = SessionManager.open(sessionFile);
  const { toolTailChars, toolSteps, toolCallsPerStep } = ctx.manifest.environment.pressure;
  const resultChars = Math.floor(toolTailChars / (toolSteps * toolCallsPerStep));
  for (let step = 0; step < toolSteps; step++) {
    const calls = Array.from({ length: toolCallsPerStep }, (_, index) => ({
      type: "toolCall",
      id: `budget-${ctx.sessionId.slice(0, 8)}-${step}-${index}`,
      name: "budget_live_tool",
      arguments: { step, index },
    }));
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `${TAIL_MARKER}_TOOL_STEP_${step}` }, ...calls],
    });
    for (let index = 0; index < calls.length; index++) {
      manager.appendMessage({
        role: "toolResult",
        toolCallId: calls[index].id,
        toolName: calls[index].name,
        isError: index % 2 === 1,
        content: [{
          type: "text",
          text: `${TAIL_MARKER}_${index % 2 === 1 ? "ERROR" : "SUCCESS"}_${step}_${index}\n${seededText(`${ctx.sessionId}/tool/${step}/${index}`, resultChars)}`,
        }],
      });
    }
  }
}

function appendAtomicInput(ctx, sessionFile) {
  const manager = SessionManager.open(sessionFile);
  manager.appendMessage({
    role: "user",
    content: `${TAIL_MARKER}_ATOMIC\n${seededText(`${ctx.sessionId}/atomic`, ctx.manifest.environment.pressure.atomicTailChars)}`,
    timestamp: Date.now(),
  });
}

function appendBranchPressure(ctx, sessionFile, descriptor) {
  const manager = SessionManager.open(sessionFile);
  const branch = manager.getBranch();
  const boundaryEntryId = ctx.initialBranch.find((event) =>
    event.eventId === descriptor.manifest.lastEventId)?.source?.entryId;
  if (!boundaryEntryId || !branch.some((entry) => entry.id === boundaryEntryId)) {
    throw new Error("Archive boundary entry is unavailable for branch workload");
  }
  manager.branch(boundaryEntryId);
  const { branchTailChars } = ctx.manifest.environment.pressure;
  manager.appendMessage({
    role: "user",
    content: `${TAIL_MARKER}_BRANCH\n${seededText(`${ctx.sessionId}/branch`, branchTailChars)}`,
    timestamp: Date.now(),
  });
}

function productClient(ctx, suffix = "budget") {
  const ov = ctx.manifest.identities.openviking;
  return new OVClient({
    endpoint: ctx.endpoint,
    apiKey: "",
    account: ov.account,
    user: ctx.storageUser,
    peerId: `${suffix}-live`,
    userAgent: `pi-openviking/${suffix}-live`,
  });
}

async function committedArchives(log, ctx, sessionFile) {
  const { branch } = await branchSource(ctx, sessionFile);
  const archives = describeArchives(ctx.sessionId, branch, ctx.manifest.environment.extensionConfig.archive);
  const committed = [];
  for (const descriptor of archives) {
    const uri = archiveStorageLocation(ctx.userRoot, ctx.sessionId, descriptor.manifest.archiveId).manifestUri;
    const stored = await ctx.client.downloadBytes(uri);
    const expected = archiveManifestBytes(descriptor.manifest);
    const valid = stored.ok && Buffer.isBuffer(stored.bytes) && stored.bytes.equals(expected);
    log.check(ctx.workloadId, `archive.${descriptor.manifest.archiveId.slice(4, 10)}.bytes`, "source-derived manifest", valid, valid);
    if (valid) committed.push(descriptor);
  }
  recordWrittenObjects(ctx, branch, archives);
  return { branch, archives: committed };
}

async function waitForCheckpoint(manager, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.status.pending === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function produceMeasuredCheckpoint(log, ctx, descriptors) {
  const client = productClient(ctx, "budget-checkpoint");
  const adapter = new RecordedEventAdapter(client, { userRoot: ctx.userRoot });
  const archives = new ArchiveManager(client, {
    userRoot: ctx.userRoot,
    adapter,
    budgets: ctx.manifest.environment.extensionConfig.archive,
  });
  const manager = new CheckpointManager(client, {
    adapter,
    archiveManager: archives,
    pollIntervalMs: ctx.manifest.thresholds.pollMs,
  });
  const started = Date.now();
  try {
    await manager.schedule(ctx.sessionId, descriptors);
    const settled = await waitForCheckpoint(manager, ctx.manifest.thresholds.checkpointWallMs);
    const wallMs = Date.now() - started;
    const expectedCheckpointId = checkpointId(descriptors.at(-1).manifest);
    log.check(ctx.workloadId, "checkpoint.settled", true, settled, settled);
    log.check(ctx.workloadId, "checkpoint.identity", expectedCheckpointId, manager.status.lastCheckpointId,
      settled && manager.status.lastCheckpointId === expectedCheckpointId);

    let previousCheckpointId = null;
    let tokenTotal = 0;
    let completedTasks = 0;
    for (const descriptor of descriptors) {
      const taskResourceId = checkpointTaskId(descriptor.manifest, previousCheckpointId, 1);
      const listed = await client.listTasks(taskResourceId);
      const task = Array.isArray(listed.result)
        ? [...listed.result].sort((left, right) => Number(right?.created_at || 0) - Number(left?.created_at || 0))[0]
        : null;
      if (task?.status === "completed") completedTasks++;
      tokenTotal += Math.max(0, Number(task?.result?.token_usage?.llm?.total_tokens) || 0);
      previousCheckpointId = checkpointId(descriptor.manifest);
    }
    log.check(ctx.workloadId, "checkpoint.tasks", descriptors.length, completedTasks,
      completedTasks === descriptors.length);
    log.check(ctx.workloadId, "checkpoint.tokens", ">0", tokenTotal, tokenTotal > 0);
    log.check(ctx.workloadId, "checkpoint.wall", `<=${ctx.manifest.thresholds.checkpointWallMs}`, wallMs,
      wallMs <= ctx.manifest.thresholds.checkpointWallMs);
    return { checkpointId: expectedCheckpointId, wallMs, tokenTotal };
  } finally {
    await manager.stop();
    await client.close(true);
  }
}


function assistantUsages(run) {
  return run.events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => event.message.usage ?? {});
}

function contentTexts(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(contentTexts);
  if (value && typeof value === "object" && typeof value.text === "string") return [value.text];
  return [];
}

async function verifyActiveChain(log, ctx, run, source, checkpointMeasurement) {
  const active = await readActiveContext(activeContextPathFor(ctx));
  const status = vikingActiveContext(run);
  log.check(ctx.workloadId, "active.persisted", true, Boolean(active), Boolean(active));
  if (!active) return null;
  const sourceArchive = source.archives.find((descriptor) => checkpointId(descriptor.manifest) === active.checkpointId);
  const expected = selectActiveContext(source.branch, source.archives, active.checkpointId);
  log.check(ctx.workloadId, "active.source", JSON.stringify(expected), JSON.stringify(active),
    Boolean(sourceArchive) && JSON.stringify(expected) === JSON.stringify(active));
  log.check(ctx.workloadId, "active.status", active.checkpointId, status.checkpointId,
    status.checkpointId === active.checkpointId && status.rawTailStartEventId === active.rawTailStartEventId);

  const adapter = new RecordedEventAdapter(ctx.client, { userRoot: ctx.userRoot });
  const stored = await adapter.readEvent(ctx.sessionId, checkpointEventIdFor(active.checkpointId));
  const checkpoint = parseCheckpointEventById(stored.event, active.checkpointId);
  const payload = materializeActiveContext({
    context: active,
    checkpoint,
    branchEvents: source.branch,
  });
  const start = source.branch.findIndex((event) => event.eventId === active.rawTailStartEventId);
  const rawTail = payloadSegment(payload, "raw-tail").events;
  const exact = start >= 0 && rawTail.length === source.branch.length - start && rawTail.every((event, index) =>
    recordedEventBytes(event).equals(recordedEventBytes(source.branch[start + index])));
  log.check(ctx.workloadId, "active.raw-tail", "byte-exact source suffix", exact, exact);

  const checkpointBudget = ctx.manifest.environment.extensionConfig.takeover.checkpointTokenBudget;
  log.check(ctx.workloadId, "capacity.checkpoint-budget", `<=${checkpointBudget}`, payload.tokens.checkpoint,
    payload.tokens.checkpoint <= checkpointBudget);
  const headroom = Number(status.usableTokens) - Number(status.payloadTokens);
  log.check(ctx.workloadId, "capacity.headroom", `>=${ctx.manifest.thresholds.minHeadroomTokens}`, headroom,
    headroom >= ctx.manifest.thresholds.minHeadroomTokens);
  log.check(ctx.workloadId, "capacity.eligible", true, status.eligible, status.eligible);

  const payloads = providerPayloads(run);
  log.check(ctx.workloadId, "provider.capture", 1, payloads.length, payloads.length === 1);
  const serialized = JSON.stringify(payloads[0] ?? null);
  log.check(ctx.workloadId, "provider.checkpoint", active.checkpointId, serialized.includes(active.checkpointId),
    serialized.includes(active.checkpointId));
  const visibleInput = providerVisibleInput(payloads[0], active.checkpointId);
  const requestEntryId = source.branch.findLast((event) =>
    JSON.stringify(event.payload).includes(`${TAIL_MARKER}_PROMPT`))?.source?.entryId;
  const requestEnd = source.branch.findLastIndex((event) => event.source?.entryId === requestEntryId);
  log.check(ctx.workloadId, "provider.request-boundary", "current prompt entry", requestEnd,
    Boolean(requestEntryId) && requestEnd >= 0);
  const requestPayload = requestEnd >= 0 ? materializeActiveContext({
    context: active, checkpoint, branchEvents: source.branch.slice(0, requestEnd + 1),
  }) : null;
  const expectedTexts = requestPayload ? renderActiveContextMessages(requestPayload).slice(1)
    .flatMap((message) => contentTexts(message.content)).filter((text) => text.length > 0) : [];
  const missingTexts = expectedTexts.filter((text) => !visibleInput.includes(JSON.stringify(text)));
  log.check(ctx.workloadId, "provider.raw-tail-texts", "all rendered text blocks", missingTexts.length,
    expectedTexts.length > 0 && missingTexts.length === 0, `expected=${expectedTexts.length}`);
  log.check(ctx.workloadId, "provider.raw-tail", true, visibleInput.includes(TAIL_MARKER),
    visibleInput.includes(TAIL_MARKER));
  log.check(ctx.workloadId, "provider.archived-prefix", false, visibleInput.includes(ARCHIVED_MARKER),
    !visibleInput.includes(ARCHIVED_MARKER));

  const usage = assistantUsages(run).at(-1) ?? {};
  const providerTokens = calculateContextTokens(usage);
  const providerWallMs = run.actions.find((action) => action.prompt !== undefined)?.ms ?? null;
  const providerHeadroom = Number(status.usableTokens) - providerTokens;
  log.check(ctx.workloadId, "provider.tokens", ">0", providerTokens, providerTokens > 0);
  log.check(ctx.workloadId, "provider.capacity", `<=${status.usableTokens}`, providerTokens,
    providerTokens > 0 && providerTokens <= status.usableTokens);
  log.check(ctx.workloadId, "provider.headroom", `>=${ctx.manifest.thresholds.minProviderHeadroomTokens}`,
    providerHeadroom, providerHeadroom >= ctx.manifest.thresholds.minProviderHeadroomTokens);
  log.check(ctx.workloadId, "provider.wall", ">0", providerWallMs,
    Number.isFinite(providerWallMs) && providerWallMs > 0);
  return {
    active,
    status,
    sourceArchive,
    sourceTokens: source.branch.reduce((total, event) => total + eventTokenWeight(event), 0),
    providerTokens,
    providerHeadroom,
    providerWallMs,
    headroom,
    checkpointWallMs: checkpointMeasurement.wallMs,
    checkpointTokens: checkpointMeasurement.tokenTotal,
  };
}

async function runBudgetWorkload(log, ctx) {
  writeExtensionConfig(ctx, ctx.manifest.environment.extensionConfig);
  const initial = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 0,
    endpoint: ctx.endpoint,
    actions: [{ prompt: "请只回复 OK，不要调用任何工具。" }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, initial, { requireCapture: false });
  appendInitialPressure(ctx, initial.sessionFile);

  const archiveRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 1,
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, archiveRun, { requireCapture: false });
  const firstSource = await committedArchives(log, ctx, archiveRun.sessionFile);
  log.check(ctx.workloadId, "archive.initial-count", 1, firstSource.archives.length,
    firstSource.archives.length === 1);
  const firstArchive = firstSource.archives[0];
  if (!firstArchive) return;
  ctx.initialBranch = firstSource.branch;
  const checkpointMeasurement = await produceMeasuredCheckpoint(log, ctx, [firstArchive]);

  const contextRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 2,
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, contextRun, { requireCapture: false });

  if (ctx.workload.family === "tool-loop") appendToolLoop(ctx, contextRun.sessionFile);
  else if (ctx.workload.family === "atomic") appendAtomicInput(ctx, contextRun.sessionFile);
  else appendBranchPressure(ctx, contextRun.sessionFile, firstArchive);

  const tailRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 3,
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, tailRun, { requireCapture: false });
  const tailCommitRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 4,
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, tailCommitRun, { requireCapture: false });
  const tailSource = await committedArchives(log, ctx, tailCommitRun.sessionFile);
  const minimumArchives = ctx.workload.family === "branch" ? 1 : 2;
  log.check(ctx.workloadId, "archive.full-count", `>=${minimumArchives}`, tailSource.archives.length,
    tailSource.archives.length >= minimumArchives);
  const catchup = await produceMeasuredCheckpoint(log, ctx, tailSource.archives);
  const fullCheckpointMeasurement = {
    wallMs: checkpointMeasurement.wallMs + catchup.wallMs,
    tokenTotal: catchup.tokenTotal,
  };

  const refreshedContextRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 5,
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, refreshedContextRun, { requireCapture: false });
  if (ctx.workload.family === "tool-loop") {
    const stale = vikingActiveContext(refreshedContextRun);
    log.check(ctx.workloadId, "recovery.epoch-held", checkpointMeasurement.checkpointId, stale.checkpointId,
      stale.checkpointId === checkpointMeasurement.checkpointId);
  }

  const providerObservationPath = join(ctx.runDir, "observations", `${ctx.workloadId}-provider.jsonl`);
  const providerRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 6,
    endpoint: ctx.endpoint,
    extraEnv: { OV_OBSERVE: providerObservationPath },
    actions: [
      { command: "/viking sync" },
      { command: "/viking sync" },
      { prompt: `${TAIL_MARKER}_PROMPT：请只回复 DONE，不要调用任何工具。` },
      { command: "/viking sync" },
      { command: "/viking sync" },
      { command: "/viking" },
    ],
  });
  assertRunHealthy(log, ctx, providerRun, { requireCapture: true });
  const providerObservation = parseObservationRun(readFileSync(providerObservationPath));
  log.check(ctx.workloadId, "provider.observation-complete", true, providerObservation.summary.complete,
    providerObservation.summary.complete, providerObservation.errors.join(","));
  const takeoverRecord = providerObservation.records.find((record) => record.stage === "active_context_takeover");
  log.check(ctx.workloadId, "provider.takeover-branch", "replace_context",
    takeoverRecord?.data?.branch ?? null, takeoverRecord?.data?.branch === "replace_context");
  const providerEnds = providerRun.events
    .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
    .map((event) => ({ stopReason: event.message.stopReason ?? null, totalTokens: event.message.usage?.totalTokens ?? 0 }));
  log.check(ctx.workloadId, "provider.assistant-end", "one non-error assistant", JSON.stringify(providerEnds),
    providerEnds.length === 1 && !["error", "aborted"].includes(providerEnds[0].stopReason) && providerEnds[0].totalTokens > 0);
  const providerCompactions = SessionManager.open(providerRun.sessionFile).getBranch()
    .filter((entry) => entry.type === "compaction");
  log.check(ctx.workloadId, "provider.no-prior-compaction", 0, providerCompactions.length,
    providerCompactions.length === 0, providerCompactions.map((entry) => String(entry.fromHook)).join(","));
  const source = await committedArchives(log, ctx, providerRun.sessionFile);
  const measurement = await verifyActiveChain(log, ctx, providerRun, source, fullCheckpointMeasurement);
  if (!measurement) return;

  log.check(ctx.workloadId, "source.minimum", `>=${ctx.manifest.thresholds.minSourceTokens}`,
    measurement.sourceTokens, measurement.sourceTokens >= ctx.manifest.thresholds.minSourceTokens);
  const errorResults = source.branch.filter((event) => event.payload?.entry?.message?.isError === true).length;
  const successResults = source.branch.filter((event) => event.source?.partType === "toolResult" && event.payload?.entry?.message?.isError !== true).length;
  if (ctx.workload.family === "tool-loop") {
    log.check(ctx.workloadId, "tool-loop.outcomes", "success+error", `${successResults}+${errorResults}`,
      successResults > 0 && errorResults > 0);
  }

  let compaction = null;
  if (ctx.workload.family === "branch") {
    const compactRun = await runPi(ctx, {
      workloadId: ctx.workloadId,
      turn: 7,
      endpoint: ctx.endpoint,
      capture: "observation",
      actions: [
        { rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs },
        { command: "/viking sync" },
      ],
    });
    const observation = parseObservationRun(readFileSync(compactRun.observationPath));
    const entry = SessionManager.open(compactRun.sessionFile).getBranch().findLast((item) => item.type === "compaction");
    log.check(ctx.workloadId, "compaction.complete", true, observation.summary.complete, observation.summary.complete);
    log.check(ctx.workloadId, "compaction.from-hook", true, entry?.fromHook, entry?.fromHook === true);
    compaction = { turn: compactRun.turn, ms: compactRun.ms, exitCode: compactRun.exitCode,
      observation: observation.summary, observationPath: compactRun.observationPath };
  }

  ctx.measurements.push({
    workload: ctx.workloadId,
    family: ctx.workload.family,
    repeat: ctx.workload.repeat,
    sourceTokens: measurement.sourceTokens,
    archiveCount: source.archives.length,
    checkpointWallMs: measurement.checkpointWallMs,
    checkpointTokens: measurement.checkpointTokens,
    providerWallMs: measurement.providerWallMs,
    providerTokens: measurement.providerTokens,
    providerHeadroomTokens: measurement.providerHeadroom,
    payloadTokens: measurement.status.payloadTokens,
    usableTokens: measurement.status.usableTokens,
    headroomTokens: measurement.headroom,
  });
  ctx.runs.push(
    summarizeRun(initial),
    summarizeRun(archiveRun),
    summarizeRun(contextRun),
    summarizeRun(tailRun),
    summarizeRun(tailCommitRun),
    summarizeRun(refreshedContextRun),
    { ...summarizeRun(providerRun), observation: providerObservation.summary, observationPath: providerObservationPath },
    ...(compaction ? [compaction] : []),
  );
}

async function collectObjectUris(ctx) {
  const uris = ctx.markerUri ? [ctx.markerUri] : [];
  for (const eventId of ctx.knownEventIds ?? []) {
    uris.push(recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri);
  }
  let previousCheckpointId = null;
  for (const manifest of ctx.knownArchiveManifests ?? []) {
    uris.push(archiveStorageLocation(ctx.userRoot, ctx.sessionId, manifest.archiveId).manifestUri);
    for (const eventId of [
      checkpointEventId(manifest),
      ...Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, index) =>
        checkpointRequestEventId(manifest, previousCheckpointId, index + 1)),
      ...Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, index) =>
        checkpointFailureEventId(manifest, previousCheckpointId, index + 1)),
    ]) {
      const uri = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri;
      const status = await ctx.client.statUri(uri);
      if (!status.ok) throw new Error(`budget fact stat failed: ${status.status}`);
      if (status.exists) uris.push(uri);
    }
    previousCheckpointId = checkpointId(manifest);
  }
  return [...new Set(uris)];
}

function collectTaskResources(ctx) {
  const resources = [];
  let previousCheckpointId = null;
  for (const manifest of ctx.knownArchiveManifests ?? []) {
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      resources.push(checkpointTaskId(manifest, previousCheckpointId, attempt));
    }
    previousCheckpointId = checkpointId(manifest);
  }
  return resources;
}

async function afterWorkloads(log, ctx) {
  for (const { id: family } of ctx.manifest.families) {
    const runs = ctx.measurements.filter((measurement) => measurement.family === family);
    log.check("release-baseline", `${family}.repeats`, ctx.manifest.repetitions, runs.length,
      runs.length === ctx.manifest.repetitions);
    log.check("release-baseline", `${family}.source`, `all>=${ctx.manifest.thresholds.minSourceTokens}`,
      runs.map((run) => run.sourceTokens).join(","),
      runs.length === ctx.manifest.repetitions && runs.every((run) => run.sourceTokens >= ctx.manifest.thresholds.minSourceTokens));
    log.check("release-baseline", `${family}.headroom`, `all>=${ctx.manifest.thresholds.minHeadroomTokens}`,
      runs.map((run) => run.headroomTokens).join(","),
      runs.length === ctx.manifest.repetitions && runs.every((run) => run.headroomTokens >= ctx.manifest.thresholds.minHeadroomTokens));
    log.check("release-baseline", `${family}.provider-headroom`,
      `all>=${ctx.manifest.thresholds.minProviderHeadroomTokens}`,
      runs.map((run) => run.providerHeadroomTokens).join(","),
      runs.length === ctx.manifest.repetitions &&
        runs.every((run) => run.providerHeadroomTokens >= ctx.manifest.thresholds.minProviderHeadroomTokens));
  }
}

const families = ["tool-loop", "atomic", "branch"];
const runners = Object.fromEntries(families.flatMap((family) =>
  Array.from({ length: 3 }, (_, index) => [`${family}-r${index + 1}`, runBudgetWorkload])));

await runLiveGate({
  gate: "budget",
  manifestPath: join(LIVE_REPO, "test/live/budget.workloads.json"),
  manifestHashPath: join(LIVE_REPO, "test/live/budget.workloads.sha256"),
  runners,
  collectObjectUris,
  collectTaskResources,
  preflightExtra: (_log, ctx) => {
    ctx.measurements = [];
    mkdirSync(join(ctx.runDir, "home", ".pi"), { recursive: true });
  },
  afterWorkloads,
  summaryExtra: async (ctx) => ({ measurements: ctx.measurements }),
});
