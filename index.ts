/**
 * Pi OpenViking extension entry point.
 *
 * Observes Pi session events, synchronizes immutable RecordedEvent projections
 * to OpenViking, and injects best-effort memory recall without changing Pi's
 * compaction or provider-context ownership.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfigFromModuleUrl, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { RecallManager } from "./recall.js";
import { SyncManager } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { observation } from "./shared/observe.mjs";
import { createStatusRefresh } from "./shared/status-refresh.mjs";
import { clearVikingFooter, formatVikingCommand, setVikingFooter } from "./shared/viking-status.mjs";
import { guardVikingUriToolCall } from "./lib/uri-guard-adapter.mjs";
import { registerTools, VIKING_TOOL_NAMES } from "./tools.js";
import { snapshotSessionSource } from "./shared/pi-session-source.mjs";

const HEALTH_REFRESH_INTERVAL_MS = 5000;
const OBSERVATION_ENTRY_TYPE = "ov-observation";
const OBSERVATION_ENTRY_SCHEMA_VERSION = 1;

export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled) return;

  // --- Initialize modules ---
  let statusContext: any = null;
  const client = new OVClient(config, observation);
  const sync = new SyncManager(client, {
    observation,
    notify: (message, level) => statusContext?.ui?.notify(message, level),
  });
  const recall = new RecallManager(client, config, () => sync.sessionId, observation);
  const recordObservation = (kind: string, content: string, targetEntryId: string | null): void => {
    const op = observation.begin("pi_entry_append", kind);
    try {
      pi.appendEntry(OBSERVATION_ENTRY_TYPE, { schemaVersion: OBSERVATION_ENTRY_SCHEMA_VERSION, kind, targetEntryId, content });
      observation.end("pi_entry_append", op, kind, "appended");
    } catch (error: unknown) {
      observation.end("pi_entry_append", op, kind, "error");
      observation.emit("index_failure", error, "observation_append", "ignore", "continue_pi");
    }
  };

  // Session state
  let bypassed = false;
  let profileBlock = "";
  let toolsRegistered = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let startupWarningShown = false;

  const beginHook = (hook: string, reason = "none"): number => observation.begin("pi_lifecycle", hook, reason);
  const endHook = (op: number, hook: string, reason = "none", outcome = "success"): void =>
    observation.end("pi_lifecycle", op, hook, reason, outcome);

  // ================================================================
  // Event Handlers
  // ================================================================

  const start = async (ctx: any): Promise<void> => {
    if (started) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      const piSessionId = ctx.sessionManager.getSessionId();
      observation.bindSession(piSessionId);
      // Bypass check
      const cwd = process.cwd();
      for (const pattern of config.bypassPatterns) {
        if (matchBypass(cwd, pattern)) {
          bypassed = true;
          observation.emit("sync_schedule", "session_start", client.connected, "skip_bypassed");
          started = true;
          return;
        }
      }

      observation.emit("memory_namespace", config.sessionScopedMemory, config.user);
      if (config.sessionScopedMemory) {
        client.bindUser(deriveMemoryNamespace(config.user, piSessionId));
      }
      await sync.ensureSession(piSessionId);
      await sync.observeSession(ctx.sessionManager);

      if (!toolsRegistered) {
        registerTools(pi, client, sync, observation);
        toolsRegistered = true;
      }

      await client.health();
      if (!client.connected) {
        if (config.logLevel === "info" && !startupWarningShown) {
          ctx.ui.notify("OpenViking: server not reachable", "warning");
        }
        startupWarningShown = true;
        observation.emit("profile_result", "");
        started = true;
        return;
      }
      startupWarningShown = false;
      profileBlock = await buildSessionProfileBlock(client, config);
      observation.emit("profile_result", profileBlock);
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

  const scheduleSync = (ctx: any, trigger: string): void => {
    if (bypassed) {
      observation.emit("sync_schedule", trigger, client.connected, "skip_bypassed");
      return;
    }
    if (!config.syncTurns) {
      observation.emit("sync_schedule", trigger, client.connected, "skip_disabled");
      return;
    }
    const source = snapshotSessionSource(ctx.sessionManager);
    const connected = client.connected;
    observation.emit("sync_schedule", trigger, connected);
    const operation = connected
      ? sync.syncSession(source)
      : sync.observeSession(source);
    void operation.then(() => {
      if (statusContext === ctx) renderStatus(ctx);
    }).catch((error: unknown) => {
      observation.emit("index_failure", error, "sync_schedule", "degrade", "continue_pi");
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
      observation.emit("index_failure", error, "health_refresh", "degrade", "continue_pi");
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
  pi.on("session_start", async (event, ctx) => {
    const reason = event?.reason ?? "none";
    observation.bindSession(ctx.sessionManager.getSessionId());
    const op = beginHook("session_start", reason);
    try {
      await refreshConnection(ctx);
      beginHealthPolling(ctx);
      endHook(op, "session_start", reason);
    } catch (error) {
      endHook(op, "session_start", reason, "error");
      throw error;
    }
  });

  // --- before_agent_start ---
  pi.on("before_agent_start", async (event, ctx) => {
    const op = beginHook("before_agent_start");
    try {
      // Keep continuations initialized and refresh health before each user-prompt run.
      await refreshConnection(ctx);
      beginHealthPolling(ctx);

      if (!client.connected || bypassed) {
        endHook(op, "before_agent_start", "none", "skipped");
        return;
      }

      // Queue recall for the context hook. Pi renders the user message before
      // that hook, so recall latency does not delay the message appearing.
      recall.queueSearch(event.prompt);

      // Compose system prompt additions
      const parts: string[] = [];
      if (profileBlock) {
        parts.push(profileBlock);
        recordObservation("profile-injection", profileBlock, ctx.sessionManager.getLeafId());
      }
      parts.push(`OpenViking tools: ${VIKING_TOOL_NAMES.join(", ")}.`);

      const additions = parts.join("\n\n");
      if (!additions) {
        endHook(op, "before_agent_start", "none", "skipped");
        return;
      }

      const result = { systemPrompt: event.systemPrompt + "\n\n" + additions };
      endHook(op, "before_agent_start");
      return result;
    } catch (error) {
      endHook(op, "before_agent_start", "none", "error");
      throw error;
    }
  });

  // --- context ---
  pi.on("context", async (event, ctx) => {
    const op = beginHook("context");
    try {
      if (!client.connected || bypassed) {
        endHook(op, "context", "none", "skipped");
        return;
      }

      // Keep recall synchronous with the provider request so the current prompt
      // still receives current-query memory, without blocking user-message UI.
      await recall.searchPending();

      const { messages, injectedBlock } = recall.injectRecall(event.messages);
      if (injectedBlock) {
        recordObservation("recall-injection", injectedBlock, ctx.sessionManager.getLeafId());
      }
      endHook(op, "context");
      return { messages };
    } catch (error) {
      endHook(op, "context", "none", "error");
      throw error;
    }
  });

  // --- tool_call ---
  pi.on("tool_call", async (event, _ctx) => {
    const op = beginHook("tool_call");
    try {
      const decision = guardVikingUriToolCall(event, observation);
      if (!decision) {
        endHook(op, "tool_call", "none", "skipped");
        return;
      }
      endHook(op, "tool_call");
      return decision;
    } catch (error) {
      endHook(op, "tool_call", "none", "error");
      throw error;
    }
  });

  // --- turn_end ---
  pi.on("turn_end", (_event, ctx) => {
    const op = beginHook("turn_end");
    try {
      if (bypassed || !config.syncTurns) {
        endHook(op, "turn_end", "none", "skipped");
        return;
      }
      scheduleSync(ctx, "turn_end");
      endHook(op, "turn_end");
    } catch (error) {
      endHook(op, "turn_end", "none", "error");
      throw error;
    }
  });

  // Pi remains the sole compaction trigger. After it appends the compaction entry,
  // record that new source fact without altering the compaction lifecycle.
  pi.on("session_compact", (event, ctx) => {
    const reason = event?.reason ?? "none";
    const op = beginHook("session_compact", reason);
    try {
      if (bypassed || !config.syncTurns) {
        endHook(op, "session_compact", reason, "skipped");
        return;
      }
      scheduleSync(ctx, "session_compact");
      endHook(op, "session_compact", reason);
    } catch (error) {
      endHook(op, "session_compact", reason, "error");
      throw error;
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    const op = beginHook("session_tree");
    try {
      if (!started || bypassed || !config.syncTurns) {
        endHook(op, "session_tree", "none", "skipped");
        return;
      }
      scheduleSync(ctx, "session_tree");
      endHook(op, "session_tree");
    } catch (error) {
      endHook(op, "session_tree", "none", "error");
      throw error;
    }
  });

  pi.on("session_info_changed", (_event, ctx) => {
    const op = beginHook("session_info_changed");
    try {
      if (!started || bypassed || !config.syncTurns) {
        endHook(op, "session_info_changed", "none", "skipped");
        return;
      }
      scheduleSync(ctx, "session_info_changed");
      endHook(op, "session_info_changed");
    } catch (error) {
      endHook(op, "session_info_changed", "none", "error");
      throw error;
    }
  });

  pi.on("model_select", (_event, ctx) => {
    const op = beginHook("model_select");
    try {
      if (!started || bypassed || !config.syncTurns) {
        endHook(op, "model_select", "none", "skipped");
        return;
      }
      scheduleSync(ctx, "model_select");
      endHook(op, "model_select");
    } catch (error) {
      endHook(op, "model_select", "none", "error");
      throw error;
    }
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    const op = beginHook("thinking_level_select");
    try {
      if (!started || bypassed || !config.syncTurns) {
        endHook(op, "thinking_level_select", "none", "skipped");
        return;
      }
      scheduleSync(ctx, "thinking_level_select");
      endHook(op, "thinking_level_select");
    } catch (error) {
      endHook(op, "thinking_level_select", "none", "error");
      throw error;
    }
  });

  // --- session_shutdown ---
  pi.on("session_shutdown", async (event, ctx) => {
    const reason = event?.reason ?? "none";
    const op = beginHook("session_shutdown", reason);
    let observationDeadline = 0;
    try {
      await stopHealthPolling(ctx);
      observationDeadline = observation.beginDrainDeadline(500);
      scheduleSync(ctx, "session_shutdown");
      const drained = await sync.waitForIdle(500);
      if (!drained) observation.abandon();
      await client.close(true);
      await sync.stopBackground();
      sync.observeFinalState();
      endHook(op, "session_shutdown", reason);
    } catch (error) {
      endHook(op, "session_shutdown", reason, "error");
      throw error;
    } finally {
      observation.bindSession(null);
      if (reason === "quit") {
        await observation.finishRemaining(observationDeadline);
      }
    }
  });

  // --- agent_end ---
  pi.on("agent_end", () => {
    const op = beginHook("agent_end");
    try {
      recall.invalidate();
      endHook(op, "agent_end");
    } catch (error) {
      endHook(op, "agent_end", "none", "error");
      throw error;
    }
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
        observation.emit("sync_schedule", "command", currentConnected);
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
          observation: observation.getStatus(),
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
      (path: string, init?: any, options?: any) => client.fetchJSON(path, init, options?.timeoutMs ?? 2000),
      client.memorySpace,
      config.profileTokenBudget,
      config.peerId,
    );
    if (!profile?.block) return "";
    return [
      '<openviking-context source="session-start">',
      profile.block,
      "</openviking-context>",
    ].join("\n");
  } catch (error) {
    observation.emit("index_failure", error, "profile_load", "degrade", "omit_profile");
    return "";
  }
}
