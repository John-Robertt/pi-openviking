import type { OVClient } from "./client.js";
import type { OVConfig } from "./config.js";
import { buildRecallBlock } from "./shared/recall-core.mjs";

export interface RecallCache {
  block: string | null;
  promptText: string;      // the query this cache is for
}

export class RecallManager {
  private client: OVClient;
  private config: OVConfig;
  private cache: RecallCache = { block: null, promptText: "" };
  private pendingPrompt = "";
  // Read lazily: the session manager that owns this id is constructed after the
  // recall manager, and the id only exists once a session has been opened.
  private sessionId: () => string | null;

  constructor(client: OVClient, config: OVConfig, sessionId: () => string | null = () => null) {
    this.client = client;
    this.config = config;
    this.sessionId = sessionId;
  }

  queueSearch(userQuery: string): void {
    this.pendingPrompt = userQuery;
  }

  async searchPending(): Promise<string | null> {
    if (!this.pendingPrompt) return this.cache.block;

    const userQuery = this.pendingPrompt;
    this.pendingPrompt = "";
    if (userQuery.trim().length < this.config.minQueryLength) {
      this.cache = { block: null, promptText: userQuery };
      return null;
    }

    const block = await buildRecallBlock(
      // 10s is this extension's own budget for a bare retrieval; when the
      // request also spends a server fuse the helper hands down a longer
      // deadline, and ignoring it would abort a request still inside its fuse.
      (path: string, init?: any, options?: any) =>
        this.client.fetchJSON(path, init, options?.timeoutMs ?? 10000),
      this.config as any,
      userQuery,
      {
        actorPeerId: this.config.peerId,
        // Passing the OV session id is what turns on server-side query
        // expansion and the cross-turn dedup ledger.
        sessionId: this.sessionId() ?? "",
      },
    );
    this.cache = { block, promptText: userQuery };
    return block;
  }

  // --- Injection ---

  injectRecall(messages: any[]): { messages: any[]; injectedBlock: string | null } {
    const block = this.cache.block;
    if (!block) return { messages, injectedBlock: null };

    let injected = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const content = typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
            : "";
        if (content.includes("<openviking-context")) break;

        if (typeof msg.content === "string") {
          msg.content = block + "\n" + msg.content;
          injected = true;
        } else if (Array.isArray(msg.content)) {
          const textBlocks = msg.content.filter((b: any) => b.type === "text");
          if (textBlocks.length > 0) {
            (textBlocks[0] as any).text = block + "\n" + (textBlocks[0] as any).text;
            injected = true;
          }
        }
        break;
      }
    }
    return { messages, injectedBlock: injected ? block : null };
  }

  invalidate(): void {
    this.cache = { block: null, promptText: "" };
    this.pendingPrompt = "";
  }
}
