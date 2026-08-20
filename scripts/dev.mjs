#!/usr/bin/env node
/**
 * pi-openviking dev environment orchestrator: one-shot bootstrap of the
 * repository-local toolchain (.dev/toolchain), an isolated OpenViking dev
 * service (up/down/status), and an isolated Pi runner (pi). All parameters
 * are predetermined by shared/toolchain.mjs pins and dev/model-profile.json;
 * no user config is read and nothing outside the repository is touched.
 * Credentials are bridged from the user's Pi login into child process env at
 * spawn time only — never persisted. See docs/development.md.
 *
 *   npm run dev -- bootstrap|up|down|status|pi [args...]
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFingerprint, summarizeServerConfig } from "../shared/managed-server-state.mjs";
import { probeServerHealth } from "../shared/server-health.mjs";
import {
  ensurePython,
  ensureServerPackages,
  ensureUv,
  isToolchainPlatformSupported,
  OPENVIKING_SPEC,
  runProcess,
  TOOLCHAIN,
  toolchainPaths,
} from "../shared/toolchain.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_HOME = join(REPO_ROOT, ".dev");
const TOOLCHAIN_HOME = join(DEV_HOME, "toolchain");
const PROFILE_PATH = join(REPO_ROOT, "dev", "model-profile.json");

// 隔离开发服务：固定 loopback 端口（避开用户默认 1933），全部状态收敛在 run 目录。
const RUN_DIR = join(DEV_HOME, "runs", "openviking");
const OV_CONF = join(RUN_DIR, "ov.conf");
const OVCLI_CONF = join(RUN_DIR, "ovcli.conf");
const PID_FILE = join(RUN_DIR, "server.pid");
const LOG_FILE = join(RUN_DIR, "server.log");
const STATE_FILE = join(RUN_DIR, "server-state.json");
const MARKER_FILE = join(RUN_DIR, "owner.marker");
const DEV_HOST = "127.0.0.1";
const DEV_PORT = 19331;
const DEV_ENDPOINT = `http://${DEV_HOST}:${DEV_PORT}`;
const DEV_ACCOUNT = "dev";
const DEV_USER = "dev";
const STATE_VERSION = "dev-1";

// 隔离 Pi：agent dir 一处设定，auth/settings/sessions/extensions 全部派生隔离。
const PI_HOME = join(DEV_HOME, "pi");
const PI_EXTENSION_WRAPPER = join(PI_HOME, "extensions", "pi-openviking-dev", "index.ts");

const say = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

function fail(message, code = 1) {
  err(`✗ ${message}`);
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Model profile + credential bridge
// ---------------------------------------------------------------------------

/** Returns a list of problems; empty means the profile is usable. */
export function validateModelProfile(profile) {
  const problems = [];
  const need = (value, path) => {
    if (typeof value !== "string" || !value) problems.push(`${path} 缺失或不是非空字符串`);
    return value;
  };
  const validateApiKeyIdentity = (identity, path, { requireApiBase = false } = {}) => {
    const model = identity ?? {};
    need(model.provider, `${path}.provider`);
    need(model.model, `${path}.model`);
    if (requireApiBase) need(model.apiBase, `${path}.apiBase`);
    if (model.credentialKind !== "api_key") problems.push(`${path}.credentialKind 当前只支持 "api_key"`);
    if (typeof model.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(model.apiKeyEnv)) {
      problems.push(`${path}.apiKeyEnv 缺失或不是合法环境变量名`);
    }
  };
  validateApiKeyIdentity(profile?.taskModel, "taskModel");
  validateApiKeyIdentity(profile?.vlm, "vlm", { requireApiBase: true });
  const dense = profile?.embedding?.dense ?? {};
  need(dense.provider, "embedding.dense.provider");
  need(dense.model, "embedding.dense.model");
  if (!Number.isInteger(dense.dimension) || dense.dimension <= 0) {
    problems.push("embedding.dense.dimension 缺失或不是正整数");
  }
  return problems;
}

export function loadModelProfile(path = PROFILE_PATH) {
  let profile;
  try {
    profile = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`无法读取开发模型身份 ${path}: ${e?.message || e}`);
  }
  const problems = validateModelProfile(profile);
  if (problems.length) throw new Error(`${path} 无效：${problems.join("；")}`);
  return profile;
}

/**
 * 构造子进程环境：清除继承的全部 OPENVIKING_* 与调用方声明的凭证变量，再应用显式值。
 * OPENVIKING_URL 优先于 OPENVIKING_BASE_URL，用户 shell 导出的同名变量会静默击穿 dev 隔离。
 */
export function buildChildEnv(extra, base = process.env, clearKeys = []) {
  const cleared = new Set(clearKeys);
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith("OPENVIKING_") && !cleared.has(key) && value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

/**
 * 从用户 Pi 登录态桥接 API key：stdout pipe 读取，trim 后必须是单行非空。只返回给
 * spawn env 使用；不持久化、不回显。失败时提示 /login。
 */
export function bridgeCredential(identity) {
  const { provider, model } = identity;
  const res = runProcess("npm", ["exec", "--", "pi", "auth", "print-api-key", "--provider", provider, "--model", model], {
    capture: true,
  });
  const key = res.ok ? res.out.trim() : "";
  if (!res.ok || !key || key.includes("\n")) {
    throw new Error(`凭证未就绪：请在 pi 中执行 /login ${provider} 后重试。`);
  }
  return key;
}

/** 只探测凭证是否存在（不输出凭证本身），供 readiness 报告。 */
function credentialReady(identity) {
  const res = runProcess(
    "npm",
    ["exec", "--", "pi", "auth", "check", "--provider", identity.provider, "--model", identity.model],
    { capture: true },
  );
  return res.ok;
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

/** engines 形如 ">=22.19.0"；只支持该下限形式。 */
export function isNodeVersionSupported(current, engines) {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(engines ?? "");
  const cur = /^v?(\d+)\.(\d+)\.(\d+)/.exec(current ?? "");
  if (!min || !cur) return false;
  const cmp = (a, b) => Number(a) - Number(b);
  return (
    cmp(cur[1], min[1]) > 0 ||
    (cmp(cur[1], min[1]) === 0 && cmp(cur[2], min[2]) > 0) ||
    (cmp(cur[1], min[1]) === 0 && cmp(cur[2], min[2]) === 0 && cmp(cur[3], min[3]) >= 0)
  );
}

function preflight() {
  if (!isToolchainPlatformSupported(platform(), arch())) {
    fail(`没有适配 ${platform()}-${arch()} 的工具链预置二进制。`);
  }
  for (const cmd of ["git", "npm"]) {
    if (!runProcess(cmd, ["--version"], { capture: true }).ok) fail(`未检测到 ${cmd}，请先安装。`);
  }
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (!isNodeVersionSupported(process.version, pkg.engines?.node)) {
    fail(`Node ${process.version} 不满足 engines ${pkg.engines?.node}。`);
  }
  if (!existsSync(join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"))) {
    fail("本地依赖未安装，先运行 npm ci。");
  }
}

async function bootstrap() {
  say(
    `pi-openviking dev bootstrap — 工具链: uv ${TOOLCHAIN.uvVersion}, Python ${TOOLCHAIN.pythonVersion}, ${OPENVIKING_SPEC}`,
  );
  say(`目标: ${TOOLCHAIN_HOME}`);
  say("");

  preflight();
  const profile = loadModelProfile();

  try {
    await ensureUv({ home: TOOLCHAIN_HOME, mirror: process.env.PI_OPENVIKING_UV_MIRROR, log: say });
    ensurePython({ home: TOOLCHAIN_HOME, log: say });
    ensureServerPackages({ home: TOOLCHAIN_HOME, log: say });
  } catch (e) {
    fail(e?.message || String(e));
  }

  const { model, dimension } = profile.embedding.dense;
  say(`本地 embedding: ${model} (dimension ${dimension})；模型文件将在首次 dev up 启动服务时自动下载。`);

  for (const [label, identity] of [["任务模型", profile.taskModel], ["VLM", profile.vlm]]) {
    if (credentialReady(identity)) {
      say(`${label}凭证就绪: ${identity.provider}/${identity.model}`);
    } else {
      say(`${label}凭证未就绪: 请在 pi 中执行 /login ${identity.provider}；对应启动动作会再次检查。`);
    }
  }

  say("");
  say("完成。.dev/ 可整体删除，由 bootstrap 重建。");
}

// ---------------------------------------------------------------------------
// Dev service lifecycle (up/down/status)
// ---------------------------------------------------------------------------

/**
 * ov.conf 生成：vlm.api_key 写 ${ENV} 占位符，由 OpenViking 配置加载器在启动时
 * 从进程环境展开（os.path.expandvars），凭证不落盘。
 */
export function buildDevServerConfig(profile) {
  return {
    storage: { workspace: join(RUN_DIR, "data") },
    server: { host: DEV_HOST, port: DEV_PORT },
    embedding: {
      dense: {
        provider: profile.embedding.dense.provider,
        model: profile.embedding.dense.model,
        dimension: profile.embedding.dense.dimension,
        // 模型缓存收敛进 run 目录，不写 ~/.cache/openviking。
        cache_dir: join(RUN_DIR, "models"),
      },
    },
    vlm: {
      provider: profile.vlm.provider,
      model: profile.vlm.model,
      api_key: `\${${profile.vlm.apiKeyEnv}}`,
      api_base: profile.vlm.apiBase,
      temperature: 0.0,
      max_retries: 2,
    },
  };
}

/** 写入 marker（随机 nonce）与状态文件；返回 nonce。 */
export function createRunFiles(runDir, { pid, config }) {
  const nonce = randomBytes(16).toString("hex");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "owner.marker"), `pi-openviking-dev\n${nonce}\n`, { mode: 0o600 });
  const state = {
    version: STATE_VERSION,
    pid,
    nonce,
    startedAt: new Date().toISOString(),
    endpoint: DEV_ENDPOINT,
    configFingerprint: configFingerprint(config),
  };
  writeFileSync(join(runDir, "server-state.json"), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return nonce;
}

/** 核对 marker、状态文件与（可选）pid 三者一致；进程身份由调用方另行核对。 */
export function verifyRunFiles(runDir, { expectedPid } = {}) {
  let marker;
  try {
    marker = readFileSync(join(runDir, "owner.marker"), "utf8");
  } catch {
    return { ok: false, reason: "缺少 owner.marker" };
  }
  const markerMatch = /^pi-openviking-dev\n([0-9a-f]{32})\n$/.exec(marker);
  if (!markerMatch) return { ok: false, reason: "owner.marker 内容不符合预期格式" };
  let state;
  try {
    state = JSON.parse(readFileSync(join(runDir, "server-state.json"), "utf8"));
  } catch {
    return { ok: false, reason: "缺少或损坏的 server-state.json" };
  }
  if (state?.version !== STATE_VERSION) return { ok: false, reason: "状态文件版本不匹配" };
  if (state.nonce !== markerMatch[1]) return { ok: false, reason: "marker 与状态文件 nonce 不一致" };
  if (!Number.isInteger(state.pid) || state.pid <= 0) return { ok: false, reason: "状态文件 pid 无效" };
  if (expectedPid !== undefined && state.pid !== expectedPid) {
    return { ok: false, reason: "状态文件 pid 与 server.pid 不一致" };
  }
  return { ok: true, state };
}

/** 核对状态指纹、实际 ov.conf 与当前 profile 生成的期望配置三者一致。 */
export function verifyDevServerConfig(runDir, state, expectedConfig) {
  const expectedFingerprint = configFingerprint(expectedConfig);
  if (!state || typeof state.configFingerprint !== "string") {
    return { ok: false, reason: "状态文件缺少配置指纹", expectedFingerprint };
  }

  let actualConfig;
  try {
    actualConfig = JSON.parse(readFileSync(join(runDir, "ov.conf"), "utf8"));
  } catch {
    return { ok: false, reason: "缺少或损坏的 ov.conf", expectedFingerprint };
  }

  const actualFingerprint = configFingerprint(actualConfig);
  if (state.configFingerprint !== actualFingerprint) {
    return {
      ok: false,
      reason: "状态文件配置指纹与 ov.conf 不一致",
      stateFingerprint: state.configFingerprint,
      actualFingerprint,
      expectedFingerprint,
    };
  }
  if (actualFingerprint !== expectedFingerprint) {
    return {
      ok: false,
      reason: "运行配置与当前开发模型身份不一致",
      stateFingerprint: state.configFingerprint,
      actualFingerprint,
      expectedFingerprint,
    };
  }
  return {
    ok: true,
    stateFingerprint: state.configFingerprint,
    actualFingerprint,
    expectedFingerprint,
  };
}

/** dev pi 的任务模型只读取 profile.taskModel，避免交互运行身份漂移。 */
export function buildDevPiArgs(profile, args = []) {
  if (!Array.isArray(args)) throw new TypeError("dev pi args must be an array");
  const forbidden = new Set(["--provider", "--model", "--models", "--api-key"]);
  const override = args.find((arg) => (
    forbidden.has(arg) || [...forbidden].some((flag) => String(arg).startsWith(`${flag}=`))
  ));
  if (override) {
    throw new Error(`${override} 不能覆盖 dev/model-profile.json 固定的任务模型`);
  }
  const { provider, model } = profile.taskModel;
  const qualifiedModel = model.includes("/") ? model : `${provider}/${model}`;
  return ["--provider", provider, "--model", model, "--models", qualifiedModel, ...args];
}

function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** 进程命令行核对：linux 读 /proc，darwin 用 ps；win32 返回 null（跳过该项核对）。 */
export function readProcessCommand(pid, { platformName = platform() } = {}) {
  try {
    if (platformName === "linux") {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    }
    if (platformName === "darwin") {
      const res = runProcess("ps", ["-p", String(pid), "-o", "command="], { capture: true });
      return res.ok ? res.out.trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** cmdline 为 null 表示该平台无法核对，退化为仅 marker/状态核对。 */
export function isDevServerProcess(cmdline, ovConfPath = OV_CONF) {
  if (cmdline === null) return true;
  return cmdline.includes("openviking-server") && cmdline.includes(ovConfPath);
}

async function portFree(port) {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.once("error", () => resolvePromise(false));
    srv.once("listening", () => srv.close(() => resolvePromise(true)));
    srv.listen(port, DEV_HOST);
  });
}

async function killServer(pid) {
  if (platform() === "win32") {
    runProcess("taskkill", ["/PID", String(pid), "/T", "/F"], { capture: true });
    return;
  }
  // spawn 使用 detached:true，服务自成进程组；优先按组终止以覆盖 uvicorn worker 子进程。
  const kill = (signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  };
  kill();
  for (let i = 0; i < 15 && pidAlive(pid); i++) await sleep(1000);
  if (pidAlive(pid)) {
    kill("SIGKILL");
    await sleep(500);
  }
}

async function waitForHealth(pid, timeoutMs) {
  process.stdout.write(`启动中 (pid ${pid})，等待 ${DEV_ENDPOINT}/health …`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(1000);
    if ((await probeServerHealth(DEV_ENDPOINT)).ok) {
      say("\n✓ 服务已就绪。");
      return true;
    }
    if (!pidAlive(pid)) break;
    process.stdout.write(".");
  }
  say("");
  return false;
}

async function up() {
  const serverBin = toolchainPaths(TOOLCHAIN_HOME).serverBin;
  if (!existsSync(serverBin)) fail(`工具链未安装，先运行 npm run dev -- bootstrap。（缺少 ${serverBin}）`);
  const profile = loadModelProfile();

  // 身份核对：marker/状态/pid/进程命令行四者一致才认定为"我们的服务"。
  const existing = readPid();
  if (existing && pidAlive(existing)) {
    const ownership = verifyRunFiles(RUN_DIR, { expectedPid: existing });
    if (ownership.ok && isDevServerProcess(readProcessCommand(existing))) {
      const configCheck = verifyDevServerConfig(RUN_DIR, ownership.state, buildDevServerConfig(profile));
      say(`服务已在运行 (pid ${existing})。endpoint: ${DEV_ENDPOINT}`);
      if (!configCheck.ok) {
        fail(`当前开发服务配置不匹配（${configCheck.reason}），请先 npm run dev -- down，再重新 up。`);
      }
      return;
    }
    fail(`pid ${existing} 存活但身份核对失败（${ownership.ok ? "进程命令行不匹配" : ownership.reason}）。不接管身份不匹配的残留进程。`);
  }

  if (!(await portFree(DEV_PORT))) {
    fail(`端口 ${DEV_PORT} 被占用。若是残留的本服务进程，先 npm run dev -- down；否则释放端口。`);
  }

  // 凭证桥接：启动时经环境注入，ov.conf 只写 ${ENV} 占位符。
  let apiKey;
  try {
    apiKey = bridgeCredential(profile.vlm);
  } catch (e) {
    fail(e.message);
  }

  const config = buildDevServerConfig(profile);
  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(OV_CONF, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(serverBin, ["--config", OV_CONF], {
    cwd: RUN_DIR,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    // OPENVIKING_CODEX_AUTH_PATH：防止服务读写用户默认的 codex auth。
    env: buildChildEnv({
      [profile.vlm.apiKeyEnv]: apiKey,
      OPENVIKING_CODEX_AUTH_PATH: join(RUN_DIR, "codex_auth.json"),
    }, process.env, [profile.taskModel.apiKeyEnv, profile.vlm.apiKeyEnv]),
  });
  closeSync(logFd);
  let spawnError = null;
  child.once("error", (e) => {
    spawnError = e;
  });
  if (child.pid === undefined) {
    fail(`服务进程启动失败（${spawnError?.message || "无法 spawn"}）。`);
  }

  // 落盘失败时杀掉已启动的进程，不留 down 无法接管的孤儿。
  try {
    writeFileSync(PID_FILE, String(child.pid));
    createRunFiles(RUN_DIR, { pid: child.pid, config });
  } catch (e) {
    await killServer(child.pid);
    fail(`写入运行状态失败（${e?.message || e}），已终止刚启动的进程。`);
  }
  child.unref();

  // 首次启动需下载本地 embedding 模型，放宽等待。
  if (!(await waitForHealth(child.pid, 180_000))) {
    await killServer(child.pid);
    rmSync(PID_FILE, { force: true });
    rmSync(STATE_FILE, { force: true });
    fail(`服务未就绪。查看日志: ${LOG_FILE}`);
  }
  // 端口探测存在 TOCTOU 窗口：确认存活与进程身份后才算成功。
  if (!pidAlive(child.pid) || !isDevServerProcess(readProcessCommand(child.pid))) {
    rmSync(PID_FILE, { force: true });
    rmSync(STATE_FILE, { force: true });
    fail("health 响应者身份无法确认为本服务进程。查看日志: " + LOG_FILE);
  }
  say(`endpoint: ${DEV_ENDPOINT}（workspace: ${join(RUN_DIR, "data")}）`);
}

async function down() {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    rmSync(STATE_FILE, { force: true });
    say("服务未在运行。");
    return;
  }
  const ownership = verifyRunFiles(RUN_DIR, { expectedPid: pid });
  if (!ownership.ok || !isDevServerProcess(readProcessCommand(pid))) {
    fail(`拒绝停止 pid ${pid}：身份核对失败（${ownership.ok ? "进程命令行不匹配" : ownership.reason}）。`);
  }
  await killServer(pid);
  const stillAlive = pidAlive(pid);
  if (!stillAlive) {
    rmSync(PID_FILE, { force: true });
    rmSync(STATE_FILE, { force: true });
  }
  say(stillAlive ? "✗ 进程仍在运行，请手动检查。" : "✓ 服务已停止（workspace 与 toolchain 保留）。");
  if (stillAlive) process.exitCode = 1;
}

async function status() {
  const pid = readPid();
  const alive = pid ? pidAlive(pid) : false;
  const ownership = existsSync(STATE_FILE) && pid ? verifyRunFiles(RUN_DIR, { expectedPid: pid }) : null;
  let profile = null;
  let profileError = null;
  try {
    profile = loadModelProfile();
  } catch (e) {
    profileError = e;
  }
  const identityOk = Boolean(alive && ownership?.ok && isDevServerProcess(readProcessCommand(pid)));
  const configCheck = identityOk && profile
    ? verifyDevServerConfig(RUN_DIR, ownership.state, buildDevServerConfig(profile))
    : null;

  say(`service:    ${alive ? `running (pid ${pid})` : "stopped"}${alive && !identityOk ? "（身份未确认）" : ""}`);
  const health = await probeServerHealth(DEV_ENDPOINT);
  if (health.ok) {
    const version = health.data?.version ? `OpenViking ${health.data.version}` : "OpenViking";
    const auth = health.data?.auth_mode ? `, auth ${health.data.auth_mode}` : "";
    say(`health:     OK (${version}${auth})${identityOk ? "" : "（非本服务）"}`);
  } else {
    say(`health:     ${health.statusCode ? `FAIL (HTTP ${health.statusCode})` : "不可达"}`);
  }
  say(`endpoint:   ${DEV_ENDPOINT}`);
  if (alive) {
    say(`config:     ${configCheck?.ok ? "matches profile" : `DRIFT (${configCheck?.reason || profileError?.message || ownership?.reason || "身份未确认"})`}`);
  }

  if (profile) say(`任务模型:   ${profile.taskModel.provider}/${profile.taskModel.model}`);
  if (existsSync(OV_CONF)) {
    try {
      const summary = summarizeServerConfig(JSON.parse(readFileSync(OV_CONF, "utf8")));
      say(`embedding:  ${summary.embedding.provider}/${summary.embedding.model} (dimension ${summary.embedding.dimension})`);
      say(`VLM:        ${summary.vlm.provider}/${summary.vlm.model} (credential: ${summary.vlm.credential})`);
    } catch (e) {
      say(`config:     INVALID (${e?.message || e})`);
    }
  } else {
    say("config:     未生成（先运行 npm run dev -- up）");
  }

  if (profile) {
    for (const [label, identity] of [["任务模型", profile.taskModel], ["VLM", profile.vlm]]) {
      const ready = credentialReady(identity);
      say(`${label}凭证: ${ready ? "ready" : `not ready（/login ${identity.provider}）`}`);
    }
  } else {
    say(`credential: profile 无效（${profileError?.message || "未知错误"}）`);
  }
  say(`log:        ${LOG_FILE}`);
  if (!alive || !health.ok || !identityOk || !configCheck?.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Isolated Pi runner
// ---------------------------------------------------------------------------

/** wrapper 让隔离 agent dir 的扩展自动发现指向仓库 index.ts，/reload 可用。 */
export function piWrapperSource() {
  return `// Generated by \`npm run dev -- pi\`. Loads the repo extension; safe to delete.\nexport { default } from "../../../../index.ts";\n`;
}

function ensurePiWrapper() {
  const content = piWrapperSource();
  try {
    if (readFileSync(PI_EXTENSION_WRAPPER, "utf8") === content) return;
  } catch {
    /* 不存在则写 */
  }
  mkdirSync(dirname(PI_EXTENSION_WRAPPER), { recursive: true });
  writeFileSync(PI_EXTENSION_WRAPPER, content);
}

async function pi(args) {
  const pid = readPid();
  const ownership = pid && pidAlive(pid) ? verifyRunFiles(RUN_DIR, { expectedPid: pid }) : null;
  if (!ownership?.ok || !isDevServerProcess(readProcessCommand(pid))) {
    fail("开发服务未运行或身份未确认，先 npm run dev -- up。");
  }
  const profile = loadModelProfile();
  const configCheck = verifyDevServerConfig(RUN_DIR, ownership.state, buildDevServerConfig(profile));
  if (!configCheck.ok) {
    fail(`开发服务配置不匹配（${configCheck.reason}），请先 npm run dev -- down，再重新 up。`);
  }
  let piArgs;
  try {
    piArgs = buildDevPiArgs(profile, args);
  } catch (e) {
    fail(e.message);
  }

  let apiKey;
  try {
    apiKey = bridgeCredential(profile.taskModel);
  } catch (e) {
    fail(e.message);
  }
  ensurePiWrapper();

  const child = spawn("npm", ["exec", "--", "pi", ...piArgs], {
    stdio: "inherit",
    windowsHide: true,
    env: buildChildEnv({
      PI_CODING_AGENT_DIR: PI_HOME,
      OPENVIKING_BASE_URL: DEV_ENDPOINT,
      OPENVIKING_ACCOUNT: DEV_ACCOUNT,
      OPENVIKING_USER: DEV_USER,
      OPENVIKING_CONFIG_FILE: OV_CONF,
      OPENVIKING_CLI_CONFIG_FILE: OVCLI_CONF,
      [profile.taskModel.apiKeyEnv]: apiKey,
    }, process.env, [profile.taskModel.apiKeyEnv, profile.vlm.apiKeyEnv]),
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "bootstrap":
      bootstrap().catch((e) => fail(e?.message || String(e)));
      break;
    case "up":
      up().catch((e) => fail(e?.message || String(e)));
      break;
    case "down":
      down().catch((e) => fail(e?.message || String(e)));
      break;
    case "status":
      status().catch((e) => fail(e?.message || String(e)));
      break;
    case "pi":
      pi(rest).catch((e) => fail(e?.message || String(e)));
      break;
    default:
      say("用法: npm run dev -- bootstrap|up|down|status|pi [args...]");
      process.exitCode = cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
