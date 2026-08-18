import assert from "node:assert/strict";
import test from "node:test";

import {
  VIKING_STATUS_KEY,
  clearVikingFooter,
  formatVikingCommand,
  formatVikingFooter,
  setVikingFooter,
} from "../shared/viking-status.mjs";

test("页脚只使用 Pi keyed status 展示连接状态", () => {
  const calls = [];
  const ctx = { ui: { setStatus: (...args) => calls.push(args) } };
  assert.equal(setVikingFooter(ctx, { connected: true }), true);
  assert.deepEqual(calls, [[VIKING_STATUS_KEY, "OV ✓"]]);
  assert.equal(clearVikingFooter(ctx), true);
  assert.deepEqual(calls.at(-1), [VIKING_STATUS_KEY, undefined]);
  assert.equal(formatVikingFooter({ connected: false }), "OV ✗");
});

test("/viking 展示 JSONL、Content capability、ACK 和待重放状态", () => {
  const output = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: {
      source: "persistent-jsonl",
      capability: "ready",
      acknowledgedLeaves: ["leaf-a", "leaf-b"],
      pendingEntries: 4,
      lastFailure: null,
    },
  });
  assert.match(output, /来源：Pi JSONL/);
  assert.match(output, /适配器：content-api-v1（可用）/);
  assert.match(output, /ACK frontier：2 个 leaves/);
  assert.match(output, /待重放：4 个 entry/);
});

test("/viking 在断线时明确 fail-open 和最近失败", () => {
  const output = formatVikingCommand({
    connected: false,
    sessionId: "pi-session",
    sync: {
      source: "in-memory",
      capability: "unknown",
      acknowledgedLeaves: [],
      pendingEntries: 2,
      lastFailure: "RecordedEventSyncError: unavailable",
    },
  });
  assert.match(output, /来源：进程内 best-effort/);
  assert.match(output, /待重放：2 个 entry/);
  assert.match(output, /主任务：fail-open/);
  assert.match(output, /最近同步失败：RecordedEventSyncError: unavailable/);
});
