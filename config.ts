import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildUserAgent, readManifestVersion, resolveOpenVikingCredentials } from "./shared/credentials.mjs";
import { resolveEffectivePeerId } from "./shared/workspace-peer.mjs";

/** Version reported in the User-Agent, read from the package manifest. */
export const EXTENSION_VERSION =
  readManifestVersion(join(dirname(fileURLToPath(import.meta.url)), "package.json")) || "0.0.0";

export interface OVConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  account: string;
  user: string;
  peerId: string;
  userAgent: string;
  workspacePeer: boolean;
  recallPeerScope: "actor" | "all";
  recallQueryExpansion: "auto" | "off";
  recallQueryExpansionConfigured: boolean;
  syncTurns: boolean;
  recallTokenBudget: number;
  recallMaxContentChars: number;
  recallPreferAbstract: boolean;
  recallLimit: number;
  recallLimitConfigured: boolean;
  scoreThreshold: number;
  minQueryLength: number;
  profileTokenBudget: number;
  resumeContextBudget: number;
  commitTokenThreshold: number;
  commitKeepRecentCount: number;
  takeoverEnabled: boolean;
  takeoverTokenThreshold: number;
  takeoverRetainedTokenBudget: number;
  takeoverKeepRecentTurns: number;
  takeoverOverviewBudget: number;
  takeoverOverviewPollMs: number;
  takeoverOverviewPollMax: number;
  captureToolResults: boolean;
  captureMode: "semantic" | "keyword";
  captureMaxLength: number;
  captureToolMaxChars: number;
  captureAssistantTurns: boolean;
  bypassPatterns: string[];
  logLevel: "silent" | "error" | "info";
  /**
   * Confine long-term memory to the current pi session.
   *
   * OpenViking stores extracted memories under `viking://user/<user_id>`, which
   * is shared by every session of that user. When this is on, the client binds
   * a per-session `user_id`, so extraction, recall, profile injection and the
   * `viking_*` tools can only reach memory produced by this session.
   */
  sessionScopedMemory: boolean;
}

const DEFAULT_CONFIG: OVConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:1933",
  apiKey: "",
  account: "",
  user: "",
  peerId: "",
  userAgent: "",
  workspacePeer: true,
  recallPeerScope: "all",
  // Server-side query expansion costs a model call before retrieval starts, so
  // it has to be switchable from the client that pays the latency.
  recallQueryExpansion: "auto",
  recallQueryExpansionConfigured: false,
  syncTurns: true,
  recallTokenBudget: 2000,
  recallMaxContentChars: 500,
  recallPreferAbstract: true,
  recallLimit: 10,
  recallLimitConfigured: false,
  scoreThreshold: 0.35,
  minQueryLength: 3,
  profileTokenBudget: 10000,
  resumeContextBudget: 32000,
  commitTokenThreshold: 20000,
  commitKeepRecentCount: 10,
  takeoverEnabled: true,
  takeoverTokenThreshold: 20000,
  takeoverRetainedTokenBudget: 30000,
  takeoverKeepRecentTurns: 3,
  takeoverOverviewBudget: 16000,
  takeoverOverviewPollMs: 2000,
  takeoverOverviewPollMax: 15,
  captureToolResults: false,
  captureMode: "semantic",
  captureMaxLength: 24000,
  captureToolMaxChars: 1000000,
  captureAssistantTurns: true,
  bypassPatterns: [],
  logLevel: "error",
  sessionScopedMemory: true,
};

/**
 * User-level override config, written with a fully commented template on first
 * run. Precedence: OPENVIKING_* env / credential files > this file > the
 * package's bundled config.json > DEFAULT_CONFIG.
 */
export const USER_CONFIG_PATH = join(homedir(), ".pi", "pi-openviking.jsonc");

const USER_CONFIG_TEMPLATE = `// =============================================================================
// pi-openviking 用户配置
//
// 生效优先级（高 → 低）：OPENVIKING_* 环境变量 > 本文件 > 扩展包内置默认值。
// 扩展配置修改后重启 pi 生效；managedServer.proxy 修改后重启受管服务。以下每一项默认都被注释，取消注释即可覆盖；
// 注释里标注的是当前默认值。
//
// 服务器地址与凭证不在本文件配置，按以下顺序解析（先命中者生效）：
//   1. OPENVIKING_URL / OPENVIKING_API_KEY 等环境变量
//   2. ~/.pi/openviking/ovcli.conf（运行 npx pi-openviking@latest credentials 生成）
//   3. ~/.pi/openviking/ov.conf（服务端配置，setup 生成模板后手工编辑）
// =============================================================================
{
  // ---- 总开关 ----------------------------------------------------------------
  // "enabled": true,                 // false 时扩展完全不加载

  // ---- 长期记忆隔离 -----------------------------------------------------------
  // "sessionScopedMemory": true,     // true: 长期记忆按 pi 会话隔离，新会话/fork 从空记忆开始
                                     // false: 同一用户的所有会话共享记忆（上游行为）

  // ---- 上下文接管（takeover）--------------------------------------------------
  // 会话历史累计超过 tokenThreshold 后提交归档，本地只保留最近 keepRecentTurns 轮。
  // "takeover": {
  //   "enabled": true,
  //   "tokenThreshold": 20000,       // 新同步内容累计到该值时触发归档
  //   "retainedTokenBudget": 30000,  // OpenViking 保留的原始消息预算；超大单轮转交 Pi compaction
  //   "keepRecentTurns": 3,          // 正常归档优先保留的最近用户轮数
  //   "overviewBudget": 16000,       // 注入模型上下文的 archive overview 最大 token 数
  //   "overviewPollMs": 2000,        // 概览未就绪时的轮询间隔（毫秒）
  //   "overviewPollMax": 15          // 概览轮询最大次数，超过则本轮 fail-open
  // },

  // ---- 召回（recall）----------------------------------------------------------
  // "syncTurns": true,               // 是否把会话内容同步到 OpenViking
  // "recallTokenBudget": 2000,       // 每次提示词注入召回记忆的最大 token
  // "recallMaxContentChars": 500,    // 单条召回记忆的最大字符数
  // "recallPreferAbstract": true,    // 优先注入摘要而非全文
  // "recallLimit": 10,               // 召回条数上限（1-50）
  // "recallQueryExpansion": "auto",  // 服务端查询扩展："auto" | "off"（开启会在检索前多花一次模型调用）
  // "scoreThreshold": 0.35,          // 召回相关度阈值（0-1），低于此分的结果被丢弃
  // "minQueryLength": 3,             // 短于此长度的提示词不触发召回
  // "profileTokenBudget": 10000,     // 注入用户画像的最大 token
  // "resumeContextBudget": 32000,    // 会话恢复时注入上下文的最大 token

  // ---- 提交（commit）----------------------------------------------------------
  // "commitTokenThreshold": 20000,   // 触发记忆抽取提交的累计 token 阈值
  // "commitKeepRecentCount": 10,     // 提交时保留的最近条数

  // ---- 捕获（capture）---------------------------------------------------------
  // "captureMode": "semantic",       // "semantic" | "keyword"
  // "captureMaxLength": 24000,       // 单条捕获内容最大字符数
  // "captureToolMaxChars": 1000000,  // 单条工具输出最大字符数
  // "captureAssistantTurns": true,   // 是否捕获助手回合

  // ---- 受管 OpenViking 服务代理 ---------------------------------------------
  // 仅影响本包启动的 OpenViking 服务和 doctor，不修改 shell 或 pi 的环境变量。
  // http/https 留空时服务明确不使用代理，也不会继承启动命令中的代理环境变量。
  // "managedServer": {
  //   "proxy": {
  //     "http": "",
  //     "https": "",
  //     "noProxy": "127.0.0.1,localhost,::1"
  //   }
  // },
  // 修改后执行：npx pi-openviking@latest server restart

  // ---- 其他 -------------------------------------------------------------------
  // "bypassPatterns": [],            // 命中这些正则的提示词跳过召回与同步
  // "workspacePeer": true,           // 同一工作区的会话视为同一 peer
  // "recallPeerScope": "all",        // 召回范围："actor" | "all"
  // "logLevel": "error"              // "silent" | "error" | "info"
}
`;

/** Strip // and block comments plus trailing commas, string-aware. */
function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

function readJsoncFile(path: string): any {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8")));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function ensureUserConfigFile(): void {
  try {
    if (existsSync(USER_CONFIG_PATH)) return;
    mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true });
    writeFileSync(USER_CONFIG_PATH, USER_CONFIG_TEMPLATE, { mode: 0o600 });
  } catch {
    // Best effort; the user config is optional.
  }
}

export function loadConfigFromModuleUrl(moduleUrl: string): OVConfig {
  return loadConfig(dirname(fileURLToPath(moduleUrl)));
}

export function loadConfig(extensionDir: string): OVConfig {
  ensureUserConfigFile();
  const pkgFile = readJsoncFile(join(extensionDir, "config.json"));
  const userFile = readJsoncFile(USER_CONFIG_PATH);
  const asObject = (v: any) => (v && typeof v === "object" ? v : {});
  const file: any = {
    ...pkgFile,
    ...userFile,
    takeover: { ...asObject(pkgFile.takeover), ...asObject(userFile.takeover) },
  };

  const takeover = file.takeover && typeof file.takeover === "object" ? file.takeover : {};
  // Credential files managed by our CLI live under ~/.pi/openviking; explicit
  // OPENVIKING_*_FILE env vars still win.
  const piOvHome = join(homedir(), ".pi", "openviking");
  process.env.OPENVIKING_CLI_CONFIG_FILE ||= join(piOvHome, "ovcli.conf");
  process.env.OPENVIKING_CONFIG_FILE ||= join(piOvHome, "ov.conf");
  const creds = resolveOpenVikingCredentials();
  const config: OVConfig = {
    ...DEFAULT_CONFIG,
    ...file,
    endpoint: creds.baseUrl,
    apiKey: creds.apiKey,
    account: creds.account,
    user: creds.user,
    peerId: creds.peerId,
    userAgent: buildUserAgent("pi", EXTENSION_VERSION),
    recallLimitConfigured: Object.prototype.hasOwnProperty.call(file, "recallLimit"),
    recallQueryExpansionConfigured: Object.prototype.hasOwnProperty.call(file, "recallQueryExpansion"),
    recallTokenBudget: file.recallTokenBudget ?? file.recallBudget ?? DEFAULT_CONFIG.recallTokenBudget,
    scoreThreshold: file.scoreThreshold ?? file.recallScoreThreshold ?? DEFAULT_CONFIG.scoreThreshold,
    minQueryLength: file.minQueryLength ?? file.recallMinQueryLength ?? DEFAULT_CONFIG.minQueryLength,
    profileTokenBudget: file.profileTokenBudget ?? file.profileBudget ?? DEFAULT_CONFIG.profileTokenBudget,
    takeoverEnabled: takeover.enabled ?? file.takeoverEnabled ?? DEFAULT_CONFIG.takeoverEnabled,
    takeoverTokenThreshold: takeover.tokenThreshold ?? file.takeoverTokenThreshold ?? DEFAULT_CONFIG.takeoverTokenThreshold,
    takeoverRetainedTokenBudget: takeover.retainedTokenBudget ?? file.takeoverRetainedTokenBudget ?? DEFAULT_CONFIG.takeoverRetainedTokenBudget,
    takeoverKeepRecentTurns: takeover.keepRecentTurns ?? file.takeoverKeepRecentTurns ?? DEFAULT_CONFIG.takeoverKeepRecentTurns,
    takeoverOverviewBudget: takeover.overviewBudget ?? file.takeoverOverviewBudget ?? DEFAULT_CONFIG.takeoverOverviewBudget,
    takeoverOverviewPollMs: takeover.overviewPollMs ?? file.takeoverOverviewPollMs ?? DEFAULT_CONFIG.takeoverOverviewPollMs,
    takeoverOverviewPollMax: takeover.overviewPollMax ?? file.takeoverOverviewPollMax ?? DEFAULT_CONFIG.takeoverOverviewPollMax,
  };

  if (process.env.OPENVIKING_URL || process.env.OPENVIKING_BASE_URL) config.endpoint = creds.baseUrl;
  if (process.env.OPENVIKING_API_KEY || process.env.OPENVIKING_BEARER_TOKEN) config.apiKey = creds.apiKey;
  if (process.env.OPENVIKING_ACCOUNT) config.account = creds.account;
  if (process.env.OPENVIKING_USER) config.user = creds.user;
  if (process.env.OPENVIKING_PEER_ID) config.peerId = creds.peerId;
  if (process.env.OPENVIKING_WORKSPACE_PEER !== undefined) {
    config.workspacePeer = envBool(process.env.OPENVIKING_WORKSPACE_PEER, config.workspacePeer);
  }
  if (process.env.OPENVIKING_RECALL_PEER_SCOPE) {
    config.recallPeerScope = process.env.OPENVIKING_RECALL_PEER_SCOPE === "actor" ? "actor" : "all";
  }
  if (process.env.OPENVIKING_RECALL_LIMIT) {
    config.recallLimit = Number(process.env.OPENVIKING_RECALL_LIMIT);
    config.recallLimitConfigured = true;
  }
  if (process.env.OPENVIKING_RECALL_QUERY_EXPANSION) {
    config.recallQueryExpansion = process.env.OPENVIKING_RECALL_QUERY_EXPANSION === "off" ? "off" : "auto";
    config.recallQueryExpansionConfigured = true;
  }

  config.recallLimit = clampInt(config.recallLimit, 1, 50, DEFAULT_CONFIG.recallLimit);
  config.recallMaxContentChars = clampInt(config.recallMaxContentChars, 100, 5000, DEFAULT_CONFIG.recallMaxContentChars);
  config.recallTokenBudget = clampInt(config.recallTokenBudget, 200, 50000, DEFAULT_CONFIG.recallTokenBudget);
  config.scoreThreshold = clampNumber(config.scoreThreshold, 0, 1, DEFAULT_CONFIG.scoreThreshold);
  config.minQueryLength = clampInt(config.minQueryLength, 1, 64, DEFAULT_CONFIG.minQueryLength);
  config.profileTokenBudget = clampInt(config.profileTokenBudget, 500, 50000, DEFAULT_CONFIG.profileTokenBudget);
  config.resumeContextBudget = clampInt(config.resumeContextBudget, 1024, 128000, DEFAULT_CONFIG.resumeContextBudget);
  config.commitTokenThreshold = clampInt(config.commitTokenThreshold, 1000, 1000000, DEFAULT_CONFIG.commitTokenThreshold);
  config.commitKeepRecentCount = clampInt(config.commitKeepRecentCount, 0, 1000, DEFAULT_CONFIG.commitKeepRecentCount);
  config.takeoverEnabled = config.takeoverEnabled !== false;
  config.takeoverTokenThreshold = clampInt(config.takeoverTokenThreshold, 1, 1000000, DEFAULT_CONFIG.takeoverTokenThreshold);
  config.takeoverRetainedTokenBudget = clampInt(config.takeoverRetainedTokenBudget, 1000, 1000000, DEFAULT_CONFIG.takeoverRetainedTokenBudget);
  config.takeoverKeepRecentTurns = clampInt(config.takeoverKeepRecentTurns, 1, 100, DEFAULT_CONFIG.takeoverKeepRecentTurns);
  config.takeoverOverviewBudget = clampInt(config.takeoverOverviewBudget, 100, 50000, DEFAULT_CONFIG.takeoverOverviewBudget);
  config.takeoverOverviewPollMs = clampInt(config.takeoverOverviewPollMs, 0, 60000, DEFAULT_CONFIG.takeoverOverviewPollMs);
  config.takeoverOverviewPollMax = clampInt(config.takeoverOverviewPollMax, 1, 120, DEFAULT_CONFIG.takeoverOverviewPollMax);
  config.captureMaxLength = clampInt(config.captureMaxLength, 200, 100000, DEFAULT_CONFIG.captureMaxLength);
  config.captureToolMaxChars = clampInt(config.captureToolMaxChars, 200, 1000000, DEFAULT_CONFIG.captureToolMaxChars);
  config.captureMode = config.captureMode === "keyword" ? "keyword" : "semantic";
  config.recallPeerScope = config.recallPeerScope === "actor" ? "actor" : "all";
  config.recallQueryExpansion = config.recallQueryExpansion === "off" ? "off" : "auto";
  if (!Array.isArray(config.bypassPatterns)) config.bypassPatterns = [];
  config.peerId = resolveEffectivePeerId({ cfg: config as any, cwd: process.cwd() }).peerId;
  return config;
}

function envBool(value: string, fallback: boolean): boolean {
  const lower = String(value || "").trim().toLowerCase();
  if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
  if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
  return fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const next = Math.round(Number(value));
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, next));
}
