export const TAKEOVER_ENTRY_TYPE: "ov-takeover";
export const OVERVIEW_MARKER: "[OpenViking Session Context]";

export interface TakeoverMessage {
  role: string;
  content?: unknown;
  timestamp?: number;
  [key: string]: any;
}

export interface TakeoverArchiveIdentity {
  archiveUri: string;
  archiveId: string;
  taskId: string;
}

export interface TakeoverPendingArchive extends TakeoverArchiveIdentity {
  purpose: "advance" | "compact" | "archiveOnly";
  acceptedTokens: number;
  targetCoveredUserTurns: number;
  boundaryFingerprint: string | null;
  syncedEntryCount: number;
}

export interface TakeoverPersistedState {
  schemaVersion: 2;
  coveredUserTurns: number;
  overview: string;
  fingerprint?: string | null;
  pendingTokens: number;
  lastSeenUserTurns?: number;
  syncedEntryCount?: number;
  pendingArchive: TakeoverPendingArchive | null;
  confirmedArchive: TakeoverArchiveIdentity | null;
  awaitingCommitDrain: boolean;
}

export interface TakeoverConfig {
  takeoverEnabled?: boolean;
  takeoverTokenThreshold?: number;
  takeoverRetainedTokenBudget?: number;
  takeoverKeepRecentTurns?: number;
  takeoverOverviewBudget?: number;
  takeoverOverviewPollMs?: number;
  takeoverOverviewPollMax?: number;
}

export interface TakeoverIo {
  flush?: () => Promise<boolean> | boolean;
  commit?: (opts?: {
    queueOnFailure?: boolean;
    keepRecentCount?: number;
    retentionMode?: "turn_budget";
    keepRecentTurnCount?: number;
    retainedMessageTokenBudget?: number;
    minRawTailSteps?: number;
  }) => Promise<unknown> | unknown;
  checkArchive?: (pending: TakeoverPendingArchive) => Promise<{
    status: "pending" | "ready" | "failed";
    archiveUri?: string;
    archiveId?: string;
    overview?: string;
  }>;
  hasActiveCommit?: () => Promise<boolean> | boolean;
  persistEntry?: (customType: string, data: TakeoverPersistedState) => void;
  getWatermark?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export function flattenContent(msg: TakeoverMessage): string;
export function fingerprintMessage(msg: TakeoverMessage): string;
export function isUserTurnStart(msg: TakeoverMessage): boolean;
export function countUserTurns(messages: TakeoverMessage[]): number;
export function findBoundaryIndex(messages: TakeoverMessage[], coveredUserTurns: number): number;
export function estimateTokens(text: string): number;
export function truncateToTokens(text: string, budget: number): string;
export function estimatePayloadTokens(payload: any): number;
export function buildOverviewMessage(overview: string, firstKeptTs?: number, budget?: number): TakeoverMessage;
export function countUndeliveredForSession(pendingEntries: any[], sid: string): number;

export class TakeoverCore {
  constructor(opts?: { config?: TakeoverConfig; io?: TakeoverIo });
  get enabled(): boolean;
  get state(): TakeoverPersistedState & {
    fingerprint: string | null;
    lastSeenUserTurns: number;
    syncedEntryCount: number;
    committing: boolean;
  };
  restore(entries: any[]): this["state"];
  transformContext(messages: TakeoverMessage[]): TakeoverMessage[];
  onTurnSynced(estTokens: number): Promise<boolean>;
  resumePending(): Promise<boolean>;
  commitAndAdvance(): Promise<boolean>;
  handleBeforeCompact(preparation?: { firstKeptEntryId?: string; tokensBefore?: number }): Promise<
    | {
        compaction: {
          summary: string;
          firstKeptEntryId: string;
          tokensBefore: number;
          details: { source: string; archiveUri?: string };
        };
      }
    | undefined
  >;
  onPiCompacted(): void;
  shutdown(): Promise<void>;
  resetBoundary(reason?: string): void;
  truncatedOverview(): string;
  persistedState(): TakeoverPersistedState;
  persist(): void;
  pollPendingArchive(): Promise<{ status: string; overview?: string; purpose?: string }>;
}
