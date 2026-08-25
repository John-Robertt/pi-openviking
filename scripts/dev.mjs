#!/usr/bin/env node
/**
 * 仓库开发环境：安装受管工具链、运行隔离的 OpenViking 服务、进入隔离 Pi。
 *
 * 全部运行时产物收敛在 .dev/；不复用用户的 ~/.pi 会话数据，也不接管非本工具启动的进程。
 * 命令：bootstrap | up | down | status | pi
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENVIKING_OAUTH_PROVIDERS, openVikingOAuthProvider } from "./openviking-oauth.mjs";
import {
  TOOLCHAIN,
  ensurePython,
  ensureServerPackages,
  ensureUv,
  isToolchainPlatformSupported,
  runProcess,
  toolchainPaths,
} from "./toolchain.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV = join(REPO, ".dev");
const TOOLCHAIN_HOME = join(DEV, "toolchain");
const OV_HOME = join(DEV, "openviking");
const OV_CONF = join(OV_HOME, "ov.conf");
const OV_DATA = join(OV_HOME, "data");
const OV_MODELS = join(OV_HOME, "models");
const OV_MARKER = join(OV_HOME, "owner.marker");
const OV_STATE = join(OV_HOME, "server-state.json");
const OV_PID = join(OV_HOME, "server.pid");
const OV_LOG = join(OV_HOME, "server.log");
const PI_HOME = join(DEV, "pi");
const PI_WRAPPER = join(PI_HOME, "extensions", "pi-openviking-dev", "index.ts");
const REPO_EXTENSION = join(REPO, "index.ts");
const PROFILE_PATH = join(REPO, "dev", "model-profile.json");
const OAUTH_STORE_DIR = join(homedir(), ".openviking", "pi-openviking-dev");

const HOST = "127.0.0.1";
const PORT = 19331;
const ENDPOINT = `http://${HOST}:${PORT}`;
const ACCOUNT = "dev";
const USER = "dev";
const STATE_VERSION = "dev-1";
const READY_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;

const say = (msg) => console.log(msg);
const step = (msg) => console.log(`  • ${msg}`);
function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 基础能力
// ---------------------------------------------------------------------------

function httpGet(url, timeoutMs = 3000) {
  return new Promise((done) => {
    const req = httpRequest(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on("error", () => done({ ok: false, status: 0, body: "" }));
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, status: 0, body: "" });
    });
    req.end();
  });
}

function portFree(port) {
  return new Promise((done) => {
    const srv = createServer();
    srv.once("error", () => done(false));
    srv.once("listening", () => srv.close(() => done(true)));
    srv.listen(port, HOST);
  });
}

/** engines 形如 ">=22.19.0"；只支持该下限形式。 */
export function isNodeVersionSupported(current, engines) {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(engines ?? "");
  const cur = /^v?(\d+)\.(\d+)\.(\d+)/.exec(current ?? "");
  if (!min || !cur) return false;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(cur[i]) - Number(min[i]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 开发模型身份
// ---------------------------------------------------------------------------

function loadProfile() {
  const profile = readJson(PROFILE_PATH);
  if (!profile) fail(`无法解析 ${PROFILE_PATH}`);
  for (const key of ["taskModel", "vlm"]) {
    const id = profile[key];
    if (!id?.provider || !id?.model) fail(`${PROFILE_PATH} 的 ${key} 缺少 provider/model`);
    if (id.credentialKind !== "oauth" && id.credentialKind !== "api_key") {
      fail(`${PROFILE_PATH} 的 ${key}.credentialKind 必须是 oauth 或 api_key`);
    }
    if (id.credentialKind === "oauth" && key === "vlm" && !openVikingOAuthProvider(id.provider)) {
      fail(`${PROFILE_PATH} 的 vlm OAuth 当前只支持 ${Object.keys(OPENVIKING_OAUTH_PROVIDERS).join("/")}`);
    }
    if (id.credentialKind === "api_key" && !id.apiKeyEnv) fail(`${PROFILE_PATH} 的 ${key} 缺少 apiKeyEnv`);
  }
  const dense = profile.embedding?.dense;
  if (!dense?.provider || !dense?.model || !dense?.dimension) {
    fail(`${PROFILE_PATH} 的 embedding.dense 缺少 provider/model/dimension`);
  }
  return profile;
}

// ---------------------------------------------------------------------------
// 服务端模型凭证：只传递引用，不复制凭证值
// ---------------------------------------------------------------------------

function oauthStorePath(oauth) {
  return join(OAUTH_STORE_DIR, oauth.storeFile);
}

/** OpenViking 服务进程读取凭证所需的环境变量；OAuth 只传路径。 */
function serverCredentialEnv(identity) {
  const oauth = identity?.credentialKind === "oauth" ? openVikingOAuthProvider(identity.provider) : null;
  if (!oauth) return {};
  mkdirSync(OAUTH_STORE_DIR, { recursive: true, mode: 0o700 });
  return { [oauth.authPathEnv]: oauthStorePath(oauth), [oauth.bootstrapPathEnv]: oauth.bootstrapPath() };
}

/** 就绪探测锁定本仓库 pin 的 OpenViking 安装执行；stdout 不输出凭证。 */
function serverCredentialReady(identity) {
  const oauth = identity?.credentialKind === "oauth" ? openVikingOAuthProvider(identity.provider) : null;
  if (!oauth) return identity?.credentialKind === "api_key" ? Boolean(process.env[identity.apiKeyEnv]) : false;
  const python = toolchainPaths(TOOLCHAIN_HOME).venvPython;
  if (!existsSync(python)) return false;
  return runProcess(python, ["-c", oauth.readinessProbe], {
    capture: true,
    env: { ...process.env, ...serverCredentialEnv(identity) },
  }).ok;
}

// ---------------------------------------------------------------------------
// 服务配置
// ---------------------------------------------------------------------------

function buildServerConfig(profile) {
  const dense = profile.embedding.dense;
  const config = {
    storage: { workspace: OV_DATA },
    server: { host: HOST, port: PORT },
    embedding: {
      dense: { provider: dense.provider, model: dense.model, dimension: dense.dimension, cache_dir: OV_MODELS },
    },
    vlm: { provider: profile.vlm.provider, model: profile.vlm.model, temperature: 0, max_retries: 2 },
  };
  if (profile.vlm.apiBase) config.vlm.api_base = profile.vlm.apiBase;
  return config;
}

// ---------------------------------------------------------------------------
// 所有权与进程身份
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

/** 读取进程命令行；win32 无法核对时返回 null，由 marker/state 单独判定。 */
function processCommand(pid) {
  if (platform() === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    } catch {
      return null;
    }
  }
  if (platform() === "win32") return null;
  const res = runProcess("ps", ["-p", String(pid), "-o", "command="], { capture: true });
  return res.ok ? res.out.trim() : null;
}

/**
 * 确认服务归本工具所有：marker 与 state 的 nonce 一致、pid 文件与 state 一致、
 * 进程命令行指向本 run 目录的 ov.conf。任一项不成立都不视为己方进程。
 */
function verifyOwnership() {
  const marker = readJson(OV_MARKER);
  const state = readJson(OV_STATE);
  const pidText = existsSync(OV_PID) ? readFileSync(OV_PID, "utf8").trim() : "";
  const pid = Number(pidText);
  if (!marker?.nonce || !state?.nonce) return { ok: false, reason: "缺少 marker 或 state" };
  if (marker.nonce !== state.nonce) return { ok: false, reason: "marker 与 state 的 nonce 不一致" };
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: "server.pid 无效" };
  if (state.pid !== pid) return { ok: false, reason: "server.pid 与 state 不一致" };
  if (!pidAlive(pid)) return { ok: false, reason: "进程不存在", stale: true, pid };
  const cmd = processCommand(pid);
  if (cmd !== null && !cmd.includes(OV_CONF)) return { ok: false, reason: "进程命令行不指向本 run 目录" };
  return { ok: true, pid, state, commandChecked: cmd !== null };
}

function clearRunFiles() {
  for (const f of [OV_STATE, OV_PID, OV_MARKER]) rmSync(f, { force: true });
}

// ---------------------------------------------------------------------------
// bootstrap
// ---------------------------------------------------------------------------

async function bootstrap() {
  say("bootstrap: 建立仓库内开发环境");
  if (!isToolchainPlatformSupported()) fail(`当前平台 ${platform()}-${process.arch} 没有受管工具链。`);
  const engines = readJson(join(REPO, "package.json"))?.engines?.node;
  if (!isNodeVersionSupported(process.version, engines)) {
    fail(`Node ${process.version} 不满足 package.json#engines ${engines}`);
  }
  step(`Node ${process.version} 满足 ${engines}`);
  const profile = loadProfile();
  step(`模型身份: task=${profile.taskModel.provider}/${profile.taskModel.model} vlm=${profile.vlm.provider}/${profile.vlm.model}`);

  mkdirSync(TOOLCHAIN_HOME, { recursive: true });
  await ensureUv({ home: TOOLCHAIN_HOME, mirror: process.env.PI_OPENVIKING_UV_MIRROR, log: step });
  ensurePython({ home: TOOLCHAIN_HOME, log: step });
  ensureServerPackages({ home: TOOLCHAIN_HOME, log: step });
  step(`openviking ${TOOLCHAIN.openvikingVersion} 就绪`);

  const vlmReady = serverCredentialReady(profile.vlm);
  step(`服务端模型凭证: ${vlmReady ? "ready" : "未就绪（服务端摘要将不可用）"}`);
  say("✓ bootstrap 完成。下一步: npm run dev -- up");
}

// ---------------------------------------------------------------------------
// up / down / status
// ---------------------------------------------------------------------------

async function up() {
  const paths = toolchainPaths(TOOLCHAIN_HOME);
  if (!existsSync(paths.serverBin)) fail("工具链未就绪，先运行 npm run dev -- bootstrap。");

  const owned = verifyOwnership();
  if (owned.ok) {
    const health = await httpGet(`${ENDPOINT}/health`);
    say(health.ok ? `服务已在运行: ${ENDPOINT} (pid ${owned.pid})` : `进程存在但 health 未通过 (pid ${owned.pid})，见 ${OV_LOG}`);
    return;
  }
  if (owned.stale) {
    step(`清理陈旧状态（pid ${owned.pid} 已不存在）`);
    clearRunFiles();
  } else if (existsSync(OV_STATE) || existsSync(OV_MARKER)) {
    fail(`已有无法确认归属的运行状态（${owned.reason}）。核对 ${OV_HOME} 后手动清理再重试。`);
  }
  if (!(await portFree(PORT))) fail(`端口 ${PORT} 被占用，且不属于本工具启动的服务。`);

  const profile = loadProfile();
  mkdirSync(OV_DATA, { recursive: true });
  mkdirSync(OV_MODELS, { recursive: true });
  writeFileSync(OV_CONF, `${JSON.stringify(buildServerConfig(profile), null, 2)}\n`, { mode: 0o600 });

  const nonce = randomBytes(16).toString("hex");
  // exclusive create：并发 up 时只有一个能建立所有权。
  try {
    writeFileSync(OV_MARKER, `${JSON.stringify({ version: STATE_VERSION, nonce, home: OV_HOME }, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    fail(`已存在 ${OV_MARKER}，另一个 up 可能正在进行。`);
  }

  const logFd = openSync(OV_LOG, "a", 0o600);
  const child = spawn(paths.serverBin, ["--config", OV_CONF], {
    detached: true, // 独立进程组，down 时可整组停止
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: { ...process.env, ...serverCredentialEnv(profile.vlm) },
  });
  child.unref();
  const pid = child.pid;
  writeFileSync(OV_PID, `${pid}\n`, { mode: 0o600 });
  writeFileSync(
    OV_STATE,
    `${JSON.stringify({ version: STATE_VERSION, pid, nonce, endpoint: ENDPOINT, startedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  step(`启动 openviking-server (pid ${pid})`);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) fail(`服务进程已退出，见 ${OV_LOG}`);
    const health = await httpGet(`${ENDPOINT}/health`);
    if (health.ok) {
      const body = (() => {
        try {
          return JSON.parse(health.body);
        } catch {
          return {};
        }
      })();
      say(`✓ 服务就绪: ${ENDPOINT} (openviking ${body.version ?? "?"}, pid ${pid})`);
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`服务在 ${READY_TIMEOUT_MS}ms 内未就绪，见 ${OV_LOG}`);
}

async function down() {
  const owned = verifyOwnership();
  if (owned.stale) {
    clearRunFiles();
    say("服务未运行，已清理陈旧状态。");
    return;
  }
  if (!owned.ok) {
    if (!existsSync(OV_STATE) && !existsSync(OV_MARKER)) {
      say("服务未运行。");
      return;
    }
    fail(`拒绝停止：无法确认进程归属（${owned.reason}）。`);
  }
  const { pid } = owned;
  step(`停止进程组 ${pid}${owned.commandChecked ? "（命令行已核对）" : "（本平台无法核对命令行）"}`);
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* 已退出 */
    }
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && pidAlive(pid)) await new Promise((r) => setTimeout(r, 200));
  if (pidAlive(pid)) {
    step("SIGTERM 超时，发送 SIGKILL");
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* 已退出 */
    }
    while (pidAlive(pid)) await new Promise((r) => setTimeout(r, 200));
  }
  clearRunFiles();
  say(`✓ 已停止 (pid ${pid})；数据保留在 ${OV_HOME}`);
}

async function status() {
  const paths = toolchainPaths(TOOLCHAIN_HOME);
  say("工具链");
  const uv = runProcess(paths.uvBin, ["--version"], { capture: true });
  step(`uv:         ${uv.ok ? uv.out.trim() : "未安装"}`);
  const server = runProcess(paths.serverBin, ["--version"], { capture: true });
  step(`openviking: ${server.ok ? server.out.trim().split("\n").pop() : "未安装"} (pin ${TOOLCHAIN.openvikingVersion})`);
  const piBin = join(REPO, "node_modules", ".bin", platform() === "win32" ? "pi.cmd" : "pi");
  const pi = runProcess(piBin, ["--version"], { capture: true });
  step(`pi:         ${pi.ok ? pi.out.trim() : "未安装（npm ci）"}`);

  say("服务");
  const owned = verifyOwnership();
  if (owned.ok) {
    const health = await httpGet(`${ENDPOINT}/health`);
    step(`状态:       ${health.ok ? "running" : "进程存在但 health 未通过"}`);
    step(`endpoint:   ${ENDPOINT} (pid ${owned.pid})`);
    step(`启动于:     ${owned.state.startedAt}`);
  } else {
    step(`状态:       ${owned.stale ? "已退出（存在陈旧状态）" : existsSync(OV_STATE) ? `未确认归属：${owned.reason}` : "未运行"}`);
  }

  say("凭证");
  const profile = loadProfile();
  step(`服务端模型: ${profile.vlm.provider}/${profile.vlm.model} — ${serverCredentialReady(profile.vlm) ? "ready" : "未就绪"}`);
  const taskOauth = profile.taskModel.credentialKind === "oauth";
  const piAuth = join(homedir(), ".pi", "agent", "auth.json");
  step(`任务模型:   ${profile.taskModel.provider}/${profile.taskModel.model} — ${taskOauth ? (existsSync(piAuth) ? "ready (Pi OAuth)" : "未登录") : process.env[profile.taskModel.apiKeyEnv] ? "ready" : "未就绪"}`);
}

// ---------------------------------------------------------------------------
// 隔离 Pi
// ---------------------------------------------------------------------------

function sameFile(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}

/** OAuth 不降级为 API key：隔离 Pi 只建立对用户 auth store 的同文件引用，不复制 token。 */
function ensurePiAuthBridge(identity) {
  const source = join(homedir(), ".pi", "agent", "auth.json");
  const target = join(PI_HOME, "auth.json");
  if (identity.credentialKind !== "oauth") {
    if (sameFile(source, target)) rmSync(target, { force: true });
    return;
  }
  let st;
  try {
    st = statSync(source);
  } catch {
    fail(`OAuth 凭证未就绪：先在 Pi 中执行 /login ${identity.provider}。`);
  }
  if (!st.isFile()) fail("Pi auth.json 不是普通文件。");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail("Pi auth.json 不属于当前用户。");
  if (platform() !== "win32" && (st.mode & 0o077) !== 0) fail("Pi auth.json 权限过宽；必须仅当前用户可读写。");

  mkdirSync(PI_HOME, { recursive: true, mode: 0o700 });
  try {
    lstatSync(target);
    if (sameFile(source, target)) return;
    fail(`隔离 Pi 已存在独立 auth.json，拒绝覆盖：${target}`);
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
  }
  try {
    symlinkSync(source, target, "file");
  } catch (symErr) {
    try {
      linkSync(source, target);
    } catch (linkErr) {
      fail(`无法建立 Pi OAuth 凭证引用：${linkErr?.message || symErr?.message}`);
    }
  }
}

/** 命令行不得覆盖 profile 固定的任务模型身份。 */
export function buildPiArgs(profile, args = []) {
  const forbidden = ["--provider", "--model", "--models", "--api-key"];
  const override = args.find((a) => forbidden.includes(a) || forbidden.some((f) => String(a).startsWith(`${f}=`)));
  if (override) throw new Error(`${override} 不能覆盖 dev/model-profile.json 固定的任务模型`);
  const { provider, model } = profile.taskModel;
  const qualified = model.includes("/") ? model : `${provider}/${model}`;
  return ["--provider", provider, "--model", model, "--models", qualified, ...args];
}

/** wrapper 使隔离 agent dir 自动发现仓库扩展，且 /reload 可用。扩展尚未建立时不生成。 */
function ensurePiWrapper() {
  if (!existsSync(REPO_EXTENSION)) {
    rmSync(dirname(PI_WRAPPER), { recursive: true, force: true });
    return false;
  }
  const content = '// Generated by `npm run dev -- pi`. Loads the repo extension; safe to delete.\nexport { default } from "../../../../index.ts";\n';
  try {
    if (readFileSync(PI_WRAPPER, "utf8") === content) return true;
  } catch {
    /* 不存在则写 */
  }
  mkdirSync(dirname(PI_WRAPPER), { recursive: true });
  writeFileSync(PI_WRAPPER, content);
  return true;
}

async function pi(args) {
  const owned = verifyOwnership();
  if (!owned.ok) fail(`开发服务未运行或身份未确认（${owned.reason}），先 npm run dev -- up。`);
  const health = await httpGet(`${ENDPOINT}/health`);
  if (!health.ok) fail(`开发服务 health 未通过，见 ${OV_LOG}`);

  const profile = loadProfile();
  let piArgs;
  try {
    piArgs = buildPiArgs(profile, args);
  } catch (e) {
    fail(e.message);
  }
  ensurePiAuthBridge(profile.taskModel);
  const loaded = ensurePiWrapper();
  say(`隔离 Pi: agentDir=${PI_HOME} endpoint=${ENDPOINT} 扩展=${loaded ? "已加载" : "尚未建立"}`);

  const piBin = join(REPO, "node_modules", ".bin", platform() === "win32" ? "pi.cmd" : "pi");
  if (!existsSync(piBin)) fail("Pi CLI 未安装，先运行 npm ci。");
  const child = spawn(piBin, piArgs, {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: PI_HOME,
      OPENVIKING_BASE_URL: ENDPOINT,
      OPENVIKING_ACCOUNT: ACCOUNT,
      OPENVIKING_USER: USER,
    },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

// ---------------------------------------------------------------------------

const HELP = `仓库开发环境

  npm run dev -- bootstrap   安装受管工具链到 .dev/toolchain（幂等，不启动服务）
  npm run dev -- up          启动隔离 OpenViking 服务
  npm run dev -- status      显示工具链、服务与凭证状态
  npm run dev -- down        停止服务（保留数据）
  npm run dev -- pi [args]   进入隔离 Pi，附加参数透传
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "bootstrap":
      return bootstrap();
    case "up":
      return up();
    case "down":
      return down();
    case "status":
      return status();
    case "pi":
      return pi(args);
    default:
      say(HELP);
      if (command && command !== "help") process.exit(1);
  }
}

// 仅在直接执行时运行；被 import 时只暴露纯函数，不产生副作用。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e?.message || String(e)));
}
