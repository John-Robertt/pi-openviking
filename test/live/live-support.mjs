import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OVClient } from "../../client.ts";
import {
  buildChildEnv,
  buildDevServerConfig,
  isDevServerProcess,
  isNodeVersionSupported,
  loadModelProfile,
  readProcessCommand,
  verifyDevServerConfig,
  verifyRunFiles,
} from "../../scripts/dev.mjs";
import { canonicalJsonBytes } from "../../shared/canonical-json.mjs";
import { probeServerHealth } from "../../shared/server-health.mjs";
import { syncAckFileKey } from "../../shared/sync-ack.mjs";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checkManifestHash(manifestBytes, hashFileText) {
  const expected = String(hashFileText || "").trim();
  return /^[0-9a-f]{64}$/.test(expected) && sha256Hex(manifestBytes) === expected;
}

export function derivePassed(assertions) {
  return assertions.length > 0 && assertions.every((assertion) => assertion.pass === true);
}

export function conflictBytesOf(bytes) {
  const copy = Buffer.from(bytes);
  copy[copy.length - 1] = copy[copy.length - 1] ^ 0x01;
  return copy;
}

export function ackFileKey(endpoint, account, user, sessionId) {
  return syncAckFileKey({ endpoint, account, user }, sessionId);
}

export class AssertionLog {
  constructor(output = process.stderr) {
    this.items = [];
    this.output = output;
  }

  check(workload, id, expected, actual, pass, detail) {
    const entry = { workload, id, expected, actual, pass: pass === true };
    if (detail !== undefined) entry.delta = String(detail).slice(0, 400);
    this.items.push(entry);
    const mark = entry.pass ? "✓" : "✗";
    this.output.write(`  ${mark} [${workload}] ${id}: expected=${truncate(expected)} actual=${truncate(actual)}${entry.pass ? "" : ` (${entry.delta ?? ""})`}\n`);
    return entry.pass;
  }

  fail(workload, id, error) {
    const errorClass = typeof error?.name === "string" ? error.name : "Error";
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null;
    const status = Number.isInteger(error?.status) ? error.status : null;
    return this.check(workload, id, "no exception", errorClass, false,
      [code ? `code=${code}` : "", status !== null ? `status=${status}` : ""].filter(Boolean).join(" ") || undefined);
  }
}

function truncate(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function createRpcLineParser() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const out = [];
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ type: "__unparsed", line: line.slice(0, 200) });
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Live gate 运行骨架
//
// Phase 0 与 Phase 1 是同一套真实边界的两个出口：Pi 子进程驱动、身份核对、本地/远端
// ownership、清理与 summary 的契约由 docs/verification.md 统一规定，因此由本模块承担。
// 各阶段只提供自己的 workload、断言和“本次写入了哪些远端对象”。
// ---------------------------------------------------------------------------

export const LIVE_REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const LIVE_ROOT = join(LIVE_REPO, "test/.artifacts/live");
const DEV_RUN_DIR = join(LIVE_REPO, ".dev/runs/openviking");
const DEV_PID_FILE = join(DEV_RUN_DIR, "server.pid");

export class PiRunError extends Error {}

/**
 * 一次真实 Pi 进程运行。actions: { prompt } 等待 agent_settled；{ command }（如
 * /viking sync）等待其后的 notify。返回事件流、segment 路径与退出码。
 */
export async function runPi(ctx, { workloadId, turn, endpoint, actions }) {
  if (ctx.verifyLocalMarker && !ctx.verifyLocalMarker()) {
    throw new PiRunError("local ownership marker compromised before Pi run");
  }
  const runDir = ctx.runDir;
  const segmentPath = join(runDir, "segments", `${workloadId}-${turn}.jsonl`);
  mkdirSync(dirname(segmentPath), { recursive: true });
  const segFd = openSync(segmentPath, "wx", 0o600);

  const ov = ctx.manifest.identities.openviking;
  const args = [
    ctx.piBin,
    "--mode", "rpc",
    "--no-extensions",
    ...ctx.manifest.identities.extensionLoadOrder.flatMap((rel) => ["-e", join(LIVE_REPO, rel)]),
    "--session-id", ctx.sessionId,
    "--session-dir", join(runDir, "sessions"),
    "--provider", ctx.profile.taskVlm.provider,
    "--model", ctx.profile.taskVlm.model,
    "--thinking", "off",
  ];
  const env = buildChildEnv({
    HOME: join(runDir, "home"),
    PI_CODING_AGENT_DIR: join(runDir, "pi"),
    OPENVIKING_URL: endpoint,
    OPENVIKING_ACCOUNT: ov.account,
    OPENVIKING_USER: ov.user,
    [ctx.profile.taskVlm.apiKeyEnv]: ctx.apiKey,
    OV_E2E_FD: "3",
    OV_E2E_TURN: String(turn),
  });

  const child = spawn(process.execPath, args, {
    cwd: join(runDir, "work"),
    env,
    stdio: ["pipe", "pipe", "pipe", segFd],
  });

  const events = [];
  const parse = createRpcLineParser();
  const waiters = [];
  let stderrTail = "";
  child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  child.stdout.on("data", (d) => {
    for (const msg of parse(d.toString("utf8"))) {
      events.push(msg);
      for (const w of [...waiters]) {
        if (w.pred(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    }
  });

  const deadline = Date.now() + ctx.manifest.thresholds.piRunWallMs;
  const waitFor = (pred, ms, label, fromIndex = 0) => {
    const hit = events.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolveP, reject) => {
      const remaining = Math.max(1, Math.min(ms, deadline - Date.now()));
      const timer = setTimeout(() => reject(new PiRunError(`timeout waiting for ${label}`)), remaining);
      waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolveP(m); } });
    });
  };
  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);

  const t0 = Date.now();
  try {
    send({ id: "gs", type: "get_state" });
    const gs = await waitFor((m) => m.type === "response" && m.id === "gs", 30000, "get_state");
    if (gs.success !== true) throw new PiRunError(`get_state rejected: ${JSON.stringify(gs).slice(0, 200)}`);
    if (gs.data?.sessionId && gs.data.sessionId !== ctx.sessionId) {
      throw new PiRunError(`session id drift: ${gs.data.sessionId} != ${ctx.sessionId}`);
    }

    let seq = 0;
    for (const action of actions) {
      const id = `a${++seq}`;
      const mark = events.length;
      if (action.prompt !== undefined) {
        send({ id, type: "prompt", message: action.prompt });
        const resp = await waitFor((m) => m.type === "response" && m.id === id, 30000, `prompt response ${id}`);
        if (resp.success !== true) throw new PiRunError(`prompt rejected: ${JSON.stringify(resp).slice(0, 200)}`);
        await waitFor((m) => m.type === "agent_settled", ctx.manifest.thresholds.agentSettledMs, "agent_settled", mark);
      } else if (action.command !== undefined) {
        send({ id, type: "prompt", message: action.command });
        const resp = await waitFor((m) => m.type === "response" && m.id === id, 30000, `command response ${id}`);
        if (resp.success !== true) throw new PiRunError(`command rejected: ${JSON.stringify(resp).slice(0, 200)}`);
        action.notifyEvent = await waitFor(
          (m) => m.type === "extension_ui_request" && m.method === "notify",
          ctx.manifest.thresholds.syncNotifyMs,
          "sync notify",
          mark,
        );
      }
    }

    child.stdin.end();
    const exitCode = await new Promise((resolveP, reject) => {
      const timer = setTimeout(() => reject(new PiRunError("timeout waiting for process exit")), Math.max(1, deadline - Date.now()));
      child.on("exit", (code) => { clearTimeout(timer); resolveP(code ?? -1); });
    });

    return {
      turn,
      ms: Date.now() - t0,
      exitCode,
      events,
      sessionFile: gs.data?.sessionFile || null,
      segmentPath,
      stderrTail,
      actions,
    };
  } finally {
    closeSync(segFd);
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

/** 单次运行的通用断言：退出码、retry、extension_error、RPC 可解析与 segment 结构。 */
export function assertRunHealthy(log, ctx, run, { requireCapture = true } = {}) {
  const w = ctx.workloadId;
  log.check(w, `run${run.turn}.exit`, 0, run.exitCode, run.exitCode === 0);
  const assistantStarts = run.events.filter((e) => e.type === "message_start" && e.message?.role === "assistant").length;
  const retries = run.events.filter((e) => typeof e.type === "string" && (e.type.startsWith("auto_retry") || e.type.startsWith("summarization_retry")));
  log.check(w, `run${run.turn}.no-retry`, 0, retries.length, retries.length === 0);
  const extErr = run.events.filter((e) => e.type === "extension_error");
  log.check(w, `run${run.turn}.extension-errors`, 0, extErr.length, extErr.length === 0,
    extErr.length ? JSON.stringify(extErr[0]).slice(0, 300) : undefined);
  const unparsed = run.events.filter((e) => e.type === "__unparsed");
  log.check(w, `run${run.turn}.rpc-parseable`, 0, unparsed.length, unparsed.length === 0);

  const segmentRaw = readFileSync(run.segmentPath);
  let records = [];
  let segmentParseable = true;
  try {
    records = segmentRaw.toString("utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    segmentParseable = false;
  }
  if (requireCapture) {
    log.check(w, `run${run.turn}.segment-parseable`, true, segmentParseable, segmentParseable);
    const sessionRecords = records.filter((r) => r.kind === "session");
    log.check(w, `run${run.turn}.segment-session`, ctx.sessionId, sessionRecords[0]?.sessionId,
      sessionRecords.length === 1 && sessionRecords[0]?.sessionId === ctx.sessionId);
    const payloads = records.filter((r) => r.kind === "providerPayload");
    const indexOk = payloads.every((p, i) => p.turn === run.turn && p.index === i + 1);
    log.check(w, `run${run.turn}.segment-sequence`, "turn/index 递增", indexOk, indexOk);
    log.check(w, `run${run.turn}.capture-count`, assistantStarts, payloads.length, payloads.length === assistantStarts,
      "providerCaptureRule: 捕获数必须等于 assistant message_start 数");
    run.captures = payloads.length;
  }

  run.assistantStarts = assistantStarts;
  run.segmentSha256 = `sha256:${sha256Hex(segmentRaw)}`;
  run.tokensTotal = run.events
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .reduce((sum, e) => sum + (Number(e.message?.usage?.totalTokens) || 0), 0);
}

export function summarizeRun(run) {
  return {
    turn: run.turn,
    ms: run.ms,
    exitCode: run.exitCode,
    assistantStarts: run.assistantStarts,
    captures: run.captures ?? null,
    tokensTotal: run.tokensTotal,
    segmentSha256: run.segmentSha256,
    segmentPath: run.segmentPath,
  };
}

export function devService(log, ctx, action) {
  const res = spawnSync(process.execPath, [join(LIVE_REPO, "scripts/dev.mjs"), action], {
    encoding: "utf8",
    timeout: ctx.manifest.thresholds.devUpMs + 60000,
  });
  log.check(ctx.workloadId, `dev-${action}`, 0, res.status, res.status === 0,
    (res.stderr || res.stdout || "").split("\n").filter(Boolean).slice(-3).join(" | "));
}

export async function mkdirChain(client, fromUri, toDirUri) {
  const base = fromUri.replace(/\/+$/, "");
  const rel = toDirUri.slice(base.length).split("/").filter(Boolean);
  let current = base;
  for (const segment of rel) {
    current = `${current}/${segment}`;
    const res = await client.mkdirUri(current);
    if (!res.ok) {
      const st = await client.statUri(current);
      if (!st.ok || !st.exists || !st.isDir) throw new Error(`mkdir failed: ${current} (${res.status})`);
    }
  }
}

export async function establishRemoteOwnership(log, ctx) {
  const w = ctx.workloadId;
  const rootStat = await ctx.client.statUri(ctx.userRoot);
  log.check(w, "namespace-absent-before", false, rootStat.ok ? rootStat.exists : `stat failed(${rootStat.status})`,
    rootStat.ok && !rootStat.exists, "随机 namespace 写入前必须不存在");
  const ovRoot = `${ctx.userRoot}/resources/.pi-openviking`;
  await mkdirChain(ctx.client, `${ctx.userRoot}/resources`, ovRoot);
  ctx.markerUri = `${ovRoot}/.live-owner.json`;
  ctx.markerBytes = Buffer.from(canonicalJsonBytes({
    schemaVersion: 1,
    type: "pi-openviking-live-owner",
    runId: ctx.runId,
    manifestSha256: ctx.manifestSha256,
    nonce: ctx.nonce,
    sessionId: ctx.sessionId,
  }));
  const write = await ctx.client.batchWrite({
    root_uri: ovRoot,
    operations: [{ uri: ctx.markerUri, content_base64: ctx.markerBytes.toString("base64"), precondition: { kind: "create_if_absent" } }],
    wait: false,
  });
  const created = write.ok && Array.isArray(write.result?.created) && write.result.created.includes(ctx.markerUri);
  log.check(w, "owner-marker-created", "created", write.ok ? JSON.stringify(write.result?.created?.length) : `HTTP ${write.status}`, created === true);
  const readback = await ctx.client.downloadBytes(ctx.markerUri);
  log.check(w, "owner-marker-readback", "byte-exact", readback.ok ? `${readback.bytes?.length}B` : `HTTP ${readback.status}`,
    readback.ok && Buffer.isBuffer(readback.bytes) && readback.bytes.equals(ctx.markerBytes));
}

export async function cleanupRemote(log, ctx, objectUris) {
  const w = ctx.workloadId;
  const cleanup = { markerVerified: false, deleted: [], residuals: [], objectUris };
  try {
    if (ctx.markerUri) {
      const readback = await ctx.client.downloadBytes(ctx.markerUri);
      cleanup.markerVerified = readback.ok && Buffer.isBuffer(readback.bytes) && readback.bytes.equals(ctx.markerBytes);
      log.check(w, "cleanup.marker-recheck", "byte-exact before delete",
        readback.ok ? `${readback.bytes?.length}B` : `HTTP ${readback.status}`, cleanup.markerVerified,
        "删除前复核 marker 必须与写入字节一致，否则拒绝删除");
    } else {
      cleanup.residuals.push("ownership never established; namespace left untouched");
    }
    if (cleanup.markerVerified) {
      // OpenViking 拒绝删除自身用户根（403）；删除动作使用服务级基础用户身份。
      for (const uri of [`${ctx.userRoot}/resources/.pi-openviking`, `${ctx.userRoot}/resources`, ctx.userRoot]) {
        let ok = false;
        let gone = false;
        // 语义刷新期间 DELETE 返回可重试的 path_busy 冲突；重试直到删除成功或超时。
        for (let attempt = 0; attempt < 20 && !gone; attempt++) {
          ok = await ctx.cleanupClient.delete(uri, true);
          const after = await ctx.cleanupClient.statUri(uri);
          gone = ok && after.ok && !after.exists;
          if (!gone) await new Promise((r) => setTimeout(r, 500));
        }
        if (gone) cleanup.deleted.push(uri);
        else cleanup.residuals.push(`${uri} (delete=${ok})`);
      }
    } else if (ctx.markerUri) {
      cleanup.residuals.push("marker recheck failed; remote namespace left untouched");
    }
  } catch (error) {
    cleanup.residuals.push(String(error?.message || error));
  }
  log.check(w, "cleanup.remote", "no residuals", cleanup.residuals.length, cleanup.residuals.length === 0,
    cleanup.residuals.join(" | "));
  return cleanup;
}

export async function preflight(log, ctx) {
  const g = "preflight";
  const pkg = JSON.parse(readFileSync(join(LIVE_REPO, "package.json"), "utf8"));
  log.check(g, "node-engines", pkg.engines?.node, process.version,
    isNodeVersionSupported(process.version, pkg.engines?.node));

  const piPkgPath = join(LIVE_REPO, "node_modules", ctx.manifest.identities.pi.package, "package.json");
  const piPkg = existsSync(piPkgPath) ? JSON.parse(readFileSync(piPkgPath, "utf8")) : null;
  log.check(g, "pi-version", ctx.manifest.identities.pi.version, piPkg?.version,
    piPkg?.version === ctx.manifest.identities.pi.version);
  ctx.piBin = join(LIVE_REPO, ctx.manifest.identities.pi.binPath);
  log.check(g, "pi-bin-exists", true, existsSync(ctx.piBin), existsSync(ctx.piBin));

  const profileBytes = readFileSync(join(LIVE_REPO, ctx.manifest.identities.modelProfile.path));
  log.check(g, "model-profile-hash", ctx.manifest.identities.modelProfile.sha256, sha256Hex(profileBytes),
    sha256Hex(profileBytes) === ctx.manifest.identities.modelProfile.sha256);
  ctx.profile = loadModelProfile(join(LIVE_REPO, ctx.manifest.identities.modelProfile.path));

  // dev 服务所有权：marker/state/pid/命令行四者一致 + /health 版本与 auth。
  let pid = null;
  try {
    pid = Number(readFileSync(DEV_PID_FILE, "utf8").trim());
  } catch { /* unreadable */ }
  const ownership = Number.isInteger(pid) && pid > 0 ? verifyRunFiles(DEV_RUN_DIR, { expectedPid: pid }) : { ok: false, reason: "server.pid 无效" };
  const cmdline = ownership.ok ? readProcessCommand(pid) : null;
  const identityOk = ownership.ok && isDevServerProcess(cmdline, join(DEV_RUN_DIR, "ov.conf"));
  log.check(g, "dev-service-ownership", "marker/state/pid/cmdline consistent",
    ownership.ok ? (identityOk ? "ok" : "cmdline mismatch") : ownership.reason, identityOk);
  const configCheck = ownership.ok
    ? verifyDevServerConfig(DEV_RUN_DIR, ownership.state, buildDevServerConfig(ctx.profile))
    : { ok: false, reason: ownership.reason };
  log.check(g, "dev-service-config", "state/ov.conf/model profile consistent",
    configCheck.ok ? "ok" : configCheck.reason, configCheck.ok);
  const health = await probeServerHealth(ctx.endpoint, { timeoutMs: 5000 });
  log.check(g, "openviking-health", `${ctx.manifest.identities.openviking.version}/${ctx.manifest.identities.openviking.authMode}`,
    health.ok ? `${health.data?.version}/${health.data?.auth_mode}` : `unreachable(${health.statusCode})`,
    health.ok && health.data?.version === ctx.manifest.identities.openviking.version
      && health.data?.auth_mode === ctx.manifest.identities.openviking.authMode);

  // 凭证桥接：只进子进程环境，不持久化、不回显。
  const bridge = spawnSync("npm", ["exec", "--", "pi", "auth", "print-api-key",
    "--provider", ctx.profile.taskVlm.provider, "--model", ctx.profile.taskVlm.model], { encoding: "utf8" });
  ctx.apiKey = bridge.status === 0 ? bridge.stdout.trim() : "";
  log.check(g, "credential-bridged", "non-empty single line", ctx.apiKey && !ctx.apiKey.includes("\n") ? "ok" : "failed",
    Boolean(ctx.apiKey) && !ctx.apiKey.includes("\n"));

  for (const rel of ctx.manifest.identities.extensionLoadOrder) {
    log.check(g, `extension-exists:${rel}`, true, existsSync(join(LIVE_REPO, rel)), existsSync(join(LIVE_REPO, rel)));
  }
}

/**
 * live gate 的统一运行骨架：manifest hash 校验 → 本地/远端 ownership → 逐 workload →
 * 持久删除核验 → summary 与本地清理。各阶段只提供 workload 运行器与对象 URI 收集。
 */
export async function runLiveGate({ gate, manifestPath, manifestHashPath, runners, collectObjectUris }) {
  const t0 = Date.now();
  const runId = `${gate}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const log = new AssertionLog();

  const manifestBytes = readFileSync(manifestPath);
  const manifestSha256 = sha256Hex(manifestBytes);
  if (!checkManifestHash(manifestBytes, readFileSync(manifestHashPath, "utf8"))) {
    process.stderr.write(`✗ manifest hash 不匹配 ${manifestHashPath}，拒绝运行（manifest 在实现前已固定）。\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));

  const runDir = join(LIVE_ROOT, runId);
  const nonce = randomBytes(16).toString("hex");
  const ctx = { runId, runDir, nonce, manifest, manifestSha256, endpoint: manifest.identities.openviking.endpoint };

  for (const d of ["home", "pi", "work", "sessions", "segments"]) mkdirSync(join(runDir, d), { recursive: true });
  const localMarker = join(runDir, "owner.marker");
  const markerText = `pi-openviking-live\n${runId}\n${manifestSha256}\n${nonce}\n`;
  try {
    const markerFd = openSync(localMarker, "wx", 0o600);
    writeFileSync(markerFd, markerText);
    closeSync(markerFd);
  } catch (error) {
    process.stderr.write(`✗ 无法以排他创建建立本地 ownership marker: ${error?.message || error}\n`);
    process.exit(1);
  }

  await preflight(log, ctx);
  if (!derivePassed(log.items)) {
    process.stderr.write("✗ preflight 身份核对未通过，拒绝进入 workloads。\n");
  } else {
    const ov = manifest.identities.openviking;
    const clientFor = (user) => new OVClient({
      endpoint: ctx.endpoint, apiKey: "", account: ov.account, user,
      peerId: `${gate}-live`, userAgent: `pi-openviking/${gate}-live`,
    });
    ctx.cleanupClientGlobal = clientFor(ov.user);
    for (const workload of manifest.workloads) {
      const runner = runners[workload.id];
      if (!runner) {
        log.check(workload.id, "runner-exists", true, false, false);
        continue;
      }
      const sessionId = randomUUID();
      const wctx = Object.assign(Object.create(ctx), {
        workloadId: workload.id,
        workload,
        sessionId,
        storageUser: `dev--pi-${sessionId}`,
        userRoot: `viking://user/dev--pi-${sessionId}`,
        runs: [],
      });
      // 每次（重启）运行前核对本地 marker 字节与权限。
      wctx.verifyLocalMarker = () => {
        let fd;
        try {
          fd = openSync(localMarker, "r");
          const stat = fstatSync(fd);
          return readFileSync(fd, "utf8") === markerText && (stat.mode & 0o077) === 0;
        } catch {
          return false;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      };
      wctx.client = clientFor(wctx.storageUser);
      wctx.cleanupClient = clientFor(ov.user);
      try {
        log.check(workload.id, "local-marker", "intact", wctx.verifyLocalMarker(), wctx.verifyLocalMarker());
        await establishRemoteOwnership(log, wctx);
        await runner(log, wctx);
      } catch (error) {
        log.fail(workload.id, "workload-exception", error);
      } finally {
        wctx.cleanup = await cleanupRemote(log, wctx, collectObjectUris(wctx));
        workload.summary = { sessionId, runs: wctx.runs };
        (ctx.deletedObjects ??= []).push({ workload: workload.id, userRoot: wctx.userRoot, objectUris: wctx.cleanup.objectUris });
      }
    }

    // 持久删除核验：OpenViking 0.4.15 会在删除后由目录语义管线物化空目录骨架（实测
    // 10–40s 窗口），已写对象不会复活。等最后一次删除越过该窗口后，逐 URI 断言全部
    // 已写对象仍为 404；骨架目录是否再现只作为观察记录，不构成失败。
    const settleMs = manifest.thresholds.cleanupSettleMs;
    if (ctx.deletedObjects?.length && Number.isFinite(settleMs) && settleMs > 0) {
      process.stderr.write(`  … 等待 ${Math.round(settleMs / 1000)}s 后做持久删除核验\n`);
      await new Promise((r) => setTimeout(r, settleMs));
      for (const entry of ctx.deletedObjects) {
        const resurrected = [];
        for (const uri of entry.objectUris) {
          const st = await ctx.cleanupClientGlobal.statUri(uri);
          if (!st.ok || st.exists) resurrected.push(uri);
        }
        log.check(entry.workload, "cleanup.durable", `${entry.objectUris.length} objects stay deleted`,
          resurrected.length, resurrected.length === 0, resurrected.slice(0, 3).join(" | "));
        const rootStat = await ctx.cleanupClientGlobal.statUri(entry.userRoot);
        entry.skeletonResurrected = rootStat.ok && rootStat.exists;
      }
    }
  }

  const passed = derivePassed(log.items);
  const summary = {
    schemaVersion: 1,
    gate: manifest.gate,
    phase: manifest.phase,
    runId,
    startedAt: new Date(t0).toISOString(),
    durationMs: Date.now() - t0,
    manifestSha256,
    identities: {
      pi: { package: manifest.identities.pi.package, version: manifest.identities.pi.version },
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      openviking: { endpoint: ctx.endpoint, version: manifest.identities.openviking.version, authMode: manifest.identities.openviking.authMode },
      modelProfile: { path: manifest.identities.modelProfile.path, sha256: manifest.identities.modelProfile.sha256 },
      extensionLoadOrder: manifest.identities.extensionLoadOrder,
    },
    assertions: log.items,
    workloads: manifest.workloads.map((w) => ({ id: w.id, sessionId: w.summary?.sessionId ?? null, runs: w.summary?.runs ?? [] })),
    cleanup: {
      remote: log.items.filter((a) => a.id.startsWith("cleanup.")).map((a) => ({ workload: a.workload, id: a.id, pass: a.pass })),
      skeletonResurrected: Object.fromEntries((ctx.deletedObjects ?? []).map((d) => [d.workload, d.skeletonResurrected ?? null])),
      local: null,
    },
    passed,
  };

  // 本地清理先于最终 summary 输出：删除前逐 segment 重算 hash 与记录值比对（payload
  // 写出后不可变）；passed 删除整个 run 目录；失败删除全部 segment（raw provider
  // payload）与会话 JSONL，保留白名单脱敏诊断。cleanup.local 因此反映事实。
  let localCleanupOk = true;
  try {
    for (const seg of manifest.workloads.flatMap((wl) => (wl.summary?.runs ?? []))) {
      if (!existsSync(seg.segmentPath)) continue;
      const actual = sha256Hex(readFileSync(seg.segmentPath));
      if (`sha256:${actual}` !== seg.segmentSha256) throw new Error(`segment payload mutated after capture: ${seg.segmentPath}`);
    }
    if (passed) {
      rmSync(runDir, { recursive: true, force: true });
      if (existsSync(runDir)) throw new Error("run directory still exists after deletion");
    } else {
      for (const f of readdirSync(join(runDir, "segments"))) rmSync(join(runDir, "segments", f), { force: true });
      if (existsSync(join(runDir, "sessions"))) rmSync(join(runDir, "sessions"), { recursive: true, force: true });
      const left = readdirSync(join(runDir, "segments"));
      if (left.length) throw new Error(`segments not fully deleted: ${left.join(",")}`);
      if (existsSync(join(runDir, "sessions"))) throw new Error("session JSONL not deleted");
    }
  } catch (error) {
    localCleanupOk = false;
    process.stderr.write(`✗ 本地清理失败: ${error?.message || error}\n`);
  }
  summary.cleanup.local = localCleanupOk ? (passed ? "run-dir removed" : "segments+sessions removed") : "failed";
  const finalPassed = passed && localCleanupOk;
  summary.passed = finalPassed;
  if (!passed) {
    try {
      writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      process.stderr.write(`✗ summary 写入失败: ${error?.message || error}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${finalPassed ? "✓" : "✗"} ${manifest.gate} ${finalPassed ? "PASSED" : "FAILED"} (${log.items.filter((a) => a.pass).length}/${log.items.length} assertions, ${Math.round((Date.now() - t0) / 1000)}s)\n`);
  process.exit(finalPassed ? 0 : 1);
}
