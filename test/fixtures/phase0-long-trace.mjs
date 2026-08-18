const usage = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id, parentId, timestamp, value) {
  return { id, parentId, timestamp, ...value };
}

export function buildPhase0LongTrace() {
  const sessionId = "phase0-session";
  const base = Date.parse("2026-08-17T00:00:00.000Z");
  const at = (offset) => new Date(base + offset).toISOString();
  const messageAt = (offset) => base + offset;
  const imageData = Buffer.alloc(12 * 1024, 7).toString("base64");
  const longText = "0123456789abcdef ".repeat(26_000);

  const user = entry("entry-user", null, at(1), {
    type: "message",
    message: {
      role: "user",
      content: [
        { type: "text", text: "inspect the complete trace" },
        { type: "image", data: imageData, mimeType: "image/png" },
      ],
      timestamp: messageAt(1),
    },
  });

  const assistantTools = entry("entry-assistant-tools", user.id, at(2), {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect both files", thinkingSignature: "opaque-signature" },
        { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.ts" } },
        { type: "toolCall", id: "call-b", name: "read", arguments: { path: "b.ts" } },
        { type: "futurePart", nested: { keep: [1, true, null] } },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "toolUse",
      timestamp: messageAt(2),
    },
  });

  const toolSuccess = entry("entry-tool-success", assistantTools.id, at(3), {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "read",
      content: [
        { type: "text", text: "file a contents" },
        { type: "image", data: imageData, mimeType: "image/png" },
      ],
      details: { durationMs: 12, transport: "local" },
      isError: false,
      timestamp: messageAt(3),
    },
  });

  const toolError = entry("entry-tool-error", toolSuccess.id, at(4), {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "read",
      content: [{ type: "text", text: "permission denied" }],
      details: { code: "EACCES" },
      isError: true,
      timestamp: messageAt(4),
    },
  });

  const assistantAborted = entry("entry-assistant-aborted", toolError.id, at(5), {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "partial response" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "aborted",
      errorMessage: "cancelled by user",
      timestamp: messageAt(5),
    },
  });

  const modelChange = entry("entry-model-change", assistantAborted.id, at(6), {
    type: "model_change",
    provider: "anthropic",
    modelId: "claude-test",
  });

  const injectedContext = entry("entry-context", modelChange.id, at(7), {
    type: "custom_message",
    customType: "openviking-recall",
    content: [
      { type: "text", text: "recalled context" },
      { type: "image", data: imageData, mimeType: "image/png" },
    ],
    details: { sourceUris: ["viking://user/memories/example"] },
    display: false,
  });

  const assistantLong = entry("entry-assistant-long", injectedContext.id, at(8), {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: longText }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: { ...usage, output: 110_500, totalTokens: 110_510 },
      stopReason: "stop",
      timestamp: messageAt(8),
    },
  });

  const main = [
    user,
    assistantTools,
    toolSuccess,
    toolError,
    assistantAborted,
    modelChange,
    injectedContext,
    assistantLong,
  ];

  const replacementAssistant = entry("entry-replacement-assistant", toolError.id, at(9), {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-c", name: "bash", arguments: { command: "pwd" } }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "toolUse",
      timestamp: messageAt(9),
    },
  });
  const replacementTool = entry("entry-replacement-tool", replacementAssistant.id, at(10), {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call-c",
      toolName: "bash",
      content: [{ type: "text", text: "/workspace" }],
      isError: false,
      timestamp: messageAt(10),
    },
  });
  const replacementCompaction = entry("entry-replacement-compaction", replacementTool.id, at(11), {
    type: "compaction",
    summary: "replacement branch summary",
    firstKeptEntryId: replacementAssistant.id,
    tokensBefore: 120_000,
    fromHook: false,
  });
  const replacementFinal = entry("entry-replacement-final", replacementCompaction.id, at(12), {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "replacement complete" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage,
      stopReason: "stop",
      timestamp: messageAt(12),
    },
  });

  return {
    sessionId,
    imageData,
    longText,
    main,
    shorter: main.slice(0, 4),
    equalReplacement: [
      ...main.slice(0, 4),
      replacementAssistant,
      replacementTool,
      replacementCompaction,
      replacementFinal,
    ],
  };
}
