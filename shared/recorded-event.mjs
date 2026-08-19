import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "./canonical-json.mjs";

export const RECORDED_EVENT_SCHEMA_VERSION = 1;
export const RECORDED_EVENT_IDENTITY_VERSION = 1;

const EVENT_DOMAIN = "pi-openviking/recorded-event";
const TURN_DOMAIN = "pi-openviking/turn";
const STEP_DOMAIN = "pi-openviking/step";

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function stableId(prefix, value) {
  return `${prefix}_${sha256Hex(canonicalJsonBytes(value))}`;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function jsonClone(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`Pi source value is not JSON-serializable: ${error?.message || String(error)}`);
  }
  if (serialized === undefined) throw new TypeError("Pi source value is not JSON-serializable");
  return JSON.parse(serialized);
}

function partType(value) {
  if (typeof value === "string") return "text";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.type === "string" && value.type.length > 0) return value.type;
    if (typeof value.kind === "string" && value.kind.length > 0) return value.kind;
  }
  return "unknown";
}

function splitContentEntry(entry, container, content, forcedPartType) {
  const envelope = jsonClone(entry);
  const path = container.split(".");
  let target = envelope;
  for (let index = 0; index < path.length - 1; index++) target = target[path[index]];
  delete target[path.at(-1)];

  const values = Array.isArray(content) ? content : [content];
  if (values.length === 0) return [];
  const form = Array.isArray(content) ? "array" : "string";
  return values.map((value, index) => ({
    partType: forcedPartType || partType(value),
    partIndex: index,
    payload: {
      entry: envelope,
      part: {
        container,
        form,
        count: values.length,
        value: jsonClone(value),
      },
    },
  }));
}

function projectableParts(entry) {
  if (entry?.type === "message" && entry.message && typeof entry.message === "object") {
    const message = entry.message;
    if (Object.prototype.hasOwnProperty.call(message, "content") &&
        (typeof message.content === "string" || Array.isArray(message.content))) {
      const forcedPartType = message.role === "toolResult" ? "toolResult" : "";
      const parts = splitContentEntry(entry, "message.content", message.content, forcedPartType);
      if (parts.length > 0) return parts;
    }
  }

  if (entry?.type === "custom_message" &&
      Object.prototype.hasOwnProperty.call(entry, "content") &&
      (typeof entry.content === "string" || Array.isArray(entry.content))) {
    const parts = splitContentEntry(entry, "content", entry.content, "");
    if (parts.length > 0) return parts;
  }

  return [{
    partType: "opaque",
    partIndex: 0,
    payload: { entry: jsonClone(entry) },
  }];
}

function entryRole(entry) {
  return entry?.type === "message" && typeof entry.message?.role === "string"
    ? entry.message.role
    : "";
}

function turnId(sessionId, entryId) {
  return stableId("turn", [TURN_DOMAIN, RECORDED_EVENT_IDENTITY_VERSION, sessionId, entryId]);
}

function stepId(sessionId, entryId) {
  return stableId("step", [STEP_DOMAIN, RECORDED_EVENT_IDENTITY_VERSION, sessionId, entryId]);
}

export function recordedEventId(source) {
  if (!source || source.system !== "pi") throw new TypeError("recordedEventId requires a pi source");
  const identity = [
    EVENT_DOMAIN,
    RECORDED_EVENT_IDENTITY_VERSION,
    "pi",
    requireString(source.sessionId, "source.sessionId"),
    requireString(source.entryId, "source.entryId"),
    requireString(source.partType, "source.partType"),
    source.partIndex,
  ];
  if (!Number.isSafeInteger(source.partIndex) || source.partIndex < 0) {
    throw new TypeError("source.partIndex must be a non-negative safe integer");
  }
  return stableId("evt", identity);
}

export function contentHash(payload) {
  return `sha256:${sha256Hex(canonicalJsonBytes(payload))}`;
}

export function recordedEventBytes(event) {
  return canonicalJsonBytes(event);
}

export function projectPiEntries(sessionId, entries) {
  requireString(sessionId, "sessionId");
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");

  const events = [];
  const lastEventByEntry = new Map();
  const seenEntries = new Set();
  const contextByEntry = new Map();

  for (const rawEntry of entries) {
    const entry = jsonClone(rawEntry);
    const entryId = requireString(entry?.id, "entry.id");
    const entryType = requireString(entry?.type, "entry.type");
    const occurredAt = requireString(entry?.timestamp, "entry.timestamp");
    const parentEntryId = entry.parentId == null ? null : requireString(entry.parentId, "entry.parentId");

    if (seenEntries.has(entryId)) throw new Error(`duplicate Pi entry id: ${entryId}`);
    if (parentEntryId !== null && !lastEventByEntry.has(parentEntryId)) {
      throw new Error(`Pi entry parent must precede child: ${entryId} -> ${parentEntryId}`);
    }
    seenEntries.add(entryId);

    const inherited = parentEntryId === null ? {} : contextByEntry.get(parentEntryId);
    let currentTurnId = inherited?.turnId;
    let currentStepId = inherited?.stepId;
    const role = entryRole(entry);
    if (role === "user") {
      currentTurnId = turnId(sessionId, entryId);
      currentStepId = undefined;
    } else if (role === "assistant") {
      currentStepId = stepId(sessionId, entryId);
    }

    const parts = projectableParts(entry);
    let parentId = parentEntryId === null ? null : lastEventByEntry.get(parentEntryId);
    for (const part of parts) {
      const source = {
        system: "pi",
        sessionId,
        entryId,
        parentEntryId,
        entryType,
        partType: part.partType,
        partIndex: part.partIndex,
      };
      const event = {
        schemaVersion: RECORDED_EVENT_SCHEMA_VERSION,
        eventId: recordedEventId(source),
        parentId,
        contentHash: contentHash(part.payload),
        occurredAt,
        source,
        ...(currentTurnId ? { turnId: currentTurnId } : {}),
        ...((role === "assistant" || role === "toolResult") && currentStepId
          ? { stepId: currentStepId }
          : {}),
        payload: part.payload,
      };
      events.push(event);
      parentId = event.eventId;
    }
    lastEventByEntry.set(entryId, parentId);
    contextByEntry.set(entryId, { turnId: currentTurnId, stepId: currentStepId });
  }

  return events;
}
