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
  assert.match(output, new RegExp(`Archive（当前分支本轮）：已验证 3 个，待验证 1 个（最近 arc_a{64}）`));
  assert.match(output, new RegExp(`Checkpoint：消费落后，已消费 1 个，积压 2 个 Archive / 3000 tokens（最近 chk_c{64}）`));
});

test("/viking 把新会话首次落盘前显示为正常等待状态", () => {
  const output = formatVikingCommand({
    connected: true,
    sessionId: "pi-new-session",
    sync: {
      source: "pending-persistence", capability: "unknown",
      acknowledgedLeaves: [], pendingEntries: 0, lastFailure: null,
    },
    observation: { state: "disabled" },
  });
  assert.match(output, /来源：等待首个响应写入 Pi JSONL/);
  assert.doesNotMatch(output, /最近同步失败/);
});

test("/viking 在 Archive 尚未形成或提交失败时给出可诊断状态", () => {
  const idle = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: { source: "persistent-jsonl", capability: "ready", acknowledgedLeaves: [], pendingEntries: 0, lastFailure: null },
    observation: { state: "disabled" },
  });
  assert.match(idle, /Archive（当前分支本轮）：已验证 0 个，待验证 0 个（最近 尚未形成）/);
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
  assert.match(failed, /Archive（当前分支本轮）：已验证 1 个，待验证 2 个/);
  assert.match(failed, /最近 Archive 失败：ContentBusyError: path busy/);
  assert.match(failed, /Checkpoint：失败，已消费 0 个，积压 1 个 Archive \/ 1000 tokens/);
  assert.match(failed, /最近 checkpoint 失败：task failed/);
});

test("/viking 展示活动上下文的身份、边界与容量判定", () => {
  const base = {
    source: "persistent-jsonl",
    capability: "ready",
    acknowledgedLeaves: ["leaf-a"],
    pendingEntries: 0,
    lastFailure: null,
    archive: { committed: 2, lastArchiveId: `arc_${"a".repeat(64)}`, pending: 0, lastFailure: null },
    checkpoint: {
      mode: "caught_up", consumed: 2, pending: 0, backlogTokens: 0,
      lastCheckpointId: `chk_${"c".repeat(64)}`, currentArchiveId: null, lastFailure: null,
    },
  };
  const eligible = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: {
      ...base,
      activeContext: {
        checkpointId: `chk_${"c".repeat(64)}`, rawTailStartEventId: `evt_${"e".repeat(64)}`, rawTailEvents: 3,
        eligibility: "eligible", capacityTokens: 272000, reserveTokens: 128000,
        usableTokens: 144000, payloadTokens: 10481, headroomTokens: 133519, lastFailure: null,
      },
    },
    observation: { state: "disabled" },
  });
  assert.match(eligible, new RegExp(`活动上下文：可接管（余量 133519 tokens），checkpoint chk_c{64}，raw tail 起点 evt_e{64}（3 个事件）`));
  assert.match(eligible, /上下文容量：Pi 报告 272000，输出预留 128000，可用 144000，候选需要 10481/);

  const mismatch = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: {
      ...base,
      activeContext: {
        checkpointId: `chk_${"c".repeat(64)}`, rawTailStartEventId: `evt_${"e".repeat(64)}`, rawTailEvents: 3,
        eligibility: "capacity_mismatch", capacityTokens: 272000, reserveTokens: 128000,
        usableTokens: 1000, payloadTokens: 10481, headroomTokens: -9481, lastFailure: "Error: read failed",
      },
    },
    observation: { state: "disabled" },
  });
  assert.match(mismatch, /活动上下文：inactive：容量不匹配，checkpoint chk_c{64}/);
  assert.match(mismatch, /上下文容量：Pi 报告 272000，输出预留 128000，可用 1000，候选需要 10481/);
  assert.match(mismatch, /最近活动上下文失败：Error: read failed/);

  const overBudget = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: {
      ...base,
      activeContext: {
        checkpointId: `chk_${"c".repeat(64)}`, rawTailStartEventId: `evt_${"e".repeat(64)}`, rawTailEvents: 3,
        eligibility: "checkpoint_over_budget", capacityTokens: 272000, reserveTokens: 128000,
        usableTokens: 144000, payloadTokens: 18000, headroomTokens: 126000, lastFailure: null,
      },
    },
    observation: { state: "disabled" },
  });
  assert.match(overBudget, /活动上下文：inactive：checkpoint 超出配置预算，checkpoint chk_c{64}/);
  assert.match(overBudget, /候选需要 18000/);

  const empty = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    sync: { ...base, activeContext: { checkpointId: null, eligibility: "no_context" } },
    observation: { state: "disabled" },
  });
  assert.match(empty, /活动上下文：尚未形成/);
  assert.doesNotMatch(empty, /最近活动上下文失败/);
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
