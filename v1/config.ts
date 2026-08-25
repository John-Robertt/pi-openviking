import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EXTENSION_CONFIG_DEFAULTS, validateExtensionConfig, type ExtensionConfigV1 } from "./shared/config-schema.mjs";
import { buildUserAgent, readManifestVersion, resolveOpenVikingCredentials } from "./shared/credentials.mjs";
import { parseJsoncObject } from "./shared/jsonc.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";

export const EXTENSION_VERSION =
  readManifestVersion(join(dirname(fileURLToPath(import.meta.url)), "package.json")) || "0.0.0";

export interface OVConfig extends ExtensionConfigV1 {
  endpoint: string;
  apiKey: string;
  account: string;
  user: string;
  peerId: string;
  userAgent: string;
  recallLimitConfigured: boolean;
  recallQueryExpansionConfigured: boolean;
}

export const USER_CONFIG_PATH = join(homedir(), ".pi", "pi-openviking.jsonc");

const USER_CONFIG_TEMPLATE = `// pi-openviking 用户配置
// 未知字段会以完整路径报错。服务器地址和凭证由 OPENVIKING_* 或 ~/.pi/openviking/*.conf 提供。
{
  // "enabled": true,
  // "syncTurns": true,

  // "archive": {
  //   "chunkTokenBudget": 50000,
  //   "rawTailTokenBudget": 20000
  // },

  // "takeover": {
  //   "enabled": true,
  //   "contextTokenThreshold": 0,
  //   "checkpointTokenBudget": 16000
  // },

  // "recallTokenBudget": 2000,
  // "recallMaxContentChars": 500,
  // "recallPreferAbstract": true,
  // "recallLimit": 10,
  // "recallQueryExpansion": "auto",
  // "scoreThreshold": 0.35,
  // "minQueryLength": 3,
  // "profileTokenBudget": 10000,
  // "sessionScopedMemory": true,
  // "workspacePeer": true,
  // "recallPeerScope": "all",
  // "bypassPatterns": [],
  // "logLevel": "error",

  // 只影响本包启动的 OpenViking 子进程。
  // "managedServer": {
  //   "proxy": {
  //     "http": "",
  //     "https": "",
  //     "noProxy": "127.0.0.1,localhost,::1"
  //   }
  // }
}
`;

function readConfigFile(path: string, optional = false): Record<string, unknown> {
  if (!existsSync(path)) {
    if (optional) return {};
    throw new Error(`${path}: 配置文件不存在`);
  }
  return parseJsoncObject(readFileSync(path, "utf8"), path);
}

function ensureUserConfigFile(): void {
  if (existsSync(USER_CONFIG_PATH)) return;
  try {
    mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
    writeFileSync(USER_CONFIG_PATH, USER_CONFIG_TEMPLATE, { mode: 0o600, flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw new Error(`无法创建 ${USER_CONFIG_PATH}: ${error?.message || String(error)}`);
  }
}

function mergeConfig(packageConfig: Record<string, any>, userConfig: Record<string, any>): Record<string, unknown> {
  return {
    ...packageConfig,
    ...userConfig,
    archive: { ...(packageConfig.archive || {}), ...(userConfig.archive || {}) },
    takeover: { ...(packageConfig.takeover || {}), ...(userConfig.takeover || {}) },
    ...(packageConfig.managedServer || userConfig.managedServer
      ? { managedServer: { ...(packageConfig.managedServer || {}), ...(userConfig.managedServer || {}) } }
      : {}),
  };
}

export function loadConfigFromModuleUrl(moduleUrl: string): OVConfig {
  return loadConfig(dirname(fileURLToPath(moduleUrl)));
}

export function loadConfig(extensionDir: string): OVConfig {
  ensureUserConfigFile();
  const packageFile = readConfigFile(join(extensionDir, "config.json"));
  const userFile = readConfigFile(USER_CONFIG_PATH, true);
  const configuredRecallLimit = Object.prototype.hasOwnProperty.call(userFile, "recallLimit");
  const configuredQueryExpansion = Object.prototype.hasOwnProperty.call(userFile, "recallQueryExpansion");
  const extension = validateExtensionConfig(mergeConfig(packageFile, userFile));

  const credentials = resolveOpenVikingCredentials();

  const config: OVConfig = {
    ...extension,
    archive: { ...extension.archive },
    takeover: { ...extension.takeover },
    bypassPatterns: [...extension.bypassPatterns],
    endpoint: credentials.baseUrl,
    apiKey: credentials.apiKey,
    account: credentials.account,
    user: credentials.user,
    peerId: credentials.peerId,
    userAgent: buildUserAgent("pi", EXTENSION_VERSION),
    recallLimitConfigured: configuredRecallLimit,
    recallQueryExpansionConfigured: configuredQueryExpansion,
  };

  if (process.env.OPENVIKING_WORKSPACE_PEER !== undefined) {
    config.workspacePeer = envBool(process.env.OPENVIKING_WORKSPACE_PEER, config.workspacePeer);
  }
  if (process.env.OPENVIKING_RECALL_PEER_SCOPE) {
    config.recallPeerScope = process.env.OPENVIKING_RECALL_PEER_SCOPE === "actor" ? "actor" : "all";
  }
  if (process.env.OPENVIKING_RECALL_LIMIT) {
    config.recallLimit = clampInt(Number(process.env.OPENVIKING_RECALL_LIMIT), 1, 50, config.recallLimit);
    config.recallLimitConfigured = true;
  }
  if (process.env.OPENVIKING_RECALL_QUERY_EXPANSION) {
    config.recallQueryExpansion = process.env.OPENVIKING_RECALL_QUERY_EXPANSION === "off" ? "off" : "auto";
    config.recallQueryExpansionConfigured = true;
  }
  config.peerId = resolveEffectivePeerId({ cfg: config as any, cwd: process.cwd() }).peerId;
  return config;
}

function envBool(value: string, fallback: boolean): boolean {
  const lower = String(value || "").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(lower)) return false;
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  return fallback;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export { EXTENSION_CONFIG_DEFAULTS };
