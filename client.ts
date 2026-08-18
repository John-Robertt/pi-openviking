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


export interface OVResponse<T> {
  ok: boolean;
  result: T | null;
  error?: any;
  status?: number;
  traceId?: string;
}

export interface OVBatchWriteOperation {
  uri: string;
  content_base64: string;
  precondition: { kind: "create_if_absent" };
}

export interface OVBatchWriteRequest {
  root_uri: string;
  operations: OVBatchWriteOperation[];
  wait: false;
}

export interface OVBatchWriteResult {
  root_uri: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  queue_status?: unknown;
}

export interface OVUriStatus {
  ok: boolean;
  exists: boolean;
  isDir: boolean;
  status: number;
  error?: unknown;
}

export interface OVBytesResponse {
  ok: boolean;
  bytes: Buffer | null;
  status: number;
  error?: unknown;
}

export class OVClient {
  private baseUrl: string;
  private apiKey: string;
  private account: string;
  private user: string;
  private peerId: string;
  private readonly loopback: boolean;
  private directAgent?: Agent;
  private lifecycleAbort = new AbortController();
  connected: boolean = false;

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
   */
  bindUser(user: string): void {
    if (!user || user === this.user) return;
    this.user = user;
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

  get recordedEventTarget(): { endpoint: string; account: string; user: string } {
    return { endpoint: this.baseUrl, account: this.account, user: this.user };
  }

  /**
   * 记忆空间名：profile 注入和 recall 展开 `viking://user/<reserved>/...` 时使用。
   *
   * 与 `userRoot` 和 `recordedEventTarget` 同源，都是 `this.user`：读取必须落在
   * 写入所在的命名空间，否则扩展会写进一处、读另一处。因此这里不做任何回退或
   * 服务端查询——身份只由已绑定的凭证决定。
   *
   * 未绑定用户时返回 ""，调用方跳过 profile 与 URI 展开。
   */
  get memorySpace(): string {
    return this.user;
  }

  private requestSignal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([AbortSignal.timeout(timeoutMs), this.lifecycleAbort.signal]);
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
          signal: this.requestSignal(timeoutMs),
          dispatcher: this.directAgent,
        });
        status = resp.statusCode;
        ok = status >= 200 && status < 300;
        body = await resp.body.json().catch(() => ({}));
      } else {
        const resp = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          signal: this.requestSignal(timeoutMs),
        });
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
    const res = await this.fetchJSON<any>("/health", undefined, 1000);
    this.connected = res.ok && res.result?.healthy === true;
    return this.connected;
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


  /** POST /api/v1/sessions/{id}/messages — add a message (simple text mode) */
  async addMessage(sessionId: string, role: string, content: string): Promise<boolean> {
    const res = await this.fetchJSON<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body: JSON.stringify({ role, content }) },
      10000,
    );
    return res.ok;
  }

  /** Commit only an explicit viking_remember message for memory extraction. */
  async commitRememberedMessage(sessionId: string): Promise<boolean> {
    const response = await this.fetchJSON<any>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/commit`,
      { method: "POST", body: JSON.stringify({ keep_recent_count: 0 }) },
      30000,
    );
    return response.ok;
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

  /** POST /api/v1/content/batch-write — immutable, preconditioned byte writes. */
  async batchWrite(request: OVBatchWriteRequest): Promise<OVResponse<OVBatchWriteResult>> {
    return this.fetchJSON<OVBatchWriteResult>(
      "/api/v1/content/batch-write",
      { method: "POST", body: JSON.stringify(request) },
      30000,
    );
  }

  /** GET /api/v1/content/download — raw stored bytes without JSON decoding. */
  async downloadBytes(uri: string): Promise<OVBytesResponse> {
    const path = `/api/v1/content/download?uri=${encodeURIComponent(uri)}`;
    try {
      const headers = this.headers();
      if (this.loopback) {
        this.directAgent ??= new Agent();
        const response = await undiciRequest(`${this.baseUrl}${path}`, {
          method: "GET",
          headers,
          signal: this.requestSignal(30000),
          dispatcher: this.directAgent,
        });
        const status = response.statusCode;
        const bytes = Buffer.from(await response.body.arrayBuffer());
        return status >= 200 && status < 300
          ? { ok: true, bytes, status }
          : { ok: false, bytes: null, status, error: { message: `HTTP ${status}` } };
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: this.requestSignal(30000),
      });
      const status = response.status;
      const bytes = Buffer.from(await response.arrayBuffer());
      return response.ok
        ? { ok: true, bytes, status }
        : { ok: false, bytes: null, status, error: { message: `HTTP ${status}` } };
    } catch (error: any) {
      return { ok: false, bytes: null, status: 0, error: { message: error?.message || String(error) } };
    }
  }

  /** Stat result that distinguishes not-found from transport failure. */
  async statUri(uri: string): Promise<OVUriStatus> {
    const response = await this.fetchJSON<OVStatInfo>(
      `/api/v1/fs/stat?uri=${encodeURIComponent(uri)}`,
      undefined,
      10000,
    );
    if (response.ok && response.result) {
      return { ok: true, exists: true, isDir: response.result.isDir === true, status: response.status || 200 };
    }
    if (response.status === 404) return { ok: true, exists: false, isDir: false, status: 404 };
    return { ok: false, exists: false, isDir: false, status: response.status || 0, error: response.error };
  }

  /** Create one VikingFS directory; callers make parents explicitly. */
  async mkdirUri(uri: string): Promise<OVResponse<{ uri: string }>> {
    return this.fetchJSON<{ uri: string }>(
      "/api/v1/fs/mkdir",
      { method: "POST", body: JSON.stringify({ uri }) },
      10000,
    );
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

  // ========== User Space Resolution ==========

  /**
   * 未配置用户时的存储用户名：服务端为本次凭证解析出的当前用户。
   *
   * SPEC“目标配置”规定 `sessionScopedMemory=false` 时使用配置用户或服务解析的
   * 当前用户。这里只问服务端本身，不枚举 `viking://user` 后挑选——该 ls 不按调
   * 用方过滤，任何挑选都可能选中其他用户的 space，并把事件写进去。
   *
   * 服务端未给出身份时回落到 `"default"`，与 index.ts:deriveMemoryNamespace
   * 对空配置用户的处理保持一致。
   */
  async resolveUserSpace(): Promise<string> {
    const statusRes = await this.fetchJSON<any>("/api/v1/system/status", undefined, 5000);
    const resolved = statusRes.ok && typeof statusRes.result?.user === "string"
      ? statusRes.result.user.trim()
      : "";
    return resolved || "default";
  }

  async close(force = false): Promise<void> {
    this.lifecycleAbort.abort();
    this.connected = false;
    const agent = this.directAgent;
    this.directAgent = undefined;
    if (agent) {
      if (force) await agent.destroy();
      else await agent.close();
    }
  }
}

function uriBasename(uri: string): string {
  const cleaned = uri.replace(/\/+$/, "");
  const last = cleaned.lastIndexOf("/");
  return last >= 0 ? cleaned.slice(last + 1) : cleaned;
}
