import assert from "node:assert/strict";
import test from "node:test";

import {
  VIKING_STATUS_KEY,
  clearVikingFooter,
  formatVikingCommand,
  formatVikingFooter,
  setVikingFooter,
} from "../shared/viking-status.mjs";

const confirmedTakeover = {
  coveredUserTurns: 4,
  lastSeenUserTurns: 7,
  pendingTokens: 1234,
  pendingArchive: null,
  confirmedArchive: { archiveId: "archive_007" },
};

test("页脚只使用 Pi 的 keyed status 展示连接状态", () => {
  const calls = [];
  const ctx = { ui: { setStatus: (...args) => calls.push(args) } };

  assert.equal(setVikingFooter(ctx, {
    connected: true,
    added: 2,
    sessionId: "pi-0123456789abcdef",
    threshold: 30000,
    takeover: confirmedTakeover,
  }), true);
  assert.deepEqual(calls, [[VIKING_STATUS_KEY, "OV ✓"]]);

  assert.equal(clearVikingFooter(ctx), true);
  assert.deepEqual(calls.at(-1), [VIKING_STATUS_KEY, undefined]);
});

test("页脚断线时不泄漏其他诊断信息", () => {
  assert.equal(formatVikingFooter({
    connected: false,
    added: 9,
    sessionId: "pi-0123456789abcdef",
    threshold: 20000,
    takeover: confirmedTakeover,
  }), "OV ✗");
});

test("/viking 用中文解释断线时保留的本地接管状态", () => {
  assert.equal(formatVikingCommand({
    connected: false,
    sessionId: "pi-0123456789abcdef",
    added: 2,
    threshold: 20000,
    keepRecentTurns: 3,
    takeover: confirmedTakeover,
  }), [
    "OpenViking：未连接",
    "模式：上下文接管",
    "会话：pi-0123456789abcdef",
    "最近捕获：2 条消息",
    "上下文：4 个旧用户轮次已归档，3 个最近用户轮次保留原文",
    "待确认内容：约 1,234 tokens",
    "自动归档条件：待确认内容达到 20,000 tokens，且用户轮次超过 3",
    "归档：已确认 archive_007",
  ].join("\n"));
});

test("/viking 区分待确认 archive 和最近已确认 archive", () => {
  assert.equal(formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    added: 6,
    threshold: 20000,
    keepRecentTurns: 3,
    takeover: {
      ...confirmedTakeover,
      pendingTokens: 20000,
      pendingArchive: { archiveId: "archive_008", taskId: "task-008" },
    },
  }), [
    "OpenViking：已连接",
    "模式：上下文接管",
    "会话：pi-session",
    "最近捕获：6 条消息",
    "上下文：4 个旧用户轮次已归档，3 个最近用户轮次保留原文",
    "待确认内容：约 20,000 tokens",
    "自动归档条件：待确认内容达到 20,000 tokens，且用户轮次超过 3",
    "归档：等待确认 archive_008",
    "最近确认：archive_007",
  ].join("\n"));
});

test("/viking 在只有 task 身份时展示可诊断任务", () => {
  assert.equal(formatVikingCommand({
    connected: true,
    sessionId: null,
    added: 0,
    threshold: 20000,
    keepRecentTurns: 3,
    takeover: {
      coveredUserTurns: 0,
      lastSeenUserTurns: 0,
      pendingTokens: 0,
      pendingArchive: { archiveId: "", taskId: "task-pending" },
      confirmedArchive: null,
    },
  }), [
    "OpenViking：已连接",
    "模式：上下文接管",
    "会话：尚未建立",
    "最近捕获：0 条消息",
    "上下文：尚无用户轮次",
    "待确认内容：无",
    "自动归档条件：待确认内容达到 20,000 tokens，且用户轮次超过 3",
    "归档：等待确认",
    "任务：task-pending",
  ].join("\n"));
});

test("/viking 非接管模式只展示同步职责和自动提交阈值", () => {
  assert.equal(formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    added: 3,
    threshold: 30000,
    takeover: null,
  }), [
    "OpenViking：已连接",
    "模式：同步与召回",
    "会话：pi-session",
    "最近捕获：3 条消息",
    "自动提交阈值：30,000 tokens",
  ].join("\n"));
});

test("/viking 明确展示未知提交结果形成的归档屏障", () => {
  const output = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    added: 0,
    threshold: 20000,
    keepRecentTurns: 3,
    takeover: {
      ...confirmedTakeover,
      awaitingCommitDrain: true,
    },
  });

  assert.match(output, /归档：正在核验已有提交任务，期间不会重复提交/);
  assert.match(output, /最近确认：archive_007/);
});

test("/viking 精确展示相近 token 数和完整归档条件", () => {
  const output = formatVikingCommand({
    connected: true,
    sessionId: "pi-session",
    added: 0,
    threshold: 20499,
    keepRecentTurns: 3,
    takeover: {
      ...confirmedTakeover,
      coveredUserTurns: 0,
      lastSeenUserTurns: 3,
      pendingTokens: 20490,
    },
  });

  assert.match(output, /待确认内容：约 20,490 tokens/);
  assert.match(output, /达到 20,499 tokens，且用户轮次超过 3/);
});
