// verify:phase1:live — Phase 1 真实验收门禁。
//
// 在真实 Pi lifecycle 与受管 OpenViking 0.4.15 上执行 test/live/phase1.workloads.json
// 声明的四个 workload，机器断言 Archive 的原子可见、幂等恢复、确定 expand、event/step
// 边界原子，以及完整性冲突不覆盖既有对象且 Pi 主任务 fail-open。manifest 字节 hash
// 固定于 test/live/phase1.workloads.sha256；不匹配即拒绝运行。
//
// 产物与凭证边界同 Phase 0，由 live-support 的统一骨架承担。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  archiveContentHash,
  archiveManifestBytes,
  buildArchiveManifest,
  eventTokenWeight,
  parseArchiveManifest,
  planArchives,
} from "../../shared/archive.mjs";
import { archiveSessionRoot, archiveStorageLocation } from "../../shared/archive-store.mjs";
import { openVikingApiPath } from "../../shared/openviking-api.mjs";
import { parsePiSessionJsonl } from "../../shared/pi-session-source.mjs";
import { projectPiEntries, recordedEventBytes } from "../../shared/recorded-event.mjs";
import { BATCH_MAX_FILE_BYTES } from "../../shared/content-objects.mjs";
import { recordedEventStorageLocation } from "../../shared/recorded-event-adapter.mjs";
import { probeServerHealth } from "../../shared/server-health.mjs";
import { isEntryAcknowledged, readSyncAck } from "../../shared/sync-ack.mjs";
import {
  LIVE_REPO as REPO,
  ackFileKey,
  assertRunHealthy,
  devService,
  runLiveGate,
  runPi,
  sha256Hex,
  summarizeRun,
} from "./live-support.mjs";

// ---------------------------------------------------------------------------
// Session setup and source correspondence
// ---------------------------------------------------------------------------

/** 归档预算是用户策略：把本次 gate 使用的值写进 run 私有 HOME，不触碰用户环境。 */
function writeExtensionConfig(ctx) {
  const path = join(ctx.runDir, "home", ".pi", "pi-openviking.jsonc");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ctx.manifest.environment.extensionConfig.content, null, 2)}\n`, { mode: 0o600 });
}

const archiveBudgets = (ctx) => ctx.manifest.environment.extensionConfig.content.archive;

/**
 * 通过真实 SessionManager 向持久 JSONL 追加确定性 entry，为归档提供真实压力。
 *
 * 归档压力来自事件自身的上下文重量，而开发模型身份的 provider 不报告 token 计量，
 * 单靠“回复 OK”的真实轮次无法越过任何预算；注入走的是 Pi 自己的持久化路径，
 * 因此 Archive 仍然只消费真实存在的事件。
 */
async function seedPressure(ctx, sessionFile) {
  const { pressureEntries, blobChars, toolResults } = ctx.manifest.pressureSource;
  const manager = SessionManager.open(sessionFile);
  const filler = (seed, length) => {
    let text = "";
    let digest = createHash("sha256").update(`${ctx.sessionId}/${seed}`).digest("base64url");
    while (text.length < length) {
      text += digest;
      digest = createHash("sha256").update(digest).digest("base64url");
    }
    return text.slice(0, length);
  };

  // 先追加一个真实的多事件 step：assistant 的 toolCall 与其后的 toolResult 共享同一
  // stepId，使“边界不拆 step”成为可证伪断言，而不是恒真的空断言。
  const callId = `ov-live-call-${ctx.sessionId.slice(0, 8)}`;
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: filler("step-text", blobChars) },
      { type: "toolCall", id: callId, name: "ov_live_probe", arguments: { seeded: true } },
    ],
  });
  for (let index = 0; index < toolResults; index++) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: callId,
      toolName: "ov_live_probe",
      content: [{ type: "text", text: filler(`step-result-${index}`, blobChars) }],
    });
  }
  for (let index = 0; index < pressureEntries; index++) {
    manager.appendCustomEntry("ov-live-blob", { index, blob: filler(index, blobChars) });
  }
}
const sessionArchiveRoot = (ctx) => archiveSessionRoot(ctx.userRoot, ctx.sessionId);

async function branchEvents(ctx, sessionFile) {
  const parsed = parsePiSessionJsonl(await readFile(sessionFile, "utf8"), { sessionId: ctx.sessionId });
  const events = projectPiEntries(ctx.sessionId, parsed.entries);
  const onBranch = new Set(parsed.branch.map((entry) => entry.id));
  return { parsed, branch: events.filter((event) => onBranch.has(event.source.entryId)) };
}

/**
 * 从 Pi JSONL 独立重算本会话应当存在的 Archive。
 *
 * 事件对象使用隐藏文件名，普通 `ls` 不返回它们（这是 Archive 不进入语义索引的前提），
 * 因此发现方式只能是从来源重算身份再逐 URI 核对——这也正是 Archive 身份确定性的含义。
 */
function expectedArchives(ctx, branch) {
  return planArchives(branch, archiveBudgets(ctx)).map((plan) => {
    const range = branch.slice(plan.startIndex, plan.endIndex + 1);
    const manifest = buildArchiveManifest(ctx.sessionId, range);
    return { ...plan, manifest, bytes: archiveManifestBytes(manifest) };
  });
}

/** 本会话 Archive 命名空间下的可见对象；隐藏 manifest 不得出现在普通 ls 中。 */
async function visibleArchiveObjects(ctx) {
  const visible = [];
  for (const shard of await ctx.client.ls(sessionArchiveRoot(ctx))) {
    if (!shard.isDir) { visible.push(shard.uri); continue; }
    for (const file of await ctx.client.ls(shard.uri)) if (!file.isDir) visible.push(file.uri);
  }
  return visible;
}

async function archiveSnapshot(ctx, branch) {
  const expected = expectedArchives(ctx, branch);
  const archives = new Map();
  for (const item of expected) {
    const download = await ctx.client.downloadBytes(
      archiveStorageLocation(ctx.userRoot, ctx.sessionId, item.manifest.archiveId).manifestUri,
    );
    if (download.ok && Buffer.isBuffer(download.bytes)) archives.set(item.manifest.archiveId, download.bytes);
  }
  return { expected, archives };
}

/**
 * 逐 Archive 核验：manifest 自证 → 按 parentId 链 expand → 与源事件逐字节比对 →
 * 聚合 hash 复算 → step 边界原子 → 范围在分支上连续互不重叠。
 */
async function verifyArchives(log, ctx, archiveIds, branch, label) {
  const w = ctx.workloadId;
  // expand 独立于被验实现：直接按 event ID 推导 URI 下载 direct 对象。该路径只对
  // 8 MiB 以内的事件成立，因此把这个前提变成显式断言，而不是沉默假设。
  const chunked = branch.filter((event) => recordedEventBytes(event).length > BATCH_MAX_FILE_BYTES).length;
  log.check(w, `${label}.branch-events-are-direct`, 0, chunked, chunked === 0,
    "本 gate 的独立 expand 只读 direct 表示；出现 chunked 事件时该路径不再适用");
  const indexOf = new Map(branch.map((event, index) => [event.eventId, index]));
  const failures = [];
  const ranges = [];

  for (const archiveId of archiveIds) {
    const location = archiveStorageLocation(ctx.userRoot, ctx.sessionId, archiveId);
    const download = await ctx.client.downloadBytes(location.manifestUri);
    if (!download.ok || !Buffer.isBuffer(download.bytes)) {
      failures.push(`${archiveId}: manifest download failed(${download.status})`);
      continue;
    }
    let manifest;
    try {
      manifest = parseArchiveManifest(download.bytes);
    } catch (error) {
      failures.push(`${archiveId}: manifest not self-proving (${error?.name})`);
      continue;
    }
    if (manifest.archiveId !== archiveId || manifest.sessionId !== ctx.sessionId) {
      failures.push(`${archiveId}: manifest identity does not match its location`);
      continue;
    }

    // expand：只依据 manifest 与不可变事件自身的 parentId 链，不使用本地投影顺序。
    const reversed = [];
    let cursor = manifest.lastEventId;
    for (let index = 0; index < manifest.eventCount && typeof cursor === "string"; index++) {
      const eventUri = recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, cursor).directUri;
      const eventBytes = await ctx.client.downloadBytes(eventUri);
      if (!eventBytes.ok || !Buffer.isBuffer(eventBytes.bytes)) break;
      const event = JSON.parse(eventBytes.bytes.toString("utf8"));
      reversed.push({ event, bytes: eventBytes.bytes });
      cursor = event.parentId;
    }
    if (reversed.length !== manifest.eventCount) {
      failures.push(`${archiveId}: parentId chain broke at ${reversed.length}/${manifest.eventCount}`);
      continue;
    }
    const expanded = reversed.reverse();
    if (expanded[0].event.eventId !== manifest.firstEventId) {
      failures.push(`${archiveId}: chain does not reach firstEventId`);
      continue;
    }
    if (archiveContentHash(expanded.map((item) => item.event)) !== manifest.contentHash) {
      failures.push(`${archiveId}: expanded events do not recompute contentHash`);
      continue;
    }

    const startIndex = indexOf.get(manifest.firstEventId);
    const endIndex = indexOf.get(manifest.lastEventId);
    if (startIndex === undefined || endIndex === undefined || endIndex - startIndex + 1 !== manifest.eventCount) {
      failures.push(`${archiveId}: manifest range is not a contiguous slice of the branch`);
      continue;
    }
    const source = branch.slice(startIndex, endIndex + 1);
    if (!source.every((event, index) => recordedEventBytes(event).equals(expanded[index].bytes))) {
      failures.push(`${archiveId}: expanded bytes differ from projected source events`);
      continue;
    }
    const boundaryStep = source.at(-1).stepId;
    const next = branch[endIndex + 1];
    if (boundaryStep && next && next.stepId === boundaryStep) {
      failures.push(`${archiveId}: boundary splits step`);
      continue;
    }
    ranges.push({ archiveId, startIndex, endIndex });
  }

  log.check(w, `${label}.archive-integrity`, `${archiveIds.length} archives verified`,
    `${ranges.length} ok`, archiveIds.length > 0 && failures.length === 0, failures.slice(0, 5).join(" | "));

  ranges.sort((a, b) => a.startIndex - b.startIndex);
  const contiguous = ranges.every((range, index) => index === 0 || range.startIndex === ranges[index - 1].endIndex + 1);
  log.check(w, `${label}.archive-ranges-contiguous`, true, contiguous, contiguous,
    `${ranges.map((r) => `${r.startIndex}-${r.endIndex}`).join(",")}（相邻 Archive 必须连续、不重叠、不遗漏事件）`);

  // step 原子性断言只有在分支确实存在跨事件 step 时才有意义。
  const stepSizes = new Map();
  for (const event of branch) {
    if (typeof event.stepId === "string") stepSizes.set(event.stepId, (stepSizes.get(event.stepId) ?? 0) + 1);
  }
  const multiEventSteps = [...stepSizes.values()].filter((size) => size > 1).length;
  log.check(w, `${label}.multi-event-step-present`, ">=1", multiEventSteps, multiEventSteps >= 1,
    "分支必须含跨事件 step，否则边界不拆 step 的断言恒真");

  // 独立于计划器的结果检查：保留的 raw tail 压力不得低于配置预算。
  const budgets = archiveBudgets(ctx);
  let running = 0;
  const series = branch.map((event) => (running += eventTokenWeight(event)));
  const lastEnd = ranges.at(-1)?.endIndex ?? -1;
  const retained = (series.at(-1) ?? 0) - (lastEnd >= 0 ? series[lastEnd] : 0);
  log.check(w, `${label}.raw-tail-retained`, `>=${budgets.rawTailTokenBudget}`, retained,
    retained >= budgets.rawTailTokenBudget, "归档必须保留配置要求的最近原始上下文预算");
}

/** /viking 输出中的 Archive 行：已提交数、最近 archiveId 与失败提示。 */
function vikingArchiveStatus(run) {
  const message = String(run.actions.at(-1)?.notifyEvent?.message ?? "");
  const matched = message.match(/Archive：已提交 (\d+) 个，待提交 (\d+) 个（最近 (arc_[0-9a-f]{64}|尚未形成)）/);
  return {
    message,
    committed: matched ? Number(matched[1]) : null,
    failure: /最近 Archive 失败：/.test(message),
  };
}

function ackPathFor(ctx) {
  const ov = ctx.manifest.identities.openviking;
  return join(ctx.runDir, "home", ".pi", "openviking", "sync-ack",
    `${ackFileKey(ctx.endpoint, ov.account, ctx.storageUser, ctx.sessionId)}.json`);
}

async function replaceManifestBytes(ctx, archiveId, bytes, baseBytes) {
  const uri = archiveStorageLocation(ctx.userRoot, ctx.sessionId, archiveId).manifestUri;
  const response = await ctx.client.batchWrite({
    root_uri: sessionArchiveRoot(ctx),
    operations: [{
      uri,
      content_base64: bytes.toString("base64"),
      precondition: { kind: "replace_if_hash", base_hash: `sha256:${sha256Hex(baseBytes)}` },
    }],
    wait: false,
  });
  return { uri, ok: response.ok && Array.isArray(response.result?.updated) && response.result.updated.includes(uri) };
}

/** 记录本 workload 已写入远端的对象，供持久删除核验。 */
function recordWrittenObjects(ctx, branch, archiveIds) {
  ctx.knownEventIds = branch.map((event) => event.eventId);
  ctx.knownArchives = [...new Set([...(ctx.knownArchives ?? []), ...archiveIds])];
}

// ---------------------------------------------------------------------------
// Workloads
// ---------------------------------------------------------------------------

async function w1(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA, { requireCapture: false });
  await seedPressure(ctx, runA.sessionFile);

  const run = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, run, { requireCapture: false });

  const { branch } = await branchEvents(ctx, run.sessionFile);
  const snapshot = await archiveSnapshot(ctx, branch);
  const status = vikingArchiveStatus(run);
  const minimum = ctx.manifest.thresholds.minArchivesPerSession;
  log.check(ctx.workloadId, "archives-formed", `>=${minimum}`, snapshot.archives.size,
    snapshot.archives.size >= minimum, "真实 Pi 单会话必须在最小归档预算下形成 Archive");
  log.check(ctx.workloadId, "archives-match-plan", snapshot.expected.length, snapshot.archives.size,
    snapshot.expected.length === snapshot.archives.size,
    "从 Pi JSONL 独立重算的每个 Archive 都必须在远端存在");
  const bytesMatch = snapshot.expected.every((item) => snapshot.archives.get(item.manifest.archiveId)?.equals(item.bytes));
  log.check(ctx.workloadId, "archive-bytes-match-recomputed", true, bytesMatch, bytesMatch,
    "远端 manifest 字节必须等于从来源重算的规范字节");
  log.check(ctx.workloadId, "viking-reports-archives", status.committed, snapshot.archives.size,
    status.committed === snapshot.archives.size, status.message.slice(0, 200));
  const visible = await visibleArchiveObjects(ctx);
  log.check(ctx.workloadId, "archives-hidden-from-ls", 0, visible.length, visible.length === 0,
    visible.slice(0, 3).join(" | "));

  await verifyArchives(log, ctx, [...snapshot.archives.keys()], branch, "runA");
  recordWrittenObjects(ctx, branch, [...snapshot.archives.keys()]);
  ctx.runs.push(summarizeRun(runA), summarizeRun(run));
}

async function w2(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA, { requireCapture: false });
  await seedPressure(ctx, runA.sessionFile);
  const seedRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, seedRun, { requireCapture: false });
  const branchA = (await branchEvents(ctx, seedRun.sessionFile)).branch;
  const before = await archiveSnapshot(ctx, branchA);
  log.check(ctx.workloadId, "runA.archives-formed", ">=1", before.archives.size, before.archives.size >= 1);
  recordWrittenObjects(ctx, branchA, [...before.archives.keys()]);

  const [targetId, targetBytes] = [...before.archives.entries()].at(-1) ?? [];
  const injected = targetId ? await replaceManifestBytes(ctx, targetId, Buffer.alloc(0), targetBytes) : { ok: false };
  const afterInject = injected.ok ? await ctx.client.downloadBytes(injected.uri) : { ok: false };
  log.check(ctx.workloadId, "residue-injected", 0, afterInject.ok ? afterInject.bytes.length : "download failed",
    injected.ok && afterInject.ok && afterInject.bytes.length === 0, "崩溃残留形态：目标 URI 存在但字节为空");

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, runB, { requireCapture: false });

  const branchB = (await branchEvents(ctx, runB.sessionFile)).branch;
  const after = await archiveSnapshot(ctx, branchB);
  const restored = after.archives.get(targetId);
  log.check(ctx.workloadId, "residue-repaired", "byte-identical to runA manifest",
    restored ? `${restored.length}B` : "missing", Boolean(restored && targetBytes && restored.equals(targetBytes)),
    "残留必须以同一 archiveId 修复为同一字节");
  const untouched = [...before.archives.entries()]
    .filter(([id]) => id !== targetId)
    .every(([id, bytes]) => after.archives.get(id)?.equals(bytes));
  log.check(ctx.workloadId, "other-archives-untouched", true, untouched, untouched);
  const visible = await visibleArchiveObjects(ctx);
  log.check(ctx.workloadId, "no-extra-visible-objects", 0, visible.length, visible.length === 0, visible.slice(0, 3).join(" | "));

  await verifyArchives(log, ctx, [...after.archives.keys()], branchB, "runB");
  recordWrittenObjects(ctx, branchB, [...after.archives.keys()]);
  ctx.runs.push(summarizeRun(runA), summarizeRun(seedRun), summarizeRun(runB));
}

async function w3(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA, { requireCapture: false });
  await seedPressure(ctx, runA.sessionFile);
  const seedRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, seedRun, { requireCapture: false });
  const branchA = (await branchEvents(ctx, seedRun.sessionFile)).branch;
  const before = await archiveSnapshot(ctx, branchA);
  log.check(ctx.workloadId, "runA.archives-formed", ">=1", before.archives.size, before.archives.size >= 1);
  recordWrittenObjects(ctx, branchA, [...before.archives.keys()]);

  // 受管重启前尽力让服务排空异步语义刷新：带着积压重启会让启动时间受无关因素支配。
  // 这是一个有界的前置条件而不是断言——服务端队列可能因既往崩溃留下无法完成的条目，
  // 那属于 `.dev/` 运行态问题，不应把“重启后 Archive 是否稳定”的结论改判为失败。
  const quiesceMs = ctx.manifest.thresholds.quiesceSeconds * 1000;
  const quiesced = await ctx.cleanupClient.fetchJSON(
    openVikingApiPath("/system/wait"),
    { method: "POST", body: JSON.stringify({ timeout: ctx.manifest.thresholds.quiesceSeconds }) },
    quiesceMs + 30000,
  );
  process.stderr.write(`  · [${ctx.workloadId}] service-quiesced: ${quiesced.ok ? "drained" : "backlog remains"}\n`);

  // 服务停机期间失败也必须把服务交还给后续 workload 与清理。
  try {
    devService(log, ctx, "down");
    const down = await probeServerHealth(ctx.endpoint);
    log.check(ctx.workloadId, "service-unreachable", false, down.ok, !down.ok);
  } finally {
    devService(log, ctx, "up");
  }

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, runB, { requireCapture: false });

  const branchB = (await branchEvents(ctx, runB.sessionFile)).branch;
  const after = await archiveSnapshot(ctx, branchB);
  const stable = [...before.archives.entries()].every(([id, bytes]) => after.archives.get(id)?.equals(bytes));
  log.check(ctx.workloadId, "archives-stable-across-restart", true, stable, stable,
    "重启前已提交的 Archive 必须逐字节不变");
  const superset = [...before.archives.keys()].every((id) => after.archives.has(id));
  log.check(ctx.workloadId, "archives-append-only", true, superset && after.archives.size >= before.archives.size,
    superset && after.archives.size >= before.archives.size, `${before.archives.size} → ${after.archives.size}`);

  await verifyArchives(log, ctx, [...after.archives.keys()], branchB, "runB");
  recordWrittenObjects(ctx, branchB, [...after.archives.keys()]);
  ctx.runs.push(summarizeRun(runA), summarizeRun(seedRun), summarizeRun(runB));
}

async function w4(log, ctx) {
  const inputs = ctx.workload.inputs;
  writeExtensionConfig(ctx);
  const runA = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 0, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P1 }, { command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, runA, { requireCapture: false });
  await seedPressure(ctx, runA.sessionFile);
  const seedRun = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 1, endpoint: ctx.endpoint,
    actions: [{ command: "/viking sync" }],
  });
  assertRunHealthy(log, ctx, seedRun, { requireCapture: false });
  const branchA = (await branchEvents(ctx, seedRun.sessionFile)).branch;
  const before = await archiveSnapshot(ctx, branchA);
  log.check(ctx.workloadId, "runA.archives-formed", ">=1", before.archives.size, before.archives.size >= 1);
  recordWrittenObjects(ctx, branchA, [...before.archives.keys()]);

  // 自证成立但内容不同：同一 archiveId 绑定了不同的事件内容，属于完整性冲突。
  const [targetId, targetBytes] = [...before.archives.entries()].at(-1) ?? [];
  const conflicting = targetBytes
    ? archiveManifestBytes({ ...parseArchiveManifest(targetBytes), contentHash: `sha256:${"c".repeat(64)}` })
    : null;
  const injected = conflicting ? await replaceManifestBytes(ctx, targetId, conflicting, targetBytes) : { ok: false };
  log.check(ctx.workloadId, "conflict-injected", true, injected.ok, injected.ok);

  const runB = await runPi(ctx, {
    workloadId: ctx.workloadId, turn: 2, endpoint: ctx.endpoint,
    actions: [{ prompt: inputs.P2 }, { command: "/viking sync" }, { command: "/viking" }],
  });
  assertRunHealthy(log, ctx, runB, { requireCapture: false });

  const current = injected.ok ? await ctx.client.downloadBytes(injected.uri) : { ok: false };
  log.check(ctx.workloadId, "conflict-not-overwritten", "injected bytes intact",
    current.ok ? `${current.bytes.length}B` : `download failed(${current.status})`,
    current.ok && conflicting !== null && current.bytes.equals(conflicting),
    "完整性冲突不得被静默修复或覆盖");

  const syncNotify = runB.actions[1].notifyEvent;
  log.check(ctx.workloadId, "sync-unaffected", "info", syncNotify?.notifyType, syncNotify?.notifyType === "info",
    "Archive 冲突不得阻断事件同步");
  const { parsed, branch } = await branchEvents(ctx, runB.sessionFile);
  const ack = await readSyncAck(ackPathFor(ctx));
  const uncovered = parsed.entries.filter((entry) => !isEntryAcknowledged(ack, entry.id, parsed.parentById));
  log.check(ctx.workloadId, "ack-covers-tree", 0, uncovered.length, uncovered.length === 0,
    uncovered.map((entry) => entry.id).join(","));

  const status = vikingArchiveStatus(runB);
  log.check(ctx.workloadId, "viking-reports-failure", true, status.failure, status.failure, status.message.slice(0, 200));

  recordWrittenObjects(ctx, branch, [...before.archives.keys()]);
  ctx.runs.push(summarizeRun(runA), summarizeRun(seedRun), summarizeRun(runB));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** 该 workload 写入远端的全部对象 URI（marker、事件、Archive manifest），供持久删除核验。 */
function collectObjectUris(ctx) {
  const uris = ctx.markerUri ? [ctx.markerUri] : [];
  for (const eventId of ctx.knownEventIds ?? []) {
    // 本 gate 的 workload 只产生 8 MiB 以内的事件，因此只有 direct 表示。
    uris.push(recordedEventStorageLocation(ctx.userRoot, ctx.sessionId, eventId).directUri);
  }
  for (const archiveId of ctx.knownArchives ?? []) {
    uris.push(archiveStorageLocation(ctx.userRoot, ctx.sessionId, archiveId).manifestUri);
  }
  return uris;
}

const WORKLOAD_RUNNERS = {
  "w1-archive-formation": w1,
  "w2-residue-recovery": w2,
  "w3-restart-idempotence": w3,
  "w4-integrity-conflict": w4,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLiveGate({
    gate: "phase1",
    manifestPath: join(REPO, "test/live/phase1.workloads.json"),
    manifestHashPath: join(REPO, "test/live/phase1.workloads.sha256"),
    runners: WORKLOAD_RUNNERS,
    collectObjectUris,
  }).catch((error) => {
    process.stderr.write(`✗ verifier 内部错误: ${error?.stack || error}\n`);
    process.exit(1);
  });
}
