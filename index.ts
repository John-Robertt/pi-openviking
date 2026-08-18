/**
 * Pi OpenViking extension entry point.
 *
 * Observes Pi session events, synchronizes immutable RecordedEvent projections
 * to OpenViking, and injects best-effort memory recall without changing Pi's
 * compaction or provider-context ownership.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfigFromModuleUrl, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { RecallManager } from "./recall.js";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { createStatusRefresh } from "./shared/status-refresh.mjs";
import { clearVikingFooter, formatVikingCommand, setVikingFooter } from "./shared/viking-status.mjs";
import { guardVikingUriToolCall } from "./lib/uri-guard-adapter.mjs";
import { registerTools } from "./tools.js";

const HEALTH_REFRESH_INTERVAL_MS = 5000;
const OBSERVATION_ENTRY_TYPE = "ov-observation";

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled) return;

  // Env overrides

  // --- Initialize modules ---
  const client = new OVClient(config);
  const sync = new SyncManager(client);
  const recall = new RecallManager(client, config, () => sync.sessionId);
  const debugLog = (message: string) => {
    const file = process.env.OV_DEBUG_LOG;
    if (!file) return;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Best effort; logging must never affect pi.
    }
  };

  const recordObservation = (kind: string, content: string, targetEntryId: string | null): void => {
    try {
      pi.appendEntry(OBSERVATION_ENTRY_TYPE, { schemaVersion: 1, kind, targetEntryId, content });
    } catch (error: unknown) {
      debugLog(`observation append failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Session state
  let bypassed = false;
  let profileBlock = "";
  let toolsRegistered = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let statusContext: any = null;
  let startupWarningShown = false;

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      // Bypass check
      const cwd = process.cwd();
      for (const pattern of config.bypassPatterns) {
        if (matchBypass(cwd, pattern)) {
          bypassed = true;
          started = true;
          return;
        }
      }

      const piSessionId = ctx.sessionManager.getSessionId();
      if (config.sessionScopedMemory) {
        client.bindUser(deriveMemoryNamespace(config.user, piSessionId));
      }
      await sync.ensureSession(piSessionId);
      await sync.observeSession(ctx.sessionManager);

      if (!toolsRegistered) {
        registerTools(pi, client, sync);
        toolsRegistered = true;
      }

      await client.health();
      if (!client.connected) {
        if (config.logLevel === "info" && !startupWarningShown) {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        startupWarningShown = true;
        started = true;
        return;
      }
      startupWarningShown = false;
      profileBlock = await buildSessionProfileBlock(client, config);
      scheduleSync(ctx, "session_start");
      started = true;
      if (config.logLevel === "info") {
        ctx.ui.notify(`OpenViking connected (${piSessionId.slice(0, 8)}...)`, "info");
      }
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  };

  const renderStatus = (ctx: any): void => {
    if (bypassed) return;
    setVikingFooter(ctx, { connected: client.connected });
  };

  const scheduleSync = (ctx: any, stage: string): void => {
    if (bypassed || !config.syncTurns) return;
    const source = snapshotSessionSource(ctx.sessionManager);
    const operation = client.connected
      ? sync.syncSession(source)
      : sync.observeSession(source);
    void operation.then((result) => {
      debugLog(`${stage}: confirmed ${result.added} entries, pending=${result.pending}`);
      if (statusContext === ctx) renderStatus(ctx);
    }).catch((error: unknown) => {
      debugLog(`${stage}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const healthRefresh = createStatusRefresh({
    refresh: async () => {
      if (bypassed) return false;
      if (started) {
        await client.health();
      } else {
        await start(statusContext);
      }
      return client.connected;
    },
    publish: () => {
      if (statusContext) renderStatus(statusContext);
    },
    onError: (error: unknown) => {
      debugLog(`health refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    },
    intervalMs: HEALTH_REFRESH_INTERVAL_MS,
  });

  const refreshConnection = (ctx: any): Promise<boolean> => {
    statusContext = ctx;
    return healthRefresh.run();
  };

  const beginHealthPolling = (ctx: any): void => {
    statusContext = ctx;
    if (!bypassed) healthRefresh.start();
  };

  const stopHealthPolling = async (ctx: any): Promise<void> => {
    const stopping = healthRefresh.stop();
    clearVikingFooter(ctx);
    await stopping;
    statusContext = null;
  };

  // --- session_start ---
  pi.on("session_start", async (_event, ctx) => {
    await refreshConnection(ctx);
    beginHealthPolling(ctx);
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (event, ctx) => {
    // Keep continuations initialized and refresh health before each user-prompt run.
    await refreshConnection(ctx);
    beginHealthPolling(ctx);

    if (!client.connected || bypassed) return;

    // Queue recall for the context hook. Pi renders the user message before
    // that hook, so recall latency does not delay the message appearing.
    recall.queueSearch(event.prompt);

    // Compose system prompt additions
    const parts: string[] = [];
    if (profileBlock) {
      parts.push(profileBlock);
      recordObservation("profile-injection", profileBlock, ctx.sessionManager.getLeafId());
    }
    parts.push("OpenViking tools: viking_search, viking_read, viking_browse, viking_remember, viking_forget, viking_add_resource, viking_archive_expand.");

    const additions = parts.join("\n\n");
    if (!additions) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + additions,
    };
  });

  // --- context ---
  pi.on("context", async (event, ctx) => {
    if (!client.connected || bypassed) return;

    // Keep recall synchronous with the provider request so the current prompt
    // still receives current-query memory, without blocking user-message UI.
    await recall.searchPending();

    const { messages, injectedBlock } = recall.injectRecall(event.messages);
    if (injectedBlock) {
      recordObservation("recall-injection", injectedBlock, ctx.sessionManager.getLeafId());
    }
    return { messages };
  });

  // --- tool_call ---
  pi.on("tool_call", async (event, _ctx) => {
    const decision = guardVikingUriToolCall(event);
    if (!decision) return;
    return decision;
  });

  // --- turn_end ---
  pi.on("turn_end", (_event, ctx) => {
    if (bypassed || !config.syncTurns) return;
    scheduleSync(ctx, "turn_end");
  });

  // Pi remains the sole compaction trigger. After it appends the compaction entry,
  // record that new source fact without altering the compaction lifecycle.
  pi.on("session_compact", (_event, ctx) => {
    if (bypassed || !config.syncTurns) return;
    scheduleSync(ctx, "session_compact");
  });

  pi.on("session_tree", (_event, ctx) => {
    if (!started || bypassed || !config.syncTurns) return;
    scheduleSync(ctx, "session_tree");
  });

  pi.on("session_info_changed", (_event, ctx) => {
    if (!started || bypassed || !config.syncTurns) return;
    scheduleSync(ctx, "session_info_changed");
  });

  pi.on("model_select", (_event, ctx) => {
    if (!started || bypassed || !config.syncTurns) return;
    scheduleSync(ctx, "model_select");
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    if (!started || bypassed || !config.syncTurns) return;
    scheduleSync(ctx, "thinking_level_select");
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    await stopHealthPolling(ctx);
    scheduleSync(ctx, "session_shutdown");
    await sync.waitForIdle(500);
    await client.close(true);
  });

  // --- agent_end ---
  pi.on("agent_end", () => {
    recall.invalidate();
  });

  // ================================================================
  // Commands
  // ================================================================

  pi.registerCommand("viking", {
    description: "查看 OpenViking 事件同步状态；使用 sync 立即重放当前会话。",
    getArgumentCompletions: (prefix) => {
      const value = "sync";
      return value.startsWith(prefix.trim())
        ? [{ value, label: value, description: "立即同步当前 Pi 会话" }]
        : null;
    },
    handler: async (args, ctx) => {
      const currentConnected = await refreshConnection(ctx);
      beginHealthPolling(ctx);

      if (args?.trim() === "sync") {
        if (!currentConnected) {
          await sync.observeSession(ctx.sessionManager);
          ctx.ui.notify("OpenViking：未连接，事件保留在 Pi 来源中等待重放", "warning");
          return;
        }
        const result = await sync.syncSession(ctx.sessionManager);
        renderStatus(ctx);
        ctx.ui.notify(
          result.allDelivered
            ? `OpenViking：已确认 ${result.added} 个 entry`
            : `OpenViking：同步未完成，仍有 ${result.pending} 个 entry 待重放`,
          result.allDelivered ? "info" : "warning",
        );
        return;
      }

      ctx.ui.notify(
        formatVikingCommand({
          connected: currentConnected,
          sessionId: sync.sessionId,
          sync: sync.status,
        }),
        currentConnected ? "info" : "warning",
      );
    },
  });
}

// ================================================================
// Helper Functions
// ================================================================

/**
 * Memory namespace for a pi session.
 *
 * OpenViking treats `user_id` as the memory boundary, so one namespace per pi
 * session is what stops one task's memories from surfacing in another. The pi
 * session id is stable across `pi -c` and `pi -p`, so a long task keeps
 * accumulating into the same namespace across processes.
 *
 * A fork or a new session id therefore starts from empty memory by design.
 */
function deriveMemoryNamespace(baseUser: string, piSessionId: string): string {
  const base = (baseUser || "default").replace(/[^A-Za-z0-9._-]/g, "-");
  const session = String(piSessionId || "").replace(/[^A-Za-z0-9._-]/g, "-");
  return session ? `${base}--pi-${session}` : base;
}

/** Simple bypass pattern matching (prefix and glob). */
function matchBypass(cwd: string, pattern: string): boolean {
  if (pattern.startsWith("*")) {
    return cwd.endsWith(pattern.slice(1));
  }
  if (pattern.endsWith("*")) {
    return cwd.startsWith(pattern.slice(0, -1));
  }
  return cwd === pattern || cwd.startsWith(pattern + "/");
}

function snapshotSessionSource(sessionManager: any): any {
  const persisted = typeof sessionManager?.isPersisted === "function" && sessionManager.isPersisted();
  const sessionFile = typeof sessionManager?.getSessionFile === "function"
    ? sessionManager.getSessionFile()
    : undefined;
  const leafId = typeof sessionManager?.getLeafId === "function" ? sessionManager.getLeafId() : null;
  const entries = !persisted && typeof sessionManager?.getEntries === "function"
    ? structuredClone(sessionManager.getEntries())
    : !persisted && typeof sessionManager?.getBranch === "function"
      ? structuredClone(sessionManager.getBranch())
      : [];
  return {
    isPersisted: () => persisted,
    getSessionFile: () => sessionFile,
    getLeafId: () => leafId,
    getEntries: () => entries,
    getBranch: () => entries,
  };
}

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path: string, init?: any, options?: any) => client.fetchJSON(path, init, options?.timeoutMs ?? 2000),
      config.profileTokenBudget,
      config.peerId,
    );
    if (!profile?.block) return "";
    return [
      '<openviking-context source="session-start">',
      profile.block,
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}
