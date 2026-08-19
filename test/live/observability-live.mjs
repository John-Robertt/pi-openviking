// verify:observability:live — 统一观察基线的真实验收门禁。
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OVClient } from "../../client.ts";
import {
  buildChildEnv,
  isDevServerProcess,
  isNodeVersionSupported,
  loadModelProfile,
  readProcessCommand,
  verifyRunFiles,
} from "../../scripts/dev.mjs";
import { canonicalJsonBytes } from "../../shared/canonical-json.mjs";
import { OBSERVATION_STAGE_REGISTRY } from "../../shared/observe.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { recordedEventStorageLocation } from "../../shared/recorded-event-adapter.mjs";
import { probeServerHealth } from "../../shared/server-health.mjs";
import { readSyncAck } from "../../shared/sync-ack.mjs";
import {
  missingExpectedRecords,
  observationRegistrySha256,
  parseObservationRun,
} from "./observation-evidence.mjs";
import {
  ackFileKey,
  AssertionLog,
  checkManifestHash,
  conflictBytesOf,
  createRpcLineParser,
  derivePassed,
  sha256Hex,
} from "./live-support.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MANIFEST_PATH = join(REPO, "test/live/observability.workloads.json");
const MANIFEST_HASH_PATH = join(REPO, "test/live/observability.workloads.sha256");
const LIVE_ROOT = join(REPO, "test/.artifacts/live");
const DEV_RUN_DIR = join(REPO, ".dev/runs/openviking");
const DEV_PID_FILE = join(DEV_RUN_DIR, "server.pid");
const DEAD_ENDPOINT = "http://127.0.0.1:9";

class PiRunError extends Error {
  constructor(message) {
    super();
    this.name = "PiRunError";
    this.code = String(message).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 64);
  }
}

class FixtureError extends Error {
  constructor(code) {
    super();
    this.name = "FixtureError";
    this.code = code;
  }
}

async function runPi(ctx, { workload, label, sessionId, endpoint, actions }) {
  const observationPath = join(ctx.runDir, "observations", `${workload.id}-${label}.jsonl`);
  mkdirSync(join(ctx.runDir, "observations"), { recursive: true });
  const observationFd = openSync(observationPath, "wx", 0o600);
  const stat = fstatSync(observationFd);
  if (!stat.isFile() || stat.size !== 0 || (stat.mode & 0o077) !== 0) {
    closeSync(observationFd);
    throw new PiRunError("observation artifact descriptor is not private and empty");
  }

  const args = [
    ctx.piBin,
    "--mode", "rpc",
    "--no-extensions",
    "-e", join(REPO, "index.ts"),
    "--session-id", sessionId,
    "--session-dir", join(ctx.runDir, "sessions"),
    "--provider", ctx.profile.taskVlm.provider,
    "--model", ctx.profile.taskVlm.model,
    "--thinking", "off",
  ];
  const env = buildChildEnv({
    HOME: join(ctx.runDir, "home"),
    PI_CODING_AGENT_DIR: join(ctx.runDir, "pi"),
    OPENVIKING_URL: endpoint,
    OPENVIKING_ACCOUNT: ctx.manifest.identities.openviking.account,
    OPENVIKING_USER: ctx.manifest.identities.openviking.user,
    [ctx.profile.taskVlm.apiKeyEnv]: ctx.apiKey,
  });
  for (const key of ["OV_OBSERVE", "OV_OBSERVE_FD", "OV_DEBUG_LOG", "OV_E2E_FD", "OV_E2E_TURN"]) delete env[key];
  env.OV_OBSERVE_FD = "3";

  const child = spawn(process.execPath, args, {
    cwd: join(ctx.runDir, "work"),
    env,
    stdio: ["pipe", "pipe", "pipe", observationFd],
  });
  const events = [];
  const waiters = [];
  const parse = createRpcLineParser();
  let stderrTail = "";
  child.stderr.on("data", (data) => { stderrTail = (stderrTail + data).slice(-2000); });
  child.stdout.on("data", (data) => {
    for (const message of parse(data.toString("utf8"))) {
      events.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });

  const deadline = Date.now() + ctx.manifest.thresholds.piRunWallMs;
  const waitFor = (predicate, timeoutMs, name, fromIndex = 0) => {
    const existing = events.slice(fromIndex).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolvePromise, reject) => {
      const remaining = Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
      const timer = setTimeout(() => reject(new PiRunError(`timeout waiting for ${name}`)), remaining);
      waiters.push({
        predicate,
        resolve: (message) => { clearTimeout(timer); resolvePromise(message); },
      });
    });
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const startedAt = Date.now();
  let sessionFile = null;
  let exitCode = -1;
  try {
    send({ id: "state", type: "get_state" });
    const state = await waitFor((message) => message.type === "response" && message.id === "state", 30000, "get_state");
    if (state.success !== true) throw new PiRunError("get_state rejected");
    sessionFile = state.data?.sessionFile || null;
    let sequence = 0;
    for (const action of actions) {
      const id = `action-${++sequence}`;
      const mark = events.length;
      send({ id, type: "prompt", message: action.prompt ?? action.command });
      const response = await waitFor((message) => message.type === "response" && message.id === id, 30000, id, mark);
      if (response.success !== true) throw new PiRunError(`${id} rejected`);
      if (action.prompt !== undefined) {
        await waitFor((message) => message.type === "agent_settled", ctx.manifest.thresholds.agentSettledMs, "agent_settled", mark);
      } else {
        action.notify = await waitFor(
          (message) => message.type === "extension_ui_request" && message.method === "notify",
          ctx.manifest.thresholds.syncNotifyMs,
          "command notify",
          mark,
        );
      }
    }
    child.stdin.end();
    exitCode = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new PiRunError("timeout waiting for Pi exit")), Math.max(1, deadline - Date.now()));
      child.on("exit", (code) => { clearTimeout(timer); resolvePromise(code ?? -1); });
    });
  } finally {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    try { fsyncSync(observationFd); } finally { closeSync(observationFd); }
  }

  const observationBytes = readFileSync(observationPath);
  const parsedObservation = parseObservationRun(observationBytes);
  return {
    label,
    ms: Date.now() - startedAt,
    exitCode,
    events,
    stderrTail,
    sessionFile,
    observationPath,
    observationRaw: observationBytes.toString("utf8"),
    observation: parsedObservation,
    actions,
  };
}

function assertPiRun(log, workload, run, expectedRecords, secrets = [], requireSession = true) {
  const id = workload.id;
  log.check(id, `${run.label}.exit`, 0, run.exitCode, run.exitCode === 0,
    run.exitCode === 0 ? undefined : `stderrBytes=${Buffer.byteLength(run.stderrTail || "")}`);
  const extensionErrors = run.events.filter((event) => event.type === "extension_error");
  log.check(id, `${run.label}.extension-errors`, 0, extensionErrors.length, extensionErrors.length === 0);
  log.check(id, `${run.label}.observation-complete`, true, run.observation.summary.complete,
    run.observation.summary.complete, run.observation.errors.join(","));
  const missing = missingExpectedRecords(run.observation.records, expectedRecords);
  log.check(id, `${run.label}.expected-records`, 0, missing.length, missing.length === 0, missing.join(","));
  const leaked = secrets.some((secret) => secret && run.observationRaw.includes(secret));
  log.check(id, `${run.label}.no-sensitive-values`, false, leaked, !leaked);
  const sessionAvailable = typeof run.sessionFile === "string" && existsSync(run.sessionFile);
  if (requireSession) {
    log.check(id, `${run.label}.session-artifact`, true, sessionAvailable, sessionAvailable);
  }
  if (sessionAvailable) {
    const sessionRaw = readFileSync(run.sessionFile, "utf8");
    const diagnosticStageInSession = Object.keys(OBSERVATION_STAGE_REGISTRY).some((stage) => sessionRaw.includes(`\"stage\":\"${stage}\"`));
    log.check(id, `${run.label}.observation-not-in-pi-jsonl`, false, diagnosticStageInSession, !diagnosticStageInSession);
  }
  return run.observation.summary;
}

async function mkdirChain(client, fromUri, targetUri) {
  const base = fromUri.replace(/\/+$/, "");
  const relative = targetUri.slice(base.length).split("/").filter(Boolean);
  let current = base;
  for (const segment of relative) {
    current = `${current}/${segment}`;
    const created = await client.mkdirUri(current);
    if (created.ok) continue;
    const status = await client.statUri(current);
    if (!status.ok || !status.exists || !status.isDir) throw new Error(`mkdir failed (${created.status || 0})`);
  }
}

async function createObject(client, rootUri, uri, bytes, wait = false, timeoutMs = 30000) {
  const request = {
    root_uri: rootUri,
    operations: [{ uri, content_base64: Buffer.from(bytes).toString("base64"), precondition: { kind: "create_if_absent" } }],
    wait,
  };
  const response = wait
    ? await client.fetchJSON(
      "/api/v1/content/batch-write",
      { method: "POST", body: JSON.stringify(request) },
      timeoutMs,
    )
    : await client.batchWrite(request);
  if (!response.ok || !response.result?.created?.includes(uri)) {
    throw new FixtureError(response.ok ? "OBJECT_NOT_CREATED" : `OBJECT_HTTP_${response.status || 0}`);
  }
}

async function establishOwnership(log, ctx, workload, sessionId) {
  const storageUser = `dev--pi-${sessionId}`;
  const userRoot = `viking://user/${storageUser}`;
  const ownerRoot = `${userRoot}/resources/.pi-openviking`;
  const markerUri = `${ownerRoot}/.observability-owner.json`;
  const markerBytes = canonicalJsonBytes({
    schemaVersion: 1,
    type: "pi-openviking-observability-owner",
    runId: ctx.runId,
    manifestSha256: ctx.manifestSha256,
    nonce: ctx.nonce,
    sessionId,
  });
  const client = new OVClient(clientConfig(ctx, storageUser));
  const cleanupClient = new OVClient(clientConfig(ctx, ctx.manifest.identities.openviking.user));
  const candidate = {
    client, cleanupClient, storageUser, userRoot, ownerRoot, markerUri, markerBytes, objectUris: [markerUri],
  };
  let markerWriteAttempted = false;
  try {
    const initial = await client.statUri(userRoot);
    const absent = initial.ok && !initial.exists;
    log.check(workload.id, "namespace-absent-before", false, initial.ok ? initial.exists : `status-${initial.status}`, absent);
    if (!absent) throw new FixtureError("NAMESPACE_NOT_ABSENT");

    await mkdirChain(client, `${userRoot}/resources`, ownerRoot);
    markerWriteAttempted = true;
    await createObject(client, ownerRoot, markerUri, markerBytes);
    const markerRead = await client.downloadBytes(markerUri);
    const markerValid = markerRead.ok && markerRead.bytes?.equals(markerBytes);
    log.check(workload.id, "owner-marker-readback", "byte-exact",
      markerRead.ok ? markerRead.bytes?.length : markerRead.status, markerValid);
    if (!markerValid) throw new FixtureError("OWNER_MARKER_MISMATCH");
    return candidate;
  } catch (error) {
    if (markerWriteAttempted) await cleanupOwnership(log, ctx, workload, candidate);
    else {
      await client.close();
      await cleanupClient.close();
    }
    throw error;
  }
}

async function cleanupOwnership(log, ctx, workload, owned) {
  if (!owned) return true;
  let pass = false;
  try {
    const rootValid = owned.userRoot === `viking://user/${owned.storageUser}`
      && /^dev--pi-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owned.storageUser);
    log.check(workload.id, "cleanup.root", true, rootValid, rootValid);
    if (!rootValid) return false;
    const marker = await owned.client.downloadBytes(owned.markerUri);
    const markerValid = marker.ok && marker.bytes?.equals(owned.markerBytes);
    log.check(workload.id, "cleanup.marker", true, markerValid, markerValid);
    if (!markerValid) return false;
    await owned.cleanupClient.delete(owned.userRoot, true);
    const deadline = Date.now() + ctx.manifest.thresholds.cleanupMs;
    let residual = true;
    while (Date.now() < deadline) {
      const statuses = await Promise.all(owned.objectUris.map((uri) => owned.cleanupClient.statUri(uri)));
      residual = statuses.some((status) => !status.ok || status.exists);
      if (!residual) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    log.check(workload.id, "cleanup.remote", 0, residual ? 1 : 0, !residual);
    pass = !residual;
    if (pass) {
      (ctx.deletedObjects ??= []).push({
        workload: workload.id,
        userRoot: owned.userRoot,
        objectUris: [...owned.objectUris],
      });
    }
  } catch (error) {
    log.fail(workload.id, "cleanup.remote", error);
  } finally {
    await owned.client.close();
    await owned.cleanupClient.close();
  }
  return pass;
}

function clientConfig(ctx, user) {
  return {
    endpoint: ctx.endpoint,
    apiKey: "",
    account: ctx.manifest.identities.openviking.account,
    user,
    peerId: "observability-live",
    userAgent: "pi-openviking/observability-live",
  };
}

function ackPath(ctx, endpoint, storageUser, sessionId) {
  const key = ackFileKey(endpoint, ctx.manifest.identities.openviking.account, storageUser, sessionId);
  return join(ctx.runDir, "home", ".pi", "openviking", "sync-ack", `${key}.json`);
}

async function assertRemoteEvents(log, workload, owned, sessionId, entries) {
  const events = projectPiEntries(sessionId, entries);
  let failures = 0;
  for (const event of events) {
    const location = recordedEventStorageLocation(owned.userRoot, sessionId, event.eventId);
    owned.objectUris.push(location.directUri);
    const readback = await owned.client.downloadBytes(location.directUri);
    if (!readback.ok || !readback.bytes?.equals(recordedEventBytes(event))) failures++;
  }
  log.check(workload.id, "remote-event-correspondence", 0, failures, failures === 0,
    `events=${events.length}`);
}

async function workloadSuccess(log, ctx, workload) {
  const sessionId = randomUUID();
  let owned;
  try {
    owned = await establishOwnership(log, ctx, workload, sessionId);
    const recallUri = `${owned.ownerRoot}/recall-fixture.md`;
    await createObject(
      owned.client, owned.ownerRoot, recallUri, Buffer.from(workload.prompt, "utf8"), true,
      ctx.manifest.thresholds.fixtureMs,
    );
    owned.objectUris.push(recallUri);
    const run = await runPi(ctx, {
      workload,
      label: "success",
      sessionId,
      endpoint: ctx.endpoint,
      actions: [{ prompt: workload.prompt }, { command: "/viking sync" }],
    });
    const observationSummary = assertPiRun(log, workload, run, workload.expectedRecords, [
      sessionId, owned.storageUser, owned.userRoot, workload.prompt, ctx.apiKey,
    ]);
    const notify = run.actions[1].notify;
    log.check(workload.id, "sync-notify", "info", notify?.notifyType, notify?.notifyType === "info");
    const sessionText = await readFile(run.sessionFile, "utf8");
    const parsed = parsePiSessionJsonl(sessionText, { sessionId });
    await assertRemoteEvents(log, workload, owned, sessionId, parsed.entries);
    const productObservation = parsed.entries.some((entry) => entry.type === "custom" && entry.customType === "ov-observation");
    log.check(workload.id, "recall-product-entry", true, productObservation, productObservation);
    const ackFile = ackPath(ctx, ctx.endpoint, owned.storageUser, sessionId);
    const ack = existsSync(ackFile) ? await readSyncAck(ackFile) : null;
    log.check(workload.id, "ack-advanced", ">=1 leaf", ack?.acknowledgedLeaves?.length ?? 0,
      Boolean(ack?.acknowledgedLeaves?.length));
    return { observationRuns: [observationSummary], runs: [summarizeRun(run)] };
  } finally {
    await cleanupOwnership(log, ctx, workload, owned);
  }
}

async function workloadDisconnect(log, ctx, workload) {
  const sessionId = randomUUID();
  const run = await runPi(ctx, {
    workload,
    label: "disconnect",
    sessionId,
    endpoint: workload.endpoint,
    actions: [{ prompt: workload.prompt }],
  });
  const summary = assertPiRun(log, workload, run, workload.expectedRecords, [sessionId, workload.prompt, ctx.apiKey]);
  const settled = run.events.some((event) => event.type === "agent_settled");
  log.check(workload.id, "agent-settled", true, settled, settled);
  const networkErrors = run.observation.records.filter(
    (record) => record.stage === "client_http" && record.data?.outcome === "network_error",
  ).length;
  log.check(workload.id, "network-error-observed", ">=1", networkErrors, networkErrors >= 1);
  const deadAck = ackPath(ctx, workload.endpoint, `dev--pi-${sessionId}`, sessionId);
  log.check(workload.id, "ack-not-created", false, existsSync(deadAck), !existsSync(deadAck));
  return { observationRuns: [summary], runs: [summarizeRun(run)] };
}

async function workloadConflict(log, ctx, workload) {
  const sessionId = randomUUID();
  const prep = await runPi(ctx, {
    workload,
    label: "conflict-prep",
    sessionId,
    endpoint: DEAD_ENDPOINT,
    actions: [{ prompt: workload.prompt }],
  });
  const prepSummary = assertPiRun(log, workload, prep, [], [sessionId, workload.prompt, ctx.apiKey]);
  const sessionText = await readFile(prep.sessionFile, "utf8");
  const parsed = parsePiSessionJsonl(sessionText, { sessionId });
  const firstEntry = parsed.entries[0];
  const event = projectPiEntries(sessionId, [firstEntry])[0];
  const bytes = recordedEventBytes(event);
  let owned;
  try {
    owned = await establishOwnership(log, ctx, workload, sessionId);
    const location = recordedEventStorageLocation(owned.userRoot, sessionId, event.eventId);
    await mkdirChain(owned.client, `${owned.userRoot}/resources`, location.shardRoot);
    const conflict = conflictBytesOf(bytes);
    await createObject(owned.client, location.sessionRoot, location.directUri, conflict);
    owned.objectUris.push(location.directUri);

    const run = await runPi(ctx, {
      workload,
      label: "conflict-sync",
      sessionId,
      endpoint: ctx.endpoint,
      actions: [{ command: "/viking sync" }],
    });
    const runSummary = assertPiRun(log, workload, run, workload.expectedRecords, [
      sessionId, owned.storageUser, owned.userRoot, workload.prompt, ctx.apiKey,
    ]);
    const notify = run.actions[0].notify;
    log.check(workload.id, "sync-notify", "warning", notify?.notifyType, notify?.notifyType === "warning");
    const failures = run.observation.records.filter((record) => record.stage === "sync_failure");
    log.check(workload.id, "owned-sync-failures", ">=1", failures.length, failures.length >= 1,
      failures.map((record) => record.data.errorCode).join(","));
    const integrityFailures = failures.length >= 1 && failures.every(
      (record) => record.data.errorClass === "integrity" && record.data.branch === "pending_replay",
    );
    log.check(workload.id, "integrity-failure", true, integrityFailures, integrityFailures);
    const http409 = run.observation.records.some(
      (record) => record.stage === "client_http" && record.data?.phase === "end" && record.data.status === 409,
    );
    log.check(workload.id, "http-409", true, http409, http409);
    const ackFile = ackPath(ctx, ctx.endpoint, owned.storageUser, sessionId);
    const ack = existsSync(ackFile) ? await readSyncAck(ackFile) : null;
    log.check(workload.id, "ack-held", 0, ack?.acknowledgedLeaves?.length ?? 0,
      !ack || ack.acknowledgedLeaves.length === 0);
    const readback = await owned.client.downloadBytes(location.directUri);
    log.check(workload.id, "conflict-bytes-intact", true,
      Boolean(readback.ok && readback.bytes?.equals(conflict)),
      Boolean(readback.ok && readback.bytes?.equals(conflict)));
    return { observationRuns: [prepSummary, runSummary], runs: [summarizeRun(prep), summarizeRun(run)] };
  } finally {
    await cleanupOwnership(log, ctx, workload, owned);
  }
}

async function workloadTool(log, ctx, workload) {
  const sessionId = randomUUID();
  const outsideRoot = `viking://user/dev--pi-${randomUUID()}`;
  const outsideUri = `${outsideRoot}/resources/not-owned.md`;
  const prompt = workload.promptTemplate.replace("{uri}", outsideUri);
  let owned;
  try {
    owned = await establishOwnership(log, ctx, workload, sessionId);
    const run = await runPi(ctx, {
      workload,
      label: "tool-uri-live",
      sessionId,
      endpoint: ctx.endpoint,
      actions: [{ prompt }],
    });
    const summary = assertPiRun(log, workload, run, workload.expectedRecords, [
      sessionId, owned.storageUser, owned.userRoot, outsideRoot, outsideUri, prompt, ctx.apiKey,
    ]);
    const toolEnd = run.events.find((event) => event.type === "tool_execution_end" && event.toolName === "read");
    const blocked = toolEnd?.isError === true && JSON.stringify(toolEnd.result || {}).includes("viking_read");
    log.check(workload.id, "pi-read-blocked", true, blocked, blocked);

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
    log.check(workload.id, "no-openviking-read-after-guard", false, disallowedRead, !disallowedRead);
    const outside = await owned.cleanupClient.statUri(outsideRoot);
    log.check(workload.id, "outside-namespace-absent", false, outside.ok ? outside.exists : `status-${outside.status}`,
      outside.ok && !outside.exists);

    const sessionText = await readFile(run.sessionFile, "utf8");
    const parsed = parsePiSessionJsonl(sessionText, { sessionId });
    await assertRemoteEvents(log, workload, owned, sessionId, parsed.entries);
    return { observationRuns: [summary], runs: [summarizeRun(run)] };
  } finally {
    await cleanupOwnership(log, ctx, workload, owned);
  }
}

function summarizeRun(run) {
  return { label: run.label, ms: run.ms, exitCode: run.exitCode };
}

function assertBaseline(log, baseline, workloadResults) {
  const ready = Boolean(
    baseline?.measuredAt
      && baseline?.expected?.disabled
      && baseline?.expected?.enabled
      && Array.isArray(baseline?.runs)
      && baseline.runs.length > 0,
  );
  log.check("global", "baseline-fixed", true, ready, ready);
  if (!ready) return;

  const actual = workloadResults.flatMap((workload) => workload.runs.map((run, index) => ({
    workload: workload.id,
    label: run.label,
    ms: run.ms,
    records: workload.observationRuns[index]?.seq?.last ?? 0,
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

async function assertDurableCleanup(log, ctx) {
  if (!ctx.deletedObjects?.length) return;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ctx.manifest.thresholds.cleanupSettleMs));
  const client = new OVClient(clientConfig(ctx, ctx.manifest.identities.openviking.user));
  try {
    for (const entry of ctx.deletedObjects) {
      const statuses = await Promise.all(entry.objectUris.map((uri) => client.statUri(uri)));
      const residuals = statuses.filter((status) => !status.ok || status.exists).length;
      log.check(entry.workload, "cleanup.durable", 0, residuals, residuals === 0);
      const root = await client.statUri(entry.userRoot);
      log.check(entry.workload, "cleanup.skeleton-observed", "informational", root.ok && root.exists, true);
    }
  } finally {
    await client.close();
  }
}

async function preflight(log, ctx) {
  const group = "preflight";
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  log.check(group, "node-engines", pkg.engines.node, process.version,
    isNodeVersionSupported(process.version, pkg.engines.node));
  const piPkg = JSON.parse(readFileSync(join(REPO, "node_modules", ctx.manifest.identities.pi.package, "package.json"), "utf8"));
  log.check(group, "pi-version", ctx.manifest.identities.pi.version, piPkg.version,
    piPkg.version === ctx.manifest.identities.pi.version);
  ctx.piBin = join(REPO, ctx.manifest.identities.pi.binPath);
  log.check(group, "pi-bin", true, existsSync(ctx.piBin), existsSync(ctx.piBin));

  const profileBytes = readFileSync(join(REPO, ctx.manifest.identities.modelProfile.path));
  log.check(group, "model-profile", ctx.manifest.identities.modelProfile.sha256, sha256Hex(profileBytes),
    sha256Hex(profileBytes) === ctx.manifest.identities.modelProfile.sha256);
  ctx.profile = loadModelProfile(join(REPO, ctx.manifest.identities.modelProfile.path));

  let pid = 0;
  try { pid = Number(readFileSync(DEV_PID_FILE, "utf8").trim()); } catch { /* asserted below */ }
  const ownership = Number.isInteger(pid) && pid > 0 ? verifyRunFiles(DEV_RUN_DIR, { expectedPid: pid }) : { ok: false, reason: "invalid pid" };
  const command = ownership.ok ? readProcessCommand(pid) : null;
  const identity = ownership.ok && isDevServerProcess(command, join(DEV_RUN_DIR, "ov.conf"));
  log.check(group, "dev-service-ownership", true, identity, identity, ownership.reason);
  const health = await probeServerHealth(ctx.endpoint, { timeoutMs: 5000 });
  log.check(group, "openviking-health", `${ctx.manifest.identities.openviking.version}/${ctx.manifest.identities.openviking.authMode}`,
    health.ok ? `${health.data?.version}/${health.data?.auth_mode}` : `unreachable-${health.statusCode}`,
    health.ok && health.data?.version === ctx.manifest.identities.openviking.version
      && health.data?.auth_mode === ctx.manifest.identities.openviking.authMode);

  const registryHash = observationRegistrySha256();
  log.check(group, "registry-hash", ctx.manifest.identities.registry.sha256, registryHash,
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
  log.check(group, "stage-evidence-total", 0, uncovered.length + unknown.length,
    uncovered.length === 0 && unknown.length === 0,
    [...uncovered.map((stage) => `missing:${stage}`), ...unknown.map((stage) => `unknown:${stage}`)].join(","));

  const bridge = spawnSync("npm", ["exec", "--", "pi", "auth", "print-api-key",
    "--provider", ctx.profile.taskVlm.provider, "--model", ctx.profile.taskVlm.model], { encoding: "utf8" });
  ctx.apiKey = bridge.status === 0 ? bridge.stdout.trim() : "";
  log.check(group, "credential-bridge", true, Boolean(ctx.apiKey) && !ctx.apiKey.includes("\n"),
    Boolean(ctx.apiKey) && !ctx.apiKey.includes("\n"));

  const productionFiles = new Set(Object.values(OBSERVATION_STAGE_REGISTRY).map((descriptor) => descriptor.owner));
  productionFiles.add("index.ts");
  productionFiles.add("sync.ts");
  const legacy = [...productionFiles].filter((file) => /OV_DEBUG_LOG|debugLog\s*\(|appendFileSync/.test(readFileSync(join(REPO, file), "utf8")));
  log.check(group, "no-second-observer", 0, legacy.length, legacy.length === 0, legacy.join(","));
}

async function main() {
  const startedAt = Date.now();
  const manifestBytes = readFileSync(MANIFEST_PATH);
  const manifestHashText = readFileSync(MANIFEST_HASH_PATH, "utf8");
  if (!checkManifestHash(manifestBytes, manifestHashText)) {
    process.stderr.write("✗ observability manifest hash mismatch; refusing live run\n");
    process.exit(1);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestSha256 = sha256Hex(manifestBytes);
  const runId = `observability-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const runDir = join(LIVE_ROOT, runId);
  for (const directory of ["home", "pi", "work", "sessions", "observations"]) mkdirSync(join(runDir, directory), { recursive: true });
  const nonce = randomBytes(16).toString("hex");
  const localMarker = join(runDir, "owner.marker");
  const marker = `pi-openviking-observability-live\n${runId}\n${manifestSha256}\n${nonce}\n`;
  writeFileSync(localMarker, marker, { flag: "wx", mode: 0o600 });

  const log = new AssertionLog();
  const ctx = {
    runId,
    runDir,
    nonce,
    manifest,
    manifestSha256,
    endpoint: manifest.identities.openviking.endpoint,
  };
  const workloadResults = [];
  try {
    await preflight(log, ctx);
    if (derivePassed(log.items)) {
      for (const workload of manifest.workloads) {
        try {
          const result = workload.id === "success-recall-sync" ? await workloadSuccess(log, ctx, workload)
            : workload.id === "disconnect-fail-open" ? await workloadDisconnect(log, ctx, workload)
              : workload.id === "conflict-409" ? await workloadConflict(log, ctx, workload)
                : workload.id === "tool-uri-rejection" ? await workloadTool(log, ctx, workload)
                  : null;
          if (!result) log.check(workload.id, "runner", true, false, false);
          else workloadResults.push({ id: workload.id, ...result });
        } catch (error) {
          log.fail(workload.id, "workload-exception", error);
        }
      }
    }
    await assertDurableCleanup(log, ctx);
    assertBaseline(log, manifest.thresholds.baseline, workloadResults);
  } finally {
    ctx.apiKey = "";
  }

  let localOwnership = false;
  try {
    const stat = lstatSync(localMarker);
    localOwnership = stat.isFile() && (stat.mode & 0o077) === 0 && readFileSync(localMarker, "utf8") === marker;
  } catch {
    localOwnership = false;
  }
  log.check("global", "local-ownership-marker", true, localOwnership, localOwnership);

  const passedBeforeLocalCleanup = derivePassed(log.items);
  const summary = {
    schemaVersion: 1,
    gate: manifest.gate,
    phase: manifest.phase,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    manifestSha256,
    registrySha256: observationRegistrySha256(),
    identities: {
      pi: { package: manifest.identities.pi.package, version: manifest.identities.pi.version },
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      openviking: { version: manifest.identities.openviking.version, authMode: manifest.identities.openviking.authMode },
      modelProfile: { path: manifest.identities.modelProfile.path, sha256: manifest.identities.modelProfile.sha256 },
    },
    assertions: log.items,
    workloads: workloadResults,
    observationRuns: workloadResults.flatMap((workload) => workload.observationRuns.map((run) => ({ workload: workload.id, ...run }))),
    cleanup: { local: null },
    passed: passedBeforeLocalCleanup,
  };

  const summaryPath = join(runDir, "summary.json");
  let localCleanup = true;
  try {
    if (!localOwnership) throw new FixtureError("LOCAL_MARKER_MISMATCH");
    if (passedBeforeLocalCleanup) {
      rmSync(runDir, { recursive: true, force: true });
      if (existsSync(runDir)) throw new Error("run directory remains");
      summary.cleanup.local = "run-dir removed";
    } else {
      for (const directory of ["home", "pi", "sessions", "observations", "work"]) {
        rmSync(join(runDir, directory), { recursive: true, force: true });
      }
      summary.cleanup.local = "raw artifacts removed";
    }
  } catch (error) {
    localCleanup = false;
    summary.cleanup.local = "failed";
    process.stderr.write(`✗ local cleanup failed (${error?.name || "Error"})\n`);
  }
  summary.passed = passedBeforeLocalCleanup && localCleanup;
  if (!summary.passed && localOwnership) writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${summary.passed ? "✓" : "✗"} verify:observability:live ${summary.passed ? "PASSED" : "FAILED"}\n`);
  process.exit(summary.passed ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? ` code=${error.code}` : "";
    process.stderr.write(`✗ observability verifier error (${error?.name || "Error"}${code})\n`);
    process.exit(1);
  });
}
