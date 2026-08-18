#!/usr/bin/env node
/**
 * pi-openviking dev environment orchestrator. The `bootstrap` command is a
 * one-shot, zero-interaction install of the repository-local toolchain
 * (.dev/toolchain): every parameter is predetermined by shared/toolchain.mjs
 * pins and dev/model-profile.json; no user config is read, nothing is
 * registered outside the repository. See DEVELOPMENT.md.
 *
 *   npm run dev -- bootstrap
 */
import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePython,
  ensureServerPackages,
  ensureUv,
  isToolchainPlatformSupported,
  OPENVIKING_SPEC,
  runProcess,
  TOOLCHAIN,
} from "../shared/toolchain.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEV_HOME = join(REPO_ROOT, ".dev");
const TOOLCHAIN_HOME = join(DEV_HOME, "toolchain");
const PROFILE_PATH = join(REPO_ROOT, "dev", "model-profile.json");

const say = (line = "") => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

function fail(message, code = 1) {
  err(`✗ ${message}`);
  process.exit(code);
}

/** Returns a list of problems; empty means the profile is usable. */
export function validateModelProfile(profile) {
  const problems = [];
  const need = (value, path) => {
    if (typeof value !== "string" || !value) problems.push(`${path} 缺失或不是非空字符串`);
    return value;
  };
  const task = profile?.taskVlm ?? {};
  need(task.provider, "taskVlm.provider");
  need(task.model, "taskVlm.model");
  need(task.apiBase, "taskVlm.apiBase");
  if (task.credentialKind !== "api_key") problems.push('taskVlm.credentialKind 当前只支持 "api_key"');
  if (typeof task.apiKeyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(task.apiKeyEnv)) {
    problems.push("taskVlm.apiKeyEnv 缺失或不是合法环境变量名");
  }
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

/** 只探测凭证是否存在（不输出凭证本身），供 readiness 报告。 */
function credentialReady(profile) {
  const res = runProcess(
    "npm",
    ["exec", "--", "pi", "auth", "check", "--provider", profile.taskVlm.provider, "--model", profile.taskVlm.model],
    { capture: true },
  );
  return res.ok;
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

  if (credentialReady(profile)) {
    say(`凭证就绪: ${profile.taskVlm.provider}/${profile.taskVlm.model}`);
  } else {
    say(`凭证未就绪: 请在 pi 中执行 /login ${profile.taskVlm.provider}；dev up 启动服务时会再次检查。`);
  }

  say("");
  say("完成。.dev/ 可整体删除，由 bootstrap 重建。");
}

function main() {
  const [cmd] = process.argv.slice(2);
  switch (cmd) {
    case "bootstrap":
      bootstrap().catch((e) => fail(e?.message || String(e)));
      break;
    case "up":
    case "down":
    case "status":
    case "pi":
      fail(`dev ${cmd} 待实现，见 DEVELOPMENT.md「当前缺口与下一执行入口」。`, 2);
      break;
    default:
      say("用法: npm run dev -- bootstrap");
      process.exitCode = cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
