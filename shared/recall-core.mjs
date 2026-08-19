import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i;
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天/i;
const QUERY_TOKEN_RE = /[a-z0-9一-龥]{2,}/gi;
const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how", "did", "does",
  "is", "are", "was", "were", "the", "and", "for", "with", "from", "that", "this", "your", "you",
]);
const USER_RESERVED_DIRS = new Set(["memories", "skills"]);
const SOURCES = [
  { type: "memory", uri: "viking://user/memories", bucket: "memories" },
  { type: "skill", uri: "viking://user/skills", bucket: "skills" },
];
const DEFAULT_CONTEXT_LIMIT = 10;
const DEFAULT_CONTEXT_MAX_TOKENS = 1600;
const CODING_QUOTA_WEIGHTS = {
  events: 1,
  entities: 2,
  preferences: 1,
  experiences: 1,
  resources: 3,
  skills: 2,
};

export function estimateTokens(text) {
  return text ? Math.ceil(String(text).length / 4) : 0;
}

function scaleQuotas(limit, weights) {
  const slots = Math.max(1, Math.floor(Number(limit) || DEFAULT_CONTEXT_LIMIT));
  const order = Object.keys(weights);
  const quotas = Object.fromEntries(order.map((key) => [key, 0]));
  if (slots < order.length) {
    for (const key of order) quotas[key] = 1;
    return quotas;
  }

  for (const key of order) quotas[key] = 1;
  const totalWeight = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const ideals = Object.fromEntries(
    order.map((key) => [key, slots * weights[key] / totalWeight]),
  );
  while (order.reduce((sum, key) => sum + quotas[key], 0) < slots) {
    const key = order.reduce((best, candidate) => (
      ideals[candidate] - quotas[candidate] > ideals[best] - quotas[best]
        ? candidate
        : best
    ));
    quotas[key] += 1;
  }
  return quotas;
}

function legacyMemoryQuotas(limit) {
  return {
    ...scaleQuotas(limit, { events: 10, entities: 10, preferences: 3 }),
    experiences: 0,
  };
}

function codingQuotas(limit) {
  return scaleQuotas(limit, CODING_QUOTA_WEIGHTS);
}

export function buildRecallEndpointBody(cfg = {}) {
  const limit = Math.max(Number(cfg.recallLimit || DEFAULT_CONTEXT_LIMIT), 1);
  const body = {
    query: "",
    quotas: legacyMemoryQuotas(limit),
    max_chars: Math.max(Number(cfg.recallMaxContentChars || 0) * limit, 1000),
    min_score: Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35,
    render: true,
  };
  if (cfg.recallPeerScope === "actor") body.peer_scope = "actor";
  return body;
}

/**
 * Body for the server-side context face. The plugin declares intent (coding
 * purpose, budget, session) and leaves the mechanics — quota ratios, tier
 * degradation, cross-turn dedup — to the server's defaults.
 */
export function buildContextSearchBody(cfg = {}, options = {}) {
  const limit = Math.max(1, Math.floor(Number(cfg.recallLimit || DEFAULT_CONTEXT_LIMIT)));
  const maxTokens = Math.max(
    64,
    Math.floor(Number(cfg.recallMaxTokens || DEFAULT_CONTEXT_MAX_TOKENS)),
  );
  const body = {
    query: "",
    mode: "context",
    purpose: "coding",
    score_threshold: Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35,
  };
  const limitConfigured = cfg.recallLimitConfigured === true;
  const maxTokensConfigured = cfg.recallMaxTokensConfigured === true;
  if (limitConfigured) body.quotas = codingQuotas(limit);
  if (maxTokensConfigured) body.max_tokens = maxTokens;
  if (cfg.recallPeerScope === "actor") body.peer_scope = "actor";

  const sessionId = String(options.sessionId || "").trim();
  if (sessionId) {
    body.session_id = sessionId;
    const queryExpansionConfigured = cfg.recallQueryExpansionConfigured === true;
    if (queryExpansionConfigured) {
      body.query_expansion = cfg.recallQueryExpansion === "off" ? "off" : "auto";
    }
    const dedupTurns = Number(cfg.recallDedupTurns);
    const resolvedDedupTurns = Number.isFinite(dedupTurns)
      ? Math.max(0, Math.floor(dedupTurns))
      : 5;
    if (resolvedDedupTurns > 0) body.dedup_turns = resolvedDedupTurns;
  }

  const excludeUris = Array.isArray(options.excludeUris) ? options.excludeUris.slice(0, 200) : [];
  if (excludeUris.length) body.exclude_uris = excludeUris;

  return body;
}

// The server pipeline is serial and each optional stage has its own fuse. A
// request is aborted client-side unless its deadline covers every stage it
// asked for, and aborting discards the whole response rather than just the
// stage that ran long.
//
//   session_id  -> query expansion   (retrieval.recall_intent_timeout_s,  5s)
//   always      -> retrieval, body reads, budget planning
//
// The budget stays inside the 60s prompt-hook allowance.
const EXPANSION_REQUEST_TIMEOUT_MS = 15000;

/**
 * HTTP deadline for one context request, or undefined to keep the caller's own.
 *
 * Derived from the request body, because the body is what states which server
 * stages will run: reading `cfg` alone cannot tell a bare retrieval from one
 * that also spends the expansion fuse.
 */
export function contextRequestTimeoutMs(cfg = {}, body = {}) {
  // `query_expansion` defaults to "auto" server-side, so only an explicit "off"
  // takes the expansion fuse back out of the budget.
  const wantsExpansion = Boolean(body.session_id) && body.query_expansion !== "off";
  if (!wantsExpansion) return undefined;

  const configured = Number(cfg.recallContextTimeoutMs);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1000, Math.floor(configured));
  return Math.max(Number(cfg.timeoutMs) || 0, EXPANSION_REQUEST_TIMEOUT_MS);
}

function clampScore(v) {
  if (typeof v !== "number" || Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function buildQueryProfile(query) {
  const text = query.trim();
  const allTokens = text.toLowerCase().match(QUERY_TOKEN_RE) || [];
  return {
    tokens: allTokens.filter((t) => !STOPWORDS.has(t)),
    wantsPreference: PREFERENCE_QUERY_RE.test(text),
    wantsTemporal: TEMPORAL_QUERY_RE.test(text),
  };
}

function lexicalOverlapBoost(tokens, text) {
  if (tokens.length === 0 || !text) return 0;
  const haystack = ` ${text.toLowerCase()} `;
  let matched = 0;
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(token)) matched += 1;
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2);
}

function rankItem(item, profile) {
  const base = clampScore(item.score);
  const abstract = (item.abstract || item.overview || "").trim();
  const cat = (item.category || "").toLowerCase();
  const uri = (item.uri || "").toLowerCase();
  const leafBoost = (item.level === 2 || uri.endsWith(".md")) ? 0.12 : 0;
  const eventBoost = profile.wantsTemporal && (cat === "events" || uri.includes("/events/")) ? 0.1 : 0;
  const prefBoost = profile.wantsPreference && (cat === "preferences" || uri.includes("/preferences/")) ? 0.08 : 0;
  const overlapBoost = lexicalOverlapBoost(profile.tokens, `${item.uri} ${abstract}`);
  return base + leafBoost + eventBoost + prefBoost + overlapBoost;
}

function isEventOrCaseItem(item) {
  const cat = (item.category || "").toLowerCase();
  const uri = (item.uri || "").toLowerCase();
  return cat === "events" || cat === "cases" || uri.includes("/events/") || uri.includes("/cases/");
}

function dedupeItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = isEventOrCaseItem(item)
      ? `uri:${item.uri}`
      : ((item.abstract || item.overview || "").trim().toLowerCase() || `uri:${item.uri}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 把 `viking://user/<reserved>/...` 展开到已绑定的记忆空间。
 *
 * `userSpace` 必须由调用方从 client 身份派生。空值时保持原 URI 不展开，
 * 使请求落在无效路径而不是落到别人的 space。
 */
function resolveTargetUri(targetUri, userSpace) {
  const trimmed = targetUri.trim().replace(/\/+$/, "");
  const m = trimmed.match(/^viking:\/\/user(?:\/(.*))?$/);
  if (!m) return trimmed;
  const rawRest = (m[1] ?? "").trim();
  if (!rawRest) return trimmed;
  const parts = rawRest.split("/").filter(Boolean);
  if (parts.length === 0) return trimmed;
  if (!USER_RESERVED_DIRS.has(parts[0])) return trimmed;
  const space = String(userSpace || "").trim();
  if (!space) return trimmed;
  return `viking://user/${space}/${parts.join("/")}`;
}

async function searchOneSource(fetchJSON, query, source, limit, actorPeerId = "", userSpace = "") {
  const resolvedUri = resolveTargetUri(source.uri, userSpace);
  const body = { query, target_uri: resolvedUri, limit, score_threshold: 0 };
  const res = await fetchJSON("/api/v1/search/find", {
    method: "POST",
    body: JSON.stringify(body),
  }, { actorPeerId });
  if (!res.ok) return [];
  const items = res.result?.[source.bucket] || [];
  return items.map((item) => ({ ...item, _sourceType: source.type }));
}

async function searchAllSources(fetchJSON, query, perSourceLimit, actorPeerId = "", observation = null, userSpace = "") {
  const results = await Promise.all(
    SOURCES.map((src) => searchOneSource(fetchJSON, query, src, perSourceLimit, actorPeerId, userSpace)),
  );
  const all = results.flat();
  observation?.emit("recall_source", "raw_find", all.length);
  return all;
}

async function resolveItemContent(fetchJSON, item, cfg, actorPeerId = "") {
  let content;

  if (cfg.recallPreferAbstract && (item.abstract || item.overview || "").trim()) {
    content = (item.abstract || item.overview).trim();
  } else if (item.level === 2) {
    try {
      const res = await fetchJSON(
        `/api/v1/content/read?uri=${encodeURIComponent(item.uri)}`,
        {},
        { actorPeerId },
      );
      const body = res.ok && typeof res.result === "string" ? res.result.trim() : "";
      content = body || (item.abstract || item.overview || "").trim() || item.uri;
    } catch {
      content = (item.abstract || item.overview || "").trim() || item.uri;
    }
  } else {
    content = (item.abstract || item.overview || "").trim() || item.uri;
  }

  const maxChars = Math.max(50, Number(cfg.recallMaxContentChars || 500));
  if (content.length > maxChars) content = `${content.slice(0, maxChars)}...`;
  return content;
}

async function buildFallbackInjectionBlock(fetchJSON, items, cfg, actorPeerId = "") {
  if (items.length === 0) return null;

  let budgetRemaining = Math.max(200, Number(cfg.recallTokenBudget || 2000));
  const lines = [
    "<openviking-context>",
    "Relevant context from OpenViking. Use the read MCP tool to expand URIs.",
  ];
  let contentCount = 0;

  for (const item of items) {
    const score = (clampScore(item.score) * 100).toFixed(0);
    const uriLine = `- [${item._sourceType} ${score}%] ${item.uri}`;

    if (budgetRemaining > 0) {
      const content = await resolveItemContent(fetchJSON, item, cfg, actorPeerId);
      const contentLine = `- [${item._sourceType} ${score}%] ${content}`;
      const lineTokens = estimateTokens(contentLine);

      if (lineTokens > budgetRemaining && contentCount > 0) {
        lines.push(uriLine);
      } else {
        lines.push(contentLine);
        budgetRemaining -= lineTokens;
        contentCount++;
      }
    } else {
      lines.push(uriLine);
    }
  }

  lines.push("</openviking-context>");

  return lines.join("\n");
}

const LEGACY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function stateFile(name) {
  const override = String(process.env.OPENVIKING_STATE_DIR || "").trim();
  return override ? join(override, name) : join(homedir(), ".openviking", "state", name);
}

async function readJsonFile(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function writeJsonFile(path, value) {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
  } catch { /* best effort */ }
}

/**
 * Hooks are one-shot processes, so "this server has no context face" has to be
 * remembered on disk or every turn pays for a rejected request.
 */
export async function isContextFaceLegacy(path = stateFile("context-face.json"), now = Date.now()) {
  const cached = await readJsonFile(path);
  return Boolean(cached?.legacyUntil && Number(cached.legacyUntil) > now);
}

export async function markContextFaceLegacy(path = stateFile("context-face.json"), now = Date.now()) {
  await writeJsonFile(path, { legacyUntil: now + LEGACY_CACHE_TTL_MS });
}

function looksLikeUnknownField(res) {
  const text = JSON.stringify(res?.error ?? res?.result ?? res?.detail ?? "").toLowerCase();
  return text.includes("extra") || text.includes("mode") || text.includes("unexpected");
}

function wrapContext(body) {
  return [
    "<openviking-context>",
    "Relevant memory from OpenViking. Use the recall/read MCP tools to expand URIs.",
    body,
    "</openviking-context>",
  ].join("\n");
}

/**
 * Server-assembled context: the context face when the deployment has it, else
 * the deprecated /recall preset. Returns the injection block, "" when there was
 * nothing relevant, or null when no server-side path was usable at all.
 */
export async function buildServerAssembledBlock(fetchJSON, cfg, query, options = {}) {
  const actorPeerId = options.actorPeerId ?? cfg.peerId ?? "";

  const block = await recallViaContextFace(fetchJSON, cfg, query, { ...options, actorPeerId });
  if (block !== null) return block;
  return recallViaEndpoint(fetchJSON, cfg, query, actorPeerId, options.observation);
}

/**
 * Raw server-assembled context, or null when the deployment has no context face.
 * Returns `{ rendered, entries, digest, stats }` — callers that need the entries
 * (their own compression, their own envelope) use this instead of the block
 * builders below.
 */
export async function fetchAssembledContext(fetchJSON, cfg, query, options = {}) {
  const actorPeerId = options.actorPeerId || "";
  const observation = options.observation;
  if (await isContextFaceLegacy(options.legacyCachePath)) return null;

  const body = buildContextSearchBody(cfg, options);
  body.query = query;
  const res = await fetchJSON("/api/v1/search/search", {
    method: "POST",
    body: JSON.stringify(body),
  }, { actorPeerId, timeoutMs: contextRequestTimeoutMs(cfg, body) });

  if (!res.ok) {
    const status = res.status || 0;
    if ((status === 400 || status === 422) && looksLikeUnknownField(res)) {
      await markContextFaceLegacy(options.legacyCachePath);
      observation?.emit("recall_failure", null, "context_unsupported", "retry", "legacy_endpoint", status);
    } else {
      observation?.emit("recall_failure", null, "context_error", "retry", "legacy_endpoint", status);
    }
    return null;
  }

  const result = res.result || {};
  const stats = result.stats || {};
  observation?.emit("recall_source", "context_face", Array.isArray(result.entries) ? result.entries.length : 0);
  return {
    rendered: String(result.rendered || "").trim(),
    entries: Array.isArray(result.entries) ? result.entries : [],
    digest: String(result.digest || "").trim(),
    stats,
  };
}

async function recallViaContextFace(fetchJSON, cfg, query, options) {
  const assembled = await fetchAssembledContext(fetchJSON, cfg, query, options);
  if (assembled === null) return null;

  const { rendered } = assembled;
  const digest = assembled.digest;
  if (String(assembled.stats?.rewrite || "").toLowerCase() === "no_relevant") {
    return "";
  }

  const injected = digest || rendered;
  if (!injected) return "";
  return wrapContext(injected);
}

async function recallViaEndpoint(fetchJSON, cfg, query, actorPeerId = "", observation = null) {
  const body = buildRecallEndpointBody(cfg);
  body.query = query;
  const res = await postRecall(fetchJSON, body, { actorPeerId, observation });
  if (!res.ok) {
    observation?.emit("recall_failure", null, "endpoint_error", "retry", "raw_find", res.status || 0);
    return null;
  }
  const rendered = String(res.result?.rendered || "").trim();
  observation?.emit("recall_source", "legacy_endpoint", rendered ? 1 : 0);
  if (!rendered) return "";
  return wrapContext(rendered);
}

export async function postRecall(fetchJSON, body, opts = {}) {
  const actorPeerId = opts.actorPeerId || "";
  const observation = opts.observation;
  const request = { ...body };
  const res = await fetchJSON("/api/v1/search/recall", {
    method: "POST",
    body: JSON.stringify(request),
  }, { actorPeerId });
  if (!request.peer_scope || (res.status !== 400 && res.status !== 422)) {
    return res;
  }

  const downgraded = { ...request };
  delete downgraded.peer_scope;
  observation?.emit("recall_failure", null, "peer_scope_unsupported", "retry", "same_without_peer", res.status || 0);
  return fetchJSON("/api/v1/search/recall", {
    method: "POST",
    body: JSON.stringify(downgraded),
  }, { actorPeerId });
}

export async function buildRecallBlock(fetchJSON, cfg, query, options = {}) {
  const actorPeerId = options.actorPeerId ?? cfg.peerId ?? "";
  const observation = options.observation;
  const trimmed = String(query || "").trim();
  if (!trimmed) return null;

  // Assembly happens server-side when the deployment offers the context face;
  // older servers fall through to /recall, then to raw find.
  const serverBlock = await buildServerAssembledBlock(fetchJSON, cfg, trimmed, {
    ...options,
    actorPeerId,
  });
  if (serverBlock !== null) return serverBlock || null;

  const recallLimit = Math.max(1, Number(cfg.recallLimit || DEFAULT_CONTEXT_LIMIT));
  const perSourceLimit = Math.max(recallLimit * 2, 8);
  const raw = await searchAllSources(fetchJSON, trimmed, perSourceLimit, actorPeerId, observation, options.userSpace);
  if (raw.length === 0) return null;

  const profile = buildQueryProfile(trimmed);
  const scoreThreshold = Number.isFinite(Number(cfg.scoreThreshold)) ? Number(cfg.scoreThreshold) : 0.35;
  const filtered = raw.filter((it) => clampScore(it.score) >= scoreThreshold);
  filtered.sort((a, b) => rankItem(b, profile) - rankItem(a, profile));
  const picked = dedupeItems(filtered).slice(0, recallLimit);

  if (picked.length === 0) return null;
  return buildFallbackInjectionBlock(fetchJSON, picked, cfg, actorPeerId);
}
