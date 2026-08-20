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
      archive: { committed: 3, lastArchiveId: `arc_${"a".repeat(64)}`, pending: 1, lastFailure: null },
      checkpoint: {
        mode: "lagging", consumed: 1, pending: 2, backlogTokens: 3000,
        lastCheckpointId: `chk_${"c".repeat(64)}`, currentArchiveId: `arc_${"d".repeat(64)}`, lastFailure: null,
      },
    },
    observation: { state: "ready", reason: "ready", accepted: 12, dropped: 0 },
  });
  assert.match(output, /来源：Pi JSONL/);
  assert.match(output, /适配器：content-api-v1（可用）/);
  assert.match(output, /观察：就绪（accepted=12，dropped=0）/);
  assert.match(output, /ACK frontier：2 个 leaves/);
  assert.match(output, /待重放：4 个 entry/);
  assert.match(output, new RegExp(`Archive：已提交 3 个，待提交 1 个（最近 arc_a{64}）`));
  assert.match(output, new RegExp(`Checkpoint：消费落后，已消费 1 个，积压 2 个 Archive / 3000 tokens（最近 chk_c{64}）`));
});

test("/viking 在 Archive 尚未形成或提交失败时给出可诊断状态", () => {
  const idle = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: { source: "persistent-jsonl", capability: "ready", acknowledgedLeaves: [], pendingEntries: 0, lastFailure: null },
    observation: { state: "disabled" },
  });
  assert.match(idle, /Archive：已提交 0 个，待提交 0 个（最近 尚未形成）/);
  assert.doesNotMatch(idle, /最近 Archive 失败/);

  const failed = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: {
      source: "persistent-jsonl",
      capability: "ready",
      acknowledgedLeaves: ["leaf-a"],
      pendingEntries: 0,
      lastFailure: null,
      archive: { committed: 1, lastArchiveId: `arc_${"b".repeat(64)}`, pending: 2, lastFailure: "ContentBusyError: path busy" },
      checkpoint: { mode: "failed", consumed: 0, pending: 1, backlogTokens: 1000, lastCheckpointId: null, currentArchiveId: `arc_${"b".repeat(64)}`, lastFailure: "task failed" },
    },
    observation: { state: "disabled" },
  });
  assert.match(failed, /Archive：已提交 1 个，待提交 2 个/);
  assert.match(failed, /最近 Archive 失败：ContentBusyError: path busy/);
  assert.match(failed, /Checkpoint：失败，已消费 0 个，积压 1 个 Archive \/ 1000 tokens/);
  assert.match(failed, /最近 checkpoint 失败：task failed/);
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
      lastFailure: "ContentWriteError: unavailable",
    },
    observation: { state: "incomplete", reason: "write_failed", accepted: 5, dropped: 2 },
  });
  assert.match(output, /来源：进程内 best-effort/);
  assert.match(output, /待重放：2 个 entry/);
  assert.match(output, /主任务：fail-open/);
  assert.match(output, /最近同步失败：ContentWriteError: unavailable/);
  assert.match(output, /观察：不完整（write_failed，accepted=5，dropped=2）/);
});
