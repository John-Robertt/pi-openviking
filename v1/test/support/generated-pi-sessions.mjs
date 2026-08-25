const TIMESTAMP_BASE = Date.parse("2026-08-18T00:00:00.000Z");

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function availableToolCall(entries, parentIndex) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const consumed = new Set();
  let current = parentIndex === null ? null : entries[parentIndex];
  while (current) {
    if (current.type === "message" && current.message.role === "toolResult") {
      consumed.add(current.message.toolCallId);
    } else if (current.type === "message" && current.message.role === "user") {
      return null;
    } else if (current.type === "message" && current.message.role === "assistant") {
      return current.message.content.find((part) => part.type === "toolCall" && !consumed.has(part.id)) || null;
    }
    current = current.parentId === null ? null : byId.get(current.parentId);
  }
  return null;
}

function pickAncestorId(entries, parentIndex, random) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const ancestors = [];
  let current = entries[parentIndex];
  while (current) {
    ancestors.push(current.id);
    current = current.parentId === null ? null : byId.get(current.parentId);
  }
  return ancestors[Math.floor(random() * ancestors.length)];
}

function messageEntry(kind, index, random, entries, parentIndex) {
  const marker = `entry-${index}-中-\\-${Math.floor(random() * 1_000_000)}`;
  if (kind === 0) {
    const content = random() < 0.5
      ? marker
      : [
          { type: "text", text: marker },
          { type: "image", mimeType: "image/png", data: Buffer.from(marker).toString("base64") },
        ];
    return { type: "message", message: { role: "user", content, timestamp: index } };
  }
  if (kind === 1) {
    return {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: `reason-${marker}` },
          { type: "text", text: `answer-${marker}` },
          { type: "toolCall", id: `call-${index}`, name: "generated_tool", arguments: { marker, values: [null, true, index] } },
          { type: `future-${index % 3}`, nested: { marker } },
        ],
        api: "generated",
        provider: "generated",
        model: `model-${index % 2}`,
        usage: { input: index, output: index + 1, cacheRead: 0, cacheWrite: 0, totalTokens: index * 2 + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: index % 7 === 0 ? "aborted" : "toolUse",
        timestamp: index,
      },
    };
  }
  if (kind === 2) {
    const call = availableToolCall(entries, parentIndex);
    if (!call) return messageEntry(1, index, random, entries, parentIndex);
    return {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: random() < 0.5 ? `result-${marker}` : [{ type: "text", text: `result-${marker}` }],
        isError: index % 4 === 0,
        details: { marker, code: index % 4 === 0 ? "E_GENERATED" : null },
        timestamp: index,
      },
    };
  }
  if (kind === 3) {
    return {
      type: "custom_message",
      customType: "generated-context",
      content: [{ type: "text", text: marker }, { type: "image", mimeType: "image/png", data: "AA==" }],
      details: { marker },
      display: false,
    };
  }

  const opaque = [
    { type: "model_change", provider: "generated", modelId: `model-${index}` },
    { type: "thinking_level_change", thinkingLevel: index % 2 === 0 ? "high" : "low" },
    { type: "custom", customType: "generated-state", data: { marker, index } },
    { type: "session_info", name: marker },
    { type: "compaction", summary: marker, firstKeptEntryId: pickAncestorId(entries, parentIndex, random), tokensBefore: index * 100 },
  ];
  return opaque[(kind - 4) % opaque.length];
}

export const GENERATED_SESSION_SEEDS = Object.freeze([
  0x00000001,
  0x00000002,
  0x00000003,
  0x00000005,
  0x00000008,
  0x0000000d,
  0x00000015,
  0x00000022,
  0x00000037,
  0x00000059,
  0x00000090,
  0x00000179,
  0x00000269,
  0x00000410,
  0x00000679,
  0x00001089,
]);

export function buildGeneratedPiSession(seed, { entryCount = 48 } = {}) {
  if (!Number.isSafeInteger(entryCount) || entryCount < 1) throw new TypeError("entryCount must be positive");
  const random = mulberry32(seed);
  const suffix = (seed >>> 0).toString(16).padStart(8, "0");
  const entries = [];

  for (let index = 0; index < entryCount; index++) {
    const id = `generated-${suffix}-${String(index).padStart(3, "0")}`;
    const parentIndex = index === 0
      ? null
      : random() < 0.55
        ? index - 1
        : Math.floor(random() * index);
    const kind = index === 0 ? 0 : Math.floor(random() * 9);
    entries.push({
      id,
      parentId: parentIndex === null ? null : entries[parentIndex].id,
      timestamp: new Date(TIMESTAMP_BASE + index * 1_000 + (seed % 997)).toISOString(),
      ...messageEntry(kind, index, random, entries, parentIndex),
    });
  }

  return {
    seed: seed >>> 0,
    sessionId: `generated-session-${suffix}`,
    entries,
  };
}

export function buildGeneratedToolLoop(seed, { steps = 64 } = {}) {
  if (!Number.isSafeInteger(steps) || steps < 1) throw new TypeError("steps must be positive");
  const suffix = (seed >>> 0).toString(16).padStart(8, "0");
  const entries = [];
  const append = (value) => {
    const index = entries.length;
    const entry = {
      id: `tool-loop-${suffix}-${String(index).padStart(4, "0")}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date(TIMESTAMP_BASE + index * 1_000 + (seed % 997)).toISOString(),
      ...value,
    };
    entries.push(entry);
    return entry;
  };

  append({ type: "message", message: { role: "user", content: `tool-loop-request-${suffix}`, timestamp: 0 } });
  for (let step = 0; step < steps; step++) {
    const callCount = 1 + ((seed + step) % 4);
    const calls = Array.from({ length: callCount }, (_, index) => ({
      type: "toolCall",
      id: `loop-call-${suffix}-${step}-${index}`,
      name: `generated_tool_${index}`,
      arguments: { seed: seed >>> 0, step, index },
    }));
    append({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: `plan-${step}` }, ...calls],
        api: "generated",
        provider: "generated",
        model: "tool-loop-model",
        usage: { input: step, output: callCount, cacheRead: 0, cacheWrite: 0, totalTokens: step + callCount, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolUse",
        timestamp: entries.length,
      },
    });
    for (let index = 0; index < callCount; index++) {
      append({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: calls[index].id,
          toolName: calls[index].name,
          content: [{ type: "text", text: `result-${step}-${index}` }],
          isError: (seed + step + index) % 11 === 0,
          timestamp: entries.length,
        },
      });
    }
  }
  append({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `tool-loop-final-${suffix}` }],
      api: "generated",
      provider: "generated",
      model: "tool-loop-model",
      usage: { input: steps, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: steps + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: entries.length,
    },
  });

  return { seed: seed >>> 0, sessionId: `tool-loop-session-${suffix}`, entries, steps };
}
