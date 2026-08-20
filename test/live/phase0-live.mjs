// verify:phase0:live — Phase 0 真实验收门禁。
//
// 在真实 Pi CLI（RPC 模式）、真实 SessionManager、受管 OpenViking 0.4.15 与开发模型
// 身份上执行 test/live/phase0.workloads.json 声明的四个 workload，机器断言
// Pi JSONL → RecordedEvent → direct/chunked 对象 → entry ACK 逐项对应，以及重放、
// 409、断线、shutdown 与清理成立。manifest 字节 hash 在实现前固定于
// test/live/phase0.workloads.sha256；不匹配即拒绝运行。
//
// 产物边界：本地数据只在 test/.artifacts/live/<runId>/（gitignored）；passed 时整体
// 删除，失败时删除 segment（raw provider payload）后保留白名单脱敏诊断。远端 namespace
// 经 ownership marker 双重核对后删除。凭证只在子进程环境中桥接，不落盘。
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { BATCH_MAX_FILE_BYTES } from "../../shared/content-objects.mjs";
import {
  EVENT_CHUNK_BYTES,
  recordedEventStorageLocation,
} from "../../shared/recorded-event-adapter.mjs";
import { probeServerHealth } from "../../shared/server-health.mjs";
import { isEntryAcknowledged, readSyncAck } from "../../shared/sync-ack.mjs";
import {
  LIVE_REPO as REPO,
  ackFileKey,
  assertRunHealthy,
  conflictBytesOf,
  devService,
  mkdirChain,
  runLiveGate,
  runPi,
  sha256Hex,
  summarizeRun,
} from "./live-support.mjs";

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

  // 服务停机期间失败也必须把服务交还给后续 workload 与清理，否则一次异常会让整轮
  // 剩余断言全部退化为“服务不可达”，掩盖真实原因。
  let runB;
  try {
    devService(log, ctx, "down");
    const downHealth = await probeServerHealth(ctx.endpoint);
    log.check(ctx.workloadId, "service-unreachable", false, downHealth.ok, !downHealth.ok);

    runB = await runPi(ctx, {
      workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
      actions: [{ prompt: inputs.P2 }],
    });
    assertRunHealthy(log, ctx, runB);
    const ackAfterB = existsSync(ackPathFor(ctx, ctx.endpoint))
      ? await readFile(ackPathFor(ctx, ctx.endpoint), "utf8")
      : null;
    log.check(ctx.workloadId, "ack-unchanged-while-down", "byte-identical", ackAfterB === ackSnapshot,
      ackSnapshot !== null && ackAfterB === ackSnapshot);
  } finally {
    devService(log, ctx, "up");
  }

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const WORKLOAD_RUNNERS = {
  "w1-chain-chunked-shutdown": w1,
  "w2-ack-loss-replay": w2,
  "w3-conflict-409": w3,
  "w4-disconnect-restart": w4,
};

const MANIFEST_PATH = join(REPO, "test/live/phase0.workloads.json");
const MANIFEST_HASH_PATH = join(REPO, "test/live/phase0.workloads.sha256");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "phase0",
    manifestPath: MANIFEST_PATH,
    manifestHashPath: MANIFEST_HASH_PATH,
    runners: WORKLOAD_RUNNERS,
    collectObjectUris: (wctx) => collectObjectUris(wctx, wctx.finalParsed),
  }).catch((error) => {
    process.stderr.write(`✗ verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
