import type { JsonValue } from "./canonical-json.mjs";

export const RECORDED_EVENT_SCHEMA_VERSION: 1;
export const RECORDED_EVENT_IDENTITY_VERSION: 1;

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
  schemaVersion: typeof RECORDED_EVENT_SCHEMA_VERSION;
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
