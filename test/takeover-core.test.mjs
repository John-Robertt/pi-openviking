import assert from "node:assert/strict";
import test from "node:test";

import { TAKEOVER_ENTRY_TYPE, TakeoverCore } from "../lib/takeover-core.mjs";

function conversation(turns) {
  const messages = [];
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: "user", content: `user-${i}`, timestamp: i * 10 });
    messages.push({ role: "assistant", content: `assistant-${i}`, timestamp: i * 10 + 1 });
  }
  return messages;
}

function takeoverEntry(data) {
  return { type: "custom", customType: TAKEOVER_ENTRY_TYPE, data };
}

function createHarness({ archiveChecks = [], archiveCheckImpl, persisted = [], commitResult, commitImpl, activeChecks = [], config = {} } = {}) {
  let commitCalls = 0;
  let checkCalls = 0;
  let activeCalls = 0;
  const commitOptions = [];
  const entries = [];
  const core = new TakeoverCore({
    config: {
      takeoverTokenThreshold: 10,
      takeoverKeepRecentTurns: 2,
      takeoverRetainedTokenBudget: 30,
      takeoverOverviewPollMs: 0,
      takeoverOverviewPollMax: 1,
      ...config,
    },
    io: {
      flush: async () => true,
      commit: async (options) => {
        commitCalls++;
        commitOptions.push(structuredClone(options));
        if (commitImpl) return commitImpl(options);
        return commitResult ?? {
          status: "accepted",
          archived: true,
          task_id: "task-2",
          archive_uri: "viking://user/test/sessions/pi-test/history/archive_002",
        };
      },
      checkArchive: async (pending) => archiveCheckImpl
        ? archiveCheckImpl(pending)
        : archiveChecks[Math.min(checkCalls++, archiveChecks.length - 1)] ?? { status: "pending" },
      hasActiveCommit: async () => activeChecks[Math.min(activeCalls++, activeChecks.length - 1)] ?? false,
      persistEntry: (customType, data) => entries.push({ customType, data: structuredClone(data) }),
      getWatermark: () => 42,
      sleep: async () => {},
    },
  });
  if (persisted.length) core.restore(persisted);
  return {
    core,
    entries,
    get commitCalls() { return commitCalls; },
    get checkCalls() { return checkCalls; },
    get activeCalls() { return activeCalls; },
    get commitOptions() { return commitOptions; },
  };
}

test("commit 后目标 archive 未就绪时持久化身份且不推进边界", async () => {
  const harness = createHarness({ archiveChecks: [{ status: "pending" }] });
  harness.core.transformContext(conversation(5));

  assert.equal(await harness.core.onTurnSynced(40), false);
  assert.equal(harness.core.state.coveredUserTurns, 0);
  assert.equal(harness.core.state.pendingTokens, 40);
  assert.equal(harness.core.state.pendingArchive.archiveId, "archive_002");
  assert.equal(harness.commitCalls, 1);
  assert.equal(harness.entries.at(-1).customType, TAKEOVER_ENTRY_TYPE);
});

test("只接受 pending 身份对应的新 archive，并且等待期间不重复 commit", async () => {
  const harness = createHarness({
    archiveChecks: [
      { status: "pending", overview: "stale archive_001 overview" },
      {
        status: "ready",
        archiveUri: "viking://user/test/sessions/pi-test/history/archive_002",
        overview: "fresh archive_002 overview",
      },
    ],
  });
  harness.core.transformContext(conversation(5));

  assert.equal(await harness.core.onTurnSynced(40), false);
  assert.equal(await harness.core.commitAndAdvance(), true);
  assert.equal(harness.commitCalls, 1);
  assert.equal(harness.core.state.coveredUserTurns, 3);
  assert.equal(harness.core.state.overview, "fresh archive_002 overview");
  assert.equal(harness.core.state.confirmedArchive.archiveId, "archive_002");
  assert.equal(harness.core.state.pendingArchive, null);
});

test("恢复等待状态后继续查询原 archive，不制造第二次 commit", async () => {
  const first = createHarness({ archiveChecks: [{ status: "pending" }] });
  first.core.transformContext(conversation(5));
  await first.core.onTurnSynced(40);
  const saved = first.entries.at(-1).data;

  const resumed = createHarness({
    persisted: [takeoverEntry(saved)],
    archiveChecks: [{
      status: "ready",
      archiveUri: saved.pendingArchive.archiveUri,
      overview: "resumed fresh overview",
    }],
  });
  resumed.core.transformContext(conversation(5));

  assert.equal(await resumed.core.commitAndAdvance(), true);
  assert.equal(resumed.commitCalls, 0);
  assert.equal(resumed.core.state.coveredUserTurns, 3);
  assert.equal(resumed.core.state.overview, "resumed fresh overview");
});

test("archive 等待期间新增 token 在完成后仍保留", async () => {
  const harness = createHarness({
    archiveChecks: [
      { status: "pending" },
      {
        status: "ready",
        archiveUri: "viking://user/test/sessions/pi-test/history/archive_002",
        overview: "fresh overview",
      },
    ],
  });
  harness.core.transformContext(conversation(5));
  await harness.core.onTurnSynced(40);
  await harness.core.onTurnSynced(7);

  assert.equal(harness.core.state.pendingTokens, 7);
  assert.equal(harness.commitCalls, 1);
});

test("旧版无 archive 身份的持久化边界恢复时失败开放", () => {
  const harness = createHarness({
    persisted: [takeoverEntry({
      coveredUserTurns: 7,
      overview: "unproven old overview",
      fingerprint: "old",
      pendingTokens: 0,
      lastSeenUserTurns: 10,
      syncedEntryCount: 123,
    })],
  });

  assert.equal(harness.core.state.coveredUserTurns, 0);
  assert.equal(harness.core.state.overview, "");
  assert.equal(harness.core.state.syncedEntryCount, 123);
  assert.equal(harness.core.state.awaitingCommitDrain, true);
});

test("task 明确失败时保留 token 压力并允许后续重试", async () => {
  const harness = createHarness({ archiveChecks: [{ status: "pending" }, { status: "failed" }] });
  harness.core.transformContext(conversation(5));

  await harness.core.onTurnSynced(40);
  assert.equal(await harness.core.commitAndAdvance(), false);
  assert.equal(harness.core.state.pendingArchive, null);
  assert.equal(harness.core.state.pendingTokens, 40);
  assert.equal(harness.core.state.coveredUserTurns, 0);
});

test("archive URI 不匹配时拒绝摘要并保持边界", async () => {
  const harness = createHarness({
    archiveChecks: [{
      status: "ready",
      archiveUri: "viking://user/test/sessions/pi-test/history/archive_003",
      overview: "wrong archive",
    }],
  });
  harness.core.transformContext(conversation(5));

  assert.equal(await harness.core.onTurnSynced(40), false);
  assert.equal(harness.core.state.coveredUserTurns, 0);
  assert.equal(harness.core.state.confirmedArchive, null);
  assert.equal(harness.core.state.pendingTokens, 40);
});

test("旧状态迁移等待未认领 task 清空后才允许新 commit", async () => {
  const legacy = takeoverEntry({
    coveredUserTurns: 2,
    overview: "unproven",
    pendingTokens: 40,
    syncedEntryCount: 10,
  });
  const harness = createHarness({
    persisted: [legacy],
    activeChecks: [true, false],
    archiveChecks: [{
      status: "ready",
      archiveUri: "viking://user/test/sessions/pi-test/history/archive_002",
      overview: "verified",
    }],
  });
  harness.core.transformContext(conversation(5));

  assert.equal(await harness.core.commitAndAdvance(), false);
  assert.equal(harness.commitCalls, 0);
  assert.equal(await harness.core.commitAndAdvance(), true);
  assert.equal(harness.commitCalls, 1);
  assert.equal(harness.core.state.awaitingCommitDrain, false);
});

test("compaction 超时保留目标 archive，Pi compaction 后不得推进旧边界", async () => {
  const harness = createHarness({
    archiveChecks: [
      { status: "pending" },
      {
        status: "ready",
        archiveUri: "viking://user/test/sessions/pi-test/history/archive_002",
        overview: "compact overview",
      },
    ],
  });
  harness.core.transformContext(conversation(5));

  const result = await harness.core.handleBeforeCompact({ firstKeptEntryId: "kept", tokensBefore: 100 });
  assert.equal(result, undefined);
  assert.equal(harness.core.state.pendingArchive.purpose, "compact");
  harness.core.onPiCompacted();
  assert.equal(await harness.core.commitAndAdvance(), true);
  assert.equal(harness.commitCalls, 1);
  assert.equal(harness.core.state.coveredUserTurns, 0);
});


test("并发推进请求最多发起一次 commit", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const harness = createHarness({
    commitImpl: async () => {
      await gate;
      return {
        status: "accepted",
        archived: true,
        task_id: "task-2",
        archive_uri: "viking://user/test/sessions/pi-test/history/archive_002",
      };
    },
    archiveChecks: [{
      status: "ready",
      archiveUri: "viking://user/test/sessions/pi-test/history/archive_002",
      overview: "fresh",
    }],
  });
  harness.core.transformContext(conversation(5));

  const first = harness.core.commitAndAdvance();
  const second = harness.core.commitAndAdvance();
  release();
  assert.equal(await second, false);
  assert.equal(await first, true);
  assert.equal(harness.commitCalls, 1);
});

test("自动 takeover 只发送 OpenViking 原生 turn_budget 参数", async () => {
  const harness = createHarness({ archiveChecks: [{ status: "pending" }] });
  harness.core.transformContext(conversation(5));
  await harness.core.onTurnSynced(40);

  assert.deepEqual(harness.commitOptions, [{
    queueOnFailure: false,
    keepRecentCount: 0,
    retentionMode: "turn_budget",
    keepRecentTurnCount: 2,
    retainedMessageTokenBudget: 30,
    minRawTailSteps: 1,
  }]);
});

test("schema v2 状态缺少 confirmed archive 身份时也不得恢复覆盖边界", () => {
  const harness = createHarness({
    persisted: [takeoverEntry({
      schemaVersion: 2,
      coveredUserTurns: 2,
      overview: "orphan overview",
      fingerprint: "orphan fingerprint",
      pendingTokens: 0,
      syncedEntryCount: 5,
      pendingArchive: null,
      confirmedArchive: null,
      awaitingCommitDrain: false,
    })],
  });

  assert.equal(harness.core.state.coveredUserTurns, 0);
  assert.equal(harness.core.state.overview, "");
  assert.equal(harness.core.state.confirmedArchive, null);
});

test("keepRecentTurns=0 被安全收敛为至少保留一轮", async () => {
  const harness = createHarness({
    config: { takeoverKeepRecentTurns: 0 },
    archiveChecks: [{
      status: "ready",
      archiveUri: "viking://user/test/sessions/pi-test/history/archive_002",
      overview: "older turns archived",
    }],
  });
  const messages = conversation(3);
  harness.core.transformContext(messages);

  assert.equal(await harness.core.onTurnSynced(40), true);
  assert.equal(harness.core.state.coveredUserTurns, 2);
  const transformed = harness.core.transformContext(messages);
  assert.equal(transformed.length, 3);
  assert.match(transformed[0].content, /older turns archived/);
});

test("旧版零边界状态也先等待无法认领的 commit task", async () => {
  const harness = createHarness({
    persisted: [takeoverEntry({
      coveredUserTurns: 0,
      overview: "",
      pendingTokens: 0,
      syncedEntryCount: 5,
    })],
    activeChecks: [true],
  });
  harness.core.transformContext(conversation(3));

  assert.equal(harness.core.state.awaitingCommitDrain, true);
  assert.equal(await harness.core.commitAndAdvance(), false);
  assert.equal(harness.commitCalls, 0);
});

test("archive 轮询期间发生 Pi compaction 时使用更新后的 archiveOnly 目的", async () => {
  let releaseCheck;
  const checkGate = new Promise((resolve) => { releaseCheck = resolve; });
  const harness = createHarness({
    archiveCheckImpl: async (pending) => {
      await checkGate;
      return { status: "ready", archiveUri: pending.archiveUri, overview: "fresh" };
    },
  });
  harness.core.transformContext(conversation(5));

  const advancing = harness.core.onTurnSynced(40);
  for (let i = 0; i < 10 && !harness.core.state.pendingArchive; i++) await Promise.resolve();
  assert.equal(harness.core.state.pendingArchive.purpose, "advance");
  harness.core.onPiCompacted();
  releaseCheck();

  assert.equal(await advancing, true);
  assert.equal(harness.core.state.confirmedArchive.archiveId, "archive_002");
  assert.equal(harness.core.state.coveredUserTurns, 0);
});

test("commit 响应丢失后凭 task id 恢复 archive 身份", async () => {
  const recoveredUri = "viking://user/test/sessions/pi-test/history/archive_002";
  const harness = createHarness({
    commitResult: {
      status: "accepted",
      archived: true,
      task_id: "recovered-task",
      archive_uri: null,
    },
    archiveChecks: [{
      status: "ready",
      archiveUri: recoveredUri,
      archiveId: "archive_002",
      overview: "recovered overview",
    }],
  });
  harness.core.transformContext(conversation(5));

  assert.equal(await harness.core.onTurnSynced(40), true);
  assert.equal(harness.core.state.confirmedArchive.archiveUri, recoveredUri);
  assert.equal(harness.core.state.coveredUserTurns, 3);
});

test("无法识别 task 的未知 commit 结果会阻止再次 POST", async () => {
  const harness = createHarness({
    commitResult: { status: "outcome_unknown" },
    activeChecks: [true],
  });
  harness.core.transformContext(conversation(5));

  assert.equal(await harness.core.onTurnSynced(40), false);
  assert.equal(harness.core.state.awaitingCommitDrain, true);
  assert.equal(await harness.core.commitAndAdvance(), false);
  assert.equal(harness.commitCalls, 1);
});

test("旧 commit 未清空时 pre-compact 也不会创建新 archive", async () => {
  const harness = createHarness({
    persisted: [takeoverEntry({
      coveredUserTurns: 0,
      overview: "",
      pendingTokens: 0,
      syncedEntryCount: 5,
    })],
    activeChecks: [true],
  });

  const result = await harness.core.handleBeforeCompact({ firstKeptEntryId: "kept", tokensBefore: 100 });
  assert.equal(result, undefined);
  assert.equal(harness.commitCalls, 0);
  assert.equal(harness.core.state.awaitingCommitDrain, true);
});

test("仅有 task id 的 pending 在轮询中 compaction 后保持 archiveOnly", async () => {
  let releaseCheck;
  const checkGate = new Promise((resolve) => { releaseCheck = resolve; });
  const recoveredUri = "viking://user/test/sessions/pi-test/history/archive_002";
  const harness = createHarness({
    commitResult: {
      status: "accepted",
      archived: true,
      task_id: "recovered-task",
      archive_uri: null,
    },
    archiveCheckImpl: async () => {
      await checkGate;
      return {
        status: "ready",
        archiveUri: recoveredUri,
        archiveId: "archive_002",
        overview: "recovered overview",
      };
    },
  });
  harness.core.transformContext(conversation(5));

  const advancing = harness.core.onTurnSynced(40);
  for (let i = 0; i < 10 && !harness.core.state.pendingArchive; i++) await Promise.resolve();
  assert.equal(harness.core.state.pendingArchive.archiveUri, "");
  harness.core.onPiCompacted();
  releaseCheck();

  assert.equal(await advancing, true);
  assert.equal(harness.core.state.confirmedArchive.archiveUri, recoveredUri);
  assert.equal(harness.core.state.coveredUserTurns, 0);
});
