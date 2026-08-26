#!/usr/bin/env node
/**
 * run-boundary live gate：验证「运行边界与观察」阶段系统保证——
 * 运行实例原子启用（装配失败时全部 callback 保持 inert）；lifecycle callback 异常沿 Pi 原生
 * 扩展错误路径报告；callback 在声明的时间上限内返回；Observer sink 失败后停止后续写入且不
 * 阻断 Pi；每次运行留下可关联、已脱敏的结构化证据。
 * 本 gate 只接触真实 Pi，不接触 OpenViking（docs/verification.md「身份先行」）。
 * 契约见 docs/verification.md「live gate 契约」；baseline 与阈值固定在 workloads.json。
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runRpc } from "../helpers/rpc.mjs";
import { loadManifest } from "../../helpers/manifest.mjs";

const GATE_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const DEV_PI = join(REPO, ".dev", "pi");
const RUNS_ROOT = join(REPO, ".dev", "gates", "run-boundary");

const fail = (reason) => {
  console.error(`拒绝运行: ${reason}`);
  process.exit(1);
};

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

// --- 身份先行 ---
const manifest = loadManifest(GATE_DIR);
for (const field of ["requiredEventMilestones", "requiredObservationOperations"]) {
  if (!Array.isArray(manifest[field]) || manifest[field].length === 0) fail(`${field} 必须是非空数组`);
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
const writeWrapper = () => {
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(wrapperDir + "/index.ts", `export { default } from "${join(REPO, "src", "index.ts")}";\n`);
};

// 凭证桥沿用 docs/development.md「凭证边界」的同文件引用：Pi 对 token 的刷新写入落在用户已授权的
// auth store（与 dev 环境同一机制）；gate 不复制凭证，run dir 清理只移除引用。
function setupAgentDir() {
  mkdirSync(agentDir, { recursive: true });
  const authSource = join(DEV_PI, "auth.json");
  try {
    symlinkSync(readlinkSync(authSource), join(agentDir, "auth.json"));
  } catch {
    linkSync(authSource, join(agentDir, "auth.json"));
  }
  cpSync(join(DEV_PI, "models-store.json"), join(agentDir, "models-store.json"));
  // settings.json 由 Pi 按需生成，不存在时无需复制。
  const settings = join(DEV_PI, "settings.json");
  if (existsSync(settings)) cpSync(settings, join(agentDir, "settings.json"));
}

const SKIP_WORKLOADS = Symbol("skip-workloads");
const assertions = [];
const assert = (name, expected, actual, pass) => {
  const record = { name, expected, actual, pass };
  // 数值比较自动补 delta（docs/verification.md「summary 可对照」）。
  if (typeof expected === "number" && typeof actual === "number") record.delta = actual - expected;
  assertions.push(record);
  return pass;
};
const evidence = {};

const commands = [
  {
    command: { id: "1", type: "prompt", message: manifest.prompt },
    until: (event) => event.type === "agent_end",
    description: "agent_end",
  },
  {
    command: { id: "2", type: "compact" },
    until: (event) =>
      event.type === "compaction_end" || (event.type === "response" && event.id === "2" && !event.success),
    description: "compaction_end 或 compact 失败响应",
  },
];

/**
 * obsEnv：PI_OPENVIKING_OBSERVE 的值；undefined 表示不设置。
 * 返回的 obsFile 仅在 obsEnv 指向 runDir 内文件时有值（供证据 hash 与内容断言）。
 */
async function runWorkload(name, { wrapper, probe, obsEnv }) {
  if (wrapper) writeWrapper();
  const sessionsDir = join(runDir, `sessions-${name}`);
  const result = await runRpc({
    args: [
      "--provider",
      provider,
      "--model",
      model,
      "--session-dir",
      sessionsDir,
      ...(probe ? ["-e", join(GATE_DIR, "probes", probe)] : []),
    ],
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      ...(obsEnv !== undefined ? { PI_OPENVIKING_OBSERVE: obsEnv } : {}),
    },
    commands,
    timeoutMs: manifest.runTimeoutMs,
  });
  const obsFile = obsEnv !== undefined && obsEnv.startsWith(runDir) ? obsEnv : undefined;
  return { result, sessionsDir, obsFile };
}

let cleanupPass = false;

/** workload 驱动失败（超时、spawn 失败）转为断言失败，保证清理与 summary 照常产出。 */
async function tryRun(name, opts) {
  try {
    return await runWorkload(name, opts);
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

function eventSequenceOf(workload) {
  return workload ? workload.result.events.map((event) => event.type) : null;
}

function assertEventMilestones(name, workload) {
  const sequence = eventSequenceOf(workload);
  assert(
    `${name} 包含必要 Pi 事件里程碑`,
    manifest.requiredEventMilestones,
    sequence ?? "运行失败",
    sequence !== null && containsInOrder(sequence, manifest.requiredEventMilestones),
  );
}

function assertExitCode(name, workload) {
  if (!workload) return;
  assert(`${name} exit code`, manifest.exitCode, workload.result.code, workload.result.code === manifest.exitCode);
}

function stderrLines(workload, pattern) {
  return workload.result.stderr.split("\n").filter((line) => line.includes(pattern));
}

try {
  // agentDir 建立失败转为断言失败并跳过 workloads，清理与 summary 照常产出。
  try {
    setupAgentDir();
  } catch (err) {
    assert("gate agentDir 建立", "成功", String(err instanceof Error ? err.message : err), false);
    throw SKIP_WORKLOADS;
  }
  // --- baseline：未加载扩展 ---
  const baseline = await tryRun("baseline", { wrapper: false, probe: null });
  assertExitCode("baseline", baseline);
  assertEventMilestones("baseline", baseline);

  // --- loaded：扩展加载 + 观察开启，验证 active 启用、callback 时界与可关联证据 ---
  const loaded = await tryRun("loaded", { wrapper: true, probe: null, obsEnv: join(runDir, "obs-loaded.jsonl") });
  assertExitCode("loaded", loaded);
  if (loaded) {
    const hasExtensionError = loaded.result.events.some((event) => event.type === "extension_error");
    assert("loaded 无 extension_error", false, hasExtensionError, !hasExtensionError);
  }
  assertEventMilestones("loaded", loaded);

  // 观察证据：可关联、字段齐全、链路结果全部 ok、callback 在时间上限内返回
  const obsFile = loaded?.obsFile;
  const obsExists = obsFile !== undefined && existsSync(obsFile);
  assert("loaded 观察文件存在", true, obsExists, obsExists);
  if (obsExists) {
    evidence[obsFile.split("/").pop()] = sha256File(obsFile);
    const records = readFileSync(obsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const operations = records.map((record) => record.operation);
    assert(
      "观察记录包含必要操作",
      manifest.requiredObservationOperations,
      operations,
      containsInOrder(operations, manifest.requiredObservationOperations),
    );
    const outcomes = records.map((record) => record.outcome);
    assert(
      "观察记录 outcome 全部 ok",
      "ok",
      outcomes,
      outcomes.every((outcome) => outcome === "ok"),
    );
    const runIds = new Set(records.map((record) => record.runId));
    assert("观察记录单一 runId", 1, runIds.size, runIds.size === 1);
    const sessionIds = new Set(records.filter((record) => record.session).map((record) => record.session));
    assert("观察记录单一 session", 1, sessionIds.size, sessionIds.size === 1);
    const sessionFile = readdirSync(loaded.sessionsDir).find((name) => name.endsWith(".jsonl"));
    const sessionUuid = sessionFile?.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1];
    assert(
      "观察 session 与 Pi session 文件一致",
      sessionUuid,
      [...sessionIds][0],
      sessionUuid !== undefined && sessionIds.has(sessionUuid),
    );
    const durations = records.map((record) => record.durationMs);
    const maxDuration = Math.max(...durations);
    assert(
      "callback 在时间上限内返回",
      `durationMs <= ${manifest.callbackDurationMaxMs}`,
      { durations, max: maxDuration, delta: maxDuration - manifest.callbackDurationMaxMs },
      maxDuration <= manifest.callbackDurationMaxMs,
    );
  }

  // --- inert：注入装配失败，Pi 正常启动，已注册 callback 全部保持 inert ---
  const inert = await tryRun("inert", { wrapper: true, probe: null, obsEnv: manifest.assemblyFailureObserve });
  assertExitCode("inert", inert);
  assertEventMilestones("inert", inert);
  if (inert) {
    const disabled = stderrLines(inert, "extension disabled, assembly failed");
    assert("inert 装配失败诊断", "恰好 1 条 extension disabled", disabled, disabled.length === 1);
  }

  // --- sink-failure：sink 写入失败不阻断 Pi，observer 降级后停止后续写入 ---
  writeFileSync(join(runDir, "blocked"), "not a directory");
  const sinkFailure = await tryRun("sink-failure", {
    wrapper: true,
    probe: null,
    obsEnv: join(runDir, "blocked", "obs.jsonl"),
  });
  assertExitCode("sink-failure", sinkFailure);
  assertEventMilestones("sink-failure", sinkFailure);
  if (sinkFailure) {
    assert(
      "sink-failure 未产生观察文件",
      false,
      existsSync(join(runDir, "blocked", "obs.jsonl")),
      !existsSync(join(runDir, "blocked", "obs.jsonl")),
    );
    const degraded = stderrLines(sinkFailure, manifest.degradedStderrPattern);
    assert(
      "sink 失败后 observer 停止后续写入",
      `恰好 1 条 ${manifest.degradedStderrPattern}`,
      degraded,
      degraded.length === 1,
    );
  }

  // --- 注入失败：callback 异常沿 Pi 原生错误路径报告，Pi 仍完成必要运行里程碑 ---
  for (const probe of ["fail-session-start.ts", "fail-session-shutdown.ts"]) {
    const name = probe.replace(".ts", "");
    const injected = await tryRun(name, { wrapper: true, probe, obsEnv: join(runDir, `obs-${name}.jsonl`) });
    assertExitCode(name, injected);
    if (injected) {
      const hasExtensionError = injected.result.events.some((event) => event.type === "extension_error");
      assert(`${name} extension_error 事件`, true, hasExtensionError, hasExtensionError);
      if (injected.obsFile && existsSync(injected.obsFile)) {
        evidence[injected.obsFile.split("/").pop()] = sha256File(injected.obsFile);
      }
    }
    assertEventMilestones(name, injected);
  }

  // --- 脱敏扫描 ---
  const forbidden = manifest.redactionForbiddenPatterns.map((pattern) => new RegExp(pattern));
  for (const file of readdirSync(runDir).filter((name) => name.startsWith("obs-"))) {
    const content = readFileSync(join(runDir, file), "utf8");
    const hits = forbidden.filter((pattern) => pattern.test(content)).map(String);
    assert(`${file} 脱敏`, "无命中", hits, hits.length === 0);
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
