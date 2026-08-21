import { createHash } from "node:crypto";

import { canonicalJson, canonicalJsonBytes } from "./canonical-json.mjs";
import { buildProducedRecordedEvent, recordedEventId } from "./recorded-event.mjs";

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECKPOINT_IDENTITY_VERSION = 1;
export const CHECKPOINT_PROMPT_VERSION = "checkpoint-v1";
export const CHECKPOINT_MODEL = "openviking/session-working-memory-v2";
export const CHECKPOINT_MAX_ATTEMPTS = 3;

const CHECKPOINT_DOMAIN = "pi-openviking/checkpoint";
const CHECKPOINT_TASK_DOMAIN = "pi-openviking/checkpoint-task";
const CHECKPOINT_ID_PATTERN = /^chk_[0-9a-f]{64}$/;
const ARCHIVE_ID_PATTERN = /^arc_[0-9a-f]{64}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CHECKPOINT_FAILURE_MESSAGES = Object.freeze({
  empty_output: "checkpoint VLM completed without a working-memory overview",
  task_cancelled: "checkpoint VLM task was cancelled",
  task_failed: "checkpoint VLM task failed",
});

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const stableId = (prefix, value) => `${prefix}_${sha256Hex(canonicalJsonBytes(value))}`;

function requireArchive(manifest) {
  if (!manifest || !ARCHIVE_ID_PATTERN.test(manifest.archiveId) || !HASH_PATTERN.test(manifest.contentHash)) {
    throw new TypeError("checkpoint requires a self-identifying Archive manifest");
  }
  return manifest;
}

function requireAttempt(attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > CHECKPOINT_MAX_ATTEMPTS) {
    throw new TypeError(`checkpoint attempt must be between 1 and ${CHECKPOINT_MAX_ATTEMPTS}`);
  }
  return attempt;
}

function requireTimestamp(value, name) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO timestamp`);
  }
  return value;
}

function hasExactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function checkpointId(manifest) {
  requireArchive(manifest);
  return stableId("chk", [
    CHECKPOINT_DOMAIN,
    CHECKPOINT_IDENTITY_VERSION,
    manifest.archiveId,
    manifest.contentHash,
    CHECKPOINT_MODEL,
    CHECKPOINT_PROMPT_VERSION,
  ]);
}

export function checkpointTaskId(manifest, previousCheckpointId, attempt) {
  requireArchive(manifest);
  requireAttempt(attempt);
  if (previousCheckpointId !== null && !CHECKPOINT_ID_PATTERN.test(previousCheckpointId)) {
    throw new TypeError("previousCheckpointId must be null or a checkpoint id");
  }
  return stableId("cptask", [
    CHECKPOINT_TASK_DOMAIN,
    CHECKPOINT_IDENTITY_VERSION,
    manifest.archiveId,
    manifest.contentHash,
    previousCheckpointId,
    attempt,
    CHECKPOINT_MODEL,
    CHECKPOINT_PROMPT_VERSION,
  ]);
}

export function checkpointEventId(manifest) {
  return checkpointEventIdFor(checkpointId(manifest));
}

/** 只凭 checkpoint 身份定位其事件：读取方不必先持有来源 Archive manifest。 */
export function checkpointEventIdFor(id) {
  if (!CHECKPOINT_ID_PATTERN.test(id)) throw new TypeError("checkpoint event lookup requires a checkpoint id");
  return recordedEventId({ system: "pi-openviking", sourceId: id, sourceType: "checkpoint" });
}

export function checkpointRequestEventId(manifest, previousCheckpointId, attempt) {
  return recordedEventId({
    system: "pi-openviking",
    sourceId: checkpointTaskId(manifest, previousCheckpointId, attempt),
    sourceType: "checkpoint-request",
  });
}

export function checkpointFailureEventId(manifest, previousCheckpointId, attempt) {
  return recordedEventId({
    system: "pi-openviking",
    sourceId: checkpointTaskId(manifest, previousCheckpointId, attempt),
    sourceType: "checkpoint-failure",
  });
}

export function buildCheckpointRequestEvent({
  manifest,
  previousCheckpointId = null,
  attempt,
  submittedAt,
}) {
  const taskId = checkpointTaskId(manifest, previousCheckpointId, attempt);
  const payload = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    type: "checkpoint-request",
    taskId,
    archiveId: manifest.archiveId,
    archiveHash: manifest.contentHash,
    previousCheckpointId,
    attempt,
    submittedAt: requireTimestamp(submittedAt, "submittedAt"),
    model: CHECKPOINT_MODEL,
    promptVersion: CHECKPOINT_PROMPT_VERSION,
  };
  return buildProducedRecordedEvent({
    system: "pi-openviking",
    sourceId: taskId,
    sourceType: "checkpoint-request",
    parentId: manifest.lastEventId,
    occurredAt: submittedAt,
    payload,
  });
}

export function buildCheckpointFailureEvent({ requestEvent, failedAt, error }) {
  const request = parseCheckpointRequestEvent(requestEvent);
  const requestedCode = typeof error?.errorCode === "string" ? error.errorCode : "";
  const errorCode = Object.hasOwn(CHECKPOINT_FAILURE_MESSAGES, requestedCode) ? requestedCode : "task_failed";
  const errorClass = "protocol";
  const message = CHECKPOINT_FAILURE_MESSAGES[errorCode];
  const payload = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    type: "checkpoint-failure",
    taskId: request.taskId,
    archiveId: request.archiveId,
    archiveHash: request.archiveHash,
    attempt: request.attempt,
    failedAt: requireTimestamp(failedAt, "failedAt"),
    error: { errorClass, errorCode, message },
  };
  return buildProducedRecordedEvent({
    system: "pi-openviking",
    sourceId: request.taskId,
    sourceType: "checkpoint-failure",
    parentId: requestEvent.eventId,
    occurredAt: failedAt,
    payload,
  });
}

function sectionMap(overview) {
  const sections = new Map();
  let current = "";
  for (const line of overview.split("\n")) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      sections.set(current, []);
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join("\n").trim()]));
}

function sectionItems(value) {
  if (!value) return [];
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const bullets = lines
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+[.)]\s+/, "").trim())
    .filter(Boolean);
  return bullets.length > 0 ? bullets : [value.trim()];
}

export function checkpointFromOverview(manifest, overview) {
  requireArchive(manifest);
  if (typeof overview !== "string" || !overview.trim()) throw new TypeError("checkpoint overview must be non-empty");
  const narrative = overview.trim();
  const sections = sectionMap(narrative);
  const goals = sectionItems(sections.get("Task & Goals"));
  const retrievalCues = [
    ...sectionItems(sections.get("Files & Context")),
    ...sectionItems(sections.get("Session Title")),
  ];
  return {
    checkpointId: checkpointId(manifest),
    sourceArchiveId: manifest.archiveId,
    sourceArchiveHash: manifest.contentHash,
    narrative,
    completed: sectionItems(sections.get("Key Facts & Decisions")),
    openItems: sectionItems(sections.get("Open Issues")),
    ...(goals[0] ? { nextEntry: goals[0] } : {}),
    retrievalCues: [...new Set(retrievalCues)],
    model: CHECKPOINT_MODEL,
    promptVersion: CHECKPOINT_PROMPT_VERSION,
  };
}

export function buildCheckpointEvent({ manifest, requestEvent, overview, completedAt }) {
  const request = parseCheckpointRequestEvent(requestEvent);
  if (request.archiveId !== manifest.archiveId || request.archiveHash !== manifest.contentHash) {
    throw new TypeError("checkpoint request does not belong to the source Archive");
  }
  const checkpoint = checkpointFromOverview(manifest, overview);
  return buildProducedRecordedEvent({
    system: "pi-openviking",
    sourceId: checkpoint.checkpointId,
    sourceType: "checkpoint",
    parentId: requestEvent.eventId,
    occurredAt: requireTimestamp(completedAt, "completedAt"),
    payload: {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      type: "checkpoint",
      checkpoint,
    },
  });
}

/**
 * 任务模型方向的 checkpoint 块。
 *
 * 只渲染身份头与 narrative：completed/openItems/nextEntry/retrievalCues 都是 narrative
 * 的派生投影，重复注入会让同一事实在上下文中占用两份。
 */
export function renderCheckpointBlock(checkpoint) {
  if (!CHECKPOINT_ID_PATTERN.test(checkpoint?.checkpointId) || typeof checkpoint?.narrative !== "string" ||
      !checkpoint.narrative || !ARCHIVE_ID_PATTERN.test(checkpoint?.sourceArchiveId)) {
    throw new TypeError("checkpoint block requires a parsed checkpoint");
  }
  return [
    `<openviking-checkpoint id="${checkpoint.checkpointId}" archive="${checkpoint.sourceArchiveId}">`,
    checkpoint.narrative,
    "</openviking-checkpoint>",
  ].join("\n");
}

export function parseCheckpointRequestEvent(event) {
  const payload = event?.payload;
  const fields = [
    "schemaVersion", "type", "taskId", "archiveId", "archiveHash", "previousCheckpointId",
    "attempt", "submittedAt", "model", "promptVersion",
  ];
  const previousValid = payload?.previousCheckpointId === null || CHECKPOINT_ID_PATTERN.test(payload?.previousCheckpointId);
  const taskMatches = payload && ARCHIVE_ID_PATTERN.test(payload.archiveId) && HASH_PATTERN.test(payload.archiveHash) &&
    previousValid && Number.isSafeInteger(payload.attempt) && payload.attempt >= 1 && payload.attempt <= CHECKPOINT_MAX_ATTEMPTS &&
    payload.taskId === checkpointTaskId(
      { archiveId: payload.archiveId, contentHash: payload.archiveHash },
      payload.previousCheckpointId,
      payload.attempt,
    );
  if (event?.source?.system !== "pi-openviking" || event.source.sourceType !== "checkpoint-request" ||
      !hasExactKeys(payload, fields) || payload.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || payload.type !== "checkpoint-request" ||
      event.source.sourceId !== payload.taskId || event.eventId !== recordedEventId(event.source) || !taskMatches ||
      !Number.isFinite(Date.parse(payload.submittedAt)) || event.occurredAt !== payload.submittedAt || payload.model !== CHECKPOINT_MODEL ||
      payload.promptVersion !== CHECKPOINT_PROMPT_VERSION) {
    throw new TypeError("checkpoint request event is not well formed");
  }
  return payload;
}

export function parseCheckpointFailureEvent(event) {
  const payload = event?.payload;
  const fields = ["schemaVersion", "type", "taskId", "archiveId", "archiveHash", "attempt", "failedAt", "error"];
  if (event?.source?.system !== "pi-openviking" || event.source.sourceType !== "checkpoint-failure" ||
      !hasExactKeys(payload, fields) || !hasExactKeys(payload?.error, ["errorClass", "errorCode", "message"]) ||
      payload.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || payload.type !== "checkpoint-failure" ||
      event.source.sourceId !== payload.taskId || event.eventId !== recordedEventId(event.source) ||
      !/^cptask_[0-9a-f]{64}$/.test(payload.taskId) || !ARCHIVE_ID_PATTERN.test(payload.archiveId) ||
      !HASH_PATTERN.test(payload.archiveHash) || !Number.isSafeInteger(payload.attempt) ||
      payload.attempt < 1 || payload.attempt > CHECKPOINT_MAX_ATTEMPTS || !Number.isFinite(Date.parse(payload.failedAt)) ||
      event.occurredAt !== payload.failedAt || payload.error.errorClass !== "protocol" ||
      !Object.hasOwn(CHECKPOINT_FAILURE_MESSAGES, payload.error.errorCode) ||
      payload.error.message !== CHECKPOINT_FAILURE_MESSAGES[payload.error.errorCode]) {
    throw new TypeError("checkpoint failure event is not well formed");
  }
  return payload;
}

export function parseCheckpointEvent(event, manifest) {
  const value = event?.payload?.checkpoint;
  const checkpointFields = [
    "checkpointId", "sourceArchiveId", "sourceArchiveHash", "narrative", "completed", "openItems",
    "retrievalCues", "model", "promptVersion", ...(value?.nextEntry === undefined ? [] : ["nextEntry"]),
  ];
  if (event?.source?.system !== "pi-openviking" || event.source.sourceType !== "checkpoint" ||
      !hasExactKeys(event.payload, ["schemaVersion", "type", "checkpoint"]) ||
      event.payload.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || event.payload.type !== "checkpoint" ||
      !hasExactKeys(value, checkpointFields) || event.source.sourceId !== value.checkpointId ||
      event.eventId !== recordedEventId(event.source) || !Number.isFinite(Date.parse(event.occurredAt)) ||
      value.checkpointId !== checkpointId(manifest) ||
      value.sourceArchiveId !== manifest.archiveId || value.sourceArchiveHash !== manifest.contentHash ||
      typeof value.narrative !== "string" || !value.narrative || !isStringArray(value.completed) ||
      !isStringArray(value.openItems) || !isStringArray(value.retrievalCues) ||
      (value.nextEntry !== undefined && typeof value.nextEntry !== "string") ||
      value.model !== CHECKPOINT_MODEL || value.promptVersion !== CHECKPOINT_PROMPT_VERSION) {
    throw new TypeError("checkpoint event is not valid for the source Archive");
  }
  return value;
}

/**
 * 只凭 `checkpointId` 校验一个 checkpoint 事件。
 *
 * `checkpointId` 由来源 Archive 的身份与内容 hash 派生，因此事件自带的
 * `sourceArchiveId`/`sourceArchiveHash` 能否复算出同一个 id，本身就是来源绑定的证明；
 * 读取方不必先持有 manifest。消费链（parent/attempt/无 failure）由 checkpoint 协调者
 * 在写入时校验，不在此重复。
 */
export function parseCheckpointEventById(event, expectedCheckpointId) {
  if (!CHECKPOINT_ID_PATTERN.test(expectedCheckpointId)) {
    throw new TypeError("checkpoint lookup requires a checkpoint id");
  }
  const value = event?.payload?.checkpoint;
  const checkpoint = parseCheckpointEvent(event, {
    archiveId: value?.sourceArchiveId,
    contentHash: value?.sourceArchiveHash,
  });
  if (checkpoint.checkpointId !== expectedCheckpointId) {
    throw new TypeError("checkpoint event does not match the requested checkpoint id");
  }
  return checkpoint;
}

export function embeddedImages(events) {
  const images = [];
  for (const event of events) {
    const value = event?.payload?.part?.value;
    if (event?.source?.partType !== "image" || value?.type !== "image" ||
        typeof value.data !== "string" || typeof value.mimeType !== "string") continue;
    const bytes = Buffer.from(value.data, "base64");
    images.push({
      eventId: event.eventId,
      mimeType: value.mimeType,
      bytes,
      contentHash: `sha256:${sha256Hex(bytes)}`,
    });
  }
  return images;
}

export function renderCheckpointInput(manifest, events, previousCheckpoint, media = []) {
  requireArchive(manifest);
  const mediaByEvent = new Map(media.map((item) => [item.eventId, item]));
  const projected = JSON.parse(JSON.stringify(events));
  for (const event of projected) {
    const item = mediaByEvent.get(event.eventId);
    if (!item || !event?.payload?.part) continue;
    event.payload.part.value = {
      type: "image",
      mimeType: item.mimeType,
      byteLength: item.byteLength,
      contentHash: item.contentHash,
      semanticAbstract: item.abstract,
    };
  }
  return canonicalJson({
    protocol: CHECKPOINT_PROMPT_VERSION,
    instruction: "Create a durable continuation checkpoint from this verified Archive. Preserve completed work, decisions, errors and corrections, open issues, the next execution entry, files and context, and retrieval cues. Prefer source facts over prior interpretation and do not invent facts.",
    sourceArchive: {
      archiveId: manifest.archiveId,
      sourceArchiveHash: manifest.contentHash,
      eventCount: manifest.eventCount,
    },
    previousCheckpoint: previousCheckpoint ?? null,
    events: projected,
  });
}
