// verify:retrieval:live — 检索、来源链与重启恢复真实验收门禁。
//
// 固定 workload 先由真实 Pi JSONL 形成 Archive/checkpoint，再在 sibling branch 写入
// chunked event。全新 Pi 进程由确定性 provider 选择生产检索工具；verifier 独立从
// 来源和远端规范字节复算身份、边界与切片。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  describeArchives,
  parseArchiveManifest,
} from "../../shared/archive.mjs";
import { archiveStorageLocation } from "../../shared/archive-store.mjs";
import {
  CHECKPOINT_MAX_ATTEMPTS,
  CHECKPOINT_MODEL,
  CHECKPOINT_PROMPT_VERSION,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointId,
  checkpointRequestEventId,
  checkpointTaskId,
  parseCheckpointEventById,
} from "../../shared/checkpoint.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import {
  BATCH_MAX_FILE_BYTES,
} from "../../shared/content-objects.mjs";
import {
  EVENT_CHUNK_BYTES,
  RecordedEventAdapter,
  recordedEventStorageLocation,
} from "../../shared/recorded-event-adapter.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import {
  LIVE_REPO as REPO,
  cancelOwnedTasks,
  assertRunHealthy,
  runLiveGate,
  runPi,
  sha256Hex,
  summarizeRun,
} from "./live-support.mjs";
import { parseObservationRun } from "./observation-evidence.mjs";
import { startScriptedProvider } from "./scripted-provider.mjs";
import {
  recordWrittenObjects,
  writeExtensionConfig,
} from "./context-live.mjs";


function filler(sessionId, seed, length) {
  let text = "";
  let digest = createHash("sha256").update(`${sessionId}/${seed}`).digest("base64url");
  while (text.length < length) {
    text += digest;
    digest = createHash("sha256").update(digest).digest("base64url");
  }
  return text.slice(0, length);
}

function appendNormalPressure(ctx, sessionFile) {
  const manager = SessionManager.open(sessionFile);
  const { normalEntries, normalChars } = ctx.manifest.environment.pressureSource;
  for (let index = 0; index < normalEntries; index++) {
    manager.appendCustomEntry("ov-retrieval-pressure", {
      index,
      blob: filler(ctx.sessionId, `normal-${index}`, normalChars),
    });
  }
}

function appendOversizedBranch(ctx, sessionFile) {
  const manager = SessionManager.open(sessionFile);
  const source = ctx.manifest.environment.pressureSource;
  const marker = ctx.workload.inputs.oversizedMarker;
  manager.appendCustomEntry("ov-retrieval-oversized", {
    marker,
    emoji: "🧭",
    blob: filler(ctx.sessionId, "oversized", source.oversizedChars),
  });
  for (let index = 0; index < source.trailingEntries; index++) {
    manager.appendCustomEntry("ov-retrieval-trailing", {
      index,
      blob: filler(ctx.sessionId, `trailing-${index}`, source.trailingChars),
    });
  }
}

async function sourceState(ctx, sessionFile) {
  const parsed = parsePiSessionJsonl(await readFile(sessionFile, "utf8"), { sessionId: ctx.sessionId });
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  const onBranch = new Set(parsed.branch.map((entry) => entry.id));
  return { parsed, events, branch: events.filter((event) => onBranch.has(event.source.entryId)) };
}

function toolResults(run, toolName) {
  return run.events.filter((event) => event.type === "tool_execution_end" && event.toolName === toolName);
}

function toolText(event) {
  const content = event?.result?.content;
  if (Array.isArray(content)) return content.map((part) => part?.text ?? "").join("\n");
  return JSON.stringify(event?.result ?? "");
}

function expectedSlice(event, offset, limit) {
  return Array.from(recordedEventBytes(event).toString("utf8")).slice(offset, offset + limit).join("");
}


function assertObservation(log, ctx, run, observationPath) {
  const bytes = readFileSync(observationPath);
  const observation = parseObservationRun(bytes);
  log.check(ctx.workloadId, "observation.complete", true, observation.summary.complete,
    observation.summary.complete, observation.errors.join(","));
  const retrievalBranches = new Set(observation.records
    .filter((record) => record.stage === "archive_retrieval")
    .map((record) => record.data?.branch));
  for (const branch of ["list", "index", "direct", "chunk"]) {
    log.check(ctx.workloadId, `observation.archive-${branch}`, true,
      retrievalBranches.has(branch), retrievalBranches.has(branch));
  }
  const scopeTools = new Set(observation.records
    .filter((record) => record.stage === "tool_scope")
    .map((record) => record.data?.tool));
  for (const tool of ["viking_search", "viking_read", "viking_archive_expand"]) {
    log.check(ctx.workloadId, `observation.scope-${tool}`, true, scopeTools.has(tool), scopeTools.has(tool));
  }
  const indexedSources = new Set(observation.records
    .filter((record) => record.stage === "retrieval_index" && record.data?.records > 0)
    .map((record) => record.data?.sourceType));
  for (const sourceType of ["raw_event", "checkpoint"]) {
    log.check(ctx.workloadId, `observation.index-${sourceType}`, true,
      indexedSources.has(sourceType), indexedSources.has(sourceType));
  }
  const raw = bytes.toString("utf8");
  const forbidden = [
    ...Object.values(ctx.workload.inputs),
    ctx.directEventUri,
    ctx.oversizedEvent?.eventId,
    ctx.taskApiKey,
  ].filter(Boolean);
  const leaks = forbidden.filter((value) => raw.includes(String(value)));
  log.check(ctx.workloadId, "observation.redacted", 0, leaks.length, leaks.length === 0,
    leaks.map((value) => `sha256:${sha256Hex(Buffer.from(String(value)))}`).join(","));
  return observation;
}

async function verifySourceChain(log, ctx, state, archives) {
  const adapter = new RecordedEventAdapter(ctx.client, { userRoot: ctx.userRoot });
  let eventBytesMatch = 0;
  for (const event of state.events) {
    const stored = await adapter.readEvent(ctx.sessionId, event.eventId);
    if (stored.bytes.equals(recordedEventBytes(event))) eventBytesMatch++;
  }
  log.check(ctx.workloadId, "chain.event-canonical-bytes", state.events.length, eventBytesMatch,
    eventBytesMatch === state.events.length);

  let manifestMatches = 0;
  for (const descriptor of archives) {
    const uri = archiveStorageLocation(ctx.userRoot, ctx.sessionId, descriptor.manifest.archiveId).manifestUri;
    const downloaded = await ctx.client.downloadBytes(uri);
    const manifest = downloaded.ok && Buffer.isBuffer(downloaded.bytes)
      ? parseArchiveManifest(downloaded.bytes, { expectedArchiveId: descriptor.manifest.archiveId })
      : null;
    if (manifest && JSON.stringify(manifest) === JSON.stringify(descriptor.manifest)) manifestMatches++;
  }
  log.check(ctx.workloadId, "chain.archive-manifests", archives.length, manifestMatches,
    manifestMatches === archives.length);

  const consumed = [];
  for (const descriptor of archives) {
    const expectedId = checkpointId(descriptor.manifest);
    const stored = await adapter.readEventIfExists(ctx.sessionId, checkpointEventId(descriptor.manifest));
    if (!stored) continue;
    consumed.push({
      descriptor,
      checkpoint: parseCheckpointEventById(stored.event, expectedId),
    });
  }
  log.check(ctx.workloadId, "chain.checkpoint-present", ">=1", consumed.length, consumed.length >= 1);
  const checkpointFactsOk = consumed.every(({ descriptor, checkpoint }) =>
    checkpoint.checkpointId === checkpointId(descriptor.manifest)
      && checkpoint.sourceArchiveId === descriptor.manifest.archiveId
      && checkpoint.sourceArchiveHash === descriptor.manifest.contentHash
      && checkpoint.model === CHECKPOINT_MODEL
      && checkpoint.promptVersion === CHECKPOINT_PROMPT_VERSION);
  log.check(ctx.workloadId, "chain.checkpoint-provenance", true, checkpointFactsOk, checkpointFactsOk);

  ctx.checkpointFacts = consumed;
}

function retrievalScript(ctx, firstArchive, oversizedArchive, directEvent, oversizedEvent, foreignRoot) {
  const rawQuery = ctx.workload.inputs.rawMarker;
  const calls = [
    { name: "viking_search", input: { query: rawQuery, limit: ctx.manifest.thresholds.searchLimit } },
    { name: "viking_read", input: { uri: ctx.directEventUri, level: "full" } },
    { name: "viking_archive_expand", input: { offset: 0, limit: 1 } },
    { name: "viking_archive_expand", input: { offset: 1, limit: 1 } },
    { name: "viking_archive_expand", input: { archive_id: firstArchive.manifest.archiveId, offset: 0, limit: 1 } },
    { name: "viking_archive_expand", input: {
      archive_id: firstArchive.manifest.archiveId,
      event_id: directEvent.eventId,
    } },
    { name: "viking_archive_expand", input: {
      archive_id: oversizedArchive.manifest.archiveId,
      event_id: oversizedEvent.eventId,
      event_offset: 0,
      event_limit: 20000,
    } },
    { name: "viking_archive_expand", input: {
      archive_id: oversizedArchive.manifest.archiveId,
      event_id: oversizedEvent.eventId,
      event_offset: 16000,
      event_limit: 20000,
    } },
    { name: "viking_search", input: { query: rawQuery, scope: foreignRoot, limit: ctx.manifest.thresholds.searchLimit } },
  ];
  return { calls, respond: (_messages, request) => request <= calls.length
    ? { toolCall: calls[request - 1] }
    : { text: "DONE" } };
}

async function w1(log, ctx) {
  writeExtensionConfig(ctx);
  const input = ctx.workload.inputs;
  const agentDir = join(ctx.runDir, "pi");
  const sourceProvider = await startScriptedProvider({
    agentDir,
    respond: () => ({ text: "SOURCE_READY" }),
  });
  let initial;
  try {
    initial = await runPi(ctx, {
      workloadId: ctx.workloadId,
      turn: 0,
      endpoint: ctx.endpoint,
      actions: [{ prompt: `${input.rawMarker}\n${input.checkpointGoal}\n${input.checkpointConstraint}\nPreserve these opaque identifiers exactly.` }],
      ...sourceProvider.runOverrides,
    });
  } finally {
    await sourceProvider.close();
  }
  assertRunHealthy(log, ctx, initial, { requireCapture: false });
  log.check(ctx.workloadId, "source-provider-requests", 1, sourceProvider.requests(), sourceProvider.requests() === 1);
  const sourceSessionReady = typeof initial.sessionFile === "string" && existsSync(initial.sessionFile);
  log.check(ctx.workloadId, "source-session-file", true, sourceSessionReady, sourceSessionReady);
  if (!sourceSessionReady) return;
  try {
    appendNormalPressure(ctx, initial.sessionFile);
    log.check(ctx.workloadId, "source-pressure-injection", true, true, true);
  } catch (error) {
    log.check(ctx.workloadId, "source-pressure-injection", true, error?.name ?? "Error", false, error?.message);
    return;
  }
  ctx.runs.push(summarizeRun(initial));

  let formation;
  try {
    formation = await runPi(ctx, {
      workloadId: ctx.workloadId,
      turn: 1,
      endpoint: ctx.endpoint,
      actions: [{ command: "/viking sync" }],
      ...sourceProvider.runOverrides,
    });
  } catch (error) {
    log.check(ctx.workloadId, "formation-run", "completed", error?.name ?? "Error", false, error?.message);
    return;
  }
  assertRunHealthy(log, ctx, formation, { requireCapture: false });
  let initialState = await sourceState(ctx, formation.sessionFile);
  const initialArchives = describeArchives(ctx.sessionId, initialState.branch,
    ctx.manifest.environment.extensionConfig.content.archive);
  log.check(ctx.workloadId, "formation.archives", ">=1", initialArchives.length, initialArchives.length >= 1);
  if (initialArchives.length === 0) return;
  const latestInitialCheckpoint = checkpointId(initialArchives.at(-1).manifest);

  const checkpointRun = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 2,
    endpoint: ctx.endpoint,
    actions: [{
      command: "/viking",
      untilNotifyIncludes: latestInitialCheckpoint,
      retryIntervalMs: 1000,
    }],
    ...sourceProvider.runOverrides,
  });
  assertRunHealthy(log, ctx, checkpointRun, { requireCapture: false });
  log.check(ctx.workloadId, "checkpoint.caught-up", latestInitialCheckpoint,
    String(checkpointRun.actions[0]?.notifyEvent?.message ?? "").includes(latestInitialCheckpoint)
      ? latestInitialCheckpoint : null,
    String(checkpointRun.actions[0]?.notifyEvent?.message ?? "").includes(latestInitialCheckpoint));
  initialState = await sourceState(ctx, checkpointRun.sessionFile);
  const stableLeafId = initialState.parsed.branch.at(-1)?.id;
  if (!stableLeafId) throw new Error("initial branch has no leaf");

  appendOversizedBranch(ctx, checkpointRun.sessionFile);
  const oversizedSync = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: 3,
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
    ...sourceProvider.runOverrides,
  });
  assertRunHealthy(log, ctx, oversizedSync, { requireCapture: false });
  const oversizedState = await sourceState(ctx, oversizedSync.sessionFile);
  const allArchives = describeArchives(ctx.sessionId, oversizedState.branch,
    ctx.manifest.environment.extensionConfig.content.archive);
  const oversizedEvent = oversizedState.branch.find((event) => JSON.stringify(event.payload).includes(input.oversizedMarker));
  const oversizedArchive = oversizedEvent && allArchives.find((archive) =>
    oversizedState.branch.slice(archive.startIndex, archive.endIndex + 1)
      .some((event) => event.eventId === oversizedEvent.eventId));
  log.check(ctx.workloadId, "oversized.event-archived", true, Boolean(oversizedEvent && oversizedArchive),
    Boolean(oversizedEvent && oversizedArchive));
  if (!oversizedEvent || !oversizedArchive) return;
  const oversizedBytes = recordedEventBytes(oversizedEvent);
  log.check(ctx.workloadId, "oversized.chunked", `>${BATCH_MAX_FILE_BYTES}`,
    oversizedBytes.length, oversizedBytes.length > BATCH_MAX_FILE_BYTES);

  const oversizedTaskResources = allArchives.slice(initialArchives.length).flatMap((archive, offset) => {
    const index = initialArchives.length + offset;
    const previousCheckpointId = index === 0 ? null : checkpointId(allArchives[index - 1].manifest);
    return Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, attempt) =>
      checkpointTaskId(archive.manifest, previousCheckpointId, attempt + 1));
  });
  const taskIsolation = await cancelOwnedTasks(ctx.client, oversizedTaskResources);
  if (taskIsolation.residuals.length > 0) {
    throw new Error(`oversized checkpoint isolation failed: ${taskIsolation.residuals.join(", ")}`);
  }
  ctx.cancelledTasks = [...(ctx.cancelledTasks ?? []), ...taskIsolation.cancelled];

  recordWrittenObjects(ctx, oversizedState.branch, allArchives);
  ctx.knownEvents = oversizedState.events;
  ctx.oversizedEvent = oversizedEvent;
  ctx.archiveChain = allArchives;
  const manager = SessionManager.open(oversizedSync.sessionFile);
  manager.branch(stableLeafId);
  manager.appendCustomEntry("ov-retrieval-restored-branch", { source: "stable_leaf" });
  const restoredState = await sourceState(ctx, oversizedSync.sessionFile);
  const restoredArchives = describeArchives(ctx.sessionId, restoredState.branch,
    ctx.manifest.environment.extensionConfig.content.archive);
  const firstArchive = restoredArchives[0];
  const directEvent = restoredState.branch
    .slice(firstArchive.startIndex, firstArchive.endIndex + 1)
    .find((event) => recordedEventBytes(event).length <= BATCH_MAX_FILE_BYTES);
  if (!directEvent) throw new Error("archive has no direct event");
  ctx.directEventUri = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, directEvent.eventId).directUri;

  const foreignRoot = "viking://user/foreign";
  const scriptedPlan = retrievalScript(ctx, firstArchive, oversizedArchive, directEvent, oversizedEvent, foreignRoot);
  const retrievalProvider = await startScriptedProvider({
    agentDir,
    api: "openai-codex-responses",
    model: { contextWindow: 272000, maxTokens: 128000 },
    respond: scriptedPlan.respond,
  });
  const observationPath = join(ctx.runDir, "observations", `${ctx.workloadId}-retrieval.jsonl`);
  let retrievalRun;
  try {
    retrievalRun = await runPi(ctx, {
      workloadId: ctx.workloadId,
      turn: 4,
      endpoint: ctx.endpoint,
      actions: [
        { prompt: "OV-RETRIEVAL-ANCHOR-55A0 execute the fixed retrieval workflow." },
        { command: "/viking sync" },
      ],
      extraEnv: { ...retrievalProvider.runOverrides.extraEnv, OV_OBSERVE: observationPath },
      provider: retrievalProvider.runOverrides.provider,
      envStrip: retrievalProvider.runOverrides.envStrip,
    });
  } finally {
    await retrievalProvider.close();
  }
  assertRunHealthy(log, ctx, retrievalRun, { requireCapture: false });
  log.check(ctx.workloadId, "driver.requests", scriptedPlan.calls.length + 1,
    retrievalProvider.requests(), retrievalProvider.requests() === scriptedPlan.calls.length + 1);

  const searches = toolResults(retrievalRun, "viking_search");
  const primarySearch = toolText(searches[0]);
  log.check(ctx.workloadId, "search.raw-source-label", true,
    /raw[_ -]?event/i.test(primarySearch), /raw[_ -]?event/i.test(primarySearch), primarySearch.slice(0, 240));
  const rawLocator = /archive_id: arc_[0-9a-f]{64}/.test(primarySearch)
    && /event_id: evt_[0-9a-f]{64}/.test(primarySearch);
  log.check(ctx.workloadId, "search.authoritative-locator", true,
    rawLocator, rawLocator);
  const clampedSearch = toolText(searches[1]);
  log.check(ctx.workloadId, "search.foreign-clamped", "current namespace results only",
    /Refused/i.test(clampedSearch) ? "refused" : clampedSearch.includes(foreignRoot) ? "foreign result" : "current namespace",
    !/Refused/i.test(clampedSearch) && !clampedSearch.includes(foreignRoot));
  const reads = toolResults(retrievalRun, "viking_read");
  const directRead = toolText(reads[0]);
  log.check(ctx.workloadId, "read.authoritative-event", directEvent.eventId,
    directRead.includes(directEvent.eventId) ? directEvent.eventId : null,
    directRead.includes(directEvent.eventId));

  const expands = toolResults(retrievalRun, "viking_archive_expand");
  const expandTexts = expands.map(toolText);
  log.check(ctx.workloadId, "archive.restart-list", firstArchive.manifest.archiveId,
    expandTexts[0]?.includes(firstArchive.manifest.archiveId) ? firstArchive.manifest.archiveId : null,
    expandTexts[0]?.includes(firstArchive.manifest.archiveId));
  log.check(ctx.workloadId, "archive.pagination", "page 1 then bounded page 2",
    `${expandTexts[0]?.includes("showing 1-1")}/${expandTexts[1]?.includes("showing")}`,
    expandTexts[0]?.includes("showing 1-1") && expandTexts[1]?.includes("showing"));
  log.check(ctx.workloadId, "archive.index", firstArchive.manifest.contentHash,
    expandTexts[2]?.includes(firstArchive.manifest.contentHash) ? firstArchive.manifest.contentHash : null,
    expandTexts[2]?.includes(firstArchive.manifest.contentHash));
  log.check(ctx.workloadId, "archive.direct", ctx.directEventUri,
    expandTexts[3]?.includes(ctx.directEventUri) ? ctx.directEventUri : null,
    expandTexts[3]?.includes(ctx.directEventUri));
  const firstChunk = expandTexts[4]?.split("\n\n").slice(1).join("\n\n") ?? "";
  const secondChunk = expandTexts[5]?.split("\n\n").slice(1).join("\n\n") ?? "";
  log.check(ctx.workloadId, "archive.chunk-limit-clamped", 16000,
    Array.from(firstChunk).length, firstChunk === expectedSlice(oversizedEvent, 0, 16000));
  log.check(ctx.workloadId, "archive.chunk-codepoint-continuity", true,
    secondChunk === expectedSlice(oversizedEvent, 16000, 16000),
    secondChunk === expectedSlice(oversizedEvent, 16000, 16000));
  await verifySourceChain(log, ctx, restoredState, restoredArchives);
  const observation = assertObservation(log, ctx, retrievalRun, observationPath);
  ctx.runs.push(
    summarizeRun(formation),
    summarizeRun(checkpointRun),
    summarizeRun(oversizedSync),
    {
      ...summarizeRun(retrievalRun),
      observation: observation.summary,
      observationPath,
    },
  );
}

async function collectObjectUris(ctx) {
  const uris = ctx.markerUri ? [ctx.markerUri] : [];
  for (const event of ctx.knownEvents ?? []) {
    const bytes = recordedEventBytes(event);
    const location = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, event.eventId);
    if (bytes.length <= BATCH_MAX_FILE_BYTES) {
      uris.push(location.directUri);
    } else {
      uris.push(location.claimUri, location.commitUri);
      const chunks = Math.ceil(bytes.length / EVENT_CHUNK_BYTES);
      for (let index = 0; index < chunks; index++) uris.push(location.chunkUri(index));
    }
  }
  for (const [index, descriptor] of (ctx.archiveChain ?? []).entries()) {
    const manifest = descriptor.manifest;
    uris.push(archiveStorageLocation(ctx.userRoot, ctx.sessionId, manifest.archiveId).manifestUri);
    const previousCheckpointId = index === 0 ? null : checkpointId(ctx.archiveChain[index - 1].manifest);
    for (const eventId of [
      checkpointEventId(manifest),
      ...Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, attempt) =>
        checkpointRequestEventId(manifest, previousCheckpointId, attempt + 1)),
      ...Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, attempt) =>
        checkpointFailureEventId(manifest, previousCheckpointId, attempt + 1)),
    ]) {
      const location = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId);
      for (const uri of [location.directUri, location.claimUri, location.commitUri]) {
        const status = await ctx.client.statUri(uri);
        if (!status.ok) throw new Error(`checkpoint fact stat failed: ${status.status}`);
        if (status.exists) uris.push(uri);
      }
    }
  }
  return [...new Set(uris)];
}

function collectTaskResources(ctx) {
  const manifests = (ctx.archiveChain ?? []).map((descriptor) => descriptor.manifest);
  return manifests.flatMap((manifest, index) => {
    const previousCheckpointId = index === 0 ? null : checkpointId(manifests[index - 1]);
    return Array.from({ length: CHECKPOINT_MAX_ATTEMPTS }, (_, attempt) =>
      checkpointTaskId(manifest, previousCheckpointId, attempt + 1));
  });
}

const WORKLOAD_RUNNERS = { "w1-restart-retrieval-chain": w1 };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "retrieval",
    manifestPath: join(REPO, "test/live/retrieval.workloads.json"),
    manifestHashPath: join(REPO, "test/live/retrieval.workloads.sha256"),
    runners: WORKLOAD_RUNNERS,
    collectObjectUris,
    collectTaskResources,
  }).catch((error) => {
    process.stderr.write(`✗ verifier internal error: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
