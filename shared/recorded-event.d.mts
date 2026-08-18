import type { JsonValue } from "./canonical-json.mjs";

export interface PiRecordedEventSourceV1 {
  system: "pi";
  sessionId: string;
  entryId: string;
  parentEntryId: string | null;
  entryType: string;
  partType: string;
  partIndex: number;
}

export interface PiRecordedEventV1 {
  schemaVersion: 1;
  eventId: string;
  parentId: string | null;
  contentHash: string;
  occurredAt: string;
  source: PiRecordedEventSourceV1;
  turnId?: string;
  stepId?: string;
  payload: JsonValue;
}

export function recordedEventId(source: PiRecordedEventSourceV1): string;
export function contentHash(payload: JsonValue): string;
export function recordedEventBytes(event: PiRecordedEventV1): Buffer;
export function projectPiEntries(sessionId: string, entries: JsonValue[]): PiRecordedEventV1[];
