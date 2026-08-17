import assert from "node:assert/strict";
import test from "node:test";

import { extractBranchCapturePayloads } from "../lib/capture-adapter.mjs";

const cfg = {
  takeoverEnabled: true,
  captureAssistantTurns: true,
  captureMaxLength: 24000,
  captureToolMaxChars: 1000000,
};

test("capture 为同一用户轮次标记 user query、assistant step 和 tool transport", () => {
  const branch = [
    { id: "user-entry", type: "message", message: { role: "user", content: "fix the bug" } },
    {
      id: "assistant-entry",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.ts" } }],
      },
    },
    {
      id: "tool-entry",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
      },
    },
    { id: "assistant-final", type: "message", message: { role: "assistant", content: "done" } },
  ];

  const result = extractBranchCapturePayloads(branch, 0, cfg);
  assert.deepEqual(result.payloads.map((payload) => payload.message_kind), [
    "user_query",
    "assistant_step",
    "tool_transport",
    "assistant_step",
  ]);
  assert.deepEqual(result.payloads.map((payload) => payload.turn_id), [
    "user-entry",
    "user-entry",
    "user-entry",
    "user-entry",
  ]);
});

test("从轮次中部恢复 watermark 时沿用最近用户 entry id", () => {
  const branch = [
    { id: "user-entry", type: "message", message: { role: "user", content: "continue" } },
    { id: "assistant-entry", type: "message", message: { role: "assistant", content: "working" } },
  ];

  const result = extractBranchCapturePayloads(branch, 1, cfg);
  assert.equal(result.payloads.length, 1);
  assert.equal(result.payloads[0].message_kind, "assistant_step");
  assert.equal(result.payloads[0].turn_id, "user-entry");
});

test("takeover 模式不会因 captureAssistantTurns=false 产生孤立 tool transport", () => {
  const branch = [
    { id: "user", type: "message", message: { role: "user", content: "read it" } },
    {
      id: "assistant",
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    },
    {
      id: "tool",
      type: "message",
      message: { role: "toolResult", toolCallId: "call", toolName: "read", content: "result" },
    },
  ];

  const result = extractBranchCapturePayloads(branch, 0, { ...cfg, captureAssistantTurns: false });
  assert.deepEqual(result.payloads.map((payload) => payload.message_kind), [
    "user_query",
    "assistant_step",
    "tool_transport",
  ]);
});
