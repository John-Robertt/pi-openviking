import type { ArchiveDescriptor, ArchiveManifestV1 } from "./archive.mjs";
import type { Observation } from "./observe.mjs";
import type { PiRecordedEventV1, ProducedRecordedEventV1, RecordedEventV1 } from "./recorded-event.mjs";

export const RETRIEVAL_INDEX_VERSION: 1;
export const RETRIEVAL_INDEX_TEXT_CHARS: number;

export interface RetrievalLocator {
  sourceType: "raw_event" | "checkpoint";
  archiveId: string;
  eventId?: string;
  checkpointId?: string;
}

export function retrievalSessionRoot(userRoot: string, sessionId: string): string;
export function retrievalRecordLocation(
  userRoot: string,
  sessionId: string,
  sourceType: RetrievalLocator["sourceType"],
  archiveId: string,
  sourceId: string,
): { recordRoot: string; contentUri: string };
export function parseRetrievalResultUri(uri: string, sessionRoot: string): RetrievalLocator | null;
export function retrievalText(event: RecordedEventV1): string;

export class RetrievalIndex {
  constructor(transport: unknown, options: { userRoot: string; observation?: Observation; busyRetrySignal?: AbortSignal });
  indexArchives(sessionId: string, archives: ArchiveDescriptor[], branchEvents: PiRecordedEventV1[]): Promise<number>;
  indexCheckpoint(sessionId: string, manifest: ArchiveManifestV1, event: ProducedRecordedEventV1): Promise<number>;
}
