/**
 * Pi OpenViking extension entry point.
 *
 * Observes Pi session events, synchronizes immutable RecordedEvent projections
 * to OpenViking, and injects best-effort memory recall without changing Pi's
 * compaction or provider-context ownership.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { loadConfigFromModuleUrl, type OVConfig } from "./config.js";
import { OVClient } from "./client.js";
import { RecallManager } from "./recall.js";
import { SyncManager, type TaskModelContext } from "./sync.js";
import { buildProfileBlock } from "./shared/profile-inject.mjs";
import { renderCompactionPointer } from "./shared/active-context.mjs";
import { observation as processObservation } from "./shared/observe.mjs";
import { createStatusRefresh } from "./shared/status-refresh.mjs";
import { clearVikingFooter, formatVikingCommand, setVikingFooter } from "./shared/viking-status.mjs";
import { guardVikingUriToolCall } from "./lib/uri-guard-adapter.mjs";
import { registerTools, VIKING_TOOL_NAMES } from "./tools.js";
import { snapshotSessionSource } from "./shared/pi-session-source.mjs";
import { evaluateTakeoverTrigger } from "./shared/active-context.mjs";
import { readTaskModelContext } from "./shared/task-model-context.mjs";

const HEALTH_REFRESH_INTERVAL_MS = 5000;
const OBSERVATION_ENTRY_TYPE = "ov-observation";
const OBSERVATION_ENTRY_SCHEMA_VERSION = 2;


export default async function (pi: ExtensionAPI) {
  // --- Load config ---
  const config = loadConfigFromModuleUrl(import.meta.url);
  if (!config.enabled) return;

  const observation = processObservation.createProducer();

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
      pi.appendEntry(OBSERVATION_ENTRY_TYPE, {
        schemaVersion: OBSERVATION_ENTRY_SCHEMA_VERSION,
        kind,
        targetEntryId,
        contentHash: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
        chars: content.length,
      });
      observation.end("pi_entry_append", op, kind, "appended");
    } catch (error: unknown) {
      observation.end("pi_entry_append", op, kind, "error");
      observation.emit("index_failure", error, "observation_append", "ignore", "continue_pi");
    }
  };

  /** 把一次性指引块前置到最后一条用户消息；没有用户消息时返回 false，保留到下一轮。 */
  const prependToLastUserMessage = (messages: any[], block: string): boolean => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        msg.content = `${block}\n${msg.content}`;
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((b: any) => b.type === "text");
        if (textBlocks.length > 0) (textBlocks[0] as any).text = `${block}\n${textBlocks[0].text}`;
        else msg.content.unshift({ type: "text", text: block });
      } else {
        msg.content = block;
      }
      return true;
    }
    return false;
  };

  // Session state
  let bypassed = false;
  let profileBlock = "";
  let toolsRegistered = false;
  let started = false;
  let startPromise: Promise<void> | null = null;
  let startupWarningShown = false;
  let appliedTakeoverCheckpointId: string | null = null;
  let extensionProvidedCompaction = false;
  let pendingCompactionEntryId: string | null = null;
  let sessionReady: Promise<unknown> = Promise.resolve();
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
      observation.emit("sync_schedule", "session_start", client.connected);
      sessionReady = sync.syncSession(snapshotSessionSource(ctx.sessionManager), taskModelContext(ctx))
        .then(() => sync.refreshCheckpointFacts())
        .catch((error: unknown) => {
          observation.emit("index_failure", error, "sync_schedule", "degrade", "continue_pi");
        });
      void sessionReady.then(() => {
        if (statusContext === ctx) renderStatus(ctx);
      });
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

  /**
   * Pi 报告的任务模型上下文事实。
   *
   * 容量、system prompt 与活动工具定义都只有 Pi 拥有，takeover eligibility 必须以这些
   * 报告值为准而不是自行估算。任一项不可用时返回空值，由下游降级为 inactive。
   */
  const taskModelContext = (ctx: any): TaskModelContext => readTaskModelContext(pi, ctx, (error) => {
    observation.emit("index_failure", error, "task_model_context", "degrade", "continue_pi");
  });

  const contextUsageTokens = (ctx: any): number | null => {
    try {
      const usage = typeof ctx?.getContextUsage === "function" ? ctx.getContextUsage() : null;
      const tokens = usage?.tokens;
      return typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null;
    } catch (error: unknown) {
      observation.emit("index_failure", error, "task_model_context", "degrade", "continue_pi");
      return null;
    }
  };

  const takeoverHighWaterTokens = (activeEpoch = false): number | null => {
    const status = sync.status.activeContext;
    if (status.eligibility !== "eligible") return null;
    const configured = Number(config.takeover.contextTokenThreshold) || 0;
    if (configured > 0) return configured;
    // The first replacement is gated by how much of the original Pi context can
    // grow before the candidate must fit. Once replaced, compare the replacement
    // payload with total usable capacity instead of subtracting that payload twice.
    const automatic = Number(activeEpoch ? status.usableTokens : status.headroomTokens);
    return Number.isFinite(automatic) && automatic > 0 ? automatic : null;
  };

  const takeoverDecision = (ctx: any) => {
    const status = sync.status.activeContext;
    return evaluateTakeoverTrigger({
      enabled: config.takeover.enabled,
      eligibility: status.eligibility,
      currentCheckpointId: status.checkpointId,
      nextCheckpointId: sync.status.checkpoint.lastCheckpointId,
      appliedCheckpointId: appliedTakeoverCheckpointId,
      piUsageTokens: contextUsageTokens(ctx),
      payloadTokens: status.payloadTokens,
      highWaterTokens: takeoverHighWaterTokens(),
      activeHighWaterTokens: takeoverHighWaterTokens(true),
    });
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
      ? sync.syncSession(source, taskModelContext(ctx))
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
    appliedTakeoverCheckpointId = null;
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
        if (!bypassed) {
          observation.emit(
            "active_context_takeover", "keep_full_context", sync.status.activeContext.eligibility,
            contextUsageTokens(ctx), takeoverHighWaterTokens(), Array.isArray(event.messages) ? event.messages.length : 0,
          );
        }
        endHook(op, "context", "none", "skipped");
        return;
      }

      // Keep recall synchronous with the provider request so the current prompt
      // still receives current-query memory, without blocking user-message UI.
      await recall.searchPending();
      await sessionReady;
      const taskModel = taskModelContext(ctx);
      const takeover = takeoverDecision(ctx);
      let messages = event.messages;
      let takeoverBranch = "keep_full_context";
      if (!takeover.render && sync.status.activeContext.eligibility === "eligible" &&
          takeover.usageTokens !== null && takeover.highWaterTokens !== null &&
          takeover.usageTokens < takeover.highWaterTokens) {
        takeoverBranch = "below_high_water";
      }
      if (takeover.render || (!taskModel.factsAvailable && sync.status.activeContext.checkpointId)) {
        const checkpointBefore = sync.status.activeContext.checkpointId;
        const replacement = await sync.takeoverMessages(
          snapshotSessionSource(ctx.sessionManager), taskModel, takeover.allowAdvance,
          takeover.epochActive ? takeover.highWaterTokens : null,
        );
        if (replacement) {
          messages = replacement;
          const checkpointAfter = sync.status.activeContext.checkpointId;
          takeoverBranch = takeover.epochActive && checkpointBefore === checkpointAfter
            ? "reuse_context"
            : "replace_context";
          appliedTakeoverCheckpointId = checkpointAfter;
        }
      }
      observation.emit(
        "active_context_takeover",
        takeoverBranch,
        sync.status.activeContext.eligibility,
        takeover.usageTokens,
        takeover.highWaterTokens,
        Array.isArray(messages) ? messages.length : 0,
      );

      const { messages: injectedMessages, injectedBlock } = recall.injectRecall(messages);
      if (injectedBlock) {
        recordObservation("recall-injection", injectedBlock, ctx.sessionManager.getLeafId());
      }
      // 原生压缩后的第一轮只在该 compaction entry 仍位于当前分支时处理恢复指针；
      // takeover 激活时 checkpoint 块已携带同类指引，仍消费同一个一次性信号。
      if (pendingCompactionEntryId) {
        const branch = typeof ctx.sessionManager?.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
        if (!branch.some((entry: any) => entry?.id === pendingCompactionEntryId)) {
          pendingCompactionEntryId = null;
        } else if (takeoverBranch === "reuse_context" || takeoverBranch === "replace_context") {
          pendingCompactionEntryId = null;
        } else {
          const pointer = renderCompactionPointer(sync.listArchives());
          if (prependToLastUserMessage(injectedMessages, pointer)) {
            pendingCompactionEntryId = null;
            recordObservation("compaction-pointer", pointer, ctx.sessionManager.getLeafId());
          }
        }
      }
      endHook(op, "context");
      return { messages: injectedMessages };
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

  // Pi remains the sole compaction trigger. When an eligible ActiveContext is readable,
  // provide it as Pi's compaction checkpoint; otherwise Pi keeps its native split-turn path.
  pi.on("session_before_compact", async (event, ctx) => {
    const reason = event?.reason ?? "none";
    const op = beginHook("session_before_compact", reason);
    try {
      if (!client.connected || bypassed || !config.takeover.enabled) {
        observation.emit("active_context_compaction", "native_compaction", sync.status.activeContext.eligibility);
        endHook(op, "session_before_compact", reason, "skipped");
        extensionProvidedCompaction = false;
        return;
      }
      await sessionReady;
      const compaction = await sync.activeContextCompaction(
        snapshotSessionSource(ctx.sessionManager),
        Number(event?.preparation?.tokensBefore) || 0,
      );
      observation.emit(
        "active_context_compaction",
        compaction ? "provide_context" : "native_compaction",
        sync.status.activeContext.eligibility,
      );
      endHook(op, "session_before_compact", reason, compaction ? "success" : "skipped");
      // 只有扩展提供了自包含压缩时，压缩摘要才携带 checkpoint 指引；原生压缩需要下一轮补指针。
      extensionProvidedCompaction = Boolean(compaction);
      return compaction ? { compaction } : undefined;
    } catch (error) {
      observation.emit("active_context_compaction", "native_compaction", sync.status.activeContext.eligibility);
      endHook(op, "session_before_compact", reason, "error");
      extensionProvidedCompaction = false;
      return;
    }
  });

  // After Pi appends the compaction entry, record that new source fact without altering the lifecycle.
  pi.on("session_compact", (event, ctx) => {
    const reason = event?.reason ?? "none";
    const op = beginHook("session_compact", reason);
    try {
      if (bypassed || !config.syncTurns) {
        endHook(op, "session_compact", reason, "skipped");
        return;
      }
      // 原生压缩的摘要不含归档指针：以新 compaction entry 绑定下一轮恢复指引；
      // 扩展自包含压缩的摘要已是 checkpoint 块，不产生 pending。
      pendingCompactionEntryId = extensionProvidedCompaction ? null : ctx.sessionManager.getLeafId();
      extensionProvidedCompaction = false;
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
      const backgroundStopped = sync.stopBackground();
      observationDeadline = observation.beginDrainDeadline(500);
      const shutdownDeadline = Date.now() + 500;
      if (sync.sourceIsCurrent(ctx.sessionManager)) {
        observation.emit("sync_schedule", "session_shutdown", client.connected, "skip_current");
      } else {
        scheduleSync(ctx, "session_shutdown");
      }
      let backgroundTimer: ReturnType<typeof setTimeout> | undefined;
      const backgroundDrained = await Promise.race([
        backgroundStopped.then(() => true),
        new Promise<boolean>((resolve) => {
          backgroundTimer = setTimeout(() => resolve(false), Math.max(0, shutdownDeadline - Date.now()));
        }),
      ]);
      if (backgroundTimer) clearTimeout(backgroundTimer);
      const syncDrained = await sync.waitForIdle(Math.max(0, shutdownDeadline - Date.now()));
      if (!syncDrained || !backgroundDrained) observation.abandon();
      await client.close(true);
      await backgroundStopped;
      sync.observeFinalState();
      endHook(op, "session_shutdown", reason);
    } catch (error) {
      endHook(op, "session_shutdown", reason, "error");
      throw error;
    } finally {
      observation.bindSession(null);
      if (reason === "quit") {
        await observation.finishRemaining(observationDeadline);
      } else {
        observation.release();
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
        const result = await sync.syncSession(ctx.sessionManager, taskModelContext(ctx));
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
