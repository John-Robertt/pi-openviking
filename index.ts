/**
 * Pi OpenViking Extension
 *
 * Integrates pi with an OpenViking context database for persistent,
 * cross-session memory. Syncs conversation turns to OV, recalls
 * relevant memories on each prompt, and commits sessions for long-term
 * memory extraction.
 *
 * Design informed by: OpenClaw (synchronous recall), Claude Code plugin
 * (most mature, production-hardened), Hermes (anti-pattern: stale prefetch).
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
import { createTakeoverManager } from "./takeover.js";

const HEALTH_REFRESH_INTERVAL_MS = 5000;

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled) return;

  // Env overrides

  // --- Initialize modules ---
  const client = new OVClient(config);
  const sync = new SyncManager(client, config);
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
  const takeover = createTakeoverManager({ pi, client, sync, config, log: debugLog });

  // Session state
  let connected = false;
  let bypassed = false;
  let profileBlock = "";
  let archiveOverview = "";
  let toolsRegistered = false;
  let compacted = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let statusContext: any = null;
  let lastAdded = 0;
  let startupWarningShown = false;
  let takeoverCompactionInFlight = false;

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

      // Health check
      connected = await client.health();
      if (!connected) {
        if (config.logLevel === "info" && !startupWarningShown) {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        startupWarningShown = true;
        return;
      }
      startupWarningShown = false;
      // Ensure OV session
      const piSessionId = ctx.sessionManager.getSessionId();

      // Bind the memory namespace before any memory-touching request. Session
      // creation, profile injection and recall all run below this point, so
      // binding here is what keeps this session's long-term memory private.
      if (config.sessionScopedMemory) {
        client.bindUser(deriveMemoryNamespace(config.user, piSessionId));
      }

      const ok = await sync.ensureSession(piSessionId);
      if (!ok) {
        if (config.logLevel !== "silent") {
          ctx.ui.notify("OpenViking: failed to create session", "error");
        }
        return;
      }
      await sync.replayPending();

      // Profile injection
      profileBlock = await buildSessionProfileBlock(client, config);

      const branch = typeof ctx.sessionManager.getBranch === "function"
        ? ctx.sessionManager.getBranch()
        : [];
      if (config.takeoverEnabled) {
        takeover.restore(branch);
        sync.restoreWatermark(takeover.state.syncedEntryCount);
      } else if (sync.sessionId) {
        // Resume rehydration — fetch archive overview if session was previously committed.
        archiveOverview = await fetchArchiveOverview(client, sync.sessionId, config);
      }

      // Register tools (also needed for pi -c continuations).
      if (!toolsRegistered) {
        registerTools(pi, client, sync);
        toolsRegistered = true;
      }
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
    const threshold = config.takeoverEnabled
      ? config.takeoverTokenThreshold
      : config.commitTokenThreshold;
    setVikingFooter(ctx, {
      connected,
      added: lastAdded,
      sessionId: sync.sessionId,
      threshold,
      takeover: config.takeoverEnabled ? takeover.state : null,
    });
  };

  const healthRefresh = createStatusRefresh({
    refresh: async () => {
      if (bypassed) return false;
      if (started) {
        connected = await client.health();
      } else {
        await start(statusContext);
      }
      return connected;
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

    if (!connected || bypassed) return;

    // Queue recall for the context hook. Pi renders the user message before
    // that hook, so recall latency does not delay the message appearing.
    recall.queueSearch(event.prompt);

    // Compose system prompt additions
    const parts: string[] = [];
    if (profileBlock) parts.push(profileBlock);
    if (!config.takeoverEnabled && archiveOverview && (compacted || archiveOverview.trim())) {
      parts.push(archiveOverview);
    }
    parts.push("OpenViking tools: viking_search, viking_read, viking_browse, viking_remember, viking_forget, viking_add_resource, viking_archive_expand.");

    const additions = parts.join("\n\n");
    if (!additions) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + additions,
    };
  });

  // --- context ---
  pi.on("context", async (event, _ctx) => {
    if (!connected || bypassed) return;

    // Keep recall synchronous with the provider request so the current prompt
    // still receives current-query memory, without blocking user-message UI.
    await recall.searchPending();

    const afterTakeover = config.takeoverEnabled
      ? takeover.transformContext(event.messages as any)
      : event.messages;
    const messages = recall.injectRecall(afterTakeover);
    return { messages };
  });

  // --- tool_call ---
  pi.on("tool_call", async (event, _ctx) => {
    const decision = guardVikingUriToolCall(event);
    if (!decision) return;
    return decision;
  });

  // --- turn_end ---
  pi.on("turn_end", async (event, ctx) => {
    if (!connected || bypassed || !config.syncTurns) return;

    const branch = ctx.sessionManager.getBranch();
    const result = await sync.syncBranch(branch);
    debugLog(`turn_end: synced ${result.added} entries, ~${result.tokens} tokens`);
    await takeover.onTurnSynced(result.tokens);
    if (config.takeoverEnabled && takeover.state.compactionRequested && !takeoverCompactionInFlight) {
      takeoverCompactionInFlight = true;
      debugLog(`turn_end: current user turn exceeded ${config.takeoverRetainedTokenBudget} tokens; requesting pi compaction`);
      ctx.compact({
        onComplete: () => { takeoverCompactionInFlight = false; },
        onError: (error: Error) => {
          takeoverCompactionInFlight = false;
          debugLog(`takeover compaction failed: ${error.message}`);
        },
      });
    }
    lastAdded = result.added;
    renderStatus(ctx);
  });

  // --- session_before_compact ---
  pi.on("session_before_compact", async (event, _ctx) => {
    if (!connected || bypassed) return;

    if (config.takeoverEnabled) {
      const prep = (event as any)?.preparation ?? {};
      return await takeover.handleBeforeCompact({
        firstKeptEntryId: prep.firstKeptEntryId,
        tokensBefore: prep.tokensBefore ?? 0,
      });
    }

    const archiveId = await sync.commit();
    compacted = true;

    // Cache archive overview for rehydration after compaction
    if (archiveId && sync.sessionId) {
      archiveOverview = await fetchArchiveOverview(
        client, sync.sessionId, config,
      );
    }
    // Return nothing → pi proceeds with default compaction
  });

  pi.on("session_compact", async (_event, _ctx) => {
    compacted = true;
    takeoverCompactionInFlight = false;
    if (config.takeoverEnabled) takeover.onPiCompacted();
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async (_event, ctx) => {
    await stopHealthPolling(ctx);
    if (!connected || bypassed) return;

    await sync.shutdown();
    if (config.takeoverEnabled) {
      await takeover.shutdown();
    } else {
      await sync.commit();
    }
  });

  // --- agent_end ---
  pi.on("agent_end", async (_event, _ctx) => {
    recall.invalidate();
  });

  // ================================================================
  // Commands
  // ================================================================

  pi.registerCommand("viking", {
    description: "OpenViking status and manual operations. Use 'commit' to force a sync.",
    getArgumentCompletions: (prefix) => {
      const value = "commit";
      return value.startsWith(prefix.trim())
        ? [{ value, label: value, description: "Commit the current OpenViking session" }]
        : null;
    },
    handler: async (args, ctx) => {
      const currentConnected = await refreshConnection(ctx);
      beginHealthPolling(ctx);

      if (args?.trim() === "commit") {
        if (!currentConnected) {
          ctx.ui.notify("OpenViking: not connected", "warning");
          return;
        }

        await sync.shutdown();
        const commitResult = config.takeoverEnabled ? null : await sync.commit();
        const ok = config.takeoverEnabled
          ? await takeover.commitAndAdvance()
          : commitResult !== null;
        await refreshConnection(ctx);
        if (ok) {
          ctx.ui.notify(
            "OpenViking: committed successfully" +
              (commitResult?.trace_id ? ` (trace_id=${commitResult.trace_id})` : ""),
            "info",
          );
        } else if (config.takeoverEnabled && takeover.state.pendingArchive) {
          ctx.ui.notify(
            `OpenViking: ${takeover.state.pendingArchive.archiveId || takeover.state.pendingArchive.taskId} accepted; overview still processing`,
            "info",
          );
        } else {
          ctx.ui.notify("OpenViking: commit failed", "error");
        }
        return;
      }

      ctx.ui.notify(
        formatVikingCommand({
          connected: currentConnected,
          sessionId: sync.sessionId,
          takeover: config.takeoverEnabled ? takeover.state : null,
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

/** Build the <openviking-context> profile block. */
async function buildSessionProfileBlock(
  client: OVClient, config: OVConfig,
): Promise<string> {
  try {
    const profile = await buildProfileBlock(
      (path: string, init?: any, options?: any) => client.fetchJSON(path, init, 10000),
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

/** Fetch archive overview for rehydration using the session context API. */
async function fetchArchiveOverview(
  client: OVClient, sessionId: string, config: OVConfig,
): Promise<string> {
  try {
    const ctx = await client.getSessionContext(sessionId, config.resumeContextBudget);
    if (!ctx || !ctx.latest_archive_overview) return "";

    return [
      '<openviking-context source="session-archive">',
      "<session-archive>",
      ctx.latest_archive_overview,
      "</session-archive>",
      "</openviking-context>",
    ].join("\n");
  } catch {
    return "";
  }
}
