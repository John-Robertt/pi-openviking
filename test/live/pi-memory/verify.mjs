#!/usr/bin/env node
/**
 * pi-memory live gate：验证「Pi 原生记忆接入」阶段系统保证——
 * 持久与 in-memory session 中来源 entries 保持 Pi 已接受的原值与顺序（自身 CueSet 除外）；
 * 测试驱动的固定 CueSet 在 compaction 后保存为当前路径的 custom entry；普通 provider
 * payload 临时呈现当前有效 CueSet；后续 compaction 的 preparation 不含既有 CueSet 文本；
 * fork 导航与 session 重开后投影与当前路径一致；callback 失败沿 Pi 原生错误路径报告。
 * 本 gate 只接触真实 Pi，不接触 OpenViking（docs/verification.md「身份先行」）。
 * 契约见 docs/verification.md「live gate 契约」；阈值固定在 workloads.json。
 *
 * compaction 需要可丢弃内容超过 keepRecentTokens 才真正发生；agentDir 的 settings.json
 * 写入 manifest.compactionKeepRecentTokens 使短会话即可触发真实 compaction（Pi 原生设置，
 * 不改变 compaction 机制本身）。
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  cpSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRpc } from "../helpers/rpc.mjs";
import { canonicalize, loadManifest } from "../../helpers/manifest.mjs";
import { CUES_CUSTOM_TYPE } from "../../../src/contracts/cue-set.ts";

const GATE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const DEV_PI = join(REPO, ".dev", "pi");
const RUNS_ROOT = join(REPO, ".dev", "gates", "pi-memory");

const fail = (reason) => {
  console.error(`拒绝运行: ${reason}`);
  process.exit(1);
};

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

const hashEntry = (entry) => createHash("sha256").update(canonicalize(entry)).digest("hex");
const isCueEntry = (entry) => entry.type === "custom" && entry.customType === CUES_CUSTOM_TYPE;
/** 与探针 collected.jsonl 同构的来源 entries 证据序列。 */
const sourceSequenceOf = (entries) =>
  entries.filter((entry) => !isCueEntry(entry)).map((entry) => ({ id: entry.id, type: entry.type, h: hashEntry(entry) }));

// --- 身份先行 ---
const manifest = loadManifest(GATE_DIR);
for (const field of ["requiredEventMilestones", "requiredObservationOperations", "prompts", "cueTemplate"]) {
  if (!Array.isArray(manifest[field]) || manifest[field].length === 0) fail(`${field} 必须是非空数组`);
}
if (!Number.isInteger(manifest.compactionKeepRecentTokens) || manifest.compactionKeepRecentTokens <= 0) {
  fail("compactionKeepRecentTokens 必须是正整数");
}
const version = spawnSync(join(REPO, "node_modules", ".bin", "pi"), ["--version"], { encoding: "utf8" })
  .stdout.trim();
if (version !== manifest.identity.piVersion) {
  fail(`Pi 版本不符：期望 ${manifest.identity.piVersion}，实际 ${version || "不可用"}`);
}
const profile = JSON.parse(readFileSync(join(REPO, "dev", "model-profile.json"), "utf8"));
const { provider, model } = manifest.identity.taskModel;
if (profile.taskModel.provider !== provider || profile.taskModel.model !== model) {
  fail(`模型身份不符：期望 ${provider}/${model}，实际 ${profile.taskModel.provider}/${profile.taskModel.model}`);
}

// --- 隔离运行 + ownership marker ---
const runId = randomUUID();
const nonce = randomUUID();
const runDir = join(RUNS_ROOT, `${new Date().toISOString().replaceAll(":", "-")}-${nonce.slice(0, 8)}`);
mkdirSync(runDir, { recursive: true });
const marker = JSON.stringify({ gate: manifest.gate, runId, nonce }, null, 2);
writeFileSync(join(runDir, "ownership.marker"), `${marker}\n`);
if (readFileSync(join(runDir, "ownership.marker"), "utf8") !== `${marker}\n`) {
  fail("ownership marker 回读不一致");
}

const agentDir = join(runDir, "agentDir");
const wrapperDir = join(agentDir, "extensions", "pi-openviking-dev");

// 凭证桥沿用 docs/development.md「凭证边界」的同文件引用；gate 不复制凭证，run dir 清理只移除引用。
// settings 写入 manifest 声明的 keepRecentTokens，其余沿用 dev 环境设置。
function setupAgentDir() {
  mkdirSync(agentDir, { recursive: true });
  const authSource = join(DEV_PI, "auth.json");
  try {
    symlinkSync(readlinkSync(authSource), join(agentDir, "auth.json"));
  } catch {
    linkSync(authSource, join(agentDir, "auth.json"));
  }
  cpSync(join(DEV_PI, "models-store.json"), join(agentDir, "models-store.json"));
  const devSettings = join(DEV_PI, "settings.json");
  const settings = existsSync(devSettings) ? JSON.parse(readFileSync(devSettings, "utf8")) : {};
  settings.compaction = { ...settings.compaction, keepRecentTokens: manifest.compactionKeepRecentTokens };
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

// --- gate 输入：每次运行唯一的 cue 标记，探针据此构造固定 CueSet ---
const cueMarker = `cue-marker-${nonce.slice(0, 8)}`;
const cues = manifest.cueTemplate.map((line) => line.replaceAll("{marker}", cueMarker));
const gateInput = join(runDir, "gate-input.json");
writeFileSync(
  gateInput,
  `${JSON.stringify({ marker: cueMarker, cues, prompts: manifest.prompts }, null, 2)}\n`,
);

const SKIP_WORKLOADS = Symbol("skip-workloads");
const assertions = [];
const assert = (name, expected, actual, pass) => {
  assertions.push({ name, expected, actual, pass });
  return pass;
};
const evidence = {};

const prompts = manifest.prompts;
const promptStep = (id, promptIndex) => ({
  command: { id, type: "prompt", message: prompts[promptIndex] },
  until: (event) => event.type === "agent_end",
  description: `agent_end(${id})`,
});
const compactStep = (id) => ({
  command: { id, type: "compact" },
  until: (event) => event.type === "response" && event.id === id,
  description: `compact 响应(${id})`,
});
const responseStep = (id, command) => ({
  command: { id, ...command },
  until: (event) => event.type === "response" && event.id === id,
  description: `response(${id})`,
});

/**
 * wrapper：是否加载真实 Composition Root（其他 workload 必须先移除 wrapper，避免双重注册）；
 * probe：探针文件名；noSession：in-memory session。
 */
async function runWorkload(name, { wrapper = false, probe = null, noSession = false, commands }) {
  rmSync(wrapperDir, { recursive: true, force: true });
  if (wrapper) {
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(wrapperDir + "/index.ts", `export { default } from "${join(REPO, "src", "index.ts")}";\n`);
  }
  const evidenceDir = join(runDir, `evidence-${name}`);
  mkdirSync(evidenceDir, { recursive: true });
  const sessionsDir = join(runDir, `sessions-${name}`);
  const result = await runRpc({
    args: [
      "--provider",
      provider,
      "--model",
      model,
      ...(noSession ? ["--no-session"] : ["--session-dir", sessionsDir]),
      ...(probe ? ["-e", join(GATE_DIR, "probes", probe)] : []),
    ],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      PI_OPENVIKING_OBSERVE: join(evidenceDir, "obs.jsonl"),
      GATE_INPUT: gateInput,
      GATE_EVIDENCE_DIR: evidenceDir,
    },
    commands,
    timeoutMs: manifest.runTimeoutMs,
  });
  return { result, evidenceDir, sessionsDir };
}

/** workload 驱动失败（超时、spawn 失败）转为断言失败，保证清理与 summary 照常产出。 */
async function tryRun(name, opts) {
  console.error(`[gate] ${name} 开始`);
  try {
    const workload = await runWorkload(name, opts);
    console.error(`[gate] ${name} 完成 code=${workload.result.code}`);
    return workload;
  } catch (err) {
    assert(`${name} 运行完成`, "成功", String(err instanceof Error ? err.message : err), false);
    return null;
  }
}

function containsInOrder(actual, required) {
  let next = 0;
  for (const value of actual) {
    if (value === required[next]) next += 1;
  }
  return next === required.length;
}

function responseOf(workload, id) {
  return workload?.result.events.find((event) => event.type === "response" && event.id === id);
}

function readSessionEntries(sessionsDir) {
  if (!existsSync(sessionsDir)) return null;
  const file = readdirSync(sessionsDir).find((name) => name.endsWith(".jsonl"));
  if (!file) return null;
  return readFileSync(join(sessionsDir, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((line) => line.type !== "session");
}

function readJsonl(file) {
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
}

/** 基本运行健康 + 每个 compact 命令都真实成功（不是 compaction_end 事件的失败变体）。 */
function assertRunOk(name, workload, compactIds = []) {
  if (!workload) return false;
  assert(`${name} exit code`, manifest.exitCode, workload.result.code, workload.result.code === manifest.exitCode);
  const sequence = workload.result.events.map((event) => event.type);
  assert(
    `${name} 包含必要 Pi 事件里程碑`,
    manifest.requiredEventMilestones,
    sequence,
    containsInOrder(sequence, manifest.requiredEventMilestones),
  );
  const errors = workload.result.events.filter((event) => event.type === "extension_error");
  assert(`${name} 无 extension_error`, 0, errors.length, errors.length === 0);
  for (const id of compactIds) {
    const response = responseOf(workload, id);
    assert(`${name} compact(${id}) 真实成功`, true, response?.success === true, response?.success === true);
  }
  return assertions.filter((a) => a.name.startsWith(name)).every((a) => a.pass);
}

/** 观察记录：必要操作按序出现，callback 在声明上限内返回。 */
function assertObservations(name, workload, { expectError } = {}) {
  if (!workload) return;
  const obsFile = join(workload.evidenceDir, "obs.jsonl");
  const obsExists = existsSync(obsFile);
  assert(`${name} 观察文件存在`, true, obsExists, obsExists);
  if (!obsExists) return;
  evidence[`${name}/obs.jsonl`] = sha256File(obsFile);
  const records = readJsonl(obsFile);
  assert(
    `${name} 观察记录包含必要操作`,
    manifest.requiredObservationOperations,
    records.map((record) => record.operation),
    containsInOrder(records.map((record) => record.operation), manifest.requiredObservationOperations),
  );
  const errorRecords = records.filter((record) => record.outcome === "error");
  if (expectError) {
    assert(
      `${name} 观察记录含注入失败`,
      "session_compact error",
      errorRecords.map((record) => `${record.operation}:${record.error}`),
      errorRecords.some((record) => record.operation === "session_compact"),
    );
  } else {
    assert(`${name} 观察记录 outcome 全部 ok`, "ok", errorRecords, errorRecords.length === 0);
  }
  const maxDuration = Math.max(...records.map((record) => record.durationMs));
  assert(
    `${name} callback 在时间上限内返回`,
    `durationMs <= ${manifest.callbackDurationMaxMs}`,
    { max: maxDuration, delta: maxDuration - manifest.callbackDurationMaxMs },
    maxDuration <= manifest.callbackDurationMaxMs,
  );
}

/** 来源 entries：探针收集的每次快照是最终序列的前缀，最后一次快照等于最终序列。 */
function assertSourceEntries(name, workload, finalEntries) {
  if (!workload || !finalEntries) return;
  const collectedFile = join(workload.evidenceDir, "collected.jsonl");
  const collected = readJsonl(collectedFile);
  assert(`${name} 来源 entries 有收集记录`, "非空", collected.length, collected.length > 0);
  if (collected.length === 0) return;
  evidence[`${name}/collected.jsonl`] = sha256File(collectedFile);
  const finalSeq = sourceSequenceOf(finalEntries);
  const isPrefix = (seq) => seq.every((item, i) => finalSeq[i] && finalSeq[i].h === item.h);
  assert(
    `${name} 每次收集都是最终来源序列的前缀（原值、原顺序）`,
    "全部为前缀",
    collected.map((seq) => seq.length),
    collected.every(isPrefix),
  );
  const last = collected[collected.length - 1];
  assert(
    `${name} 最后一次收集等于最终来源序列`,
    finalSeq.length,
    last.length,
    last.length === finalSeq.length && finalSeq.every((item, i) => last[i] && last[i].h === item.h),
  );
}

/** CueSet custom entry：每次 compaction 恰好一份，挂在该 CompactionEntry 下，内容即固定 CueSet。 */
function assertCueEntries(name, entries, compactionCount) {
  if (!entries) return;
  const compactions = entries.filter((entry) => entry.type === "compaction");
  const cueEntries = entries.filter(isCueEntry);
  assert(`${name} compaction 次数`, compactionCount, compactions.length, compactions.length === compactionCount);
  assert(
    `${name} 每次 compaction 恰好保存一份 CueSet`,
    compactionCount,
    cueEntries.length,
    cueEntries.length === compactionCount,
  );
  for (let i = 0; i < Math.min(compactions.length, cueEntries.length); i += 1) {
    assert(
      `${name} CueSet[${i}] 挂在对应 CompactionEntry 下且引用压缩前最后一条 entry`,
      { parentId: compactions[i].id, lastUsedEntryId: compactions[i].parentId },
      { parentId: cueEntries[i].parentId, lastUsedEntryId: cueEntries[i].data?.lastUsedEntryId },
      cueEntries[i].parentId === compactions[i].id &&
        cueEntries[i].data?.lastUsedEntryId === compactions[i].parentId,
    );
    assert(
      `${name} CueSet[${i}] 内容为固定线索`,
      cues,
      cueEntries[i].data?.cues,
      JSON.stringify(cueEntries[i].data?.cues) === JSON.stringify(cues),
    );
  }
}

/**
 * payload/preparation 扫描：compaction preparation 从不携带 cue 标记；携带 prompt 的普通请求
 * 在 projected=true 的 prompt 上必须出现标记，其余请求一律不出现。projected 为 undefined 的下标跳过。
 */
function assertScans(name, workload, projectedPrompts) {
  if (!workload) return;
  const scansFile = join(workload.evidenceDir, "scans.jsonl");
  const scans = readJsonl(scansFile);
  assert(`${name} 捕获扫描记录存在`, "非空", scans.length, scans.length > 0);
  if (scans.length === 0) return;
  evidence[`${name}/scans.jsonl`] = sha256File(scansFile);
  const preparations = scans.filter((scan) => scan.hook === "before_compact");
  assert(
    `${name} 后续 compaction 的 preparation 不含既有 CueSet 文本`,
    "全部不含标记",
    preparations,
    preparations.length > 0 && preparations.every((scan) => !scan.marker),
  );
  const requests = scans.filter((scan) => scan.hook === "provider_request");
  for (const [index, projected] of projectedPrompts.entries()) {
    if (projected === undefined) continue;
    const hits = requests.filter((scan) => scan.prompt === index);
    assert(
      `${name} prompt[${index}] 普通请求的 CueSet 投影`,
      projected ? "出现标记" : "不出现标记",
      hits,
      hits.length > 0 && hits.every((scan) => scan.marker === projected),
    );
  }
  const stray = requests.filter((scan) => scan.prompt === -1 && scan.marker);
  assert(`${name} 非 prompt 请求（如 compaction summary）不携带 CueSet`, "不出现标记", stray, stray.length === 0);
}

let cleanupPass = false;

try {
  try {
    setupAgentDir();
  } catch (err) {
    assert("gate agentDir 建立", "成功", String(err instanceof Error ? err.message : err), false);
    throw SKIP_WORKLOADS;
  }

  // --- baseline：未加载扩展，确认 workload 形状下两次真实 compaction 可行 ---
  const baseline = await tryRun("baseline", {
    commands: [
      promptStep("b1", 0),
      promptStep("b2", 1),
      promptStep("b3", 2),
      compactStep("b4"),
      promptStep("b5", 3),
      promptStep("b6", 4),
      compactStep("b7"),
      promptStep("b8", 5),
    ],
  });
  if (assertRunOk("baseline", baseline, ["b4", "b7"])) {
    const entries = readSessionEntries(baseline.sessionsDir);
    const compactions = entries ? entries.filter((entry) => entry.type === "compaction").length : 0;
    assert("baseline 产生两份 CompactionEntry", 2, compactions, compactions === 2);
  }

  // --- loaded：真实 Composition Root；无 cue 源时不保存、不投影，callback 有界 ---
  const loaded = await tryRun("loaded", {
    wrapper: true,
    commands: [promptStep("l1", 0), promptStep("l2", 1), promptStep("l3", 2), compactStep("l4"), promptStep("l5", 3)],
  });
  if (assertRunOk("loaded", loaded, ["l4"])) {
    assertObservations("loaded", loaded);
    const entries = readSessionEntries(loaded.sessionsDir);
    assert(
      "loaded 无 cue 源时不保存 CueSet custom entry",
      0,
      entries ? entries.filter(isCueEntry).length : "无 session 文件",
      entries !== null && entries.filter(isCueEntry).length === 0,
    );
  }

  // --- persistent：固定 CueSet 驱动；来源 entries、保存、投影、二次 compaction ---
  const persistent = await tryRun("persistent", {
    probe: "fixed-cues.ts",
    commands: [
      promptStep("p1", 0),
      promptStep("p2", 1),
      promptStep("p3", 2),
      compactStep("p4"),
      promptStep("p5", 3),
      promptStep("p6", 4),
      compactStep("p7"),
      promptStep("p8", 5),
    ],
  });
  if (assertRunOk("persistent", persistent, ["p4", "p7"])) {
    assertObservations("persistent", persistent);
    const entries = readSessionEntries(persistent.sessionsDir);
    assert("persistent session 文件存在", true, entries !== null, entries !== null);
    assertSourceEntries("persistent", persistent, entries);
    assertCueEntries("persistent", entries, 2);
    assertScans("persistent", persistent, [false, false, false, true, true, true]);
  }

  // --- tree：fork 到 compaction 前（路径无 CueSet）→ 投影消失；switch_session 重开 → 投影恢复 ---
  const tree = await tryRun("tree", {
    probe: "fixed-cues.ts",
    commands: [
      promptStep("t1", 0),
      promptStep("t2", 1),
      promptStep("t3", 2),
      compactStep("t4"),
      responseStep("t5", { type: "get_state" }),
      responseStep("t6", { type: "get_entries" }),
      {
        command: (events) => {
          const entries = events.find((event) => event.type === "response" && event.id === "t6")?.data?.entries;
          const target = entries?.find((entry) => entry.type === "message" && entry.message?.role === "user");
          if (!target) throw new Error("tree：未找到 fork 目标（首条 user message entry）");
          return { id: "t7", type: "fork", entryId: target.id };
        },
        until: (event) => event.type === "response" && event.id === "t7",
        description: "fork 响应(t7)",
      },
      // fork 后的新路径在 compaction 之前，不含 CueSet custom entry。
      promptStep("t8", 6),
      {
        command: (events) => {
          const sessionFile = events.find((event) => event.type === "response" && event.id === "t5")?.data
            ?.sessionFile;
          if (!sessionFile) throw new Error("tree：未取得原 session 文件路径");
          return { id: "t9", type: "switch_session", sessionPath: sessionFile };
        },
        until: (event) => event.type === "response" && event.id === "t9",
        description: "switch_session 响应(t9)",
      },
      // 重开原 session：扩展状态仅从 Pi 当前 entries 重建，投影恢复。
      promptStep("t10", 7),
    ],
  });
  if (assertRunOk("tree", tree, ["t4"])) {
    assertObservations("tree", tree);
    assert("tree fork 成功", true, responseOf(tree, "t7")?.success === true, responseOf(tree, "t7")?.success === true);
    assert(
      "tree switch_session 重开成功",
      true,
      responseOf(tree, "t9")?.success === true,
      responseOf(tree, "t9")?.success === true,
    );
    // 下标：0-2 投影前；6 在 fork 路径（无 CueSet）；7 在重开的原路径（有 CueSet）
    assertScans("tree", tree, [false, false, false, undefined, undefined, undefined, false, true]);
  }

  // --- failure：resolveCueSet 注入失败，沿 Pi 原生错误路径报告，compaction 与主流程继续 ---
  const failure = await tryRun("failure", {
    probe: "fail-cues.ts",
    commands: [promptStep("f1", 0), promptStep("f2", 1), promptStep("f3", 2), compactStep("f4"), promptStep("f5", 3)],
  });
  if (failure) {
    assert("failure exit code", manifest.exitCode, failure.result.code, failure.result.code === manifest.exitCode);
    const hasExtensionError = failure.result.events.some((event) => event.type === "extension_error");
    assert("failure extension_error 事件", true, hasExtensionError, hasExtensionError);
    assert(
      "failure compaction 仍然真实成功",
      true,
      responseOf(failure, "f4")?.success === true,
      responseOf(failure, "f4")?.success === true,
    );
    assertObservations("failure", failure, { expectError: true });
    const entries = readSessionEntries(failure.sessionsDir);
    assert(
      "failure 不保存 CueSet custom entry",
      0,
      entries ? entries.filter(isCueEntry).length : "无 session 文件",
      entries !== null && entries.filter(isCueEntry).length === 0,
    );
  }

  // --- in-memory：--no-session 下来源 entries 读取与投影 ---
  const memory = await tryRun("in-memory", {
    probe: "fixed-cues.ts",
    noSession: true,
    commands: [
      promptStep("m1", 0),
      promptStep("m2", 1),
      promptStep("m3", 2),
      compactStep("m4"),
      promptStep("m5", 3),
      responseStep("m6", { type: "get_entries" }),
    ],
  });
  if (assertRunOk("in-memory", memory, ["m4"])) {
    assertObservations("in-memory", memory);
    const rpcEntries = responseOf(memory, "m6")?.data?.entries;
    assert("in-memory get_entries 取得 entries", "非空数组", rpcEntries?.length, Array.isArray(rpcEntries));
    if (Array.isArray(rpcEntries)) assertSourceEntries("in-memory", memory, rpcEntries);
    assertScans("in-memory", memory, [false, false, false, true]);
    const sessionsRoot = join(agentDir, "sessions");
    const straySessions = existsSync(sessionsRoot)
      ? readdirSync(sessionsRoot).filter((f) => f.endsWith(".jsonl"))
      : [];
    assert("in-memory 不产生 session 文件", 0, straySessions, straySessions.length === 0);
  }

  // --- 脱敏扫描：观察与收集证据不出现用户正文、凭证与 cue 标记原文 ---
  const forbidden = manifest.redactionForbiddenPatterns.map((pattern) => new RegExp(pattern));
  for (const workload of [loaded, persistent, tree, failure, memory]) {
    if (!workload) continue;
    for (const name of ["obs.jsonl", "collected.jsonl", "scans.jsonl"]) {
      const file = join(workload.evidenceDir, name);
      if (!existsSync(file)) continue;
      const content = readFileSync(file, "utf8");
      const hits = forbidden.filter((pattern) => pattern.test(content)).map(String);
      assert(`${workload.evidenceDir.split("/").pop()}/${name} 脱敏`, "无命中", hits, hits.length === 0);
    }
  }
} catch (err) {
  if (err !== SKIP_WORKLOADS) throw err;
} finally {
  // --- 清理即断言 ---
  try {
    const current = JSON.parse(readFileSync(join(runDir, "ownership.marker"), "utf8"));
    if (current.runId !== runId || current.nonce !== nonce) throw new Error("marker 不符");
    rmSync(runDir, { recursive: true, force: true });
    cleanupPass = !existsSync(runDir);
  } catch {
    cleanupPass = false;
  }
}

const passed = assertions.every((assertion) => assertion.pass) && cleanupPass;
console.log(
  JSON.stringify(
    {
      gate: manifest.gate,
      identity: { piVersion: version, taskModel: `${provider}/${model}` },
      runId,
      assertions,
      evidence,
      cleanup: cleanupPass,
      passed,
    },
    null,
    2,
  ),
);
process.exit(passed ? 0 : 1);
