export interface SyncAck {
  acknowledgedLeaves: string[];
}

export function normalizeSyncAck(value: unknown): SyncAck;
export function isAncestorEntry(ancestorId: string, descendantId: string, parentById: Map<string, string | null>): boolean;
export function isEntryAcknowledged(ack: SyncAck, entryId: string, parentById: Map<string, string | null>): boolean;
export function advanceSyncAck(ack: SyncAck, entryId: string, parentById: Map<string, string | null>): SyncAck;
export function readSyncAck(path: string): Promise<SyncAck>;
export function writeSyncAck(path: string, ack: SyncAck): Promise<SyncAck>;
