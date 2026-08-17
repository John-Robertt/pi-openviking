#!/usr/bin/env node
/**
 * pi-openviking CLI — one-command setup and cross-platform server lifecycle
 * for the OpenViking context database. Zero runtime dependencies.
 *
 *   npx pi-openviking@latest setup        full chain: venv → pinned install → init → doctor → start → pi install
 *   npx pi-openviking@latest server start|stop|restart|status|doctor
 *   npx pi-openviking@latest credentials  configure server URL / API key (~/.openviking/ovcli.conf)
 */

import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { buildManagedServerEnv, readManagedServerProxy } from "../shared/managed-server-env.mjs";
import { probeServerHealth } from "../shared/server-health.mjs";
import {
  configFingerprint,
  createManagedServerState,
  parseManagedServerState,
  proxyFingerprint,
  summarizeServerConfig,
} from "../shared/managed-server-state.mjs";

// Pinned server dependencies. xxhash<4 is NOT optional: openviking 0.4.13
// passes str into xxhash.xxh64(), and xxhash 4 removed implicit encoding,
// which silently drops every vector record (see USAGE.md §2.2).
const OV_VERSION = "0.4.13";
const OV_SPEC = `openviking[local-embed]==${OV_VERSION}`;
const XXHASH_SPEC = "xxhash<4";
const MIN_PYTHON = [3, 10];

const IS_WIN = platform() === "win32";
// Everything this CLI manages lives under ~/.pi/openviking so that one
// uninstall command can clean it all. (~/.openviking is the upstream default,
// shared with other OpenViking harnesses; we deliberately do not touch it.)
const OV_HOME = join(homedir(), ".pi", "openviking");
const LEGACY_OV_HOME = join(homedir(), ".openviking");
const VENV_DIR = join(OV_HOME, "venv");
const VENV_BIN = join(VENV_DIR, IS_WIN ? "Scripts" : "bin");
const VENV_PYTHON = join(VENV_BIN, IS_WIN ? "python.exe" : "python");
const SERVER_BIN = join(VENV_BIN, IS_WIN ? "openviking-server.exe" : "openviking-server");
const OV_CONF = join(OV_HOME, "ov.conf");
const OVCLI_CONF = join(OV_HOME, "ovcli.conf");
const PID_FILE = join(OV_HOME, "server.pid");
const LOG_FILE = join(OV_HOME, "server.log");
const STATE_FILE = join(OV_HOME, "server-state.json");
const USER_CONFIG = join(homedir(), ".pi", "pi-openviking.jsonc");

// The server's Codex-OAuth store defaults to the upstream-shared ~/.openviking;
// keep it inside OV_HOME. Children (doctor, server) inherit this.
process.env.OPENVIKING_CODEX_AUTH_PATH ||= join(OV_HOME, "codex_auth.json");

function managedServerRuntime() {
  const proxy = readManagedServerProxy(USER_CONFIG);
  return { env: buildManagedServerEnv(process.env, proxy), proxy };
}

function managedServerEnv() {
  return managedServerRuntime().env;
}

const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PKG_DIR, "..", "package.json"), "utf8")).version || "?";
  } catch {
    return "?";
  }
})();

const say = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

function fail(message, code = 1) {
  err(`✗ ${message}`);
  process.exit(code);
}

function run(cmd, args, { capture = false, env = process.env } = {}) {
  const res = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
    windowsHide: true,
    env,
  });
  if (res.error) return { ok: false, code: -1, out: "", err: String(res.error) };
  return {
    ok: res.status === 0,
    code: res.status ?? -1,
    out: (res.stdout || "").toString(),
    err: (res.stderr || "").toString(),
  };
}

function hasCommand(cmd, args = ["--version"]) {
  return run(cmd, args, { capture: true }).code !== -1;
}

// ---------------------------------------------------------------------------
// Python / venv / pinned install
// ---------------------------------------------------------------------------

function findPython() {
  const candidates = IS_WIN ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
  for (const [cmd, prefix] of candidates) {
    const res = run(cmd, [...prefix, "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], {
      capture: true,
    });
    if (!res.ok) continue;
    const [major, minor] = res.out.trim().split(".").map(Number);
    if (major === MIN_PYTHON[0] && minor >= MIN_PYTHON[1]) {
      return { cmd, args: prefix, version: res.out.trim() };
    }
  }
  return null;
}

function createVenv(python) {
  say(`创建虚拟环境: ${VENV_DIR}`);
  if (run(python.cmd, [...python.args, "-m", "venv", VENV_DIR]).ok && existsSync(VENV_PYTHON)) return;
  // A failed venv run (e.g. missing ensurepip) leaves a partial directory behind; clear it.
  rmSync(VENV_DIR, { recursive: true, force: true });
  // Debian/Ubuntu without python3-venv end up here; uv is the fallback.
  if (hasCommand("uv") && run("uv", ["venv", VENV_DIR, "--python", python.cmd]).ok && existsSync(VENV_PYTHON)) return;
  fail(
    "创建 venv 失败。Debian/Ubuntu 请先 `sudo apt install python3-venv`，或安装 uv (https://docs.astral.sh/uv/) 后重试。",
  );
}

function installedVersion(pkg) {
  const res = run(VENV_PYTHON, ["-c", `import importlib.metadata as m; print(m.version("${pkg}"))`], {
    capture: true,
  });
  return res.ok ? res.out.trim() : "";
}

function ensureServerInstalled(python) {
  if (!existsSync(VENV_PYTHON)) createVenv(python);

  const ov = installedVersion("openviking");
  const xxhash = installedVersion("xxhash");
  if (ov === OV_VERSION && xxhash && Number(xxhash.split(".")[0]) < 4) {
    say(`服务端已就绪: openviking ${ov}, xxhash ${xxhash}（跳过安装）`);
    return;
  }

  say(`安装/修正服务端: ${OV_SPEC} ${XXHASH_SPEC}（当前 openviking=${ov || "未安装"}, xxhash=${xxhash || "未安装"}）`);
  // Prefer uv for speed when available; plain pip otherwise.
  const useUv = hasCommand("uv");
  const install = useUv
    ? run("uv", ["pip", "install", "--python", VENV_PYTHON, OV_SPEC, XXHASH_SPEC])
    : run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", OV_SPEC, XXHASH_SPEC]);
  if (!install.ok) fail("服务端依赖安装失败，见上方输出。");
  if (!existsSync(SERVER_BIN)) fail(`安装完成但找不到 ${SERVER_BIN}`);
}

// ---------------------------------------------------------------------------
// Server config + doctor
// ---------------------------------------------------------------------------

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return ((await rl.question(question)).trim().toLowerCase() || "n") === "y";
  } finally {
    rl.close();
  }
}

/**
 * Starter ov.conf. The server config loader is strict JSON (no comments), so
 * per-field documentation lives in USAGE.md「服务端配置」instead of the file.
 *
 * Defaults chosen for zero-friction first run: local-only server, and the
 * ~24 MB llama.cpp embedding preset (auto-downloads on first server start).
 * Only the vlm section requires user input — there is no zero-config memory
 * model, and without it extraction/takeover never work (USAGE.md §2.3).
 */
function ovConfTemplate() {
  return {
    storage: { workspace: join(OV_HOME, "data") },
    server: { host: "127.0.0.1", port: 1933 },
    embedding: {
      dense: { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: 512 },
    },
    vlm: {
      provider: "volcengine",
      model: "doubao-seed-2-0-code-preview-260215",
      api_key: "",
      api_base: "https://ark.cn-beijing.volces.com/api/v3",
      temperature: 0.0,
      max_retries: 2,
    },
  };
}

async function ensureServerConfig() {
  if (existsSync(OV_CONF)) {
    say(`服务端配置已存在: ${OV_CONF}（如需修改直接编辑该文件；配置项说明见 USAGE.md「服务端配置」）`);
    return;
  }
  mkdirSync(OV_HOME, { recursive: true });
  writeFileSync(OV_CONF, `${JSON.stringify(ovConfTemplate(), null, 2)}\n`, { mode: 0o600 });
  say(`已生成服务端配置: ${OV_CONF}`);
  say("");
  say("该文件是严格 JSON（不支持注释），请用任意编辑器打开并完成：");
  say("  · vlm 段必填：api_key（以及对应 provider 的 model/api_base）——记忆模型，不配置则记忆抽取与上下文接管不生效");
  say("  · embedding 段已预填零依赖本地模型（bge-small-zh，约 24MB，首次启动自动下载），通常无需改动");
  say("  · 全部 provider 示例（云端 API / Codex 订阅复用 / Kimi / GLM / Ollama 本地等）见 USAGE.md「服务端配置」一节");
  say("");
  if (!(await confirm("已完成编辑，继续运行 doctor 验证? [y/N] "))) {
    fail(`请先编辑 ${OV_CONF}（至少填写 vlm.api_key），然后重新运行 \`npx pi-openviking@latest setup\`。`);
  }
}

// ---------------------------------------------------------------------------
// Ollama (optional, local-model route)
// ---------------------------------------------------------------------------

/**
 * The upstream wizard's built-in Ollama installer is fragile (it shells out to
 * install.sh, which currently needs zstd and has broken fallbacks), so we offer
 * a pre-install before the wizard starts: if the binary is already on PATH the
 * wizard skips its own installer entirely. Cloud-API users don't need Ollama.
 */
async function ensureOllama() {
  if (hasCommand("ollama")) {
    say("Ollama 已安装。");
    return;
  }
  say("未检测到 Ollama。仅「本地模型」路线（Ollama embedding / vlm）需要；使用云端 API 或 llama.cpp 可跳过。");
  if (!(await confirm("现在安装 Ollama? [y/N] "))) return;

  let ok = false;
  if (IS_WIN) {
    ok = run("winget", ["install", "-e", "--id", "Ollama.Ollama", "--accept-source-agreements", "--accept-package-agreements"]).ok;
  } else if (platform() === "darwin") {
    ok = hasCommand("brew")
      ? run("brew", ["install", "ollama"]).ok
      : run("bash", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]).ok;
  } else {
    // Linux: current Ollama releases ship .tar.zst assets, so the official
    // installer hard-requires zstd. Install it first when missing.
    if (!hasCommand("zstd")) {
      say("安装前置依赖 zstd（Ollama 安装包现为 .tar.zst 格式）…");
      const pm = ["apt-get", "dnf", "yum", "pacman", "zypper"].find((c) => hasCommand(c));
      const args = {
        "apt-get": ["install", "-y", "zstd"],
        dnf: ["install", "-y", "zstd"],
        yum: ["install", "-y", "zstd"],
        pacman: ["-S", "--noconfirm", "zstd"],
        zypper: ["install", "-y", "zstd"],
      }[pm];
      if (!args || !run("sudo", [pm, ...args]).ok) {
        err("zstd 安装失败，Ollama 安装可能会继续失败。");
      }
    }
    ok = run("bash", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"]).ok;
  }

  if (ok && hasCommand("ollama")) {
    say("✓ Ollama 安装完成。");
  } else {
    err("Ollama 自动安装失败。可手动安装（https://ollama.com/download）后重跑 setup；");
    err("也可以在接下来的向导中选择 Cloud API / llama.cpp 路线，无需 Ollama。");
  }
}

function runDoctor() {
  say("运行 openviking-server doctor …");
  const res = run(SERVER_BIN, ["doctor", "--config", OV_CONF], { env: managedServerEnv() });
  if (!res.ok) {
    fail("doctor 存在 FAIL 项（常见问题：vlm 模型未配置或不可用）。修复后重新运行 `npx pi-openviking@latest server doctor`。", res.code > 0 ? res.code : 1);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

function readServerConfig() {
  try {
    return JSON.parse(readFileSync(OV_CONF, "utf8"));
  } catch {
    throw new Error(`${OV_CONF}: ${existsSync(OV_CONF) ? "JSON 格式无效" : "文件不存在"}`);
  }
}

function serverAddress(config = readServerConfig()) {
  return summarizeServerConfig(config).endpoint;
}

function readServerState() {
  try {
    return parseManagedServerState(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function serverStart(preparedRuntime) {
  if (!existsSync(SERVER_BIN)) fail(`未安装服务端，先运行 \`npx pi-openviking@latest setup\`。（缺少 ${SERVER_BIN}）`);
  if (!existsSync(OV_CONF)) fail(`未找到服务端配置 ${OV_CONF}，先运行 \`npx pi-openviking@latest setup\`。`);

  const existing = readPid();
  if (existing && pidAlive(existing)) {
    say(`服务已在运行 (pid ${existing})。`);
    return;
  }

  const config = readServerConfig();
  const runtime = preparedRuntime ?? managedServerRuntime();
  const url = serverAddress(config);
  mkdirSync(OV_HOME, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(SERVER_BIN, ["--config", OV_CONF], {
    cwd: OV_HOME, // any cwd-relative server state stays under OV_HOME
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
    env: runtime.env,
  });
  child.unref();
  closeSync(logFd);
  writeFileSync(PID_FILE, String(child.pid));
  const state = createManagedServerState({ pid: child.pid, config, proxy: runtime.proxy });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  process.stdout.write(`启动中 (pid ${child.pid})，等待 ${url}/health …`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if ((await probeServerHealth(url)).ok) {
      say("\n✓ 服务已就绪。");
      return;
    }
    if (!pidAlive(child.pid)) break;
    process.stdout.write(".");
  }
  say("");
  fail(`服务未就绪。查看日志: ${LOG_FILE}`);
}

async function serverStop() {
  const pid = readPid();
  if (!pid || !pidAlive(pid)) {
    rmSync(PID_FILE, { force: true });
    rmSync(STATE_FILE, { force: true });
    say("服务未在运行。");
    return true;
  }
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  for (let i = 0; i < 15 && pidAlive(pid); i++) await sleep(1000);
  if (pidAlive(pid) && !IS_WIN) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    await sleep(500);
  }
  const stillAlive = pidAlive(pid);
  if (!stillAlive) {
    rmSync(PID_FILE, { force: true });
    rmSync(STATE_FILE, { force: true });
  }
  say(stillAlive ? "✗ 进程仍在运行，请手动检查。" : "✓ 服务已停止。");
  if (stillAlive) process.exitCode = 1;
  return !stillAlive;
}

async function serverStatus() {
  const pid = readPid();
  const alive = pid ? pidAlive(pid) : false;
  const savedState = readServerState();
  const activeState = alive && savedState?.pid === pid ? savedState : null;

  let config = null;
  let configError = "";
  try {
    config = readServerConfig();
  } catch (error) {
    configError = error?.message || String(error);
  }

  let proxy = null;
  let proxyError = "";
  try {
    proxy = readManagedServerProxy(USER_CONFIG);
  } catch (error) {
    proxyError = error?.message || String(error);
  }

  const currentSummary = config ? summarizeServerConfig(config) : null;
  const configChanged = Boolean(activeState && (!config || configFingerprint(config) !== activeState.configFingerprint));
  const proxyChanged = Boolean(activeState && (!proxy || proxyFingerprint(proxy) !== activeState.proxyFingerprint));
  const displayed = activeState ?? currentSummary ?? {};
  const endpoint = activeState?.endpoint || currentSummary?.endpoint || "http://127.0.0.1:1933";
  const health = await probeServerHealth(endpoint);
  const probeOnly = alive && !activeState;
  const probeNote = probeOnly ? "（当前配置地址探测；与受管进程的关联未确认）" : "";

  const started = activeState?.startedAt ? `, since ${activeState.startedAt}` : "";
  say(`service:    ${alive ? `running (pid ${pid}${started})` : `stopped${pid ? ` (stale pid ${pid})` : ""}`}`);
  if (health.ok) {
    const version = health.data?.version ? `OpenViking ${health.data.version}` : "OpenViking";
    const auth = health.data?.auth_mode ? `, auth ${health.data.auth_mode}` : "";
    say(`health:     ${probeOnly ? "PROBE OK" : "OK"} (${version}${auth})${probeNote}`);
  } else {
    const failure = health.statusCode ? `FAIL (HTTP ${health.statusCode})` : "不可达";
    say(`health:     ${probeOnly ? `PROBE ${failure}` : failure}${probeNote}`);
  }
  say(`endpoint:   ${endpoint}${probeNote}`);
  say("");

  if (configError) {
    say(`config:     INVALID (${configError})`);
  } else if (activeState && configChanged) {
    say(`config:     CHANGED (${OV_CONF}; 需要 server restart)`);
  } else if (activeState) {
    say(`config:     ${OV_CONF}（运行中配置一致）`);
  } else {
    say(`config:     ${OV_CONF}（${alive ? "当前配置；运行态未确认" : "已配置；服务未运行"}）`);
  }

  const modelNote = activeState
    ? configChanged
      ? "（运行中；当前配置有变更，需重启）"
      : ""
    : `（${alive ? "当前配置；运行态未确认" : "已配置"}）`;
  const embedding = displayed.embedding;
  const embeddingName = embedding?.provider || embedding?.model
    ? `${embedding.provider || "?"}/${embedding.model || "?"}${embedding.dimension ? ` (dimension ${embedding.dimension})` : ""}`
    : "未配置";
  say(`embedding:  ${embeddingName}${modelNote}`);

  const vlm = displayed.vlm;
  const vlmName = vlm?.provider || vlm?.model ? `${vlm.provider || "?"}/${vlm.model || "?"}` : "未配置";
  const credential = vlm?.credential ? ` (credential: ${vlm.credential})` : "";
  say(`vlm:        ${vlmName}${credential}${modelNote}`);

  const displayedProxy = activeState?.proxy ?? proxy;
  const proxyProtocols = [displayedProxy?.http ? "HTTP" : "", displayedProxy?.https ? "HTTPS" : ""].filter(Boolean);
  const proxyMode = proxyProtocols.length ? `${proxyProtocols.join("+")} enabled` : "disabled";
  if (proxyError) {
    say(
      activeState
        ? `proxy:      ${proxyMode}（已注入；当前配置无效，需修复并重启：${proxyError}）`
        : `proxy:      INVALID (${proxyError})`,
    );
  } else if (activeState && proxyChanged) {
    say(`proxy:      ${proxyMode}（运行中；当前配置有变更，需重启）`);
  } else if (activeState) {
    say(`proxy:      ${proxyMode}（已注入）`);
  } else {
    say(`proxy:      ${proxyMode}（${alive ? "当前配置；运行态未确认" : "已配置"}）`);
  }

  say(`storage:    ${displayed.storage || "未配置"}`);
  say(`log:        ${LOG_FILE}`);
  if (!alive || !health.ok || probeOnly) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// pi extension install
// ---------------------------------------------------------------------------

function installPiExtension() {
  if (!hasCommand("pi")) {
    say("未检测到 pi CLI。安装 pi 后执行: pi install npm:pi-openviking");
    return;
  }
  say("安装 pi 扩展: pi install npm:pi-openviking");
  if (!run("pi", ["install", "npm:pi-openviking"]).ok) {
    err("pi install 失败，可稍后手动执行: pi install npm:pi-openviking");
  }
}

// ---------------------------------------------------------------------------
// Uninstall — removes everything this CLI manages
// ---------------------------------------------------------------------------

async function uninstall() {
  say("将删除以下内容：");
  say(`  · ${OV_HOME}（服务端 venv、配置、日志、全部长期记忆数据）`);
  say(`  · ${USER_CONFIG}（扩展用户配置）`);
  say("  · pi 包注册（pi remove npm:pi-openviking）");
  if (existsSync(LEGACY_OV_HOME)) {
    say(`注意: ${LEGACY_OV_HOME} 为上游默认目录，可能被其他 OpenViking 客户端共享，本命令不会触碰。`);
  }
  if (!(await confirm("确认卸载并删除以上全部内容? [y/N] "))) {
    say("已取消。");
    return;
  }

  if (!(await serverStop())) fail("服务仍在运行，已中止卸载以避免删除正在使用的数据。");
  rmSync(OV_HOME, { recursive: true, force: true });
  rmSync(USER_CONFIG, { force: true });
  if (hasCommand("pi")) {
    run("pi", ["remove", "npm:pi-openviking"]);
  } else {
    say("未检测到 pi CLI，请手动从 pi settings 移除 npm:pi-openviking。");
  }
  say("✓ 卸载完成。Ollama 为系统级安装，如需移除请用系统包管理器（如 sudo apt remove ollama）。");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function setup() {
  say(`pi-openviking setup (v${CLI_VERSION}) — 目标服务端: ${OV_SPEC}, ${XXHASH_SPEC}`);
  say("");

  const python = findPython();
  if (!python) fail(`未找到 Python >= ${MIN_PYTHON.join(".")}。请先安装 Python: https://www.python.org/downloads/`);
  say(`Python ${python.version} (${python.cmd})`);

  ensureServerInstalled(python);
  await ensureOllama();
  await ensureServerConfig();
  runDoctor();

  const pid = readPid();
  if (pid && pidAlive(pid)) {
    say("服务已在运行，如需应用新配置请执行: npx pi-openviking@latest server restart");
  } else {
    await serverStart();
  }

  installPiExtension();

  say("");
  say("完成。下一步：");
  say("  · 本地模式（默认 127.0.0.1:1933 无认证）无需再配置，直接启动 pi 即可。");
  say("  · 连接远端或需要 API key 时运行: npx pi-openviking@latest credentials");
  say("  · 验证扩展生效见 USAGE.md §7（OV_DEBUG_LOG 三行日志）。");
}

async function main() {
  const [cmd, sub] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "setup":
      await setup();
      break;
    case "server":
      if (sub === "start") await serverStart();
      else if (sub === "stop") await serverStop();
      else if (sub === "restart") {
        const runtime = managedServerRuntime();
        if (!(await serverStop())) break;
        await serverStart(runtime);
      } else if (sub === "status") await serverStatus();
      else if (sub === "doctor") runDoctor();
      else fail("用法: pi-openviking server start|stop|restart|status|doctor", 2);
      break;
    case "credentials": {
      const { runSetupWizard } = await import("../shared/setup-wizard.mjs");
      // Keep the credential file inside OV_HOME, not the upstream default location.
      await runSetupWizard({ env: { ...process.env, OPENVIKING_CLI_CONFIG_FILE: OVCLI_CONF } });
      break;
    }
    case "uninstall":
      await uninstall();
      break;
    case "--version":
    case "-v":
      say(CLI_VERSION);
      break;
    default:
      say(`用法: pi-openviking [setup] | server start|stop|restart|status|doctor | credentials | uninstall | --version`);
      process.exitCode = cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

main().catch((e) => fail(e?.stack || String(e)));
