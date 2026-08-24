import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { OVClient } from "./client.js";
import type { SyncManager } from "./sync.js";
import { observation, type Observation } from "./shared/observe.mjs";
import { eventTokenWeight } from "./shared/context-weight.mjs";
import { recordedEventBytes } from "./shared/recorded-event.mjs";
import { parseRetrievalResultUri } from "./shared/retrieval-index.mjs";

/** 已注册的工具名，供系统提示引用；集合的事实源在本模块。 */
export const VIKING_TOOL_NAMES = [
  "viking_search",
  "viking_read",
  "viking_browse",
  "viking_remember",
  "viking_forget",
  "viking_add_resource",
  "viking_archive_expand",
] as const;

function boundedIndexField(value: unknown, maxChars = 80): string {
  const flat = String(value ?? "unknown").replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 事件索引行的种类标签：entry 类型加上消息角色或工具名。 */
function describeEventKind(event: any): string {
  const entry = event?.payload?.entry ?? {};
  const kind = event?.source?.entryType ?? entry.type ?? "unknown";
  const detail = entry.message?.role ?? entry.message?.toolName ?? entry.customType;
  return boundedIndexField(detail ? `${kind}/${detail}` : kind);
}

/** 单行摘要：取 part 文本的前 100 字符；非文本部分只描述形状。 */
function eventExcerpt(event: any): string {
  const value = event?.payload?.part?.value;
  const text = typeof value === "string" ? value
    : typeof value?.text === "string" ? value.text
      : typeof value?.thinking === "string" ? value.thinking
        : null;
  if (text === null) return `(${boundedIndexField(event?.payload?.part?.form ?? "no")} part, no text)`;
  const flat = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > 100 ? `${flat.slice(0, 100)}…` : flat);
}
export function registerTools(pi: any, client: OVClient, sync: SyncManager, observe: Observation = observation): void {
  // Session-scoped memory confines the model to its own namespace. The server
  // applies the user header to memory-semantic calls only, so every tool that
  // takes or returns a viking:// URI is clamped here as well.
  const scoped = (): string =>
    client.cfg.sessionScopedMemory ? client.userRoot : "";

  const unavailable = (tool: string): boolean => {
    observe.emit("tool_availability", tool, client.connected);
    return !client.connected;
  };

  const userRelativeRoots = new Set(["memories", "resources", "skills", "peers", "privacy", "sessions"]);
  const canonicalVikingUri = (input: unknown): string | null => {
    const raw = String(input ?? "").trim();
    if (raw === "viking://") return raw;
    if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
    const match = /^viking:\/\/([^/?#]+)(?:\/([^?#]*))?$/.exec(raw);
    if (!match) return null;
    const path = match[2];
    const segments = path === undefined ? [] : path.split("/");
    const last = segments.length - 1;
    if (segments.some((segment, index) =>
      (!segment && index !== last) || segment === "." || segment === ".." || segment.includes("\\"),
    )) return null;
    if (match[1] === "user" && segments[0] && userRelativeRoots.has(segments[0])) {
      const currentRoot = String(client.userRoot || "").replace(/\/+$/, "");
      if (!/^viking:\/\/user\/[^/?#]+$/.test(currentRoot)) return null;
      return `${currentRoot}/${path}`;
    }
    return raw;
  };

  const insideCanonical = (uri: string, root: string): boolean =>
    !root || uri === root || uri.startsWith(`${root}/`);

  const authorizeUri = (
    input: unknown, tool: string, operation: "read" | "browse", root = scoped(),
  ): { uri: string | null; error: string | null } => {
    const raw = String(input ?? "").trim();
    const uri = canonicalVikingUri(raw);
    const allowed = uri !== null && insideCanonical(uri, root);
    observe.emit("tool_scope", tool, operation, Boolean(root), allowed ? "allow" : "deny", allowed ? 1 : 0, allowed ? 0 : 1);
    if (allowed) return { uri, error: null };
    return {
      uri: null,
      error: uri === null
        ? `Refused: ${raw} is not a valid viking URI.`
        : `Refused: ${raw} is outside this session's memory namespace (${root}).`,
    };
  };

  /** Deletion is additionally forbidden for adapter-owned immutable facts. */
  const authorizeDelete = (input: unknown, tool: string, root = scoped()): { uri: string | null; error: string | null } => {
    const raw = String(input ?? "").trim();
    const uri = canonicalVikingUri(raw);
    const internal = Boolean(uri &&
      /^viking:\/\/user\/[^/]+\/resources\/\.pi-openviking(?:\/|$)/.test(uri));
    const allowed = uri !== null && insideCanonical(uri, root) && !internal;
    observe.emit("tool_scope", tool, "delete", Boolean(root), allowed ? "allow" : "deny", allowed ? 1 : 0, allowed ? 0 : 1);
    if (allowed) return { uri, error: null };
    if (!uri) return { uri: null, error: `Refused: ${raw} is not a valid viking URI.` };
    return {
      uri: null,
      error: internal
        ? `Refused: ${raw} is managed by pi-openviking and cannot be deleted through memory tools.`
        : `Refused: ${raw} is outside this session's memory namespace (${root}).`,
    };
  };

  /** Search scope: invalid input is rejected; only a valid out-of-scope URI is clamped. */
  const resolveSearchScope = (
    tool: string, requested?: string, root = scoped(),
  ): { targetUri: string | undefined; error: string | null } => {
    const raw = String(requested ?? "").trim();
    if (!raw) {
      observe.emit("tool_scope", tool, "search_request", Boolean(root), "allow", 1, 0);
      return { targetUri: root || undefined, error: null };
    }
    const uri = canonicalVikingUri(raw);
    if (!uri) {
      observe.emit("tool_scope", tool, "search_request", Boolean(root), "deny", 0, 1);
      return { targetUri: undefined, error: `Refused: ${raw} is not a valid viking URI.` };
    }
    const allowed = insideCanonical(uri, root);
    const branch = allowed ? "allow" : "clamp";
    observe.emit("tool_scope", tool, "search_request", Boolean(root), branch, 1, 0);
    return { targetUri: allowed ? uri : root, error: null };
  };

  // --- viking_search ---
  pi.registerTool({
    name: "viking_search",
    label: "Viking Search",
    description: "Semantic search over public OpenViking knowledge and the current Pi session's rebuildable history index. Session-history hits return Archive/event or checkpoint locators; use viking_archive_expand to read authoritative raw events.",
    promptSnippet: "Search OpenViking for past decisions, preferences, project knowledge, and compacted earlier context of this session",
    promptGuidelines: [
      "Use viking_search when you need information from previous sessions not in MEMORY.md.",
      "Use viking_search when current work references earlier session context you can no longer see; expand raw_event hits with viking_archive_expand and read public viking:// hits with viking_read.",
      "Use viking_search before making decisions that might conflict with past decisions.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      scope: Type.Optional(Type.String({ description: "Viking URI prefix to scope search (e.g., 'viking://user/memories/')" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_search")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      // Public knowledge and Pi history have different trust boundaries: public search never returns
      // adapter-owned internals; the history query targets only the rebuildable index and converts
      // server faces into stable Archive/event or checkpoint locators.
      const root = scoped();
      const searchScope = resolveSearchScope("viking_search", params.scope, root);
      if (searchScope.error) return { content: [{ type: "text", text: searchScope.error }] };
      const limit = Math.min(50, Math.max(1, Math.floor(Number(params.limit) || 10)));
      const historyRoot = sync.retrievalRoot;
      const includeHistory = Boolean(historyRoot && (!params.scope || !root || searchScope.targetUri === root));
      const [publicFound, historyFound] = await Promise.all([
        client.find(params.query, { targetUri: searchScope.targetUri, topK: limit }),
        includeHistory ? client.find(params.query, { targetUri: historyRoot!, topK: limit }) : Promise.resolve([]),
      ]);
      const publicResults = publicFound.flatMap((result) => {
        const uri = canonicalVikingUri(result.uri);
        return uri && insideCanonical(uri, root) && !uri.includes("/.pi-openviking/")
          ? [{ kind: "public" as const, ...result, uri }]
          : [];
      });
      const historyBySource = new Map<string, any>();
      for (const result of historyFound) {
        const uri = canonicalVikingUri(result.uri);
        const locator = uri && historyRoot ? parseRetrievalResultUri(uri, historyRoot) : null;
        if (!locator || !insideCanonical(uri!, root)) continue;
        const key = locator.sourceType === "raw_event" ? locator.eventId! : locator.checkpointId!;
        const previous = historyBySource.get(key);
        if (!previous || result.score > previous.score) {
          historyBySource.set(key, { kind: "history" as const, ...result, locator });
        }
      }
      const results = [...publicResults, ...historyBySource.values()]
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
      const foundCount = publicFound.length + historyFound.length;
      observe.emit(
        "tool_scope",
        "viking_search",
        "search_result",
        Boolean(root),
        results.length === foundCount ? "allow" : "filter",
        results.length,
        foundCount - results.length,
      );
      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }
      const maxChars = client.cfg.recallMaxContentChars;
      const abstract = (result: any): string => {
        const value = String(result.abstract || result.overview || result.match_reason || "");
        return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
      };
      const lines = results.map((result: any) => {
        if (result.kind === "public") {
          return `[${result.score.toFixed(2)}] ${result.uri}\n  ${abstract(result)}`;
        }
        const locator = result.locator;
        const identity = locator.sourceType === "raw_event"
          ? `archive_id: ${locator.archiveId}\n  event_id: ${locator.eventId}`
          : `source_archive_id: ${locator.archiveId}\n  checkpoint_id: ${locator.checkpointId}`;
        return `[${result.score.toFixed(2)}] ${locator.sourceType}\n  ${identity}\n  ${abstract(result)}`;
      });
      const details = results.map((result: any) => result.kind === "public"
        ? { kind: "public", uri: result.uri, score: result.score, abstract: abstract(result) }
        : { kind: "history", ...result.locator, score: result.score, abstract: abstract(result) });
      return {
        content: [{ type: "text", text: lines.join("\n\n") }],
        details: { results: details },
      };
    },
  });

  // --- viking_read ---
  pi.registerTool({
    name: "viking_read",
    label: "Viking Read",
    description: "Read content at a viking:// URI. Three detail levels: 'abstract' (~100 tokens), 'overview' (~2k tokens), 'full' (complete). Start with abstract, escalate when needed.",
    promptSnippet: "Read OpenViking content at a viking:// URI with tiered detail levels",
    parameters: Type.Object({
      uri: Type.String({ description: "viking:// URI to read" }),
      level: StringEnum(["abstract", "overview", "full"] as const),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_read")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      const root = scoped();
      const read = authorizeUri(params.uri, "viking_read", "read", root);
      if (read.error) return { content: [{ type: "text", text: read.error }] };
      const uri = read.uri!;
      let content: string | null = null;
      switch (params.level) {
        case "abstract": content = await client.abstract(uri); break;
        case "overview": content = await client.overview(uri); break;
        case "full":     content = await client.readContent(uri); break;
      }
      if (!content) {
        return { content: [{ type: "text", text: `No content at ${uri}` }] };
      }
      return { content: [{ type: "text", text: content }] };
    },
  });

  // --- viking_browse ---
  pi.registerTool({
    name: "viking_browse",
    label: "Viking Browse",
    description: "Browse the OpenViking knowledge store like a filesystem. List directory contents or get metadata.",
    promptSnippet: "Browse the viking:// directory tree in OpenViking",
    parameters: Type.Object({
      action: StringEnum(["list", "stat"] as const),
      uri: Type.Optional(Type.String({ description: "viking:// URI (default: 'viking://')" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_browse")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      // Browsing defaults to the namespace root so the model cannot enumerate
      // sibling sessions from `viking://`.
      const root = scoped();
      const requested = params.uri ?? (root || "viking://");
      const browse = authorizeUri(requested, "viking_browse", "browse", root);
      if (browse.error) return { content: [{ type: "text", text: browse.error }] };
      const uri = browse.uri!;
      if (params.action === "stat") {
        const info = await client.stat(uri);
        if (!info) return { content: [{ type: "text", text: `Not found: ${uri}` }] };
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      // list
      const entries = await client.ls(uri);
      if (entries.length === 0) {
        return { content: [{ type: "text", text: `Empty directory: ${uri}` }] };
      }
      const lines = entries.map(e => `${e.isDir ? "📁" : "📄"} ${e.name}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });

  // --- viking_remember ---
  pi.registerTool({
    name: "viking_remember",
    label: "Viking Remember",
    description: "Store a fact or memory in OpenViking. Stored as a session message and extracted into long-term memory on commit. Use for important information the agent should remember: preferences, decisions, gotchas, lessons learned.",
    promptSnippet: "Store a fact in OpenViking for cross-session persistence",
    promptGuidelines: [
      "Use viking_remember for facts that should survive across sessions but don't belong in MEMORY.md.",
      "Good for: user preferences, architectural decisions, gotchas, environment details.",
    ],
    parameters: Type.Object({
      content: Type.String({ description: "The fact or observation to store" }),
      category: Type.Optional(Type.String({ description: "Category hint: 'preference', 'entity', 'event', 'case', 'pattern'" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_remember")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      // Store as a tagged message directly in OV — the extractor picks up [Remember — ...] prefix
      const category = params.category ?? "general";
      const tagged = `[Remember — ${category}] ${params.content}`;

      // Directly add to OV session if available
      let stored = false;
      if (sync?.sessionId && await client.createSession(sync.sessionId)) {
        const added = await client.addMessage(sync.sessionId, "user", tagged);
        stored = added && await client.commitRememberedMessage(sync.sessionId);
      }

      return {
        content: [{ type: "text", text: stored ? `Remembered in OpenViking: "${params.content}" (${category})` : `OpenViking could not store: "${params.content}" (${category})` }],
        details: { stored, category, tagged },
      };
    },
  });

  // --- viking_forget ---
  pi.registerTool({
    name: "viking_forget",
    label: "Viking Forget",
    description: "Delete a memory by URI, or search for a specific memory and remove it. Use to correct outdated or wrong information.",
    promptSnippet: "Delete a memory from OpenViking by URI or query",
    parameters: Type.Object({
      uri: Type.Optional(Type.String({ description: "Exact viking:// URI to delete" })),
      query: Type.Optional(Type.String({ description: "Search query — deletes the strongest match if score > 0.8" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_forget")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      if (params.uri) {
        const root = scoped();
        const deletion = authorizeDelete(params.uri, "viking_forget", root);
        if (deletion.error) return { content: [{ type: "text", text: deletion.error }] };
        const uri = deletion.uri!;
        const ok = await client.delete(uri);
        return {
          content: [{ type: "text", text: ok ? `Deleted: ${uri}` : `Failed to delete: ${uri}` }],
        };
      }
      if (params.query) {
        // 搜索限定在绑定命名空间内，命中结果在删除前仍逐条复核归属：
        // 删除不可逆，不能只依赖搜索范围。
        const root = scoped();
        const searchScope = resolveSearchScope("viking_forget", undefined, root);
        const results = await client.find(params.query, { targetUri: searchScope.targetUri, topK: 1 });
        if (results.length > 0 && results[0].score > 0.8) {
          const deletion = authorizeDelete(results[0].uri, "viking_forget", root);
          if (deletion.error) return { content: [{ type: "text", text: deletion.error }] };
          const uri = deletion.uri!;
          const ok = await client.delete(uri);
          return {
            content: [{ type: "text", text: ok ? `Deleted: ${uri}` : `Failed: ${uri}` }],
          };
        }
        return { content: [{ type: "text", text: "No strong match found (score > 0.8 required)." }] };
      }
      return { content: [{ type: "text", text: "Provide either 'uri' or 'query'." }] };
    },
  });

  // --- viking_add_resource ---
  pi.registerTool({
    name: "viking_add_resource",
    label: "Viking Add Resource",
    description: "Ingest a URL into OpenViking. The page is auto-processed into L0/L1/L2 tiers and indexed for semantic search. HTTP only — local file paths are not supported by the OV server.",
    promptSnippet: "Ingest a URL into OpenViking for indexed retrieval",
    parameters: Type.Object({
      url: Type.String({ description: "URL to ingest (HTTP only, no file paths)" }),
      reason: Type.Optional(Type.String({ description: "Why this resource is relevant (improves indexing)" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_add_resource")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      const root = scoped();
      if (root) {
        observe.emit("tool_scope", "viking_add_resource", "resource_add", true, "deny", 0, 1);
        return { content: [{ type: "text", text: "Refused: resource ingestion is unavailable while session-scoped memory is enabled." }] };
      }
      const result = await client.addResource(params.url, params.reason ? { reason: params.reason } : undefined);
      if (!result) {
        return { content: [{ type: "text", text: `Failed to ingest: ${params.url}` }] };
      }
      const uri = canonicalVikingUri(result.root_uri);
      observe.emit("tool_scope", "viking_add_resource", "resource_add", false, uri ? "allow" : "deny", uri ? 1 : 0, uri ? 0 : 1);
      if (!uri) {
        return { content: [{ type: "text", text: `Failed to ingest: ${params.url}` }] };
      }
      return {
        content: [{ type: "text", text: `Ingested: ${uri}` }],
        details: { ...result, root_uri: uri },
      };
    },
  });

  // --- viking_archive_expand ---
  pi.registerTool({
    name: "viking_archive_expand",
    label: "Viking Archive Expand",
    description:
      "List committed archives currently known in this session process, or page through one archive's event index" +
      " (event ids, roles, context weights, short excerpts, and direct-representation read URIs when available)." +
      " Use to recover earlier context of THIS session that was compacted or replaced by a checkpoint; use" +
      " viking_read when the index exposes a read URI; pass event_id only for an oversized event without one." +
      " Never dumps full archive payloads by default.",
    promptSnippet: "List this session's archives or inspect one archive's event index to recover compacted earlier context",
    promptGuidelines: [
      "Retrieve only when an omitted fact could change the next action; inspect the archive list or index first.",
      "Read the smallest relevant page or event slice, and do not expand a complete omitted range by default.",
      "Use viking_read for indexed direct URIs; use event_id with bounded event_offset/event_limit only when no URI is available.",
    ],
    parameters: Type.Object({
      archive_id: Type.Optional(Type.String({
        description: "Archive ID (arc_<64 hex>) produced by this session; omit to list committed archives currently known in this process",
      })),
      event_id: Type.Optional(Type.String({
        description: "Event ID from this archive's index; only oversized events without a read URI are returned in bounded slices",
      })),
      offset: Type.Optional(Type.Number({ description: "Event index offset for paging (default 0)" })),
      limit: Type.Optional(Type.Number({ description: "Max events per index page (default 50)" })),
      event_offset: Type.Optional(Type.Number({ description: "Code-point offset within an oversized event (default 0)" })),
      event_limit: Type.Optional(Type.Number({ description: "Max code points from an oversized event (default 4000, max 16000)" })),
    }),
    async execute(
      _id: string, params: any, _signal: AbortSignal,
      _onUpdate: any, _ctx: any,
    ) {
      if (unavailable("viking_archive_expand")) {
        return { content: [{ type: "text", text: "OpenViking server is not reachable." }] };
      }
      const archiveId = String(params.archive_id ?? "").trim();
      // 无 archive_id 时是发现路径：列出当前进程在本会话已验证的 Archive，模型据此选择要检查的 archive。
      if (!archiveId) {
        observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "allow", 1, 0);
        const archives = sync.listArchives();
        if (archives.length === 0) {
          return { content: [{ type: "text", text: "No committed archives are currently known in this session process." }] };
        }
        const offset = Math.min(archives.length, Math.max(0, Math.floor(Number(params.offset) || 0)));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(params.limit) || 50)));
        const page = archives.slice(offset, offset + limit);
        const pageRange = page.length > 0 ? `${offset + 1}-${offset + page.length}` : "none";
        observe.emit("archive_retrieval", "list", limit, page.length, archives.length);
        const lines = page.map((descriptor: any, index: number) => {
          const manifest = descriptor.manifest;
          return `- [${offset + index + 1}] ${manifest.archiveId} — ${manifest.eventCount} events,` +
            ` ≈${descriptor.tokenCount} context tokens, ${manifest.firstEventId} → ${manifest.lastEventId}`;
        });
        return {
          content: [{
            type: "text",
            text: `This session process currently knows ${archives.length} committed archive(s); showing ${pageRange}:\n${lines.join("\n")}` +
              "\n\nPage with offset/limit, or call viking_archive_expand with one archive_id for its event index.",
          }],
        };
      }
      // Archive 位置由当前 Pi session 推导，跨会话展开在命名空间层面不可寻址；
      // 这里只需要拒绝形状非法的标识，避免把任意字符串带进 URI 组合。
      if (!/^arc_[0-9a-f]{64}$/.test(archiveId)) {
        observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "deny", 0, 1);
        return { content: [{ type: "text", text: `Refused: ${archiveId} is not a valid archive id.` }] };
      }
      const eventId = String(params.event_id ?? "").trim();
      if (eventId && !/^evt_[0-9a-f]{64}$/.test(eventId)) {
        observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "deny", 0, 1);
        return { content: [{ type: "text", text: `Refused: ${eventId} is not a valid event id.` }] };
      }
      observe.emit("tool_scope", "viking_archive_expand", "archive", Boolean(scoped()), "allow", 1, 0);
      try {
        const { manifest, events } = await sync.expandArchive(archiveId);
        if (eventId) {
          const event = events.find((candidate: any) => candidate.eventId === eventId);
          if (!event) {
            return { content: [{ type: "text", text: `Event ${eventId} is not referenced by archive ${archiveId}.` }] };
          }
          const bytes = recordedEventBytes(event);
          const uri = sync.eventStorageUri(event.eventId, bytes.length);
          if (uri) {
            observe.emit("archive_retrieval", "direct", 1, 1, 1);
            return { content: [{
              type: "text",
              text: `Event ${eventId} has an authoritative direct representation. Read the smallest required level with viking_read: ${uri}`,
            }] };
          }
          const points = Array.from(bytes.toString("utf8"));
          const eventOffset = Math.min(points.length, Math.max(0, Math.floor(Number(params.event_offset) || 0)));
          const eventLimit = Math.min(16000, Math.max(1, Math.floor(Number(params.event_limit) || 4000)));
          const slice = points.slice(eventOffset, eventOffset + eventLimit).join("");
          const emitted = Math.min(eventLimit, points.length - eventOffset);
          observe.emit("archive_retrieval", "chunk", eventLimit, emitted, points.length);
          return { content: [{
            type: "text",
            text: `Oversized event ${eventId}; canonical JSON code points ${eventOffset + 1}-${eventOffset + emitted}` +
              ` of ${points.length}. Continue with event_offset=${eventOffset + emitted} and the smallest needed event_limit.\n\n${slice}`,
          }] };
        }
        const offset = Math.min(events.length, Math.max(0, Math.floor(Number(params.offset) || 0)));
        const limit = Math.min(200, Math.max(1, Math.floor(Number(params.limit) || 50)));
        const page = events.slice(offset, offset + limit);
        const pageRange = page.length > 0 ? `${offset + 1}-${offset + page.length}` : "none";
        const header = [
          `archive ${manifest.archiveId}`,
          `events ${manifest.eventCount} (${manifest.firstEventId} → ${manifest.lastEventId})`,
          `content ${manifest.contentHash}`,
          `showing ${pageRange} of ${events.length}; page with offset/limit.`,
          "This is an index, not full content: use viking_read for a read URI; for an oversized event without one, pass its event_id and bounded event_offset/event_limit.",
        ].join("\n");
        const body = page.map((event: any, index: number) => {
          const uri = sync.eventStorageUri(event.eventId, recordedEventBytes(event).length);
          const lines = [
            `[${offset + index + 1}] ${event.eventId} ${event.occurredAt} ${describeEventKind(event)}` +
              ` weight≈${eventTokenWeight(event)} tokens`,
            `    excerpt: ${eventExcerpt(event)}`,
          ];
          if (uri) lines.push(`    read: ${uri}`);
          return lines.join("\n");
        });
        observe.emit("archive_retrieval", "index", limit, page.length, events.length);
        return { content: [{ type: "text", text: `${header}\n\n${body.join("\n")}` }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Archive not available: ${error?.name || "Error"}` }] };
      }
    },
  });
}
