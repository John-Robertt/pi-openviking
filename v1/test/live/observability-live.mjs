// verify:observability:live — 统一观察基线的真实验收门禁。
//
// 在真实 Pi CLI（RPC 模式）、真实 SessionManager、受管 OpenViking 与开发模型身份上执行
// test/live/observability.workloads.json 声明的四个 workload，机器断言观察 run 完整、op 配对、
// 分支/状态/失败可还原、无敏感值且记录不进入事实源。Pi 进程驱动、身份核对、ownership、清理
// 与 summary 复用 test/live/live-support.mjs 的统一骨架；tool-uri-rejection 由确定性脚本
// provider（test/live/scripted-provider.mjs）触发 guard，不依赖模型自由选择工具。
// manifest 字节 hash 固定于 test/live/observability.workloads.sha256；不匹配即拒绝运行。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OBSERVATION_STAGE_REGISTRY } from "../../shared/observe.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { recordedEventStorageLocation } from "../../shared/recorded-event-adapter.mjs";
import { readSyncAck } from "../../shared/sync-ack.mjs";
import {
  COMPACTION_PADDING_PROMPT,
  LIVE_REPO as REPO,
  ackFileKey,
  conflictBytesOf,
  mkdirChain,
  runLiveGate,
  runPi,
} from "./live-support.mjs";
import {
  missingExpectedRecords,
  observationRegistrySha256,
  parseObservationRun,
} from "./observation-evidence.mjs";
import { startScriptedProvider } from "./scripted-provider.mjs";

const MANIFEST_PATH = join(REPO, "test/live/observability.workloads.json");
const MANIFEST_HASH_PATH = join(REPO, "test/live/observability.workloads.sha256");
const DEAD_ENDPOINT = "http://127.0.0.1:9";

class FixtureError extends Error {
  constructor(code) {
    super();
    this.name = "FixtureError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 观察 run 断言与远端对应
// ---------------------------------------------------------------------------

function attachObservation(run) {
  const bytes = readFileSync(run.observationPath);
  run.observationRaw = bytes.toString("utf8");
  run.observation = parseObservationRun(bytes);
}

/** 单个观察 run 的通用断言：退出码、extension_error、run 完整性、预期记录、脱敏与事实源隔离。 */
function assertObsRun(log, ctx, run, expectedRecords, secrets = []) {
  const id = ctx.workloadId;
  log.check(id, `${run.turn}.exit`, 0, run.exitCode, run.exitCode === 0,
    run.exitCode === 0 ? undefined : `stderrBytes=${Buffer.byteLength(run.stderrTail || "")}`);
  const extensionErrors = run.events.filter((event) => event.type === "extension_error");
  log.check(id, `${run.turn}.extension-errors`, 0, extensionErrors.length, extensionErrors.length === 0);
  log.check(id, `${run.turn}.observation-complete`, true, run.observation.summary.complete,
    run.observation.summary.complete, run.observation.errors.join(","));
  const missing = missingExpectedRecords(run.observation.records, expectedRecords);
  log.check(id, `${run.turn}.expected-records`, 0, missing.length, missing.length === 0, missing.join(","));
  const leaked = secrets.some((secret) => secret && run.observationRaw.includes(secret));
  log.check(id, `${run.turn}.no-sensitive-values`, false, leaked, !leaked);
  const sessionAvailable = typeof run.sessionFile === "string" && existsSync(run.sessionFile);
  log.check(id, `${run.turn}.session-artifact`, true, sessionAvailable, sessionAvailable);
  if (sessionAvailable) {
    const sessionRaw = readFileSync(run.sessionFile, "utf8");
    const stageInSession = Object.keys(OBSERVATION_STAGE_REGISTRY).some((stage) => sessionRaw.includes(`\"stage\":\"${stage}\"`));
    log.check(id, `${run.turn}.observation-not-in-pi-jsonl`, false, stageInSession, !stageInSession);
  }
}

function recordRun(ctx, run) {
  ctx.runs.push({
    label: run.turn,
    ms: run.ms,
    exitCode: run.exitCode,
    observation: run.observation.summary,
  });
}

async function createObject(client, rootUri, uri, bytes) {
  const response = await client.batchWrite({
    root_uri: rootUri,
    operations: [{ uri, content_base64: Buffer.from(bytes).toString("base64"), precondition: { kind: "create_if_absent" } }],
    wait: false,
  });
  if (!response.ok || !response.result?.created?.includes(uri)) {
    throw new FixtureError(response.ok ? "OBJECT_NOT_CREATED" : `OBJECT_HTTP_${response.status || 0}`);
  }
}

export async function waitForRecallFixture(client, { query, targetUri, expectedUri, timeoutMs, pollMs }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw new TypeError("recall fixture requires positive timeoutMs and pollMs");
  }
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const diagnosticBudgetMs = Math.min(2000, Math.max(1, Math.floor(timeoutMs / 10)));
  const searchDeadline = deadline - diagnosticBudgetMs;
  let attempts = 0;
  while (Date.now() < searchDeadline) {
    const remaining = searchDeadline - Date.now();
    attempts++;
    const results = await client.find(query, { targetUri, topK: 10, timeoutMs: Math.max(1, remaining) });
    const match = results.find((result) => result.uri === expectedUri && result.context_type === "resource");
    if (match && Date.now() <= searchDeadline) {
      return { ready: true, attempts, elapsedMs: Date.now() - startedAt, match: { uri: match.uri, score: match.score } };
    }
    const nextRemaining = searchDeadline - Date.now();
    if (nextRemaining <= 0) break;
    await delay(Math.min(pollMs, nextRemaining));
  }

  const diagnosticTimeoutMs = Math.max(1, deadline - Date.now());
  const [queue, models] = await Promise.all([
    client.fetchJSON("/api/v1/observer/queue", undefined, diagnosticTimeoutMs),
    client.fetchJSON("/api/v1/observer/models", undefined, diagnosticTimeoutMs),
  ]);
  return {
    ready: false,
    attempts,
    elapsedMs: Date.now() - startedAt,
    diagnostics: {
      queue: queue.ok ? queue.result?.status ?? "unavailable" : `HTTP ${queue.status || 0}`,
      models: models.ok ? models.result?.status ?? "unavailable" : `HTTP ${models.status || 0}`,
    },
  };
}

function ackPath(ctx, endpoint) {
  const key = ackFileKey(endpoint, ctx.manifest.identities.openviking.account, ctx.storageUser, ctx.sessionId);
  return join(ctx.runDir, "home", ".pi", "openviking", "sync-ack", `${key}.json`);
}

/** 持久 session 的每个源事件都有远端字节级对应；写入对象计入持久删除核验清单。 */
async function assertRemoteEvents(log, ctx, entries) {
  const events = projectPiEntries(ctx.sessionId, entries);
  let failures = 0;
  for (const event of events) {
    const location = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, event.eventId);
    (ctx.extraUris ??= []).push(location.directUri);
    const readback = await ctx.client.downloadBytes(location.directUri);
    if (!readback.ok || !readback.bytes?.equals(recordedEventBytes(event))) failures++;
  }
  log.check(ctx.workloadId, "remote-event-correspondence", 0, failures, failures === 0, `events=${events.length}`);
}

// ---------------------------------------------------------------------------
// gate 专属身份核对（骨架 preflight 的扩展点）
// ---------------------------------------------------------------------------

function preflightObservability(log, ctx) {
  const g = "preflight";
  const registryHash = observationRegistrySha256();
  log.check(g, "registry-hash", ctx.manifest.identities.registry.sha256, registryHash,
    registryHash === ctx.manifest.identities.registry.sha256);
  const expectedStages = new Set([
    "observe_run_start",
    "observe_run_end",
    ...ctx.manifest.workloads.flatMap((workload) => workload.expectedRecords.map((expected) => expected.stage)),
    ...(ctx.manifest.deterministicStages ?? []),
  ]);
  const unknown = [...expectedStages].filter((stage) => !OBSERVATION_STAGE_REGISTRY[stage]);
  log.check(g, "expected-stages-known", 0, unknown.length, unknown.length === 0, unknown.join(","));
  const missing = Object.keys(OBSERVATION_STAGE_REGISTRY).filter((stage) => !expectedStages.has(stage));
  log.check(g, "all-stages-covered", 0, missing.length, missing.length === 0, missing.join(","));
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

async function wSuccessRecallSync(log, ctx) {
  const ownerRoot = `${ctx.userRoot}/resources/observability-fixture`;
  const recallUri = `${ownerRoot}/recall-fixture.md`;
  (ctx.extraCleanupRoots ??= []).push(ownerRoot);
  await mkdirChain(ctx.client, `${ctx.userRoot}/resources`, ownerRoot);
  await createObject(ctx.client, ownerRoot, recallUri, Buffer.from(ctx.workload.prompt, "utf8"));
  (ctx.extraUris ??= []).push(recallUri);
  // 预期记录要求 recall_filter 命中 filter_internal：种入一个与 query 完全同文的内部 fixture 并等待其可被检索，
  // 使命中内部对象成为确定性前置条件，而不是依赖 session 事件是否恰好被语义索引（时序敏感、 flaky）。
  const internalUri = `${ctx.userRoot}/resources/.pi-openviking/observability-internal-fixture.md`;
  await createObject(ctx.client, `${ctx.userRoot}/resources/.pi-openviking`, internalUri, Buffer.from(ctx.workload.prompt, "utf8"));
  (ctx.extraUris ??= []).push(internalUri);
  const fixture = await waitForRecallFixture(ctx.client, {
    query: ctx.workload.prompt,
    targetUri: ownerRoot,
    expectedUri: recallUri,
    timeoutMs: ctx.manifest.thresholds.fixtureMs,
    pollMs: ctx.manifest.thresholds.fixturePollMs,
  });
  const internalFixture = fixture.ready ? await waitForRecallFixture(ctx.client, {
    query: ctx.workload.prompt,
    targetUri: `${ctx.userRoot}/resources/.pi-openviking`,
    expectedUri: internalUri,
    timeoutMs: ctx.manifest.thresholds.fixtureMs,
    pollMs: ctx.manifest.thresholds.fixturePollMs,
  }) : { ready: false, attempts: 0, elapsedMs: 0, match: null, diagnostics: null };
  ctx.runs.push({
    label: "recall-fixture",
    ready: fixture.ready && internalFixture.ready,
    attempts: fixture.attempts + internalFixture.attempts,
    elapsedMs: fixture.elapsedMs + internalFixture.elapsedMs,
    score: fixture.match?.score ?? null,
    diagnostics: fixture.diagnostics ?? internalFixture.diagnostics ?? null,
  });
  if (!fixture.ready) throw new FixtureError("FIXTURE_RECALL_TIMEOUT");
  if (!internalFixture.ready) throw new FixtureError("FIXTURE_INTERNAL_RECALL_TIMEOUT");
  const run = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: "success",
    endpoint: ctx.endpoint,
    actions: [
      { prompt: ctx.workload.prompt },
      { command: "/viking sync" },
      { prompt: COMPACTION_PADDING_PROMPT },
      { rpc: { type: "compact" }, timeoutMs: ctx.manifest.thresholds.agentSettledMs },
      { command: "/viking sync" },
    ],
    capture: "observation",
  });
  attachObservation(run);
  assertObsRun(log, ctx, run, ctx.workload.expectedRecords, [
    ctx.sessionId, ctx.storageUser, ctx.userRoot, ctx.workload.prompt, ctx.taskApiKey,
  ]);
  const notify = run.actions[1].notifyEvent;
  log.check(ctx.workloadId, "sync-notify", "info", notify?.notifyType, notify?.notifyType === "info");
  const sessionText = await readFile(run.sessionFile, "utf8");
  const parsed = parsePiSessionJsonl(sessionText, { sessionId: ctx.sessionId });
  const compactionEntry = parsed.branch.findLast((entry) => entry.type === "compaction");
  const compaction = run.actions[3]?.response?.data;
  log.check(ctx.workloadId, "compaction-native", false, compactionEntry?.fromHook ?? false,
    compactionEntry?.fromHook !== true && compaction?.details?.type !== "openviking-active-context" && Boolean(compaction?.usage));
  await assertRemoteEvents(log, ctx, parsed.entries);
  const productObservation = parsed.entries.find((entry) => entry.type === "custom" && entry.customType === "ov-observation");
  const provenance = productObservation?.data;
  const minimalProvenance = provenance?.schemaVersion === 2 && provenance.kind === "recall-injection" &&
    /^sha256:[0-9a-f]{64}$/.test(provenance.contentHash) && Number.isSafeInteger(provenance.chars) &&
    provenance.chars > 0 && !Object.hasOwn(provenance, "content");
  log.check(ctx.workloadId, "recall-product-provenance", true, minimalProvenance, minimalProvenance);
  const ack = existsSync(ackPath(ctx, ctx.endpoint)) ? await readSyncAck(ackPath(ctx, ctx.endpoint)) : null;
  log.check(ctx.workloadId, "ack-advanced", ">=1 leaf", ack?.acknowledgedLeaves?.length ?? 0,
    Boolean(ack?.acknowledgedLeaves?.length));
  recordRun(ctx, run);
}

async function wDisconnectFailOpen(log, ctx) {
  const run = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: "disconnect",
    endpoint: ctx.workload.endpoint,
    actions: [{ prompt: ctx.workload.prompt }],
    capture: "observation",
  });
  attachObservation(run);
  assertObsRun(log, ctx, run, ctx.workload.expectedRecords, [ctx.sessionId, ctx.workload.prompt, ctx.taskApiKey]);
  const settled = run.events.some((event) => event.type === "agent_settled");
  log.check(ctx.workloadId, "agent-settled", true, settled, settled);
  const networkErrors = run.observation.records.filter(
    (record) => record.stage === "client_http" && record.data?.outcome === "network_error",
  ).length;
  log.check(ctx.workloadId, "network-error-observed", ">=1", networkErrors, networkErrors >= 1);
  log.check(ctx.workloadId, "ack-not-created", false, existsSync(ackPath(ctx, ctx.workload.endpoint)),
    !existsSync(ackPath(ctx, ctx.workload.endpoint)));
  recordRun(ctx, run);
}

async function wConflict409(log, ctx) {
  const prep = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: "conflict-prep",
    endpoint: DEAD_ENDPOINT,
    actions: [{ prompt: ctx.workload.prompt }],
    capture: "observation",
  });
  attachObservation(prep);
  assertObsRun(log, ctx, prep, [], [ctx.sessionId, ctx.workload.prompt, ctx.taskApiKey]);
  const sessionText = await readFile(prep.sessionFile, "utf8");
  const parsed = parsePiSessionJsonl(sessionText, { sessionId: ctx.sessionId });
  const firstEntry = parsed.entries[0];
  const event = projectPiEntries(ctx.sessionId, [firstEntry])[0];
  const bytes = recordedEventBytes(event);
  const location = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, event.eventId);
  await mkdirChain(ctx.client, `${ctx.userRoot}/resources`, location.shardRoot);
  const conflict = conflictBytesOf(bytes);
  await createObject(ctx.client, location.sessionRoot, location.directUri, conflict);
  (ctx.extraUris ??= []).push(location.directUri);

  const run = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: "conflict-sync",
    endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
    capture: "observation",
  });
  attachObservation(run);
  assertObsRun(log, ctx, run, ctx.workload.expectedRecords, [
    ctx.sessionId, ctx.storageUser, ctx.userRoot, ctx.workload.prompt, ctx.taskApiKey,
  ]);
  const notify = run.actions[0].notifyEvent;
  log.check(ctx.workloadId, "sync-notify", "warning", notify?.notifyType, notify?.notifyType === "warning");
  const failures = run.observation.records.filter((record) => record.stage === "sync_failure");
  log.check(ctx.workloadId, "owned-sync-failures", ">=1", failures.length, failures.length >= 1,
    failures.map((record) => record.data.errorCode).join(","));
  const integrityFailures = failures.length >= 1 && failures.every(
    (record) => record.data.errorClass === "integrity" && record.data.branch === "pending_replay",
  );
  log.check(ctx.workloadId, "integrity-failure", true, integrityFailures, integrityFailures);
  const http409 = run.observation.records.some(
    (record) => record.stage === "client_http" && record.data?.phase === "end" && record.data.status === 409,
  );
  log.check(ctx.workloadId, "http-409", true, http409, http409);
  const ack = existsSync(ackPath(ctx, ctx.endpoint)) ? await readSyncAck(ackPath(ctx, ctx.endpoint)) : null;
  log.check(ctx.workloadId, "ack-held", 0, ack?.acknowledgedLeaves?.length ?? 0,
    !ack || ack.acknowledgedLeaves.length === 0);
  const readback = await ctx.client.downloadBytes(location.directUri);
  log.check(ctx.workloadId, "conflict-bytes-intact", true,
    Boolean(readback.ok && readback.bytes?.equals(conflict)),
    Boolean(readback.ok && readback.bytes?.equals(conflict)));
  recordRun(ctx, prep);
  recordRun(ctx, run);
}

async function wToolUriRejection(log, ctx) {
  const outsideRoot = `viking://user/dev--pi-${randomUUID()}`;
  const outsideUri = `${outsideRoot}/resources/not-owned.md`;
  const internalUri = `${ctx.userRoot}/resources/.pi-openviking/recorded-events/v1/protected/.event.json`;
  const resourceUrl = "https://example.com/";
  // 依次验证通用工具 guard、内部事实删除拒绝和资源返回 URI 的 allow 边界。
  const scripted = await startScriptedProvider({
    agentDir: join(ctx.runDir, "pi"),
    respond: (messages) => {
      const toolResults = messages.filter((message) => message.role === "tool").length;
      if (toolResults === 0) return { toolCall: { name: "read", input: { path: outsideUri } } };
      if (toolResults === 1) return { toolCall: { name: "viking_forget", input: { uri: internalUri } } };
      if (toolResults === 2) return { toolCall: { name: "viking_add_resource", input: { url: resourceUrl } } };
      return { text: "DONE" };
    },
  });
  try {
    const run = await runPi(ctx, {
      workloadId: ctx.workloadId,
      turn: "tool-uri-live",
      endpoint: ctx.endpoint,
      actions: [{ prompt: ctx.workload.prompt }, { command: "/viking sync" }],
      capture: "observation",
      ...scripted.runOverrides,
    });
    attachObservation(run);
    assertObsRun(log, ctx, run, ctx.workload.expectedRecords, [
      ctx.sessionId, ctx.storageUser, ctx.userRoot, outsideRoot, outsideUri, internalUri, resourceUrl,
      ctx.workload.prompt, ctx.taskApiKey,
    ]);
    log.check(ctx.workloadId, "scripted-provider-requests", 4, scripted.requests(), scripted.requests() === 4);
    const toolEnd = run.events.find((event) => event.type === "tool_execution_end" && event.toolName === "read");
    const blocked = toolEnd?.isError === true && JSON.stringify(toolEnd.result || {}).includes("viking_read");
    log.check(ctx.workloadId, "pi-read-blocked", true, blocked, blocked);
    const forgetEnd = run.events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "viking_forget",
    );
    const protectedInternal = JSON.stringify(forgetEnd?.result || {}).includes("managed by pi-openviking");
    log.check(ctx.workloadId, "internal-fact-delete-refused", true, protectedInternal, protectedInternal);
    const deleteDenial = run.observation.records.find(
      (record) => record.stage === "tool_scope" && record.data?.tool === "viking_forget"
        && record.data?.operation === "delete" && record.data?.branch === "deny",
    );
    const disallowedDelete = run.observation.records.some((record) =>
      deleteDenial
        && record.seq > deleteDenial.seq
        && record.stage === "client_http"
        && record.data?.phase === "begin"
        && record.data?.method === "DELETE",
    );
    log.check(ctx.workloadId, "no-openviking-delete-after-deny", false, disallowedDelete, !disallowedDelete);

    const resourceEnd = run.events.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "viking_add_resource",
    );
    const resourceDenied = JSON.stringify(resourceEnd?.result || {}).includes("session-scoped memory");
    log.check(ctx.workloadId, "resource-ingest-refused", true, resourceDenied, resourceDenied);
    const resourceDecision = run.observation.records.some(
      (record) => record.stage === "tool_scope" && record.data?.tool === "viking_add_resource"
        && record.data?.operation === "resource_add" && record.data?.branch === "deny",
    );
    log.check(ctx.workloadId, "resource-add-denied", true, resourceDecision, resourceDecision);
    const resourceRequest = run.observation.records.some(
      (record) => record.stage === "client_http" && record.data?.phase === "begin"
        && record.data?.route === "/api/v1/resources",
    );
    log.check(ctx.workloadId, "no-global-resource-request", false, resourceRequest, !resourceRequest);

    const guard = run.observation.records.find(
      (record) => record.stage === "tool_uri_guard" && record.data?.tool === "read",
    );
    const disallowedRead = run.observation.records.some((record) =>
      guard
        && record.seq > guard.seq
        && record.stage === "client_http"
        && record.data?.phase === "begin"
        && record.data.route === "/api/v1/content/read",
    );
    log.check(ctx.workloadId, "no-openviking-read-after-guard", false, disallowedRead, !disallowedRead);
    const outside = await ctx.cleanupClient.statUri(outsideRoot);
    log.check(ctx.workloadId, "outside-namespace-absent", false, outside.ok ? outside.exists : `status-${outside.status}`,
      outside.ok && !outside.exists);
    const sessionText = await readFile(run.sessionFile, "utf8");
    const parsed = parsePiSessionJsonl(sessionText, { sessionId: ctx.sessionId });
    await assertRemoteEvents(log, ctx, parsed.entries);
    recordRun(ctx, run);
  } finally {
    await scripted.close();
  }
}

// ---------------------------------------------------------------------------
// 全局断言与 summary 附加字段
// ---------------------------------------------------------------------------

export function collectObservedRuns(workloads) {
  return workloads.flatMap((workload) =>
    (Array.isArray(workload.summary?.runs) ? workload.summary.runs : [])
      .filter((run) => run.observation)
      .map((run) => ({ workload: workload.id, run })));
}

function assertBaseline(log, ctx) {
  const baseline = ctx.manifest.thresholds.baseline;
  const ready = Boolean(
    baseline?.measuredAt
      && baseline?.expected?.disabled
      && baseline?.expected?.enabled
      && Array.isArray(baseline?.runs)
      && baseline.runs.length > 0,
  );
  log.check("global", "baseline-fixed", true, ready, ready);
  if (!ready) return;
  const actual = collectObservedRuns(ctx.manifest.workloads).map(({ workload, run }) => ({
    workload,
    label: run.label,
    ms: run.ms,
    records: run.observation.seq.last,
  }));
  const keyOf = (item) => `${item.workload}/${item.label}`;
  const actualKeys = actual.map(keyOf).sort();
  const baselineKeys = baseline.runs.map(keyOf).sort();
  const inventoryMatches = actualKeys.length === baselineKeys.length
    && actualKeys.every((key, index) => key === baselineKeys[index]);
  log.check("global", "baseline-run-inventory", baselineKeys.length, actualKeys.length, inventoryMatches,
    inventoryMatches ? undefined : `expected=${baselineKeys.join(",")} actual=${actualKeys.join(",")}`);
  for (const expected of baseline.runs) {
    const measured = actual.find((item) => keyOf(item) === keyOf(expected));
    if (!measured) continue;
    log.check("global", `baseline.${expected.workload}.${expected.label}.wall-ms`, `<=${expected.maxMs}`, measured.ms,
      measured.ms <= expected.maxMs, `baseline=${expected.observedMs}`);
    const recordsInRange = measured.records >= expected.minRecords && measured.records <= expected.maxRecords;
    log.check("global", `baseline.${expected.workload}.${expected.label}.records`,
      `${expected.minRecords}..${expected.maxRecords}`, measured.records, recordsInRange,
      `baseline=${expected.observedRecords}`);
  }
}

function observabilitySummaryExtra(ctx) {
  return {
    registrySha256: observationRegistrySha256(),
    observationRuns: collectObservedRuns(ctx.manifest.workloads)
      .map(({ workload, run }) => ({ workload, label: run.label, ...run.observation })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const WORKLOAD_RUNNERS = {
  "success-recall-sync": wSuccessRecallSync,
  "disconnect-fail-open": wDisconnectFailOpen,
  "conflict-409": wConflict409,
  "tool-uri-rejection": wToolUriRejection,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "observability",
    manifestPath: MANIFEST_PATH,
    manifestHashPath: MANIFEST_HASH_PATH,
    runners: WORKLOAD_RUNNERS,
    collectObjectUris: (wctx) => [wctx.markerUri, ...(wctx.extraUris ?? [])].filter(Boolean),
    preflightExtra: preflightObservability,
    afterWorkloads: assertBaseline,
    summaryExtra: observabilitySummaryExtra,
  }).catch((error) => {
    process.stderr.write(`✗ observability verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
