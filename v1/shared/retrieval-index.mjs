import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "./canonical-json.mjs";
import {
  ContentConflictError,
  ensureDirectoryChain,
  withBusyRetry,
  writeContentObjects,
} from "./content-objects.mjs";
import { observation as processObservation } from "./observe.mjs";

export const RETRIEVAL_INDEX_VERSION = 1;
export const RETRIEVAL_INDEX_TEXT_CHARS = 32_000;

const STORAGE_DOMAIN = "pi-openviking/retrieval-index";
const ARCHIVE_ID = /^arc_[0-9a-f]{64}$/;
const EVENT_ID = /^evt_[0-9a-f]{64}$/;
const CHECKPOINT_ID = /^chk_[0-9a-f]{64}$/;

function requireId(value, pattern, name) {
  if (!pattern.test(String(value ?? ""))) throw new TypeError(`invalid ${name}: ${value}`);
  return value;
}

function requireUserRoot(userRoot) {
  const root = String(userRoot || "").replace(/\/+$/, "");
  if (!/^viking:\/\/user\/[^/]+$/.test(root)) throw new TypeError("Retrieval index requires a bound user root");
  return root;
}

export function retrievalSessionRoot(userRoot, sessionId) {
  const root = requireUserRoot(userRoot);
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
  const sessionKey = createHash("sha256")
    .update(canonicalJsonBytes([STORAGE_DOMAIN, RETRIEVAL_INDEX_VERSION, "session", sessionId]))
    .digest("hex");
  return `${root}/resources/.pi-openviking/retrieval/v${RETRIEVAL_INDEX_VERSION}/${sessionKey}`;
}

export function retrievalRecordLocation(userRoot, sessionId, sourceType, archiveId, sourceId) {
  const sessionRoot = retrievalSessionRoot(userRoot, sessionId);
  requireId(archiveId, ARCHIVE_ID, "archiveId");
  const kind = sourceType === "raw_event" ? "raw" : sourceType === "checkpoint" ? "checkpoint" : null;
  if (!kind) throw new TypeError(`invalid retrieval sourceType: ${sourceType}`);
  requireId(sourceId, kind === "raw" ? EVENT_ID : CHECKPOINT_ID, kind === "raw" ? "eventId" : "checkpointId");
  const recordRoot = `${sessionRoot}/${kind}/${archiveId}/${sourceId}`;
  return { recordRoot, contentUri: `${recordRoot}/content.md` };
}

/** Search may return the source file or a server-derived face inside its per-record directory. */
export function parseRetrievalResultUri(uri, sessionRoot) {
  const root = String(sessionRoot || "").replace(/\/+$/, "");
  const value = String(uri || "");
  if (!root || !value.startsWith(`${root}/`)) return null;
  const rest = value.slice(root.length + 1).split("/");
  if (rest.length < 3) return null;
  const [kind, archiveId, sourceId] = rest;
  if (!ARCHIVE_ID.test(archiveId)) return null;
  if (kind === "raw" && EVENT_ID.test(sourceId)) {
    return { sourceType: "raw_event", archiveId, eventId: sourceId };
  }
  if (kind === "checkpoint" && CHECKPOINT_ID.test(sourceId)) {
    return { sourceType: "checkpoint", archiveId, checkpointId: sourceId };
  }
  return null;
}

function appendText(value, output, budget, path = "") {
  if (budget.remaining <= 0 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const prefix = path ? `${path}: ` : "";
    const available = Math.max(0, budget.remaining - Array.from(prefix).length);
    if (available === 0) return;
    const text = Array.from(value).slice(0, available).join("");
    if (text.trim()) {
      output.push(`${prefix}${text}`);
      budget.remaining -= Array.from(`${prefix}${text}\n`).length;
    }
    return;
  }
  if (typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) appendText(item, output, budget, path);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    appendText(item, output, budget, path ? `${path}.${key}` : key);
  }
}

export function retrievalText(event) {
  if (event?.source?.system === "pi-openviking" && event.source.sourceType === "checkpoint") {
    return Array.from(String(event?.payload?.checkpoint?.narrative ?? "").trim()).slice(0, RETRIEVAL_INDEX_TEXT_CHARS).join("");
  }
  if (event?.source?.system !== "pi") return "";
  const source = event?.payload?.part?.value ?? event?.payload?.entry ?? event?.payload;
  const output = [];
  appendText(source, output, { remaining: RETRIEVAL_INDEX_TEXT_CHARS });
  return output.join("\n").trim();
}

function recordBytes(locator, text) {
  const identity = locator.sourceType === "raw_event"
    ? `archive_id: ${locator.archiveId}\nevent_id: ${locator.eventId}`
    : `source_archive_id: ${locator.archiveId}\ncheckpoint_id: ${locator.checkpointId}`;
  return Buffer.from(`# Pi session history\nsource_type: ${locator.sourceType}\n${identity}\n\n${text}\n`, "utf8");
}

export class RetrievalIndex {
  constructor(transport, { userRoot, observation = processObservation, busyRetrySignal } = {}) {
    this.transport = transport;
    this.userRoot = requireUserRoot(userRoot);
    this.observe = observation;
    this.busyRetrySignal = busyRetrySignal;
    this.createdDirectories = new Set();
    this.indexedRawEvents = new Set();
    this.indexedCheckpoints = new Set();
  }

  get resourceRoot() {
    return `${this.userRoot}/resources`;
  }

  async writeRecords(sessionId, sourceType, records) {
    if (records.length === 0) return 0;
    const objects = [];
    for (const record of records) {
      const sourceId = sourceType === "raw_event" ? record.eventId : record.checkpointId;
      const location = retrievalRecordLocation(this.userRoot, sessionId, sourceType, record.archiveId, sourceId);
      await ensureDirectoryChain(this.transport, this.resourceRoot, location.recordRoot, this.createdDirectories);
      objects.push({ uri: location.contentUri, bytes: recordBytes(record, record.text) });
    }
    const sessionRoot = retrievalSessionRoot(this.userRoot, sessionId);
    await withBusyRetry(() => writeContentObjects(this.transport, sessionRoot, objects, (batch) => {
      if (batch.updated.size !== 0) {
        throw new ContentConflictError("OpenViking replaced an immutable retrieval record", [...batch.updated][0]);
      }
    }), { signal: this.busyRetrySignal });
    this.observe.emit("retrieval_index", sourceType, records.length);
    return records.length;
  }

  async indexArchives(sessionId, archives, branchEvents) {
    const records = [];
    for (const descriptor of archives ?? []) {
      const archiveId = descriptor?.manifest?.archiveId;
      for (const event of (branchEvents ?? []).slice(descriptor.startIndex, descriptor.endIndex + 1)) {
        if (this.indexedRawEvents.has(event.eventId)) continue;
        const text = retrievalText(event);
        if (text) records.push({ sourceType: "raw_event", archiveId, eventId: event.eventId, text });
      }
    }
    try {
      await this.writeRecords(sessionId, "raw_event", records);
    } catch (error) {
      this.observe.emit("retrieval_index_failure", error, "raw_event");
      throw error;
    }
    for (const record of records) this.indexedRawEvents.add(record.eventId);
    return records.length;
  }

  async indexCheckpoint(sessionId, manifest, event) {
    const archiveId = manifest?.archiveId;
    const checkpointId = event?.source?.sourceId;
    if (event?.source?.system !== "pi-openviking" || event.source.sourceType !== "checkpoint") {
      throw new TypeError("retrieval checkpoint source is invalid");
    }
    // 纵深防御：调用方在 checkpoint 验证通过后才触发本回调，来源一致性仍在这里断言一次。
    if (event?.payload?.checkpoint?.sourceArchiveId !== archiveId) {
      throw new TypeError("checkpoint source archive does not match the manifest");
    }
    if (this.indexedCheckpoints.has(checkpointId)) return 0;
    const text = retrievalText(event);
    if (!text) return 0;
    try {
      await this.writeRecords(sessionId, "checkpoint", [
        { sourceType: "checkpoint", archiveId, checkpointId, text },
      ]);
    } catch (error) {
      this.observe.emit("retrieval_index_failure", error, "checkpoint");
      throw error;
    }
    this.indexedCheckpoints.add(checkpointId);
    return 1;
  }
}
