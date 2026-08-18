import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { parsePiSessionJsonl } from "../shared/pi-session-source.mjs";
import { projectPiEntries } from "../shared/recorded-event.mjs";

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

test("真实 Pi SessionManager 持久化的 JSONL 可完整恢复、分支并投影", async () => {
  const root = fileURLToPath(new URL(`./.artifacts/pi-session-runtime-${randomUUID()}/`, import.meta.url));
  await rm(root, { recursive: true, force: true });

  try {
    const manager = SessionManager.create("/workspace", root, { id: randomUUID() });
    const userId = manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "runtime user" },
        { type: "image", mimeType: "image/png", data: "AA==" },
      ],
      timestamp: Date.now(),
    });
    const assistantId = manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "runtime thinking" },
        { type: "toolCall", id: "runtime-call", name: "runtime_tool", arguments: { path: "a.txt" } },
      ],
      api: "runtime-test",
      provider: "runtime-test",
      model: "runtime-test",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "runtime-call",
      toolName: "runtime_tool",
      content: [{ type: "text", text: "main result" }],
      isError: false,
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "runtime-test",
      provider: "runtime-test",
      model: "runtime-test",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });

    manager.branch(assistantId);
    const errorId = manager.appendMessage({
      role: "toolResult",
      toolCallId: "runtime-call",
      toolName: "runtime_tool",
      content: [{ type: "text", text: "branch failure" }],
      isError: true,
      details: { code: "E_RUNTIME" },
      timestamp: Date.now(),
    });
    manager.appendModelChange("runtime-provider", "runtime-model");
    manager.appendCustomEntry("runtime-state", { nested: [1, true, null] });
    manager.appendCustomMessageEntry("runtime-context", "runtime injected context", false, { source: "test" });
    manager.appendCompaction("runtime summary", errorId, 123, { reason: "runtime-test" }, true, usage);

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    const source = parsePiSessionJsonl(await readFile(sessionFile, "utf8"), {
      sessionId: manager.getSessionId(),
      leafId: manager.getLeafId(),
    });
    const persistedEntries = JSON.parse(JSON.stringify(manager.getEntries()));
    const persistedBranch = JSON.parse(JSON.stringify(manager.getBranch()));

    assert.deepEqual(source.entries, persistedEntries);
    assert.deepEqual(source.branch, persistedBranch);
    assert.ok(source.entries.some((entry) => entry.id === userId));
    assert.equal(source.parentById.get(errorId), assistantId);

    const events = projectPiEntries(manager.getSessionId(), source.entries);
    const errorEvent = events.find((event) => event.source.entryId === errorId);
    assert.equal(errorEvent.payload.entry.message.isError, true);
    assert.equal(errorEvent.payload.entry.message.details.code, "E_RUNTIME");
    assert.ok(events.some((event) => event.source.entryType === "compaction" && event.source.partType === "opaque"));

    const reopened = SessionManager.open(sessionFile, root, "/workspace");
    assert.deepEqual(JSON.parse(JSON.stringify(reopened.getEntries())), persistedEntries);
    assert.deepEqual(JSON.parse(JSON.stringify(reopened.getBranch())), persistedBranch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
