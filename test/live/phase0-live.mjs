// verify:phase0:live — Phase 0 真实验收门禁。
//
// 在真实 Pi CLI（RPC 模式）、真实 SessionManager、受管 OpenViking 0.4.13 与开发模型
// 身份上执行 test/live/phase0.workloads.json 声明的四个 workload，机器断言
// Pi JSONL → RecordedEvent → direct/chunked 对象 → entry ACK 逐项对应，以及重放、
// 409、断线、shutdown 与清理成立。manifest 字节 hash 在实现前固定于
// test/live/phase0.workloads.sha256；不匹配即拒绝运行。
//
// 产物边界：本地数据只在 test/.artifacts/live/<runId>/（gitignored）；passed 时整体
// 删除，失败时删除 segment（raw provider payload）后保留白名单脱敏诊断。远端 namespace
// 经 ownership marker 双重核对后删除。凭证只在子进程环境中桥接，不落盘。
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
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

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
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import {
  BATCH_MAX_FILE_BYTES,
  EVENT_CHUNK_BYTES,
  recordedEventStorageLocation,
} from "../../shared/recorded-event-adapter.mjs";
import { probeServerHealth } from "../../shared/server-health.mjs";
import { isEntryAcknowledged, readSyncAck } from "../../shared/sync-ack.mjs";
import {
  AssertionLog,
  ackFileKey,
  checkManifestHash,
  conflictBytesOf,
  createRpcLineParser,
  derivePassed,
  sha256Hex,
} from "./live-support.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const MANIFEST_PATH = join(REPO, "test/live/phase0.workloads.json");
const MANIFEST_HASH_PATH = join(REPO, "test/live/phase0.workloads.sha256");
const LIVE_ROOT = join(REPO, "test/.artifacts/live");
const DEV_RUN_DIR = join(REPO, ".dev/runs/openviking");
const DEV_PID_FILE = join(DEV_RUN_DIR, "server.pid");
const DEAD_ENDPOINT = "http://127.0.0.1:9";

// ---------------------------------------------------------------------------
// Pure helpers (deterministic-test surface)
// ---------------------------------------------------------------------------

/** 确定性伪随机字符串：对 seed 的 SHA-256 迭代链取 base64url 拼接截断。 */
export function seededString(seed, n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError("seededString length must be a non-negative integer");
  let h = createHash("sha256").update(String(seed)).digest();
  const parts = [];
  let len = 0;
  while (len < n) {
    h = createHash("sha256").update(h).digest();
    const s = h.toString("base64url");
    parts.push(s);
    len += s.length;
  }
  return parts.join("").slice(0, n);
}


// ---------------------------------------------------------------------------
// Pi RPC driver
// ---------------------------------------------------------------------------

class PiRunError extends Error {}

/**
 * 一次真实 Pi 进程运行。actions: { prompt } 等待 agent_settled；{ command }（如
 * /viking sync）等待其后的 notify。返回事件流、segment 路径与退出码。
 */
async function runPi(ctx, { workloadId, turn, endpoint, actions }) {
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
    "-e", join(REPO, "index.ts"),
    "-e", join(REPO, "scripts/e2e-probe.ts"),
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

/** 单次运行的通用断言：退出码、捕获计数规则、retry、extension_error、segment 结构。 */
function assertRunHealthy(log, ctx, run) {
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
  log.check(w, `run${run.turn}.segment-parseable`, true, segmentParseable, segmentParseable);
  const sessionRecords = records.filter((r) => r.kind === "session");
  log.check(w, `run${run.turn}.segment-session`, ctx.sessionId, sessionRecords[0]?.sessionId,
    sessionRecords.length === 1 && sessionRecords[0]?.sessionId === ctx.sessionId);
  const payloads = records.filter((r) => r.kind === "providerPayload");
  const indexOk = payloads.every((p, i) => p.turn === run.turn && p.index === i + 1);
  log.check(w, `run${run.turn}.segment-sequence`, "turn/index 递增", indexOk, indexOk);
  log.check(w, `run${run.turn}.capture-count`, assistantStarts, payloads.length, payloads.length === assistantStarts,
    "providerCaptureRule: 捕获数必须等于 assistant message_start 数");

  run.assistantStarts = assistantStarts;
  run.captures = payloads.length;
  run.segmentSha256 = `sha256:${sha256Hex(segmentRaw)}`;
  run.tokensTotal = run.events
    .filter((e) => e.type === "message_end" && e.message?.role === "assistant")
    .reduce((sum, e) => sum + (Number(e.message?.usage?.totalTokens) || 0), 0);
}

// ---------------------------------------------------------------------------
// Source / ACK / remote verification
// ---------------------------------------------------------------------------

async function readSession(ctx, sessionFile) {
  const text = await readFile(sessionFile, "utf8");
  return parsePiSessionJsonl(text, { sessionId: ctx.sessionId });
}

function ackPathFor(ctx, endpoint) {
  const ov = ctx.manifest.identities.openviking;
  const key = ackFileKey(endpoint, ov.account, ctx.storageUser, ctx.sessionId);
  return join(ctx.runDir, "home", ".pi", "openviking", "sync-ack", `${key}.json`);
}

async function assertAckCovers(log, ctx, endpoint, parsed, label) {
  const path = ackPathFor(ctx, endpoint);
  if (!existsSync(path)) {
    return log.check(ctx.workloadId, `ack-covers-tree.${label}`, "ACK file exists", "missing", false, path);
  }
  const raw = await readFile(path, "utf8");
  let ack;
  try {
    ack = await readSyncAck(path);
  } catch (error) {
    return log.check(ctx.workloadId, `ack-covers-tree.${label}`, "ACK parseable", String(error?.message || error), false);
  }
  const uncovered = parsed.entries.filter((entry) => !isEntryAcknowledged(ack, entry.id, parsed.parentById)).map((e) => e.id);
  const pass = log.check(ctx.workloadId, `ack-covers-tree.${label}`, 0, uncovered.length, uncovered.length === 0,
    uncovered.length ? `未覆盖: ${uncovered.join(",")}` : undefined);
  return pass ? { ack, raw, path } : null;
}

/** 逐事件远端字节核验：direct 比对规范字节且 claim 缺席；chunked 校验 claim/chunks/commit 与重组字节。 */
async function verifyRemoteEvents(log, ctx, parsed, { expectChunked = false } = {}) {
  const w = ctx.workloadId;
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  let direct = 0;
  let chunked = 0;
  const failures = [];
  for (const event of events) {
    const bytes = recordedEventBytes(event);
    const loc = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, event.eventId);
    if (bytes.length <= BATCH_MAX_FILE_BYTES) {
      const dl = await ctx.client.downloadBytes(loc.directUri);
      if (!dl.ok || !dl.bytes || !dl.bytes.equals(bytes)) {
        failures.push(`${event.eventId}: direct ${dl.ok ? "bytes-mismatch" : `download-failed(${dl.status})`}`);
        continue;
      }
      const claim = await ctx.client.statUri(loc.claimUri);
      if (!claim.ok || claim.exists) {
        failures.push(`${event.eventId}: direct representation coexists with claim`);
        continue;
      }
      direct++;
    } else {
      const [claimDl, commitDl, directStat] = await Promise.all([
        ctx.client.downloadBytes(loc.claimUri),
        ctx.client.downloadBytes(loc.commitUri),
        ctx.client.statUri(loc.directUri),
      ]);
      if (!claimDl.ok || !commitDl.ok) {
        failures.push(`${event.eventId}: chunked markers missing (claim=${claimDl.status}, commit=${commitDl.status})`);
        continue;
      }
      if (!directStat.ok || directStat.exists) {
        failures.push(`${event.eventId}: chunked representation coexists with direct`);
        continue;
      }
      let claim;
      try {
        claim = JSON.parse(claimDl.bytes.toString("utf8"));
      } catch {
        failures.push(`${event.eventId}: claim unparseable`);
        continue;
      }
      const chunkParts = [];
      let chunkOk = true;
      for (const c of claim.chunks ?? []) {
        const cd = await ctx.client.downloadBytes(c.uri);
        if (!cd.ok || !cd.bytes || cd.bytes.length !== c.byteLength || `sha256:${sha256Hex(cd.bytes)}` !== c.contentHash) {
          chunkOk = false;
          break;
        }
        chunkParts.push(cd.bytes);
      }
      const recombined = Buffer.concat(chunkParts);
      const structureOk = claim.schemaVersion === 1 && claim.type === "recorded-event-claim"
        && claim.eventId === event.eventId && claim.byteLength === bytes.length
        && `sha256:${sha256Hex(bytes)}` === claim.eventHash
        && Array.isArray(claim.chunks) && claim.chunks.every((c, i) => c.index === i);
      let commitOk = false;
      try {
        const commit = JSON.parse(commitDl.bytes.toString("utf8"));
        commitOk = commit.schemaVersion === 1 && commit.type === "recorded-event-commit"
          && commit.eventId === event.eventId && commit.claimHash === `sha256:${sha256Hex(claimDl.bytes)}`;
      } catch { /* commit unparseable */ }
      if (!chunkOk || !structureOk || !commitOk || !recombined.equals(bytes)) {
        failures.push(`${event.eventId}: chunked integrity failed (chunkOk=${chunkOk} structure=${structureOk} commit=${commitOk} bytes=${recombined.equals(bytes)})`);
        continue;
      }
      chunked++;
    }
  }
  const pass = failures.length === 0;
  log.check(w, "remote-byte-correspondence", `${events.length} events byte-exact`,
    `${events.length - failures.length} ok (direct=${direct} chunked=${chunked})`, pass,
    failures.slice(0, 5).join(" | "));
  if (expectChunked) log.check(w, "remote-chunked-covered", ">=1 chunked event", chunked, chunked >= 1);
  return { total: events.length, direct, chunked, pass, events };
}

// ---------------------------------------------------------------------------
// Remote ownership + cleanup
// ---------------------------------------------------------------------------

async function mkdirChain(client, fromUri, toDirUri) {
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

async function establishRemoteOwnership(log, ctx) {
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

/** 该 workload 写入远端的全部对象 URI（marker、事件、冲突注入），供持久删除核验。 */
function collectObjectUris(ctx, parsed) {
  const uris = [];
  if (ctx.markerUri) uris.push(ctx.markerUri);
  if (ctx.extraUris) uris.push(...ctx.extraUris);
  if (parsed) {
    for (const event of projectPiEntries(ctx.sessionId, parsed.entries)) {
      const bytes = recordedEventBytes(event);
      const loc = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, event.eventId);
      if (bytes.length <= BATCH_MAX_FILE_BYTES) {
        uris.push(loc.directUri);
      } else {
        uris.push(loc.claimUri, loc.commitUri);
        const chunks = Math.ceil(bytes.length / EVENT_CHUNK_BYTES);
        for (let i = 0; i < chunks; i++) uris.push(loc.chunkUri(i));
      }
    }
  }
  return uris;
}

async function cleanupRemote(log, ctx, parsed) {
  const w = ctx.workloadId;
  const cleanup = { markerVerified: false, deleted: [], residuals: [], objectUris: collectObjectUris(ctx, parsed) };
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
        const ok = await ctx.cleanupClient.delete(uri, true);
        // 服务端删除可能存在异步一致窗口：轮询 stat 直至消失（上限 10s）。
        let gone = false;
        for (let i = 0; i < 20 && !gone; i++) {
          const after = await ctx.cleanupClient.statUri(uri);
          gone = after.ok && !after.exists;
          if (!gone) await new Promise((r) => setTimeout(r, 500));
        }
        gone = gone && ok;
        if (gone) cleanup.deleted.push(uri);
        else cleanup.residuals.push(`${uri} (delete=${ok} exists=${after.exists})`);
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

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

async function w1(log, ctx) {
  const inputs = ctx.workload.inputs;
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA);
  const parsedA = await readSession(ctx, runA.sessionFile);
  await assertAckCovers(log, ctx, ctx.endpoint, parsedA, "runA-exit");

  // 轮间由真实 SessionManager 注入大 custom entry（只在已含 assistant 消息的会话上持久化）。
  const sm = SessionManager.open(runA.sessionFile);
  sm.appendCustomEntry("ov-live-blob", { blob: seededString(inputs.blobSeed, inputs.blobChars) });
  await new Promise((r) => setTimeout(r, 300));

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runB);
  const notify = runB.actions[1].notifyEvent;
  log.check(ctx.workloadId, "sync-notify-info", "info", notify?.notifyType, notify?.notifyType === "info", notify?.message);

  const parsedB = await readSession(ctx, runB.sessionFile);
  log.check(ctx.workloadId, "blob-entry-present", true,
    parsedB.entries.some((e) => e.type === "custom" && e.customType === "ov-live-blob"),
    parsedB.entries.some((e) => e.type === "custom" && e.customType === "ov-live-blob"));
  await assertAckCovers(log, ctx, ctx.endpoint, parsedB, "runB-exit");
  await verifyRemoteEvents(log, ctx, parsedB, { expectChunked: true });
  ctx.finalParsed = parsedB;
  ctx.runs.push(summarizeRun(runA), summarizeRun(runB));
}

async function w2(log, ctx) {
  const inputs = ctx.workload.inputs;
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA);
  const parsedA = await readSession(ctx, runA.sessionFile);
  await assertAckCovers(log, ctx, ctx.endpoint, parsedA, "runA-exit");
  const verifiedA = await verifyRemoteEvents(log, ctx, parsedA);

  // ACK 丢失：删除 ACK 文件后由 run B 幂等重放。
  const ackPath = ackPathFor(ctx, ctx.endpoint);
  await rm(ackPath, { force: true });
  log.check(ctx.workloadId, "ack-file-removed", false, existsSync(ackPath), !existsSync(ackPath));

  // run B 不以显式 /viking sync 收尾：最后一条 turn 的 entry 只能由 turn_end 调度的
  // fire-and-forget 同步与 shutdown grace 兜底确认，使 ack-covers-tree.runB-exit 可证伪。
  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }],
  });
  assertRunHealthy(log, ctx, runB);
  const parsedB = await readSession(ctx, runB.sessionFile);
  await assertAckCovers(log, ctx, ctx.endpoint, parsedB, "runB-exit");

  // run A 事件在重放后仍逐字节一致（服务端 unchanged，不覆盖已接受对象）。
  let replayOk = 0;
  const replayFailures = [];
  for (const event of verifiedA.events) {
    const bytes = recordedEventBytes(event);
    const loc = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, event.eventId);
    const uri = bytes.length <= BATCH_MAX_FILE_BYTES ? loc.directUri : loc.commitUri;
    const dl = await ctx.client.downloadBytes(uri);
    if (bytes.length <= BATCH_MAX_FILE_BYTES) {
      if (dl.ok && dl.bytes?.equals(bytes)) replayOk++;
      else replayFailures.push(event.eventId);
    } else if (dl.ok) replayOk++;
    else replayFailures.push(event.eventId);
  }
  log.check(ctx.workloadId, "replay-idempotent", `${verifiedA.events.length} events intact`,
    `${replayOk} intact`, replayFailures.length === 0, replayFailures.slice(0, 5).join(","));
  await verifyRemoteEvents(log, ctx, parsedB);
  ctx.finalParsed = parsedB;
  ctx.runs.push(summarizeRun(runA), summarizeRun(runB));
}

async function w3(log, ctx) {
  const inputs = ctx.workload.inputs;
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: DEAD_ENDPOINT,
    actions: [{ prompt: inputs.P1 }],
  });
  assertRunHealthy(log, ctx, runA);
  // ACK 目录在同一 run 内被其他 workload 共享，只能按本 session 的 target key 判定缺席。
  const deadAck = ackPathFor(ctx, DEAD_ENDPOINT);
  const realAck = ackPathFor(ctx, ctx.endpoint);
  log.check(ctx.workloadId, "runA-no-ack-progress", "no ACK for this session",
    `${existsSync(deadAck)}/${existsSync(realAck)}`, !existsSync(deadAck) && !existsSync(realAck));

  // 直接向首个待同步 entry 的首个事件 URI 写入冲突字节（create_if_absent → created）。
  const parsedA = await readSession(ctx, runA.sessionFile);
  const firstEntry = parsedA.entries[0];
  const targetEvent = projectPiEntries(ctx.sessionId, [firstEntry])[0];
  const targetBytes = recordedEventBytes(targetEvent);
  const loc = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, targetEvent.eventId);
  const conflict = conflictBytesOf(targetBytes);
  await mkdirChain(ctx.client, `${ctx.userRoot}/resources`, loc.shardRoot);
  const write = await ctx.client.batchWrite({
    root_uri: loc.sessionRoot,
    operations: [{ uri: loc.directUri, content_base64: conflict.toString("base64"), precondition: { kind: "create_if_absent" } }],
    wait: false,
  });
  const conflictCreated = write.ok && write.result?.created?.includes(loc.directUri);
  log.check(ctx.workloadId, "conflict-injected", "created", write.ok ? "created" : `HTTP ${write.status}`, conflictCreated === true);
  ctx.extraUris = [loc.directUri];

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runB);
  const notify = runB.actions[0].notifyEvent;
  log.check(ctx.workloadId, "sync-notify-warning", "warning", notify?.notifyType, notify?.notifyType === "warning", notify?.message);

  // 409 必须停止 ACK 推进：ACK 不存在或 frontier 为空。
  const ackPath = ackPathFor(ctx, ctx.endpoint);
  let frontierEmpty = true;
  let ackActual = "absent";
  if (existsSync(ackPath)) {
    const ack = await readSyncAck(ackPath);
    frontierEmpty = ack.acknowledgedLeaves.length === 0;
    ackActual = JSON.stringify(ack.acknowledgedLeaves);
  }
  log.check(ctx.workloadId, "ack-blocked-by-409", "absent or empty frontier", ackActual, frontierEmpty);

  // 冲突对象字节未被覆盖。
  const after = await ctx.client.downloadBytes(loc.directUri);
  log.check(ctx.workloadId, "conflict-not-overwritten", "conflict bytes intact",
    after.ok ? `${after.bytes?.length}B` : `HTTP ${after.status}`,
    after.ok && Buffer.isBuffer(after.bytes) && after.bytes.equals(conflict));
  ctx.finalParsed = parsedA;
  ctx.runs.push(summarizeRun(runA), summarizeRun(runB));
}

async function w4(log, ctx) {
  const inputs = ctx.workload.inputs;
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA);
  const parsedA = await readSession(ctx, runA.sessionFile);
  const ackA = await assertAckCovers(log, ctx, ctx.endpoint, parsedA, "runA-exit");
  const ackSnapshot = ackA?.raw ?? null;

  devService(log, ctx, "down");
  const downHealth = await probeServerHealth(ctx.endpoint);
  log.check(ctx.workloadId, "service-unreachable", false, downHealth.ok, !downHealth.ok);

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }],
  });
  assertRunHealthy(log, ctx, runB);
  const ackAfterB = existsSync(ackPathFor(ctx, ctx.endpoint))
    ? await readFile(ackPathFor(ctx, ctx.endpoint), "utf8")
    : null;
  log.check(ctx.workloadId, "ack-unchanged-while-down", "byte-identical", ackAfterB === ackSnapshot,
    ackSnapshot !== null && ackAfterB === ackSnapshot);

  devService(log, ctx, "up");

  const runC = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runC);
  const notify = runC.actions[0].notifyEvent;
  log.check(ctx.workloadId, "sync-notify-info", "info", notify?.notifyType, notify?.notifyType === "info", notify?.message);

  const parsedC = await readSession(ctx, runC.sessionFile);
  await assertAckCovers(log, ctx, ctx.endpoint, parsedC, "runC-exit");
  await verifyRemoteEvents(log, ctx, parsedC);
  ctx.finalParsed = parsedC;
  ctx.runs.push(summarizeRun(runA), summarizeRun(runB), summarizeRun(runC));
}

function devService(log, ctx, action) {
  const res = spawnSync(process.execPath, [join(REPO, "scripts/dev.mjs"), action], {
    encoding: "utf8",
    timeout: ctx.manifest.thresholds.devUpMs + 60000,
  });
  log.check(ctx.workloadId, `dev-${action}`, 0, res.status, res.status === 0,
    (res.stderr || res.stdout || "").split("\n").filter(Boolean).slice(-3).join(" | "));
}

function summarizeRun(run) {
  return {
    turn: run.turn,
    ms: run.ms,
    exitCode: run.exitCode,
    assistantStarts: run.assistantStarts,
    captures: run.captures,
    tokensTotal: run.tokensTotal,
    segmentSha256: run.segmentSha256,
    segmentPath: run.segmentPath,
  };
}

// ---------------------------------------------------------------------------
// Preflight identity checks
// ---------------------------------------------------------------------------

async function preflight(log, ctx) {
  const g = "preflight";
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  log.check(g, "node-engines", pkg.engines?.node, process.version,
    isNodeVersionSupported(process.version, pkg.engines?.node));

  const piPkgPath = join(REPO, "node_modules", ctx.manifest.identities.pi.package, "package.json");
  const piPkg = existsSync(piPkgPath) ? JSON.parse(readFileSync(piPkgPath, "utf8")) : null;
  log.check(g, "pi-version", ctx.manifest.identities.pi.version, piPkg?.version,
    piPkg?.version === ctx.manifest.identities.pi.version);
  ctx.piBin = join(REPO, ctx.manifest.identities.pi.binPath);
  log.check(g, "pi-bin-exists", true, existsSync(ctx.piBin), existsSync(ctx.piBin));

  const profileBytes = readFileSync(join(REPO, ctx.manifest.identities.modelProfile.path));
  log.check(g, "model-profile-hash", ctx.manifest.identities.modelProfile.sha256, sha256Hex(profileBytes),
    sha256Hex(profileBytes) === ctx.manifest.identities.modelProfile.sha256);
  ctx.profile = loadModelProfile(join(REPO, ctx.manifest.identities.modelProfile.path));

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
    log.check(g, `extension-exists:${rel}`, true, existsSync(join(REPO, rel)), existsSync(join(REPO, rel)));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const WORKLOAD_RUNNERS = {
  "w1-chain-chunked-shutdown": w1,
  "w2-ack-loss-replay": w2,
  "w3-conflict-409": w3,
  "w4-disconnect-restart": w4,
};

async function main() {
  const t0 = Date.now();
  const runId = `phase0-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const log = new AssertionLog();

  const manifestBytes = readFileSync(MANIFEST_PATH);
  const hashText = readFileSync(MANIFEST_HASH_PATH, "utf8");
  const manifestSha256 = sha256Hex(manifestBytes);
  if (!checkManifestHash(manifestBytes, hashText)) {
    process.stderr.write(`✗ manifest hash 不匹配 ${MANIFEST_HASH_PATH}，拒绝运行（manifest 在实现前已固定）。\n`);
    process.exit(1);
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));

  const runDir = join(LIVE_ROOT, runId);
  const nonce = randomBytes(16).toString("hex");
  const ctx = {
    runId,
    runDir,
    nonce,
    manifest,
    manifestSha256,
    endpoint: manifest.identities.openviking.endpoint,
  };

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
    ctx.cleanupClientGlobal = new OVClient({
      endpoint: ctx.endpoint, apiKey: "", account: manifest.identities.openviking.account, user: manifest.identities.openviking.user,
      peerId: "phase0-live", userAgent: "pi-openviking/phase0-live",
    });
    for (const workload of manifest.workloads) {
      const runner = WORKLOAD_RUNNERS[workload.id];
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
      wctx.client = new OVClient({
        endpoint: ctx.endpoint, apiKey: "", account: manifest.identities.openviking.account, user: wctx.storageUser,
        peerId: "phase0-live", userAgent: "pi-openviking/phase0-live",
      });
      wctx.cleanupClient = new OVClient({
        endpoint: ctx.endpoint, apiKey: "", account: manifest.identities.openviking.account, user: manifest.identities.openviking.user,
        peerId: "phase0-live", userAgent: "pi-openviking/phase0-live",
      });
      try {
        log.check(workload.id, "local-marker", "intact", wctx.verifyLocalMarker(), wctx.verifyLocalMarker());
        await establishRemoteOwnership(log, wctx);
        await runner(log, wctx);
      } catch (error) {
        log.fail(workload.id, "workload-exception", error);
      } finally {
        wctx.cleanup = await cleanupRemote(log, wctx, wctx.finalParsed);
        workload.summary = { sessionId, runs: wctx.runs };
        (ctx.deletedObjects ??= []).push({ workload: workload.id, userRoot: wctx.userRoot, objectUris: wctx.cleanup.objectUris });
      }
    }

    // 持久删除核验：OpenViking 0.4.13 会在删除后由目录语义管线物化空目录骨架（实测
    // 10–40s 窗口），事件文件与 marker 不会复活。等最后一次删除越过该窗口后，逐 URI
    // 断言全部已写对象仍为 404；骨架目录是否再现只作为观察记录，不构成失败。
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

  const summaryPath = join(runDir, "summary.json");

  // 本地清理先于最终 summary 输出：删除前逐 segment 重算 hash 与记录值比对（payload
  // 写出后不可变）；passed 删除整个 run 目录；失败删除全部 segment（raw provider
  // payload）与会话 JSONL，保留白名单脱敏诊断。cleanup.local 因此反映事实。
  let localCleanupOk = true;
  try {
    for (const seg of manifest.workloads.flatMap((wl) => (wl.summary?.runs ?? []))) {
      if (!existsSync(seg.segmentPath)) continue;
      const actual = createHash("sha256").update(readFileSync(seg.segmentPath)).digest("hex");
      if (`sha256:${actual}` !== seg.segmentSha256) throw new Error(`segment payload mutated after capture: ${seg.segmentPath}`);
    }
    if (passed) {
      rmSync(runDir, { recursive: true, force: true });
      if (existsSync(runDir)) throw new Error("run directory still exists after deletion");
    } else {
      for (const f of readdirSync(join(runDir, "segments"))) {
        rmSync(join(runDir, "segments", f), { force: true });
      }
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
      writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      process.stderr.write(`✗ summary 写入失败: ${error?.message || error}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.stderr.write(`${finalPassed ? "✓" : "✗"} verify:phase0:live ${finalPassed ? "PASSED" : "FAILED"} (${log.items.filter((a) => a.pass).length}/${log.items.length} assertions, ${Math.round((Date.now() - t0) / 1000)}s)\n`);
  process.exit(finalPassed ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`✗ verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
