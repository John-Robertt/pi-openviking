import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { OVClient } from "./client.js";
import { canonicalJsonBytes } from "./shared/canonical-json.mjs";
import { parsePiSessionJsonl } from "./shared/pi-session-source.mjs";
import { RecordedEventAdapter } from "./shared/recorded-event-adapter.mjs";
import { projectPiEntries } from "./shared/recorded-event.mjs";
import { deriveHarnessSessionId } from "./shared/session-model.mjs";
import {
  advanceSyncAck,
  isEntryAcknowledged,
  readSyncAck,
  writeSyncAck,
  type SyncAck,
} from "./shared/sync-ack.mjs";

export interface SyncBranchResult {
  added: number;
  allDelivered: boolean;
  pending: number;
  failure: string | null;
}


export interface SyncStatus {
  source: "persistent-jsonl" | "in-memory" | "none";
  capability: "unknown" | "ready" | "mismatch";
  acknowledgedLeaves: string[];
  pendingEntries: number;
  lastFailure: string | null;
}

interface SyncManagerOptions {
  ackPathForSession?: (sessionId: string) => string | null;
  adapterFactory?: (client: OVClient, userRoot: string) => RecordedEventAdapter;
}

function debugLog(message: string): void {
  const file = process.env.OV_DEBUG_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never affect the Pi task.
  }
}

function defaultAckPath(
  sessionId: string,
  target: { endpoint: string; account: string; user: string },
): string {
  const key = createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/sync-ack", 1, target, sessionId]))
    .digest("hex");
  return join(homedir(), ".pi", "openviking", "sync-ack", `${key}.json`);
}


export class SyncManager {
  private client: OVClient;
  private options: SyncManagerOptions;
  private ovSessionId: string | null = null;
  private piSessionId: string | null = null;
  private adapter: RecordedEventAdapter | null = null;
  private ack: SyncAck = { acknowledgedLeaves: [] };
  private ackPath: string | null = null;
  private knownParents = new Map<string, string | null>();
  private operationTail: Promise<void> = Promise.resolve();
  private syncStatus: SyncStatus = {
    source: "none",
    capability: "unknown",
    acknowledgedLeaves: [],
    pendingEntries: 0,
    lastFailure: null,
  };

  constructor(client: OVClient, options: SyncManagerOptions = {}) {
    this.client = client;
    this.options = options;
  }

  get sessionId(): string | null { return this.ovSessionId; }
  get status(): SyncStatus { return { ...this.syncStatus, acknowledgedLeaves: [...this.syncStatus.acknowledgedLeaves] }; }

  async ensureSession(piSessionId: string): Promise<boolean> {
    if (this.piSessionId === piSessionId && this.adapter) return true;
    this.piSessionId = piSessionId;
    this.ovSessionId = deriveHarnessSessionId("pi-", piSessionId);

    let userRoot = this.client.userRoot;
    if (!userRoot) {
      const userSpace = await this.client.resolveScopeSpace("user");
      this.client.bindUser(userSpace);
      userRoot = this.client.userRoot;
    }
    this.adapter = this.options.adapterFactory
      ? this.options.adapterFactory(this.client, userRoot)
      : new RecordedEventAdapter(this.client, { userRoot });

    this.ackPath = this.options.ackPathForSession
      ? this.options.ackPathForSession(piSessionId)
      : defaultAckPath(piSessionId, this.client.recordedEventTarget);
    try {
      this.ack = this.ackPath ? await readSyncAck(this.ackPath) : { acknowledgedLeaves: [] };
    } catch (error: any) {
      this.ack = { acknowledgedLeaves: [] };
      this.syncStatus.lastFailure = error?.message || String(error);
    }
    this.publishStatus();
    return true;
  }


  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async waitForIdle(timeoutMs = 500): Promise<boolean> {
    const pending = this.operationTail;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async sessionSource(sessionManager: any): Promise<{
    entries: any[];
    parentById: Map<string, string | null>;
    source: SyncStatus["source"];
  }> {
    const persisted = typeof sessionManager?.isPersisted === "function" && sessionManager.isPersisted();
    const sessionFile = typeof sessionManager?.getSessionFile === "function" ? sessionManager.getSessionFile() : null;
    if (persisted && sessionFile) {
      const parsed = parsePiSessionJsonl(await readFile(sessionFile, "utf8"), {
        sessionId: this.piSessionId || undefined,
        leafId: typeof sessionManager.getLeafId === "function" ? sessionManager.getLeafId() : null,
      });
      return { entries: parsed.entries, parentById: parsed.parentById, source: "persistent-jsonl" };
    }

    const entries = typeof sessionManager?.getEntries === "function"
      ? sessionManager.getEntries()
      : typeof sessionManager?.getBranch === "function"
        ? sessionManager.getBranch()
        : [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.id === "string") this.knownParents.set(entry.id, entry.parentId ?? null);
    }
    return {
      entries: Array.isArray(entries) ? entries : [],
      parentById: this.knownParents,
      source: "in-memory",
    };
  }

  async observeSession(sessionManager: any, failure = "OpenViking unavailable"): Promise<SyncBranchResult> {
    return this.serialize(() => this.observeSessionNow(sessionManager, failure));
  }

  private async observeSessionNow(sessionManager: any, failure: string): Promise<SyncBranchResult> {
    if (!this.piSessionId || !this.adapter) return this.emptyResult("sync session is not initialized");
    try {
      const { entries, parentById, source } = await this.sessionSource(sessionManager);
      const pending = entries.filter((entry) => !isEntryAcknowledged(this.ack, entry.id, parentById)).length;
      this.syncStatus = {
        source,
        capability: this.syncStatus.capability,
        acknowledgedLeaves: [...this.ack.acknowledgedLeaves],
        pendingEntries: pending,
        lastFailure: pending > 0 ? failure : null,
      };
      return { added: 0, allDelivered: pending === 0, pending, failure: pending > 0 ? failure : null };
    } catch (error: any) {
      return this.failResult(error?.message || String(error));
    }
  }

  async syncSession(sessionManager: any): Promise<SyncBranchResult> {
    return this.serialize(() => this.syncSessionNow(sessionManager));
  }

  private async syncSessionNow(sessionManager: any): Promise<SyncBranchResult> {
    if (!this.piSessionId || !this.adapter) return this.emptyResult("sync session is not initialized");
    try {
      const { entries, parentById, source } = await this.sessionSource(sessionManager);
      return await this.syncSource(entries, parentById, source);
    } catch (error: any) {
      return this.failResult(error?.message || String(error));
    }
  }


  private async syncSource(
    entries: any[],
    parentById: Map<string, string | null>,
    source: SyncStatus["source"],
  ): Promise<SyncBranchResult> {
    if (!this.piSessionId || !this.adapter) return this.emptyResult("sync session is not initialized");

    let events: any[];
    try {
      events = projectPiEntries(this.piSessionId, entries);
    } catch (error: any) {
      return this.failResult(error?.message || String(error), source);
    }
    const eventsByEntry = new Map<string, any[]>();
    for (const event of events) {
      const entryEvents = eventsByEntry.get(event.source.entryId) || [];
      entryEvents.push(event);
      eventsByEntry.set(event.source.entryId, entryEvents);
    }
    const pendingEntries = entries.filter((entry) => !isEntryAcknowledged(this.ack, entry.id, parentById));
    this.syncStatus = {
      source,
      capability: this.syncStatus.capability,
      acknowledgedLeaves: [...this.ack.acknowledgedLeaves],
      pendingEntries: pendingEntries.length,
      lastFailure: null,
    };

    let added = 0;
    for (const entry of pendingEntries) {
      const entryEvents = eventsByEntry.get(entry.id) || [];
      try {
        const result = await this.adapter.writeEvents(this.piSessionId, entryEvents);
        if (result.acceptedEventIds.length !== entryEvents.length) {
          throw new Error(`OpenViking did not confirm every event for Pi entry ${entry.id}`);
        }
        if (!result.capabilityVerified) {
          throw new Error("OpenViking Content capability was not byte-verified");
        }
        this.syncStatus.capability = "ready";
        const nextAck = advanceSyncAck(this.ack, entry.id, parentById);
        if (this.ackPath) await writeSyncAck(this.ackPath, nextAck);
        this.ack = nextAck;
        added++;
        this.syncStatus.pendingEntries--;
        this.publishStatus();
      } catch (error: any) {
        const status = Number(error?.status || 0);
        if ([404, 405, 422].includes(status) || /invalid result|did not confirm|verification failed/.test(error?.message || "")) {
          this.syncStatus.capability = "mismatch";
        }
        const failure = `${error?.name || "Error"}: ${error?.message || String(error)}`;
        this.syncStatus.lastFailure = failure;
        this.publishStatus();
        debugLog(`recorded-event sync failed: ${failure}`);
        return { added, allDelivered: false, pending: this.syncStatus.pendingEntries, failure };
      }
    }

    this.publishStatus();
    return { added, allDelivered: true, pending: 0, failure: null };
  }

  private publishStatus(): void {
    this.syncStatus.acknowledgedLeaves = [...this.ack.acknowledgedLeaves];
  }

  private emptyResult(failure: string): SyncBranchResult {
    return { added: 0, allDelivered: false, pending: this.syncStatus.pendingEntries, failure };
  }

  private failResult(failure: string, source: SyncStatus["source"] = "none"): SyncBranchResult {
    this.syncStatus.source = source;
    this.syncStatus.lastFailure = failure;
    this.publishStatus();
    return this.emptyResult(failure);
  }


}
