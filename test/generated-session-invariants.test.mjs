import assert from "node:assert/strict";
import test from "node:test";

import { parsePiSessionJsonl } from "../shared/pi-session-source.mjs";
import { contentHash, projectPiEntries, recordedEventBytes, recordedEventId } from "../shared/recorded-event.mjs";
import { advanceSyncAck, isAncestorEntry, isEntryAcknowledged } from "../shared/sync-ack.mjs";
import {
  buildGeneratedPiSession,
  buildGeneratedToolLoop,
  GENERATED_SESSION_SEEDS,
} from "./support/generated-pi-sessions.mjs";

function jsonl(sessionId, entries) {
  return [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-18T00:00:00.000Z", cwd: "/workspace" }),
    ...entries.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function groupEvents(events) {
  const byEntry = new Map();
  for (const event of events) {
    const group = byEntry.get(event.source.entryId) || [];
    group.push(event);
    byEntry.set(event.source.entryId, group);
  }
  return byEntry;
}

function setContainer(entry, container, value) {
  const path = container.split(".");
  let target = entry;
  for (const segment of path.slice(0, -1)) target = target[segment];
  target[path.at(-1)] = value;
}

function reconstructEntry(entryEvents) {
  if (entryEvents.length === 1 && entryEvents[0].source.partType === "opaque") {
    return entryEvents[0].payload.entry;
  }

  const entry = jsonClone(entryEvents[0].payload.entry);
  const metadata = entryEvents[0].payload.part;
  assert.equal(metadata.count, entryEvents.length);
  assert.deepEqual(entryEvents.map((event) => event.source.partIndex), entryEvents.map((_, index) => index));
  for (const event of entryEvents) {
    assert.equal(event.payload.part.container, metadata.container);
    assert.equal(event.payload.part.form, metadata.form);
    assert.equal(event.payload.part.count, metadata.count);
  }
  const values = entryEvents.map((event) => event.payload.part.value);
  setContainer(entry, metadata.container, metadata.form === "array" ? values : values[0]);
  return entry;
}

function manualBranch(leafId, byId) {
  const branch = [];
  let current = byId.get(leafId);
  while (current) {
    branch.push(current);
    current = current.parentId === null ? null : byId.get(current.parentId);
  }
  return branch.reverse();
}

function expectedAcknowledged(entryId, selected, parentById) {
  return selected.some((leaf) => isAncestorEntry(entryId, leaf, parentById));
}

function ackAll(orderedIds, parentById) {
  let ack = { acknowledgedLeaves: [] };
  for (const id of orderedIds) ack = advanceSyncAck(ack, id, parentById);
  return ack;
}

test("生成的 Pi session 对完整投影、树恢复和上下文关系保持不变量", () => {
  let nonDirectCompactions = 0;
  for (const seed of GENERATED_SESSION_SEEDS) {
    const sample = buildGeneratedPiSession(seed);
    const source = parsePiSessionJsonl(jsonl(sample.sessionId, sample.entries), { sessionId: sample.sessionId });
    const byId = new Map(sample.entries.map((entry) => [entry.id, entry]));
    const leaves = sample.entries.filter((entry) => !sample.entries.some((candidate) => candidate.parentId === entry.id));

    assert.deepEqual(source.entries, sample.entries, `seed=${seed}`);
    for (const entry of sample.entries) {
      if (entry.type === "message" && entry.message.role === "toolResult") {
        const ancestors = manualBranch(entry.parentId, byId).reverse();
        const nearestTurnMessage = ancestors.find((ancestor) =>
          ancestor.type === "message" && (ancestor.message.role === "assistant" || ancestor.message.role === "user"),
        );
        assert.equal(nearestTurnMessage?.message.role, "assistant", `seed=${seed} entry=${entry.id}`);
        const call = nearestTurnMessage.message.content
          .find((part) => part.type === "toolCall" && part.id === entry.message.toolCallId);
        assert.ok(call, `seed=${seed} entry=${entry.id}`);
        assert.equal(entry.message.toolName, call.name, `seed=${seed} entry=${entry.id}`);
      }
      if (entry.type === "compaction") {
        const ancestorIds = manualBranch(entry.parentId, byId).map((ancestor) => ancestor.id);
        assert.ok(ancestorIds.includes(entry.firstKeptEntryId), `seed=${seed} entry=${entry.id}`);
        if (entry.firstKeptEntryId !== entry.parentId) nonDirectCompactions++;
      }
    }
    for (const leaf of leaves) {
      const selected = parsePiSessionJsonl(jsonl(sample.sessionId, sample.entries), { leafId: leaf.id });
      assert.deepEqual(selected.branch, manualBranch(leaf.id, byId), `seed=${seed} leaf=${leaf.id}`);
    }

    const events = projectPiEntries(sample.sessionId, sample.entries);
    const replay = projectPiEntries(sample.sessionId, jsonClone(sample.entries));
    const eventsByEntry = groupEvents(events);
    const lastEventByEntry = new Map();
    const contextByEntry = new Map();

    assert.deepEqual(replay, events, `seed=${seed}`);
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length, `seed=${seed}`);

    for (const entry of sample.entries) {
      const entryEvents = eventsByEntry.get(entry.id);
      assert.ok(entryEvents?.length > 0, `seed=${seed} entry=${entry.id}`);
      assert.deepEqual(reconstructEntry(entryEvents), jsonClone(entry), `seed=${seed} entry=${entry.id}`);

      const inherited = entry.parentId === null ? {} : contextByEntry.get(entry.parentId);
      const role = entry.type === "message" ? entry.message.role : "";
      const expectedTurn = role === "user" ? entryEvents[0].turnId : inherited?.turnId;
      const expectedStep = role === "user" ? undefined : role === "assistant" ? entryEvents[0].stepId : inherited?.stepId;

      for (let index = 0; index < entryEvents.length; index++) {
        const event = entryEvents[index];
        assert.equal(event.eventId, recordedEventId(event.source), `seed=${seed} entry=${entry.id}`);
        assert.equal(event.contentHash, contentHash(event.payload), `seed=${seed} entry=${entry.id}`);
        assert.deepEqual(JSON.parse(recordedEventBytes(event)), event, `seed=${seed} entry=${entry.id}`);
        assert.equal(event.source.entryType, entry.type);
        assert.equal(event.source.parentEntryId, entry.parentId);
        assert.equal(event.occurredAt, entry.timestamp);
        assert.equal(
          event.parentId,
          index === 0 ? (entry.parentId === null ? null : lastEventByEntry.get(entry.parentId)) : entryEvents[index - 1].eventId,
          `seed=${seed} entry=${entry.id}`,
        );
        assert.equal(event.turnId, expectedTurn, `seed=${seed} entry=${entry.id}`);
        assert.equal(event.stepId, (role === "assistant" || role === "toolResult") ? expectedStep : undefined, `seed=${seed} entry=${entry.id}`);
      }

      lastEventByEntry.set(entry.id, entryEvents.at(-1).eventId);
      contextByEntry.set(entry.id, { turnId: expectedTurn, stepId: expectedStep });
    }
  }
  assert.ok(nonDirectCompactions > 0);
});

test("多个生成的长工具循环保持 call/result step 原子性", () => {
  for (const seed of [1, 55, 4233]) {
    const sample = buildGeneratedToolLoop(seed);
    const events = projectPiEntries(sample.sessionId, sample.entries);
    const byEntry = groupEvents(events);
    const rootTurnId = byEntry.get(sample.entries[0].id)[0].turnId;
    let cursor = 1;
    let previousStepId;
    let errorResults = 0;

    for (let step = 0; step < sample.steps; step++) {
      const assistant = sample.entries[cursor++];
      const assistantEvents = byEntry.get(assistant.id);
      const stepId = assistantEvents[0].stepId;
      const callCount = assistant.message.content.filter((part) => part.type === "toolCall").length;
      assert.ok(stepId && stepId !== previousStepId, `seed=${seed} step=${step}`);
      assert.ok(assistantEvents.every((event) => event.turnId === rootTurnId && event.stepId === stepId));

      for (let index = 0; index < callCount; index++) {
        const result = sample.entries[cursor++];
        const resultEvents = byEntry.get(result.id);
        assert.equal(result.message.role, "toolResult");
        assert.ok(resultEvents.every((event) => event.turnId === rootTurnId && event.stepId === stepId));
        assert.deepEqual(reconstructEntry(resultEvents), result);
        if (result.message.isError) errorResults++;
      }
      previousStepId = stepId;
    }

    const finalEvents = byEntry.get(sample.entries.at(-1).id);
    assert.equal(cursor, sample.entries.length - 1);
    assert.equal(finalEvents[0].turnId, rootTurnId);
    assert.notEqual(finalEvents[0].stepId, previousStepId);
    assert.ok(errorResults > 0);
    assert.deepEqual(projectPiEntries(sample.sessionId, jsonClone(sample.entries)), events);
  }
});

test("生成树的 SyncAck 对确认顺序不敏感并始终保持最小叶集合", () => {
  for (const seed of GENERATED_SESSION_SEEDS) {
    const sample = buildGeneratedPiSession(seed);
    const { parentById } = parsePiSessionJsonl(jsonl(sample.sessionId, sample.entries));
    const selected = sample.entries
      .filter((_, index) => (index + seed) % 3 === 0 || index === sample.entries.length - 1)
      .map((entry) => entry.id);
    const forward = ackAll(selected, parentById);
    const reverse = ackAll([...selected].reverse(), parentById);

    assert.deepEqual(reverse, forward, `seed=${seed}`);
    for (const entry of sample.entries) {
      assert.equal(
        isEntryAcknowledged(forward, entry.id, parentById),
        expectedAcknowledged(entry.id, selected, parentById),
        `seed=${seed} entry=${entry.id}`,
      );
    }
    for (const left of forward.acknowledgedLeaves) {
      for (const right of forward.acknowledgedLeaves) {
        if (left !== right) assert.equal(isAncestorEntry(left, right, parentById), false, `seed=${seed}`);
      }
    }
  }
});
