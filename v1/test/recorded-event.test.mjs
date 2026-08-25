import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, canonicalJsonBytes } from "../shared/canonical-json.mjs";
import {
  contentHash,
  projectPiEntries,
  recordedEventId,
} from "../shared/recorded-event.mjs";
import { buildLongToolLoopTrace } from "./fixtures/long-tool-loop-trace.mjs";

function groupByEntry(events) {
  const grouped = new Map();
  for (const event of events) {
    const entryEvents = grouped.get(event.source.entryId) || [];
    entryEvents.push(event);
    grouped.set(event.source.entryId, entryEvents);
  }
  return grouped;
}

test("RFC 8785 规范字节稳定且拒绝非 JSON 输入", () => {
  assert.equal(canonicalJson({ b: 1, a: "x" }), '{"a":"x","b":1}');
  assert.equal(canonicalJson({ n: -0, values: [1e30, 0.000001] }), '{"n":0,"values":[1e+30,0.000001]}');
  assert.deepEqual(canonicalJsonBytes({ a: "中" }), Buffer.from('{"a":"中"}', "utf8"));
  assert.throws(() => canonicalJson({ value: undefined }), /JSON/);
  assert.throws(() => canonicalJson(Number.NaN), /finite/);
  assert.throws(() => canonicalJson("\ud800"), /surrogate/);
});

test("事件、内容、turn 和 step 身份符合固定协议向量", () => {
  assert.equal(recordedEventId({
    system: "pi",
    sessionId: "identity-session",
    entryId: "identity-entry",
    parentEntryId: null,
    entryType: "message",
    partType: "text",
    partIndex: 0,
  }), "evt_5f31edf4d0dc5de1e1a1d6e449f662a2fcf1661984955a946857fce0193876c9");
  assert.throws(
    () => recordedEventId({ system: "openviking", sourceId: "unused", sourceType: "unused" }),
    /not supported/,
  );
  assert.equal(
    contentHash({ z: 1, a: [true, null, "中"] }),
    "sha256:2bf0d6b68168b022b4eb53c8ba7ca064387e28e246c2f5547eb4956373573cf3",
  );

  const timestamp = "2026-08-18T00:00:00.000Z";
  const events = projectPiEntries("identity-session", [
    { id: "identity-user", parentId: null, timestamp, type: "message", message: { role: "user", content: "u" } },
    { id: "identity-assistant", parentId: "identity-user", timestamp, type: "message", message: { role: "assistant", content: "a" } },
  ]);
  assert.equal(events[0].turnId, "turn_38123de3eb738c11e06e5e5a4ed454352634cfef51792dc90480ad6ff641d424");
  assert.equal(events[1].turnId, events[0].turnId);
  assert.equal(events[1].stepId, "step_d6fe883507bcfd7d4caf98f0092bfa8def09470266b632ac47db57d803aed1fc");
});

test("长轨迹逐 part 完整投影并保留错误、aborted、image、thinking 和未知 part", () => {
  const trace = buildLongToolLoopTrace();
  assert.ok(trace.longText.length / 4 > 100_000);

  const events = projectPiEntries(trace.sessionId, trace.main);
  const byEntry = groupByEntry(events);

  assert.equal(byEntry.get("entry-user").length, 2);
  assert.deepEqual(byEntry.get("entry-user").map((event) => event.source.partType), ["text", "image"]);
  assert.equal(byEntry.get("entry-assistant-tools").length, 4);
  assert.deepEqual(byEntry.get("entry-assistant-tools").map((event) => event.source.partType), [
    "thinking",
    "toolCall",
    "toolCall",
    "futurePart",
  ]);
  assert.deepEqual(byEntry.get("entry-assistant-tools")[3].payload.part.value, {
    type: "futurePart",
    nested: { keep: [1, true, null] },
  });

  const success = byEntry.get("entry-tool-success");
  const failure = byEntry.get("entry-tool-error");
  assert.equal(success.length, 2);
  assert.ok(success[1].payload.part.value.data.length === trace.imageData.length);
  assert.equal(success[0].payload.entry.message.isError, false);
  assert.equal(failure[0].payload.entry.message.isError, true);
  assert.equal(failure[0].payload.entry.message.details.code, "EACCES");

  const aborted = byEntry.get("entry-assistant-aborted")[0];
  assert.equal(aborted.payload.entry.message.stopReason, "aborted");
  assert.equal(aborted.payload.entry.message.errorMessage, "cancelled by user");

  const opaque = byEntry.get("entry-model-change")[0];
  assert.equal(opaque.source.partType, "opaque");
  assert.deepEqual(opaque.payload.entry, trace.main[5]);

  const long = byEntry.get("entry-assistant-long")[0];
  assert.equal(long.payload.part.value.text, trace.longText);
  assert.doesNotMatch(long.payload.part.value.text, /\[truncated\]/);
});

test("事件身份、内容 hash、parent、turn 和 step 可确定重算", () => {
  const trace = buildLongToolLoopTrace();
  const first = projectPiEntries(trace.sessionId, trace.main);
  const replay = projectPiEntries(trace.sessionId, JSON.parse(JSON.stringify(trace.main)));
  assert.deepEqual(replay, first);

  const byEntry = groupByEntry(first);
  for (const entryEvents of byEntry.values()) {
    for (let index = 0; index < entryEvents.length; index++) {
      const event = entryEvents[index];
      assert.equal(event.source.partIndex, index);
      assert.equal(event.eventId, recordedEventId(event.source));
      assert.equal(event.contentHash, contentHash(event.payload));
      if (index > 0) assert.equal(event.parentId, entryEvents[index - 1].eventId);
    }
  }

  const user = byEntry.get("entry-user");
  const assistant = byEntry.get("entry-assistant-tools");
  const toolSuccess = byEntry.get("entry-tool-success");
  const toolError = byEntry.get("entry-tool-error");
  assert.equal(assistant[0].parentId, user.at(-1).eventId);
  assert.equal(toolSuccess[0].parentId, assistant.at(-1).eventId);
  assert.equal(toolError[0].parentId, toolSuccess.at(-1).eventId);
  assert.ok(user[0].turnId);
  assert.equal(assistant[0].turnId, user[0].turnId);
  assert.ok(assistant[0].stepId);
  assert.equal(toolSuccess[0].stepId, assistant[0].stepId);
  assert.equal(toolError[0].stepId, assistant[0].stepId);

  const mutated = structuredClone(trace.main);
  mutated[0].message.content[0].text = "different";
  const changed = projectPiEntries(trace.sessionId, mutated);
  assert.equal(changed[0].eventId, first[0].eventId);
  assert.notEqual(changed[0].contentHash, first[0].contentHash);
});

test("等长替换、较短分支和相同内容不同 entry 不依赖数组长度", () => {
  const trace = buildLongToolLoopTrace();
  const main = projectPiEntries(trace.sessionId, trace.main);
  const replacement = projectPiEntries(trace.sessionId, trace.equalReplacement);
  const shorter = projectPiEntries(trace.sessionId, trace.shorter);

  const commonEntryIds = new Set(trace.shorter.map((entry) => entry.id));
  const mainCommon = main.filter((event) => commonEntryIds.has(event.source.entryId));
  const replacementCommon = replacement.filter((event) => commonEntryIds.has(event.source.entryId));
  assert.deepEqual(replacementCommon, mainCommon);
  assert.ok(replacement.some((event) => event.source.entryId === "entry-replacement-final"));
  assert.ok(!replacement.some((event) => event.source.entryId === "entry-assistant-long"));
  assert.deepEqual(shorter, mainCommon);

  const duplicateContent = structuredClone(trace.shorter);
  duplicateContent[0].id = "entry-user-copy";
  duplicateContent[1].parentId = "entry-user-copy";
  const duplicateEvents = projectPiEntries(trace.sessionId, duplicateContent);
  assert.notEqual(duplicateEvents[0].eventId, main[0].eventId);
});

test("完整 entry tree 的 sibling branch 分别继承各自祖先 turn/step", () => {
  const timestamp = "2026-08-17T00:00:00.000Z";
  const entries = [
    { id: "user-root", parentId: null, timestamp, type: "message", message: { role: "user", content: "root" } },
    { id: "assistant-root", parentId: "user-root", timestamp, type: "message", message: { role: "assistant", content: "root answer" } },
    { id: "user-a", parentId: "assistant-root", timestamp, type: "message", message: { role: "user", content: "branch a" } },
    { id: "assistant-a", parentId: "user-a", timestamp, type: "message", message: { role: "assistant", content: "a" } },
    { id: "assistant-b", parentId: "assistant-root", timestamp, type: "message", message: { role: "assistant", content: "b" } },
  ];
  const byEntry = groupByEntry(projectPiEntries("tree-session", entries));
  assert.equal(byEntry.get("assistant-b")[0].turnId, byEntry.get("user-root")[0].turnId);
  assert.notEqual(byEntry.get("assistant-b")[0].turnId, byEntry.get("user-a")[0].turnId);
  assert.equal(byEntry.get("assistant-b")[0].parentId, byEntry.get("assistant-root").at(-1).eventId);
});

test("进程内可选 undefined 字段按 Pi JSONL 序列化语义投影", () => {
  const event = projectPiEntries("memory-session", [{
    id: "bash-entry",
    parentId: null,
    timestamp: "2026-08-17T00:00:00.000Z",
    type: "message",
    message: {
      role: "bashExecution",
      command: "true",
      output: "",
      exitCode: undefined,
      cancelled: false,
      truncated: false,
      timestamp: 0,
    },
  }])[0];
  assert.equal(event.source.partType, "opaque");
  assert.equal(Object.hasOwn(event.payload.entry.message, "exitCode"), false);
});
