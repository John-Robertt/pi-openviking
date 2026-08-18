import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import test from "node:test";

import { parsePiSessionJsonl } from "../shared/pi-session-source.mjs";
import {
  advanceSyncAck,
  isEntryAcknowledged,
  readSyncAck,
  writeSyncAck,
} from "../shared/sync-ack.mjs";
import { buildPhase0LongTrace } from "./fixtures/phase0-long-trace.mjs";

function jsonl(sessionId, entries) {
  return [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-17T00:00:00.000Z", cwd: "/workspace" }),
    ...entries.map((entry) => JSON.stringify(entry)),
    "",
  ].join("\n");
}

test("持久 Pi JSONL 按 leaf 恢复当前分支和完整 parent tree", () => {
  const trace = buildPhase0LongTrace();
  const allEntries = [...trace.main, ...trace.equalReplacement.slice(4)];
  const source = parsePiSessionJsonl(jsonl(trace.sessionId, allEntries), {
    sessionId: trace.sessionId,
    leafId: trace.equalReplacement.at(-1).id,
  });

  assert.deepEqual(source.branch, trace.equalReplacement);
  assert.equal(source.entries.length, 12);
  assert.equal(source.parentById.get("entry-replacement-assistant"), "entry-tool-error");
  const empty = parsePiSessionJsonl(jsonl(trace.sessionId, allEntries), { leafId: null });
  assert.deepEqual(empty.branch, []);
  assert.equal(empty.parentById.size, allEntries.length);

  assert.throws(
    () => parsePiSessionJsonl(jsonl(trace.sessionId, allEntries), { sessionId: "wrong" }),
    /does not match/,
  );
  assert.throws(
    () => parsePiSessionJsonl(jsonl(trace.sessionId, [
      ...allEntries,
      { id: "orphan", parentId: "missing", timestamp: "2026-08-17T00:00:00.000Z", type: "label", targetId: "x" },
    ]), { leafId: trace.equalReplacement.at(-1).id }),
    /parent does not exist/,
  );
});

test("SyncAck 在共同祖先、等长替换和短分支上保持最小 leaves", () => {
  const trace = buildPhase0LongTrace();
  const allEntries = [...trace.main, ...trace.equalReplacement.slice(4)];
  const { parentById } = parsePiSessionJsonl(jsonl(trace.sessionId, allEntries));

  let ack = { acknowledgedLeaves: [] };
  ack = advanceSyncAck(ack, trace.main.at(-1).id, parentById);
  assert.deepEqual(ack.acknowledgedLeaves, ["entry-assistant-long"]);
  assert.equal(isEntryAcknowledged(ack, "entry-tool-error", parentById), true);
  assert.equal(isEntryAcknowledged(ack, "entry-replacement-assistant", parentById), false);

  ack = advanceSyncAck(ack, trace.equalReplacement.at(-1).id, parentById);
  assert.deepEqual(ack.acknowledgedLeaves, ["entry-assistant-long", "entry-replacement-final"]);
  assert.equal(isEntryAcknowledged(ack, trace.shorter.at(-1).id, parentById), true);

  const unchanged = advanceSyncAck(ack, "entry-tool-error", parentById);
  assert.deepEqual(unchanged, ack);
});

test("SyncAck 原子持久化只保存最小 leaves", async () => {
  const root = "test/.artifacts/sync-ack";
  const path = `${root}/ack.json`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  try {
    assert.deepEqual(await readSyncAck(path), { acknowledgedLeaves: [] });
    await writeSyncAck(path, { acknowledgedLeaves: ["b", "a", "b"] });
    assert.deepEqual(await readSyncAck(path), { acknowledgedLeaves: ["a", "b"] });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { acknowledgedLeaves: ["a", "b"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
