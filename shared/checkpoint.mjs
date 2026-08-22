import { createHash } from "node:crypto";

import { canonicalJson, canonicalJsonBytes } from "./canonical-json.mjs";
import { buildProducedRecordedEvent, reconstructPiEntry, recordedEventId } from "./recorded-event.mjs";

export const CHECKPOINT_SCHEMA_VERSION = 2;
export const CHECKPOINT_IDENTITY_VERSION = 2;
export const CHECKPOINT_PROMPT_VERSION = "checkpoint-v2";
export const CHECKPOINT_MODEL = "openviking/session-working-memory-v2";
export const CHECKPOINT_MAX_ATTEMPTS = 3;

const CHECKPOINT_DOMAIN = "pi-openviking/checkpoint";
const CHECKPOINT_TASK_DOMAIN = "pi-openviking/checkpoint-task";
const CHECKPOINT_ID_PATTERN = /^chk_[0-9a-f]{64}$/;
const ARCHIVE_ID_PATTERN = /^arc_[0-9a-f]{64}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CHECKPOINT_FAILURE_MESSAGES = Object.freeze({
  empty_output: "checkpoint VLM completed without a working-memory overview",
  invalid_output: "checkpoint VLM completed without a valid unified continuation",
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
      if (sections.has(current)) throw new TypeError(`checkpoint overview repeats ${current}`);
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

function withoutTemplateGuidance(value) {
  const lines = String(value || "").split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first >= 0 && /^_.*_$/.test(lines[first].trim()) && /(?:What is the purpose|Stable facts|Referenced resources|Mistakes, misunderstandings|Unresolved questions)/.test(lines[first])) {
    lines.splice(first, 1);
  }
  return lines.join("\n").trim();
}

const PLACEHOLDER_ITEM = /^(?:none|n\/a|not applicable|no (?:open|remaining|unresolved|current|known)?\s*(?:issues?|goals?|facts?|decisions?|state|work|errors?|corrections?)?)[.!]?$/i;
const CONTAINER_COUNT_ITEM = /^(?:(?:overview|summary|status|current state)\s*:\s*)?(?:\d+\s+(?:turns?|messages?|sessions?|archives?|entries?|events?|files?|tools?|resources?)(?:\s*(?:,|\/|\+|&|and)\s*|\s+)?)+[.!]?$/i;

function continuationItem(value) {
  const normalized = String(value || "")
    .replace(/^[-*]\s+|^\d+[.)]\s+/, "")
    .replace(/[*_`]/g, "")
    .trim();
  return Boolean(normalized) && !PLACEHOLDER_ITEM.test(normalized) && !CONTAINER_COUNT_ITEM.test(normalized);
}

function requireContinuationSection(sections, name) {
  const value = withoutTemplateGuidance(sections.get(name));
  if (!value) throw new TypeError(`checkpoint overview is missing ${name}`);
  if (!sectionItems(value).some(continuationItem)) {
    throw new TypeError(`checkpoint overview has no continuation content in ${name}`);
  }
  return value;
}

const REQUIRED_CHECKPOINT_SECTIONS = Object.freeze([
  "Task & Goals",
  "Current State",
  "Key Facts & Decisions",
  "Open Issues",
  "Files & Context",
  "Errors & Corrections",
]);

function nextActionFrom(sections) {
  const explicit = withoutTemplateGuidance(sections.get("Next Action"));
  if (sectionItems(explicit).some(continuationItem)) return explicit;
  const open = sectionItems(withoutTemplateGuidance(sections.get("Open Issues")))
    .find(continuationItem);
  if (!open) throw new TypeError("checkpoint overview has no executable Open Issues");
  return `- Address the highest-priority open issue: ${open}`;
}

export function validateCheckpointOverview(overview) {
  if (typeof overview !== "string" || !overview.trim()) {
    throw new TypeError("checkpoint overview must be non-empty");
  }
  const source = overview.trim().replace(/\r\n?/g, "\n");
  if (!/^# Working Memory(?:\n|$)/.test(source)) {
    throw new TypeError("checkpoint overview is missing Working Memory root");
  }
  const sections = sectionMap(source);
  for (const name of REQUIRED_CHECKPOINT_SECTIONS) {
    if (!withoutTemplateGuidance(sections.get(name))) throw new TypeError(`checkpoint overview is missing ${name}`);
  }
  const goals = requireContinuationSection(sections, "Task & Goals");
  const currentState = requireContinuationSection(sections, "Current State");
  const facts = requireContinuationSection(sections, "Key Facts & Decisions");
  const openIssues = requireContinuationSection(sections, "Open Issues");
  return [
    "# Working Memory",
    `## Task & Goals\n${goals}`,
    `## Current State\n${currentState}`,
    `## Key Facts & Decisions\n${facts}`,
    `## Open Issues\n${openIssues}`,
    `## Next Action\n${nextActionFrom(sections)}`,
    `## Files & Context\n${withoutTemplateGuidance(sections.get("Files & Context"))}`,
    `## Errors & Corrections\n${withoutTemplateGuidance(sections.get("Errors & Corrections"))}`,
  ].join("\n\n");
}

export function checkpointFromOverview(manifest, overview) {
  requireArchive(manifest);
  const narrative = validateCheckpointOverview(overview);
  return {
    checkpointId: checkpointId(manifest),
    sourceArchiveId: manifest.archiveId,
    sourceArchiveHash: manifest.contentHash,
    narrative,
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
 * checkpoint 的 continuation schema 只有身份、来源与 narrative；任务状态只表达一次。
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
    "checkpointId", "sourceArchiveId", "sourceArchiveHash", "narrative", "model", "promptVersion",
  ];
  if (event?.source?.system !== "pi-openviking" || event.source.sourceType !== "checkpoint" ||
      !hasExactKeys(event.payload, ["schemaVersion", "type", "checkpoint"]) ||
      event.payload.schemaVersion !== CHECKPOINT_SCHEMA_VERSION || event.payload.type !== "checkpoint" ||
      !hasExactKeys(value, checkpointFields) || event.source.sourceId !== value.checkpointId ||
      event.eventId !== recordedEventId(event.source) || !Number.isFinite(Date.parse(event.occurredAt)) ||
      value.checkpointId !== checkpointId(manifest) ||
      value.sourceArchiveId !== manifest.archiveId || value.sourceArchiveHash !== manifest.contentHash ||
      typeof value.narrative !== "string" || !value.narrative ||
      value.model !== CHECKPOINT_MODEL || value.promptVersion !== CHECKPOINT_PROMPT_VERSION) {
    throw new TypeError("checkpoint event is not valid for the source Archive");
  }
  validateCheckpointOverview(value.narrative);
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
  const semanticEvents = events.filter((event) => !(
    event?.source?.entryType === "custom" && event?.payload?.entry?.customType === "ov-observation"
  ));
  const projected = JSON.parse(JSON.stringify(semanticEvents));
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
  const entries = [];
  for (let start = 0; start < projected.length;) {
    const entryId = projected[start]?.source?.entryId;
    let end = start + 1;
    while (end < projected.length && projected[end]?.source?.entryId === entryId) end++;
    entries.push(reconstructPiEntry(projected.slice(start, end)));
    start = end;
  }
  return canonicalJson({
    protocol: CHECKPOINT_PROMPT_VERSION,
    operation: "update_unified_continuation",
    instruction: [
      "Update one self-contained working-memory state from priorUnifiedState plus newContext.",
      "Produce one updated OpenViking Working Memory from the full prior state and new context, not a summary of only the latest Archive.",
      "Keep only unfinished current goals and currently valid source-backed facts and decisions; remove completed goals, superseded facts, and duplicate formulations.",
      "Keep Current State, Open Issues, Files & Context, and Errors & Corrections sufficient to resume the task; phrase the highest-priority open issue as an executable action.",
      "Preserve exact opaque identifiers that remain relevant across updates.",
      "Describe the user's work, not Archive/session/message container counts. Prefer source facts over prior interpretation and do not invent facts.",
    ].join(" "),
    unifiedContinuation: {
      priorUnifiedState: previousCheckpoint ? {
        checkpointId: previousCheckpoint.checkpointId,
        narrative: previousCheckpoint.narrative,
      } : null,
      newContext: {
        sourceArchive: {
          archiveId: manifest.archiveId,
          sourceArchiveHash: manifest.contentHash,
          eventCount: manifest.eventCount,
        },
        entries,
      },
    },
  });
}
