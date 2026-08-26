#!/usr/bin/env node
/**
 * run-boundary live gate：验证「运行边界与观察」阶段系统保证——
 * 扩展在真实 Pi 中加载与卸载；任一扩展链路失败时 Pi 主任务继续运行；
 * 每次运行留下可关联、已脱敏的结构化证据。
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
import { get as httpGet } from "node:http";
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

function httpOk(url) {
  return new Promise((resolve) => {
    const req = httpGet(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(5000, () => req.destroy());
  });
}

function filteredSequence(events, filteredOut) {
  return events.map((event) => event.type).filter((type) => !filteredOut.includes(type));
}

function sha256File(file) {
  return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

// --- 身份先行 ---
const manifest = loadManifest(GATE_DIR);
const version = spawnSync(join(REPO, "node_modules", ".bin", "pi"), ["--version"], { encoding: "utf8" })
  .stdout.trim();
if (version !== manifest.identity.piVersion) {
  fail(`Pi 版本不符：期望 ${manifest.identity.piVersion}，实际 ${version || "不可用"}`);
}
if (!(await httpOk(`${manifest.identity.endpoint}/health`))) {
  fail(`OpenViking endpoint 不可用：${manifest.identity.endpoint}`);
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
mkdirSync(agentDir, { recursive: true });
// 凭证桥沿用 docs/development.md「凭证边界」的同文件引用：Pi 对 token 的刷新写入落在用户已授权的
// auth store（与 dev 环境同一机制）；gate 不复制凭证，run dir 清理只移除引用。
const authSource = join(DEV_PI, "auth.json");
try {
  symlinkSync(readlinkSync(authSource), join(agentDir, "auth.json"));
} catch {
  linkSync(authSource, join(agentDir, "auth.json"));
}
cpSync(join(DEV_PI, "models-store.json"), join(agentDir, "models-store.json"));
cpSync(join(DEV_PI, "settings.json"), join(agentDir, "settings.json"));

const wrapperDir = join(agentDir, "extensions", "pi-openviking-dev");
const writeWrapper = () => {
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(wrapperDir + "/index.ts", `export { default } from "${join(REPO, "src", "index.ts")}";\n`);
};

const assertions = [];
const assert = (name, expected, actual, pass) => {
  assertions.push({ name, expected, actual, pass });
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

async function runWorkload(name, { wrapper, probe, observe }) {
  if (wrapper) writeWrapper();
  const sessionsDir = join(runDir, `sessions-${name}`);
  const obsFile = observe ? join(runDir, `obs-${name}.jsonl`) : undefined;
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
      ...(obsFile ? { PI_OPENVIKING_OBSERVE: obsFile } : {}),
    },
    commands,
    timeoutMs: manifest.runTimeoutMs,
  });
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

function sequenceOf(workload) {
  return workload ? filteredSequence(workload.result.events, manifest.filteredOut) : null;
}

function assertSequence(name, workload, reference) {
  const sequence = sequenceOf(workload);
  assert(
    `${name} 事件序列与 baseline 一致`,
    reference ?? "baseline 运行失败",
    sequence ?? "运行失败",
    sequence !== null && reference !== null && JSON.stringify(sequence) === JSON.stringify(reference),
  );
}

try {
  // --- baseline：未加载扩展 ---
  const baseline = await tryRun("baseline", { wrapper: false, probe: null, observe: false });
  if (baseline) {
    assert(
      "baseline exit code",
      manifest.exitCode,
      baseline.result.code,
      baseline.result.code === manifest.exitCode,
    );
  }
  const baselineSequence = sequenceOf(baseline);
  assert(
    "baseline 事件序列",
    manifest.expectedSequence,
    baselineSequence ?? "运行失败",
    baselineSequence !== null && JSON.stringify(baselineSequence) === JSON.stringify(manifest.expectedSequence),
  );

  // --- loaded：扩展加载 + 观察开启 ---
  const loaded = await tryRun("loaded", { wrapper: true, probe: null, observe: true });
  if (loaded) {
    assert("loaded exit code", manifest.exitCode, loaded.result.code, loaded.result.code === manifest.exitCode);
    const hasExtensionError = loaded.result.events.some((event) => event.type === "extension_error");
    assert("loaded 无 extension_error", false, hasExtensionError, !hasExtensionError);
  }
  assertSequence("loaded", loaded, baselineSequence);

  // 观察证据：可关联、字段齐全、链路结果全部 ok
  const obsFile = loaded?.obsFile;
  const obsExists = obsFile !== undefined && existsSync(obsFile);
  assert("loaded 观察文件存在", true, obsExists, obsExists);
  if (obsExists) {
    evidence[obsFile.split("/").pop()] = sha256File(obsFile);
    const records = readFileSync(obsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert(
      "观察操作序列",
      manifest.observationOperations,
      records.map((record) => record.operation),
      JSON.stringify(records.map((record) => record.operation)) === JSON.stringify(manifest.observationOperations),
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
  }

  // --- 注入失败：各注册点失败后 Pi 行为与 baseline 一致 ---
  for (const probe of ["fail-session-start.ts", "fail-session-shutdown.ts"]) {
    const name = probe.replace(".ts", "");
    const injected = await tryRun(name, { wrapper: true, probe, observe: true });
    if (injected) {
      assert(
        `${name} exit code`,
        manifest.exitCode,
        injected.result.code,
        injected.result.code === manifest.exitCode,
      );
      const hasExtensionError = injected.result.events.some((event) => event.type === "extension_error");
      assert(`${name} extension_error 事件`, true, hasExtensionError, hasExtensionError);
      if (existsSync(injected.obsFile)) evidence[injected.obsFile.split("/").pop()] = sha256File(injected.obsFile);
    }
    assertSequence(name, injected, baselineSequence);
  }

  // --- 脱敏扫描 ---
  const forbidden = manifest.redactionForbiddenPatterns.map((pattern) => new RegExp(pattern));
  for (const file of readdirSync(runDir).filter((name) => name.startsWith("obs-"))) {
    const content = readFileSync(join(runDir, file), "utf8");
    const hits = forbidden.filter((pattern) => pattern.test(content)).map(String);
    assert(`${file} 脱敏`, "无命中", hits, hits.length === 0);
  }
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
      identity: { piVersion: version, endpoint: manifest.identity.endpoint, taskModel: `${provider}/${model}` },
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
