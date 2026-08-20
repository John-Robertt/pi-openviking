import type { Observation } from "./observe.mjs";
import type { ContentTransport } from "./content-objects.mjs";
import type { PiRecordedEventV1 } from "./recorded-event.mjs";

export const RECORDED_EVENT_STORAGE_VERSION: 1;
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

export function recordedEventStorageLocation(userRoot: string, sessionId: string, eventId: string): RecordedEventStorageLocation;
export function verifyRecordedEventBytes(bytes: Buffer, expectedEventId: string): PiRecordedEventV1;

export class RecordedEventAdapter {
  constructor(transport: ContentTransport, options: { userRoot: string; observation?: Observation });
  writeEvents(sessionId: string, events: PiRecordedEventV1[]): Promise<{
    acceptedEventIds: string[];
    capabilityVerified: boolean;
  }>;
  readEvent(sessionId: string, eventId: string): Promise<{ event: PiRecordedEventV1; bytes: Buffer }>;
}
