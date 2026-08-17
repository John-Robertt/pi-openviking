import assert from "node:assert/strict";
import test from "node:test";

import {
  VIKING_STATUS_KEY,
  clearVikingFooter,
  formatVikingCommand,
  formatVikingFooter,
  setVikingFooter,
} from "../shared/viking-status.mjs";

const takeover = { coveredUserTurns: 4, lastSeenUserTurns: 7, pendingTokens: 1234 };

test("页脚状态使用 Pi 的 keyed setStatus API", () => {
  const calls = [];
  const ctx = { ui: { setStatus: (...args) => calls.push(args) } };
  const snapshot = {
    connected: true,
    added: 2,
    sessionId: "pi-0123456789abcdef",
    threshold: 30000,
    takeover,
  };

  assert.equal(setVikingFooter(ctx, snapshot), true);
  assert.deepEqual(calls, [[VIKING_STATUS_KEY, "OV ✓ · ↩2 · ctx 4 · ~1234/30000 · pi-012345678"]]);

  assert.equal(clearVikingFooter(ctx), true);
  assert.deepEqual(calls.at(-1), [VIKING_STATUS_KEY, undefined]);
});

test("页脚明确区分当前连接结果并保留非接管阈值", () => {
  assert.equal(
    formatVikingFooter({
      connected: false,
      added: 0,
      sessionId: null,
      threshold: 20000,
      takeover: null,
    }),
    "OV ✗ · ↩0 · ✎ 20000 · none",
  );
});

test("/viking 快照在断线时仍保留本地会话信息", () => {
  assert.equal(
    formatVikingCommand({
      connected: false,
      sessionId: "pi-0123456789abcdef",
      takeover,
    }),
    "OpenViking: disconnected | session: pi-012345678... | takeover: 4/7 turns archived, ~1234 tokens pending",
  );
});
