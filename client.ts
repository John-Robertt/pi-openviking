import type { OVConfig } from "./config.js";
import { Agent, request as undiciRequest } from "undici";

// pi installs a proxying global dispatcher (undici EnvHttpProxyAgent) when
// settings.httpProxy is set, and it only honors NO_PROXY captured at startup.
// Loopback endpoints must never traverse a proxy, so they get a direct agent.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// --- OV API Response Shapes ---
// All OV responses wrap in: { status: "ok"|"error", result: T, error?: {...}, ... }
// This client normalizes to { ok, result } internally.

export interface OVSearchResult {
  uri: string;
  context_type: string;   // "memory" | "resource" | "skill"
  score: number;
  abstract: string;
  overview: string | null;
  level: number;          // 0=L0, 1=L1, 2=L2
  category: string;
  match_reason: string;
}

export interface OVDirEntry {
  uri: string;
  name: string;
  isDir: boolean;
  size: number;
  mode: number;
  modTime: string;
  abstract: string;
}

export interface OVStatInfo {
  name: string;
  size: number;
  mode: number;
  modTime: string;
  isDir: boolean;
  isLocked: boolean;
  uri?: string;
  count?: number;         // directories only
}

export interface OVSessionMeta {
  session_id: string;
  message_count: number;
  total_message_count?: number;
  commit_count: number;
  pending_tokens?: number;
  memories_extracted?: Record<string, number>;
  last_commit_at?: string;
}

export interface OVSessionContext {
  latest_archive_overview: string | null;
  pre_archive_abstracts: any[];
  messages: any[];
  estimatedTokens: number;
  stats: {
    totalArchives: number;
    includedArchives: number;
    droppedArchives: number;
    failedArchives: number;
    activeTokens: number;
    archiveTokens: number;
  };
}

export interface OVCommitResult {
  session_id?: string;
  status?: string;
  task_id?: string | null;
  archive_uri?: string | null;
  archived?: boolean;
  reason?: string;
  estimated_active_tokens?: number;
  trace_id?: string;
}

export interface OVCommitOptions {
  keepRecentCount?: number;
  retentionMode?: "turn_budget";
  keepRecentTurnCount?: number;
  retainedMessageTokenBudget?: number;
  minRawTailSteps?: number;
}

export interface OVTask {
  task_id: string;
  task_type: string;
  status: string;
  resource_id?: string;
  stage?: string | null;
  result?: Record<string, any> | null;
  error?: string | null;
}

export interface OVSessionArchive {
  archive_id: string;
  abstract: string;
  overview: string;
  messages: any[];
}

export interface OVCommitResponse {
  result: OVCommitResult | null;
  traceId?: string;
  error?: any;
  status?: number;
}

export interface OVResponse<T> {
  ok: boolean;
  result: T | null;
  error?: any;
  status?: number;
  traceId?: string;
}

export class OVClient {
  private baseUrl: string;
  private apiKey: string;
  private account: string;
  private user: string;
  private peerId: string;
  private readonly loopback: boolean;
  private directAgent?: Agent;
  connected: boolean = false;

  private resolvedSpaces: Map<string, string> = new Map();

  private static RESERVED_USER = new Set(["memories"]);
  private static RESERVED_AGENT = new Set(["memories", "skills", "instructions", "workspaces"]);

  /** Read-only access to config (for value access across modules). */
  readonly cfg: OVConfig;

  constructor(config: OVConfig) {
    this.cfg = config;
    this.baseUrl = config.endpoint.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.account = config.account;
    this.user = config.user;
    this.peerId = config.peerId;
    this.loopback = LOOPBACK_HOSTS.has(new URL(this.baseUrl).hostname);
  }

  /**
   * Rebind the memory namespace this client reads and writes.
   *
   * Must be called before the first request that touches memory, otherwise
   * earlier calls land in the shared user space and leak across sessions.
   * Cached space resolutions are dropped because they belong to the old user.
   */
  bindUser(user: string): void {
    if (!user || user === this.user) return;
    this.user = user;
    this.resolvedSpaces.clear();
  }

  /**
   * Root of the bound memory namespace, or "" when none is bound.
   *
   * The user header only scopes memory-semantic operations; direct viking://
   * URI access stays global. Callers that expose URIs to the model use this
   * to keep the model inside its own namespace.
   */
  get userRoot(): string {
    return this.user ? `viking://user/${this.user}` : "";
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["Authorization"] = `Bearer ${this.apiKey}`;
    if (this.account) h["X-OpenViking-Account"] = this.account;
    if (this.user) h["X-OpenViking-User"] = this.user;
    if (this.peerId) h["X-OpenViking-Actor-Peer"] = this.peerId;
    if (this.cfg.userAgent) h["User-Agent"] = this.cfg.userAgent;
    return h;
  }

  /** Core fetch wrapper. Returns { ok, result } after parsing OV's { status, result } envelope. */
  async fetchJSON<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<OVResponse<T>> {
    try {
      const headers = { ...this.headers(), ...((init?.headers as Record<string, string>) || {}) };
      let ok: boolean, status: number, body: any;
      if (this.loopback) {
        this.directAgent ??= new Agent();
        const resp = await undiciRequest(`${this.baseUrl}${path}`, {
          method: (init?.method as "GET" | "POST" | "PUT" | "DELETE" | undefined) ?? "GET",
          headers,
          body: init?.body as string | undefined,
          signal: AbortSignal.timeout(timeoutMs),
          dispatcher: this.directAgent,
        });
        status = resp.statusCode;
        ok = status >= 200 && status < 300;
        body = await resp.body.json().catch(() => ({}));
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: controller.signal });
        clearTimeout(timer);
        status = resp.status;
        ok = resp.ok;
        body = await resp.json().catch(() => ({}));
      }
      const traceId = body?.result?.trace_id || body?.error?.trace_id || body?.trace_id || undefined;
      if (!ok || body.status === "error") {
        return {
          ok: false,
          result: null,
          status,
          error: body.error || { message: `HTTP ${status}` },
          traceId,
        };
      }
      return { ok: true, result: (body.result ?? body) as T, traceId };
    } catch (err: any) {
      return { ok: false, result: null, status: 0, error: { message: err?.message || String(err) } };
    }
  }

  // ========== Health ==========

  async health(): Promise<boolean> {
    const res = await this.fetchJSON<any>("/health", undefined, 5000);
    this.connected = res.ok;
    return res.ok;
  }

  // ========== Sessions ==========

  /** POST /api/v1/sessions — create or reuse session */
  async createSession(sessionId: string): Promise<boolean> {
    const res = await this.fetchJSON<any>("/api/v1/sessions", {
      method: "POST",
      body: JSON.stringify({ session_id: sessionId }),
    });
    return res.ok;
  }

  /** GET /api/v1/sessions/{id} — session metadata */
  async getSession(sessionId: string, autoCreate = false): Promise<OVSessionMeta | null> {
    const q = autoCreate ? "?auto_create=true" : "";
    const res = await this.fetchJSON<OVSessionMeta>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}${q}`,
      undefined, 5000,
    );
    return res.ok ? res.result : null;
  }

  /** GET /api/v1/sessions/{id}/context — assembled context with archive overview */
  async getSessionContext(sessionId: string, tokenBudget = 128000): Promise<OVSessionContext | null> {
    const res = await this.fetchJSON<OVSessionContext>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${tokenBudget}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  /** GET one completed archive by the identity returned from commit. */
  async getSessionArchive(sessionId: string, archiveId: string): Promise<OVSessionArchive | null> {
    const res = await this.fetchJSON<OVSessionArchive>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/archives/${encodeURIComponent(archiveId)}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  /** GET /api/v1/tasks/{task_id} — background commit status. */
  async getTask(taskId: string): Promise<OVTask | null> {
    const res = await this.fetchJSON<OVTask>(
      `/api/v1/tasks/${encodeURIComponent(taskId)}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  /** List commit tasks for migration safety; no task content is exposed to the model. */
  async listSessionCommitTasks(sessionId: string, limit = 50): Promise<OVTask[] | null> {
    const query = new URLSearchParams({
      task_type: "session_commit",
      resource_id: sessionId,
      limit: String(limit),
    });
    const res = await this.fetchJSON<OVTask[]>(`/api/v1/tasks?${query}`, undefined, 10000);
    return res.ok && Array.isArray(res.result) ? res.result : null;
  }

  /** POST /api/v1/sessions/{id}/messages — add a message (simple text mode) */
  async addMessage(sessionId: string, role: string, content: string): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: JSON.stringify({ role, content }) },
      10000,
    );
    return res.ok;
  }

  /** POST /api/v1/sessions/{id}/messages — add a message with parts */
  async addMessageParts(sessionId: string, role: string, parts: any[]): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: JSON.stringify({ role, parts }) },
      10000,
    );
    return res.ok;
  }

  async addMessagePayload(sessionId: string, payload: any): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: JSON.stringify(payload) },
      10000,
    );
    return res.ok;
  }

  /** POST /api/v1/sessions/{id}/commit — commit session for archiving + extraction */
  async commitSessionResponse(
    sessionId: string,
    options: OVCommitOptions = {},
  ): Promise<OVCommitResponse> {
    const body: Record<string, unknown> = {
      keep_recent_count: options.keepRecentCount ?? this.cfg.commitKeepRecentCount,
    };
    if (options.retentionMode) body.retention_mode = options.retentionMode;
    if (options.keepRecentTurnCount !== undefined) body.keep_recent_turn_count = options.keepRecentTurnCount;
    if (options.retainedMessageTokenBudget !== undefined) {
      body.retained_message_token_budget = options.retainedMessageTokenBudget;
    }
    if (options.minRawTailSteps !== undefined) body.min_raw_tail_steps = options.minRawTailSteps;

    const res = await this.fetchJSON<OVCommitResult>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      { method: "POST", body: JSON.stringify(body) },
      30000,
    );
    if (res.ok && res.result && !res.result.trace_id && res.traceId) {
      res.result.trace_id = res.traceId;
    }
    return {
      result: res.ok ? res.result : null,
      traceId: res.traceId,
      error: res.error,
      status: res.status,
    };
  }

  async commitSession(
    sessionId: string,
    options: OVCommitOptions = {},
  ): Promise<OVCommitResult | null> {
    return (await this.commitSessionResponse(sessionId, options)).result;
  }

  /** DELETE /api/v1/sessions/{id} */
  async deleteSession(sessionId: string): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      10000,
    );
    return res.ok;
  }

  // ========== Search ==========

  /** POST /api/v1/search/find — basic vector search */
  async find(
    query: string,
    opts?: { targetUri?: string; topK?: number; scoreThreshold?: number },
  ): Promise<OVSearchResult[]> {
    const body: Record<string, unknown> = { query };
    if (opts?.targetUri) body.target_uri = opts.targetUri;
    if (opts?.topK) body.limit = opts.topK;
    if (opts?.scoreThreshold) body.score_threshold = opts.scoreThreshold;

    const res = await this.fetchJSON<any>("/api/v1/search/find", {
      method: "POST", body: JSON.stringify(body),
    }, 10000);
    if (!res.ok || !res.result) return [];

    // OV returns { memories: [...], resources: [...], skills: [...], total }
    const all: OVSearchResult[] = [];
    for (const bucket of ["memories", "resources", "skills"]) {
      const items = res.result[bucket];
      if (Array.isArray(items)) {
        for (const m of items) {
          all.push({
            uri: m.uri ?? "",
            context_type: m.context_type ?? (bucket === "memories" ? "memory" : bucket === "skills" ? "skill" : "resource"),
            score: m.score ?? 0,
            abstract: m.abstract ?? "",
            overview: m.overview ?? null,
            level: m.level ?? 0,
            category: m.category ?? "",
            match_reason: m.match_reason ?? "",
          });
        }
      }
    }
    return all;
  }

  // ========== Content ==========

  /** GET /api/v1/content/abstract — L0 summary */
  async abstract(uri: string): Promise<string | null> {
    const res = await this.fetchJSON<string>(
      `/api/v1/content/abstract?uri=${encodeURIComponent(uri)}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  /** GET /api/v1/content/overview — L1 overview (directories only) */
  async overview(uri: string): Promise<string | null> {
    const res = await this.fetchJSON<string>(
      `/api/v1/content/overview?uri=${encodeURIComponent(uri)}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  /** GET /api/v1/content/read — L2 full content (files only) */
  async readContent(uri: string): Promise<string | null> {
    const res = await this.fetchJSON<string>(
      `/api/v1/content/read?uri=${encodeURIComponent(uri)}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  // ========== Filesystem ==========

  /** GET /api/v1/fs/ls — list directory */
  async ls(uri: string): Promise<OVDirEntry[]> {
    const res = await this.fetchJSON<any[]>(
      `/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`,
      undefined, 10000,
    );
    if (!res.ok || !Array.isArray(res.result)) return [];
    return res.result.map(e => ({
      uri: e.uri ?? "",
      name: e.name ?? uriBasename(e.uri ?? ""),
      isDir: e.isDir ?? false,
      size: e.size ?? 0,
      mode: e.mode ?? 0,
      modTime: e.modTime ?? "",
      abstract: e.abstract ?? "",
    }));
  }

  /** GET /api/v1/fs/stat — file/directory metadata */
  async stat(uri: string): Promise<OVStatInfo | null> {
    const res = await this.fetchJSON<OVStatInfo>(
      `/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`,
      undefined, 10000,
    );
    return res.ok ? res.result : null;
  }

  /** DELETE /api/v1/fs — remove file or directory */
  async delete(uri: string, recursive = false): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      `/api/v1/fs?uri=${encodeURIComponent(uri)}&recursive=${recursive}`,
      { method: "DELETE" },
      10000,
    );
    return res.ok;
  }

  // ========== Resources ==========

  /** POST /api/v1/resources — ingest a URL or file path */
  async addResource(
    path: string, opts?: { to?: string },
  ): Promise<{ root_uri: string } | null> {
    const body: Record<string, unknown> = { path };
    if (opts?.to) body.to = opts.to;
    const res = await this.fetchJSON<{ root_uri: string }>(
      "/api/v1/resources",
      { method: "POST", body: JSON.stringify(body) },
      30000,
    );
    return res.ok ? res.result : null;
  }

  // ========== URI Space Resolution ==========

  async resolveScopeSpace(scope: "user" | "agent"): Promise<string> {
    const cached = this.resolvedSpaces.get(scope);
    if (cached) return cached;

    // Probe system status for user identity fallback
    let fallbackSpace = "default";
    const statusRes = await this.fetchJSON<any>("/api/v1/system/status", undefined, 5000);
    if (statusRes.ok && typeof statusRes.result?.user === "string" && statusRes.result.user.trim()) {
      fallbackSpace = statusRes.result.user.trim();
    }

    // List scope root for actual namespaces
    const reserved = scope === "user" ? OVClient.RESERVED_USER : OVClient.RESERVED_AGENT;
    const entries = await this.ls(`viking://${scope}/`);
    const spaces = entries
      .filter(e => e.isDir && !e.name.startsWith(".") && !reserved.has(e.name))
      .map(e => e.name);

    if (spaces.length > 0) {
      // Prefer the fallback space if it exists, then "default", then first available
      let chosen = spaces[0];
      if (spaces.includes(fallbackSpace)) chosen = fallbackSpace;
      else if (spaces.includes("default")) chosen = "default";
      this.resolvedSpaces.set(scope, chosen);
      return chosen;
    }

    this.resolvedSpaces.set(scope, fallbackSpace);
    return fallbackSpace;
  }

  async resolveTargetUri(targetUri: string): Promise<string> {
    const trimmed = targetUri.trim().replace(/\/+$/, "");
    const m = trimmed.match(/^viking:\/\/(user|agent)(?:\/(.*))?$/);
    if (!m) return trimmed;
    const scope = m[1] as "user" | "agent";
    const rawRest = (m[2] ?? "").trim();
    if (!rawRest) return trimmed;
    const parts = rawRest.split("/").filter(Boolean);
    if (parts.length === 0) return trimmed;

    const reserved = scope === "user" ? OVClient.RESERVED_USER : OVClient.RESERVED_AGENT;
    if (!reserved.has(parts[0])) return trimmed; // already has space

    const space = await this.resolveScopeSpace(scope);
    return `viking://${scope}/${space}/${parts.join("/")}`;
  }
}

function uriBasename(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const last = cleaned.lastIndexOf("/");
  return last >= 0 ? cleaned.slice(last + 1) : cleaned;
}
