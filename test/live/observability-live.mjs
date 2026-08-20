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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OBSERVATION_STAGE_REGISTRY } from "../../shared/observe.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { recordedEventStorageLocation } from "../../shared/recorded-event-adapter.mjs";
import { readSyncAck } from "../../shared/sync-ack.mjs";
import {
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

async function createObject(client, rootUri, uri, bytes, wait = false, timeoutMs = 30000) {
  const request = {
    root_uri: rootUri,
    operations: [{ uri, content_base64: Buffer.from(bytes).toString("base64"), precondition: { kind: "create_if_absent" } }],
    wait,
  };
  const response = wait
    ? await client.fetchJSON("/api/v1/content/batch-write", { method: "POST", body: JSON.stringify(request) }, timeoutMs)
    : await client.batchWrite(request);
  if (!response.ok || !response.result?.created?.includes(uri)) {
    throw new FixtureError(response.ok ? "OBJECT_NOT_CREATED" : `OBJECT_HTTP_${response.status || 0}`);
  }
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
  const activeStages = Object.keys(OBSERVATION_STAGE_REGISTRY);
  const evidenceStages = new Set([
    "observe_run_start",
    "observe_run_end",
    ...ctx.manifest.deterministicStages,
    ...ctx.manifest.workloads.flatMap((workload) => workload.expectedRecords.map((expected) => expected.stage)),
  ]);
  const uncovered = activeStages.filter((stage) => !evidenceStages.has(stage));
  const unknown = [...evidenceStages].filter((stage) => !OBSERVATION_STAGE_REGISTRY[stage]);
  log.check(g, "stage-evidence-total", 0, uncovered.length + unknown.length,
    uncovered.length === 0 && unknown.length === 0,
    [...uncovered.map((stage) => `missing:${stage}`), ...unknown.map((stage) => `unknown:${stage}`)].join(","));
  const ownerFiles = new Set(Object.values(OBSERVATION_STAGE_REGISTRY).map((descriptor) => descriptor.owner));
  ownerFiles.delete("shared/observe.mjs"); // 统一 sink 自身的写出原语不属于第二观察点
  const secondObserver = [...ownerFiles].filter((file) => /appendFileSync|console\.(?:log|debug)|process\.stderr\.write/.test(readFileSync(join(REPO, file), "utf8")));
  log.check(g, "no-second-observer", 0, secondObserver.length, secondObserver.length === 0, secondObserver.join(","));
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

async function wSuccessRecallSync(log, ctx) {
  const ownerRoot = `${ctx.userRoot}/resources/.pi-openviking`;
  const recallUri = `${ownerRoot}/recall-fixture.md`;
  await createObject(ctx.client, ownerRoot, recallUri, Buffer.from(ctx.workload.prompt, "utf8"), true,
    ctx.manifest.thresholds.fixtureMs);
  (ctx.extraUris ??= []).push(recallUri);
  const run = await runPi(ctx, {
    workloadId: ctx.workloadId,
    turn: "success",
    endpoint: ctx.endpoint,
    actions: [{ prompt: ctx.workload.prompt }, { command: "/viking sync" }],
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
  await assertRemoteEvents(log, ctx, parsed.entries);
  const productObservation = parsed.entries.some((entry) => entry.type === "custom" && entry.customType === "ov-observation");
  log.check(ctx.workloadId, "recall-product-entry", true, productObservation, productObservation);
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
  // 确定性触发：脚本 provider 固定以内置 read 逐字调用越界 URI，第二轮回复 DONE。
  const scripted = await startScriptedProvider({
    agentDir: join(ctx.runDir, "pi"),
    respond: (messages) => messages.some((message) => message.role === "tool")
      ? { text: "DONE" }
      : { toolCall: { name: "read", input: { path: outsideUri } } },
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
      ctx.sessionId, ctx.storageUser, ctx.userRoot, outsideRoot, outsideUri, ctx.workload.prompt, ctx.taskApiKey,
    ]);
    log.check(ctx.workloadId, "scripted-provider-requests", 2, scripted.requests(), scripted.requests() === 2);
    const toolEnd = run.events.find((event) => event.type === "tool_execution_end" && event.toolName === "read");
    const blocked = toolEnd?.isError === true && JSON.stringify(toolEnd.result || {}).includes("viking_read");
    log.check(ctx.workloadId, "pi-read-blocked", true, blocked, blocked);
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
  const actual = ctx.manifest.workloads.flatMap((workload) =>
    (Array.isArray(workload.summary?.runs) ? workload.summary.runs : []).map((run) => ({
      workload: workload.id,
      label: run.label,
      ms: run.ms,
      records: run.observation?.seq?.last ?? 0,
    })));
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
    observationRuns: ctx.manifest.workloads.flatMap((workload) =>
      (Array.isArray(workload.summary?.runs) ? workload.summary.runs : [])
        .filter((run) => run.observation)
        .map((run) => ({ workload: workload.id, label: run.label, ...run.observation }))),
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
