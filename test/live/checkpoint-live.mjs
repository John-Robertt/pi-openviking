// verify:checkpoint:live — checkpoint 生产真实验收门禁。
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OVClient } from "../../client.ts";
import { archiveManifestBytes } from "../../shared/archive.mjs";
import { ArchiveManager, archiveStorageLocation } from "../../shared/archive-store.mjs";
import {
  CHECKPOINT_MAX_ATTEMPTS,
  CHECKPOINT_MODEL,
  CHECKPOINT_PROMPT_VERSION,
  checkpointEventId,
  checkpointFailureEventId,
  checkpointId,
  checkpointRequestEventId,
  checkpointTaskId,
  parseCheckpointEvent,
  parseCheckpointFailureEvent,
  parseCheckpointRequestEvent,
} from "../../shared/checkpoint.mjs";
import { OpenVikingCheckpointProcessor } from "../../shared/checkpoint-processor.mjs";
import { CheckpointManager } from "../../shared/checkpoint-store.mjs";
import { createObservation } from "../../shared/observe.mjs";
import { RecordedEventAdapter, recordedEventStorageLocation } from "../../shared/recorded-event-adapter.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { parseObservationRun } from "./observation-evidence.mjs";
import { LIVE_REPO as REPO, runLiveGate } from "./live-support.mjs";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z7S8AAAAASUVORK5CYII=";

function productClient(ctx, observation) {
  const ov = ctx.manifest.identities.openviking;
  return new OVClient({
    endpoint: ctx.endpoint,
    apiKey: "",
    account: ov.account,
    user: ctx.storageUser,
    peerId: "checkpoint-live",
    userAgent: "pi-openviking/checkpoint-live",
  }, observation);
}

function sourceEntries(ctx, { textEntries = 2, image = false } = {}) {
  const entries = [];
  let parentId = null;
  for (let index = 0; index < textEntries; index++) {
    const id = `entry-${index}`;
    const prefix = index === 0
      ? "Checkpoint source: checkpoint must preserve completed work, decisions, open issues and restart recovery. "
      : `Archive continuation ${index}: next implement and verify the remaining checkpoint chain. `;
    const text = prefix.padEnd(4000, String(index));
    const content = image && index === 0
      ? [{ type: "text", text }, { type: "image", mimeType: "image/png", data: PNG_BASE64 }]
      : text;
    entries.push({
      id,
      parentId,
      type: "message",
      timestamp: `2026-08-20T00:00:${String(index).padStart(2, "0")}.000Z`,
      message: { role: "user", content },
    });
    parentId = id;
  }
  return entries;
}

async function createArchives(log, ctx, client, observation, options) {
  const events = projectPiEntries(ctx.sessionId, sourceEntries(ctx, options));
  const adapter = new RecordedEventAdapter(client, { userRoot: ctx.userRoot, observation });
  await adapter.writeEvents(ctx.sessionId, events);
  const manager = new ArchiveManager(client, {
    userRoot: ctx.userRoot,
    adapter,
    budgets: ctx.manifest.environment.archiveBudgets,
    observation,
  });
  const formed = await manager.formArchives(ctx.sessionId, events);
  log.check(ctx.workloadId, "archives-formed", `>=${options.expectedArchives}`, formed.archives.length,
    formed.archives.length >= options.expectedArchives);
  for (const descriptor of formed.archives) await manager.expand(ctx.sessionId, descriptor.manifest.archiveId);
  ctx.knownEventIds = events.map((event) => event.eventId);
  ctx.knownArchives = formed.archives.map((item) => item.manifest.archiveId);
  ctx.sourceBytes = new Map(events.map((event) => [event.eventId, recordedEventBytes(event)]));
  ctx.archiveBytes = new Map(formed.archives.map((item) => [item.manifest.archiveId, archiveManifestBytes(item.manifest)]));
  return { events, adapter, manager, descriptors: formed.archives };
}

async function sourceStillIntact(log, ctx, adapter, archiveManager, descriptors, label) {
  const failures = [];
  for (const [eventId, bytes] of ctx.sourceBytes) {
    const stored = await adapter.readEvent(ctx.sessionId, eventId);
    if (!stored.bytes.equals(bytes)) failures.push(`event:${eventId}`);
  }
  for (const descriptor of descriptors) {
    const expanded = await archiveManager.expand(ctx.sessionId, descriptor.manifest.archiveId);
    if (!archiveManifestBytes(expanded.manifest).equals(ctx.archiveBytes.get(descriptor.manifest.archiveId))) {
      failures.push(`archive:${descriptor.manifest.archiveId}`);
    }
  }
  log.check(ctx.workloadId, `${label}.source-unchanged`, 0, failures.length, failures.length === 0,
    failures.slice(0, 3).join(" | "));
}

async function checkpointFact(log, ctx, adapter, descriptor, previousCheckpointId = null, attempt = 1) {
  const requestStored = await adapter.readEventIfExists(
    ctx.sessionId,
    checkpointRequestEventId(descriptor.manifest, previousCheckpointId, attempt),
  );
  const checkpointStored = await adapter.readEventIfExists(ctx.sessionId, checkpointEventId(descriptor.manifest));
  let request = null;
  let checkpoint = null;
  try {
    request = requestStored ? parseCheckpointRequestEvent(requestStored.event) : null;
    checkpoint = checkpointStored ? parseCheckpointEvent(checkpointStored.event, descriptor.manifest) : null;
  } catch { /* assertions below report malformed facts */ }
  log.check(ctx.workloadId, `checkpoint.${descriptor.manifest.archiveId.slice(4, 10)}.request`, true, Boolean(request), Boolean(request));
  log.check(ctx.workloadId, `checkpoint.${descriptor.manifest.archiveId.slice(4, 10)}.source`,
    `${descriptor.manifest.archiveId}/${descriptor.manifest.contentHash}`,
    checkpoint ? `${checkpoint.sourceArchiveId}/${checkpoint.sourceArchiveHash}` : "missing",
    checkpoint?.sourceArchiveId === descriptor.manifest.archiveId && checkpoint?.sourceArchiveHash === descriptor.manifest.contentHash);
  const structure = Boolean(checkpoint?.narrative) && Array.isArray(checkpoint?.completed) &&
    Array.isArray(checkpoint?.openItems) && Array.isArray(checkpoint?.retrievalCues) &&
    checkpoint?.model === CHECKPOINT_MODEL && checkpoint?.promptVersion === CHECKPOINT_PROMPT_VERSION;
  log.check(ctx.workloadId, `checkpoint.${descriptor.manifest.archiveId.slice(4, 10)}.structure`, true, structure, structure);
  return { request, checkpoint, requestStored, checkpointStored };
}

async function taskMeasurement(log, ctx, client, taskId, wallMs, label) {
  const listed = await client.listTasks(taskId);
  const task = Array.isArray(listed.result)
    ? [...listed.result].sort((a, b) => Number(b?.created_at || 0) - Number(a?.created_at || 0))[0]
    : null;
  const tokenTotal = Math.max(0, Number(task?.result?.token_usage?.llm?.total_tokens) || 0);
  log.check(ctx.workloadId, `${label}.task-completed`, "completed", task?.status, task?.status === "completed");
  log.check(ctx.workloadId, `${label}.tokens-measured`, ">0", tokenTotal, tokenTotal > 0);
  log.check(ctx.workloadId, `${label}.wall-threshold`, `<=${ctx.manifest.thresholds.checkpointWallMs}`, wallMs,
    wallMs <= ctx.manifest.thresholds.checkpointWallMs);
  return { wallMs, tokenTotal };
}

async function waitForCheckpoint(manager, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.status.pending === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function observedWorkload(log, ctx, run) {
  const observationPath = join(ctx.runDir, "observations", `${ctx.workloadId}.jsonl`);
  mkdirSync(join(ctx.runDir, "observations"), { recursive: true });
  const observation = createObservation({ env: { OV_OBSERVE: observationPath } });
  observation.bindSession(ctx.sessionId);
  const clients = [];
  const managers = [];
  const makeClient = () => {
    const client = productClient(ctx, observation);
    clients.push(client);
    return client;
  };
  try {
    await run({ observation, makeClient, managers });
    for (const manager of managers) manager.observeFinalState();
  } finally {
    for (const manager of managers) await manager.stop();
    for (const client of clients) await client.close(true);
    observation.bindSession(null);
    await observation.finish(10000);
  }
  const bytes = await readFile(observationPath);
  const parsed = parseObservationRun(bytes);
  const required = ["checkpoint_request", "checkpoint_process", "checkpoint_state", "client_http", "archive_commit"];
  if (ctx.workloadId === "w3-failure-retry") required.push("checkpoint_failure");
  const missing = required.filter((stage) => !parsed.summary.stageCounts[stage]);
  log.check(ctx.workloadId, "observation.complete", true, parsed.summary.complete, parsed.summary.complete,
    parsed.errors.slice(0, 5).join(" | "));
  log.check(ctx.workloadId, "observation.stages", "all required", missing.length, missing.length === 0, missing.join(","));
  const raw = bytes.toString("utf8");
  const safe = !raw.includes(ctx.sessionId) && !raw.includes(ctx.storageUser) && !raw.includes(ctx.userRoot);
  log.check(ctx.workloadId, "observation.redacted", true, safe, safe);
  ctx.observationSummary = parsed.summary;
}

async function w1(log, ctx) {
  await observedWorkload(log, ctx, async ({ observation, makeClient, managers }) => {
    const client = makeClient();
    const fixture = await createArchives(log, ctx, client, observation, { textEntries: 2, expectedArchives: 1 });
    const descriptor = fixture.descriptors[0];
    const manager = new CheckpointManager(client, {
      adapter: fixture.adapter, archiveManager: fixture.manager,
      observation, pollIntervalMs: ctx.manifest.thresholds.pollMs,
    });
    managers.push(manager);
    const started = Date.now();
    await manager.schedule(ctx.sessionId, [descriptor]);
    const settled = await waitForCheckpoint(manager, ctx.manifest.thresholds.checkpointWallMs);
    log.check(ctx.workloadId, "checkpoint-settled", true, settled, settled);
    log.check(ctx.workloadId, "checkpoint-status", "caught_up", manager.status.mode, manager.status.mode === "caught_up");
    const fact = await checkpointFact(log, ctx, fixture.adapter, descriptor);
    await sourceStillIntact(log, ctx, fixture.adapter, fixture.manager, [descriptor], "after");
    const measurement = await taskMeasurement(log, ctx, client, fact.request.taskId, Date.now() - started, "checkpoint");
    ctx.measurements = [measurement];
  });
  ctx.runs.push({ label: "checkpoint-formation", ...ctx.measurements[0], observationSha256: ctx.observationSummary.evidenceSha256 });
}

async function w2(log, ctx) {
  await observedWorkload(log, ctx, async ({ observation, makeClient, managers }) => {
    const client = makeClient();
    const fixture = await createArchives(log, ctx, client, observation, { textEntries: 3, image: true, expectedArchives: 1 });
    let descriptor = null;
    for (const item of fixture.descriptors) {
      const expanded = await fixture.manager.expand(ctx.sessionId, item.manifest.archiveId);
      if (expanded.events.some((event) => event.source.partType === "image")) descriptor = item;
    }
    log.check(ctx.workloadId, "image-archive-selected", true, Boolean(descriptor), Boolean(descriptor));
    const mediaEvidence = [];
    class CapturingProcessor extends OpenVikingCheckpointProcessor {
      async prepareMedia(taskId, events) {
        const media = await super.prepareMedia(taskId, events);
        mediaEvidence.push(...media);
        return media;
      }
    }
    const processor = new CapturingProcessor(client, { observation });
    const manager = new CheckpointManager(client, {
      adapter: fixture.adapter, archiveManager: fixture.manager,
      processor, observation, pollIntervalMs: ctx.manifest.thresholds.pollMs,
    });
    managers.push(manager);
    const started = Date.now();
    await manager.schedule(ctx.sessionId, [descriptor]);
    const settled = await waitForCheckpoint(manager, ctx.manifest.thresholds.checkpointWallMs);
    log.check(ctx.workloadId, "checkpoint-settled", true, settled, settled);
    const fact = await checkpointFact(log, ctx, fixture.adapter, descriptor);
    const mediaOk = mediaEvidence.length === 1 && mediaEvidence[0].abstract.length > 0;
    log.check(ctx.workloadId, "media-abstract", "one non-empty abstract",
      `${mediaEvidence.length}/${mediaEvidence[0]?.abstract?.length ?? 0}`, mediaOk);
    const factBytes = Buffer.concat([fact.requestStored.bytes, fact.checkpointStored.bytes]).toString("utf8");
    log.check(ctx.workloadId, "media-base64-not-copied", false, factBytes.includes(PNG_BASE64), !factBytes.includes(PNG_BASE64));
    const taskId = fact.request.taskId;
    const taskRoot = `${ctx.userRoot}/resources/.pi-openviking/checkpoint-inputs/v1/${taskId}`;
    const temp = await client.statUri(taskRoot);
    log.check(ctx.workloadId, "media-temp-cleaned", false, temp.exists, temp.ok && !temp.exists);
    ctx.extraUris = [`${taskRoot}/image-0000.png`];
    await sourceStillIntact(log, ctx, fixture.adapter, fixture.manager, [descriptor], "after");
    const measurement = await taskMeasurement(log, ctx, client, taskId, Date.now() - started, "checkpoint");
    ctx.measurements = [measurement];
  });
  ctx.runs.push({ label: "multimodal-checkpoint", ...ctx.measurements[0], observationSha256: ctx.observationSummary.evidenceSha256 });
}

async function w3(log, ctx) {
  await observedWorkload(log, ctx, async ({ observation, makeClient, managers }) => {
    const client = makeClient();
    const fixture = await createArchives(log, ctx, client, observation, { textEntries: 2, expectedArchives: 1 });
    const descriptor = fixture.descriptors[0];
    const real = new OpenVikingCheckpointProcessor(client, { observation });
    let first = true;
    const processor = {
      async advance(input) {
        if (first) {
          first = false;
          return { status: "failed", error: { errorClass: "protocol", errorCode: "task_failed", message: "controlled terminal failure" } };
        }
        return real.advance(input);
      },
      cleanup: (taskId) => taskId === checkpointTaskId(descriptor.manifest, null, 1)
        ? Promise.resolve(true)
        : real.cleanup(taskId),
    };
    const notifications = [];
    const manager = new CheckpointManager(client, {
      adapter: fixture.adapter, archiveManager: fixture.manager,
      processor, observation, pollIntervalMs: ctx.manifest.thresholds.pollMs,
      notify: (message, level) => notifications.push({ message, level }),
    });
    managers.push(manager);
    const started = Date.now();
    await manager.schedule(ctx.sessionId, [descriptor]);
    const settled = await waitForCheckpoint(manager, ctx.manifest.thresholds.checkpointWallMs);
    log.check(ctx.workloadId, "checkpoint-settled", true, settled, settled);
    const failure = await fixture.adapter.readEventIfExists(
      ctx.sessionId, checkpointFailureEventId(descriptor.manifest, null, 1),
    );
    let failureFact = null;
    try { failureFact = failure ? parseCheckpointFailureEvent(failure.event) : null; } catch { /* assertion below */ }
    log.check(ctx.workloadId, "failure-fact", "task_failed", failureFact?.error?.errorCode,
      failureFact?.error?.errorCode === "task_failed");
    const retry = await checkpointFact(log, ctx, fixture.adapter, descriptor, null, 2);
    const firstTask = checkpointTaskId(descriptor.manifest, null, 1);
    log.check(ctx.workloadId, "retry-task-identity", "different", retry.request.taskId,
      retry.request.taskId !== firstTask);
    log.check(ctx.workloadId, "failure-notified", true,
      notifications.some((item) => item.message.includes("失败")), notifications.some((item) => item.message.includes("失败")));
    await sourceStillIntact(log, ctx, fixture.adapter, fixture.manager, [descriptor], "after");
    const measurement = await taskMeasurement(log, ctx, client, retry.request.taskId, Date.now() - started, "retry");
    ctx.measurements = [measurement];
  });
  ctx.runs.push({ label: "failure-retry", ...ctx.measurements[0], observationSha256: ctx.observationSummary.evidenceSha256 });
}

async function w4(log, ctx) {
  await observedWorkload(log, ctx, async ({ observation, makeClient, managers }) => {
    const clientA = makeClient();
    const fixtureA = await createArchives(log, ctx, clientA, observation, { textEntries: 3, expectedArchives: 2 });
    const descriptors = fixtureA.descriptors.slice(0, 2);
    const notifications = [];
    const managerA = new CheckpointManager(clientA, {
      adapter: fixtureA.adapter, archiveManager: fixtureA.manager,
      observation, pollIntervalMs: 60000,
      notify: (message, level) => notifications.push({ message, level }),
    });
    managers.push(managerA);
    await managerA.schedule(ctx.sessionId, descriptors);
    const expectedBacklog = descriptors.reduce((sum, item) => sum + item.tokenCount, 0);
    log.check(ctx.workloadId, "backlog-mode", "lagging", managerA.status.mode, managerA.status.mode === "lagging");
    log.check(ctx.workloadId, "backlog-count", 2, managerA.status.pending, managerA.status.pending === 2);
    log.check(ctx.workloadId, "backlog-tokens", expectedBacklog, managerA.status.backlogTokens,
      managerA.status.backlogTokens === expectedBacklog);
    const firstRequestBefore = await fixtureA.adapter.readEventIfExists(
      ctx.sessionId, checkpointRequestEventId(descriptors[0].manifest, null, 1),
    );
    const taskBefore = firstRequestBefore ? parseCheckpointRequestEvent(firstRequestBefore.event).taskId : null;
    log.check(ctx.workloadId, "request-before-restart", true, Boolean(taskBefore), Boolean(taskBefore));
    await managerA.stop();
    await clientA.close(true);

    const clientB = makeClient();
    const adapterB = new RecordedEventAdapter(clientB, { userRoot: ctx.userRoot, observation });
    const archivesB = new ArchiveManager(clientB, {
      userRoot: ctx.userRoot, adapter: adapterB,
      budgets: ctx.manifest.environment.archiveBudgets, observation,
    });
    const managerB = new CheckpointManager(clientB, {
      adapter: adapterB, archiveManager: archivesB,
      observation, pollIntervalMs: ctx.manifest.thresholds.pollMs,
      notify: (message, level) => notifications.push({ message, level }),
    });
    managers.push(managerB);
    const started = Date.now();
    await managerB.schedule(ctx.sessionId, descriptors);
    const settled = await waitForCheckpoint(managerB, ctx.manifest.thresholds.checkpointWallMs * 2);
    log.check(ctx.workloadId, "backlog-settled", true, settled, settled);
    log.check(ctx.workloadId, "backlog-final-mode", "caught_up", managerB.status.mode, managerB.status.mode === "caught_up");
    log.check(ctx.workloadId, "backlog-final-count", "0/0", `${managerB.status.pending}/${managerB.status.backlogTokens}`,
      managerB.status.pending === 0 && managerB.status.backlogTokens === 0);
    const firstFact = await checkpointFact(log, ctx, adapterB, descriptors[0]);
    const secondFact = await checkpointFact(log, ctx, adapterB, descriptors[1], firstFact.checkpoint.checkpointId);
    log.check(ctx.workloadId, "restart-task-reused", taskBefore, firstFact.request.taskId,
      taskBefore === firstFact.request.taskId);
    const laggingNotices = notifications.filter((item) => item.message.includes("消费落后")).length;
    const recoveryNotices = notifications.filter((item) => item.message.includes("已恢复")).length;
    log.check(ctx.workloadId, "lagging-notify-per-process", 2, laggingNotices, laggingNotices === 2);
    log.check(ctx.workloadId, "recovery-notify-once", 1, recoveryNotices, recoveryNotices === 1);
    await sourceStillIntact(log, ctx, adapterB, archivesB, descriptors, "after");
    const m1 = await taskMeasurement(log, ctx, clientB, firstFact.request.taskId, Date.now() - started, "first");
    const m2 = await taskMeasurement(log, ctx, clientB, secondFact.request.taskId, Date.now() - started, "second");
    ctx.measurements = [m1, m2];
  });
  ctx.runs.push({
    label: "restart-backlog",
    wallMs: Math.max(...ctx.measurements.map((item) => item.wallMs)),
    tokenTotal: ctx.measurements.reduce((sum, item) => sum + item.tokenTotal, 0),
    observationSha256: ctx.observationSummary.evidenceSha256,
  });
}


async function collectObjectUris(ctx) {
  const uris = ctx.markerUri ? [ctx.markerUri] : [];
  const includeFactIfStored = async (eventId) => {
    const uri = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri;
    const status = await ctx.client.statUri(uri);
    if (!status.ok) throw new Error(`checkpoint fact stat failed: ${status.status}`);
    if (status.exists) uris.push(uri);
    return status.exists;
  };
  for (const eventId of ctx.knownEventIds ?? []) {
    uris.push(recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri);
  }
  for (const archiveId of ctx.knownArchives ?? []) {
    uris.push(archiveStorageLocation(ctx.userRoot, ctx.sessionId, archiveId).manifestUri);
  }
  let previousCheckpointId = null;
  for (const bytes of ctx.archiveBytes?.values() ?? []) {
    const manifest = JSON.parse(bytes.toString("utf8"));
    const checkpointStored = await includeFactIfStored(checkpointEventId(manifest));
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      await includeFactIfStored(checkpointRequestEventId(manifest, previousCheckpointId, attempt));
      await includeFactIfStored(checkpointFailureEventId(manifest, previousCheckpointId, attempt));
    }
    if (!checkpointStored) break;
    previousCheckpointId = checkpointId(manifest);
  }
  uris.push(...(ctx.extraUris ?? []));
  return [...new Set(uris)];
}

/**
 * 本次 workload 可能创建的 VLM task 身份：checkpoint task id 由 Archive manifest 的
 * 内容 hash 与 attempt 链确定性派生，因此可在不依赖远端枚举的情况下逐项构造，作为
 * 取消时的归属依据。未真正提交的 attempt 只是空集合，不影响归属判定。
 */
function collectTaskResources(ctx) {
  const resources = [];
  let previousCheckpointId = null;
  for (const bytes of ctx.archiveBytes?.values() ?? []) {
    const manifest = JSON.parse(bytes.toString("utf8"));
    for (let attempt = 1; attempt <= CHECKPOINT_MAX_ATTEMPTS; attempt++) {
      resources.push(checkpointTaskId(manifest, previousCheckpointId, attempt));
    }
    previousCheckpointId = checkpointId(manifest);
  }
  return resources;
}

const RUNNERS = {
  "w1-checkpoint-formation": w1,
  "w2-multimodal-checkpoint": w2,
  "w3-failure-retry": w3,
  "w4-restart-backlog": w4,
};


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "checkpoint",
    manifestPath: join(REPO, "test/live/checkpoint.workloads.json"),
    manifestHashPath: join(REPO, "test/live/checkpoint.workloads.sha256"),
    runners: RUNNERS,
    collectObjectUris,
    collectTaskResources,
    preflightExtra: async (log, ctx) => {
      log.check("preflight", "checkpoint-model", CHECKPOINT_MODEL, ctx.manifest.mechanism.modelField,
        ctx.manifest.mechanism.modelField.includes(CHECKPOINT_MODEL));
      log.check("preflight", "checkpoint-prompt", CHECKPOINT_PROMPT_VERSION, ctx.manifest.mechanism.promptVersion,
        ctx.manifest.mechanism.promptVersion === CHECKPOINT_PROMPT_VERSION);
    },
  }).catch((error) => {
    process.stderr.write(`✗ verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
