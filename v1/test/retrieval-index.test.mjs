import assert from "node:assert/strict";
import test from "node:test";

import {
  RETRIEVAL_INDEX_TEXT_CHARS,
  RetrievalIndex,
  parseRetrievalResultUri,
  retrievalRecordLocation,
  retrievalSessionRoot,
  retrievalText,
} from "../shared/retrieval-index.mjs";
import { archiveEvents, MemoryContentTransport } from "./fixtures/archive-fixtures.mjs";

const USER_ROOT = "viking://user/test";
const SESSION = "retrieval-session";
const ARCHIVE = `arc_${"a".repeat(64)}`;
const CHECKPOINT = `chk_${"b".repeat(64)}`;

const observation = () => {
  const records = [];
  return { records, emit(stage, ...values) { records.push({ stage, values }); } };
};

test("检索位置由会话和来源身份确定，服务端派生 face 仍能还原 locator", () => {
  const root = retrievalSessionRoot(USER_ROOT, SESSION);
  assert.equal(root, retrievalSessionRoot(USER_ROOT, SESSION));
  assert.notEqual(root, retrievalSessionRoot(USER_ROOT, `${SESSION}-other`));

  const raw = retrievalRecordLocation(USER_ROOT, SESSION, "raw_event", ARCHIVE, `evt_${"c".repeat(64)}`);
  assert.deepEqual(parseRetrievalResultUri(`${raw.recordRoot}/.abstract.md`, root), {
    sourceType: "raw_event",
    archiveId: ARCHIVE,
    eventId: `evt_${"c".repeat(64)}`,
  });

  const checkpoint = retrievalRecordLocation(USER_ROOT, SESSION, "checkpoint", ARCHIVE, CHECKPOINT);
  assert.deepEqual(parseRetrievalResultUri(checkpoint.contentUri, root), {
    sourceType: "checkpoint",
    archiveId: ARCHIVE,
    checkpointId: CHECKPOINT,
  });
  assert.equal(parseRetrievalResultUri(raw.contentUri, retrievalSessionRoot(USER_ROOT, "foreign")), null);
});

test("索引正文只投影有界语义文本，不复制完整超大事件", () => {
  const [event] = archiveEvents(SESSION, [{ role: "user", chars: RETRIEVAL_INDEX_TEXT_CHARS * 2 }]);
  const text = retrievalText(event);
  assert.ok(text.length > 0);
  assert.ok(Array.from(text).length <= RETRIEVAL_INDEX_TEXT_CHARS);
});

test("checkpoint 索引正文按 code point 截断，不劈开代理对", () => {
  const event = {
    source: { system: "pi-openviking", sourceType: "checkpoint", sourceId: CHECKPOINT },
    payload: { checkpoint: { narrative: `${"a".repeat(RETRIEVAL_INDEX_TEXT_CHARS - 1)}\u{1F600}zz` } },
  };
  const text = retrievalText(event);
  assert.equal(Array.from(text).length, RETRIEVAL_INDEX_TEXT_CHARS);
  assert.ok(text.endsWith("\u{1F600}"), "边界上的增补平面字符必须完整保留");
});

test("raw event 与 checkpoint 共用一套不可变、可重建索引", async () => {
  const transport = new MemoryContentTransport(USER_ROOT);
  const observe = observation();
  const index = new RetrievalIndex(transport, { userRoot: USER_ROOT, observation: observe });
  const events = archiveEvents(SESSION, [
    { role: "user", chars: 100 },
    { role: "assistant", chars: 100 },
  ]);
  const descriptor = { manifest: { archiveId: ARCHIVE }, startIndex: 0, endIndex: 1 };
  transport.busyOnce = retrievalRecordLocation(
    USER_ROOT, SESSION, "raw_event", ARCHIVE, events[0].eventId,
  ).contentUri;

  assert.equal(await index.indexArchives(SESSION, [descriptor], events), 2);
  assert.equal(await index.indexArchives(SESSION, [descriptor], events), 0);
  for (const event of events) {
    const location = retrievalRecordLocation(USER_ROOT, SESSION, "raw_event", ARCHIVE, event.eventId);
    assert.match(transport.files.get(location.contentUri).toString("utf8"), new RegExp(event.eventId));
  }

  const checkpointEvent = {
    source: { system: "pi-openviking", sourceType: "checkpoint", sourceId: CHECKPOINT },
    payload: { checkpoint: { narrative: "A bounded working-memory fact", sourceArchiveId: ARCHIVE } },
  };
  assert.equal(await index.indexCheckpoint(SESSION, { archiveId: ARCHIVE }, checkpointEvent), 1);
  assert.equal(await index.indexCheckpoint(SESSION, { archiveId: ARCHIVE }, checkpointEvent), 0);
  const checkpointLocation = retrievalRecordLocation(USER_ROOT, SESSION, "checkpoint", ARCHIVE, CHECKPOINT);
  assert.match(transport.files.get(checkpointLocation.contentUri).toString("utf8"), /bounded working-memory fact/);

  // 没有新增记录时不发空点位；只有实际写入才产生 decision 记录。
  assert.deepEqual(observe.records.map((record) => record.values[0]), ["raw_event", "checkpoint"]);
});
