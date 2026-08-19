import type { Observation } from "./observe.mjs";
import type { PiRecordedEventV1 } from "./recorded-event.mjs";

export const BATCH_MAX_OPERATIONS: 128;
export const BATCH_MAX_FILE_BYTES: number;
export const BATCH_MAX_TOTAL_BYTES: number;
export const EVENT_CHUNK_BYTES: number;

export interface RecordedEventStorageLocation {
  sessionKey: string;
  sessionRoot: string;
  shardRoot: string;
  directUri: string;
  claimUri: string;
  chunkUri(index: number): string;
  commitUri: string;
}

export interface RecordedEventBatchWriteRequest {
  root_uri: string;
  operations: Array<{
    uri: string;
    content_base64: string;
    precondition: { kind: "create_if_absent" };
  }>;
  wait: false;
}

export interface RecordedEventTransport {
  statUri(uri: string): Promise<{ ok: boolean; exists: boolean; isDir: boolean; status?: number; error?: unknown }>;
  mkdirUri(uri: string): Promise<{ ok: boolean; status?: number; error?: unknown }>;
  batchWrite(request: RecordedEventBatchWriteRequest): Promise<{ ok: boolean; result?: unknown; status?: number; error?: unknown }>;
  downloadBytes(uri: string): Promise<{ ok: boolean; bytes: Buffer | null; status?: number; error?: unknown }>;
}

export class RecordedEventConflictError extends Error {
  uri: string;
}
export class RecordedEventSyncError extends Error {
  status?: number;
  error?: unknown;
}

export function recordedEventStorageLocation(userRoot: string, sessionId: string, eventId: string): RecordedEventStorageLocation;

export class RecordedEventAdapter {
  constructor(transport: RecordedEventTransport, options: { userRoot: string; observation?: Observation });
  writeEvents(sessionId: string, events: PiRecordedEventV1[]): Promise<{
    acceptedEventIds: string[];
    capabilityVerified: boolean;
  }>;
}
