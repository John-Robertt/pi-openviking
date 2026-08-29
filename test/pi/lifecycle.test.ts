/**
 * 真实 Pi 检查:生命周期失效与重建、工具取消信号、失败隔离。
 * 对应 docs/modules/pi-boundary.md「真实 Pi 检查」相关条目。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createPiHarness, waitFor, waitForCues } from "./harness.ts";

test("reload:旧实例先 shutdown 失效,新实例 start 后重建线索能力", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitForCues(h);

  // 让下一次准备挂起,reload 时它必须被取消并分类为失效。
  h.behavior.prepareHangs = true;
  h.respondText("回答2");
  await h.session().prompt("问题2");
  await waitFor(
    () => h.current.cueProvider.prepareCalls.length >= 2,
    "挂起的准备已启动",
  );
  h.behavior.prepareHangs = false;

  const successBefore = h.observation.filter(
    (e) => e.operation === "cue_preparation" && e.result === "success",
  ).length;
  await h.session().reload();

  const shutdownIndex = h.sessionLog.findIndex((l) => l.startsWith("session_shutdown(reload)"));
  const startIndex = h.sessionLog.findIndex((l) => l.startsWith("session_start(reload)"));
  assert.ok(shutdownIndex >= 0 && startIndex > shutdownIndex, "reload 先 shutdown 再 start");

  await waitFor(
    () =>
      h.observation.some((e) => e.operation === "cue_preparation" && e.result === "stale"),
    "挂起的准备被分类为失效",
  );

  // 新实例重建能力:新一轮 prepare 成功,普通请求恢复注入。
  await waitFor(
    () =>
      h.observation.filter(
        (e) => e.operation === "cue_preparation" && e.result === "success",
      ).length > successBefore,
    "reload 后的线索准备",
  );
  h.respondText("回答3");
  await h.session().prompt("问题3");
  assert.equal(h.requests.at(-1)?.hasCues, true, "reload 后注入恢复");
});

test("session 替换(new):旧范围失效,新范围重建", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitForCues(h);
  const oldSessionId = h.session().sessionManager.getSessionId();

  const result = await h.runtime.newSession();
  assert.equal(result.cancelled, false);
  assert.ok(h.sessionLog.some((l) => l.startsWith("session_before_switch(new)")));
  assert.ok(h.sessionLog.some((l) => l.startsWith("session_shutdown(new)")));
  assert.ok(h.sessionLog.some((l) => l.startsWith("session_start(new)")));
  assert.notEqual(h.session().sessionManager.getSessionId(), oldSessionId);

  // 新 session 中旧 handle 不可用。
  h.respondToolCall("recall_memory", { handle: `h:${oldSessionId}:anything` });
  h.respondText("结束");
  await h.session().prompt("旧 handle");
  const recall = h.observation.findLast((e) => e.operation === "fact_recall");
  assert.equal(recall?.result, "not_found");
});

test("正常退出:dispose 发出 session_shutdown(quit) 并取消后台任务", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.behavior.prepareHangs = true;
  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitFor(() => h.current.cueProvider.prepareCalls.length >= 1, "准备已启动");

  await h.runtime.dispose();
  assert.ok(
    h.sessionLog.some((l) => l.startsWith("session_shutdown(quit)")),
    "正常退出触发 shutdown(quit)",
  );
  await waitFor(
    () => h.observation.some((e) => e.operation === "cue_preparation" && e.result === "stale"),
    "挂起任务被取消且完成值被拒绝",
  );
});

test("工具 execute 收到 Pi 当前调用的取消信号", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitForCues(h);

  h.behavior.recallHangs = true;
  h.respond((context) => {
    const match = /\\"handle\\":\\"(h:[^\\"]+)\\"/.exec(JSON.stringify(context.messages));
    assert.ok(match);
    return fauxAssistantMessage([fauxToolCall("recall_memory", { handle: match[1] })], {
      stopReason: "toolUse",
    });
  });
  const prompt = h.session().prompt("找回事实");
  await waitFor(() => h.current.retriever.calls.length === 1, "recall 已开始");
  const record = h.current.retriever.calls[0];
  assert.equal(record.signal.aborted, false, "开始时未取消");

  await h.session().abort();
  await prompt;
  assert.equal(record.signal.aborted, true, "Pi 取消传递到工具执行");

  // Pi 从取消中恢复,后续请求正常。
  h.behavior.recallHangs = false;
  h.respondText("恢复回答");
  await h.session().prompt("继续");
  assert.equal(h.requests.at(-1)?.label, "恢复回答");
});

test("记忆模块抛错或超时后,Pi 的模型请求与关闭流程继续", async (t: TestContext) => {
  const h = await createPiHarness(t, { prepareDeadlineMs: 100, recallDeadlineMs: 100 });
  h.behavior.prepareThrows = true;
  h.behavior.currentThrows = true;

  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitFor(
    () => h.observation.some((e) => e.operation === "cue_preparation" && e.result === "failed"),
    "prepare 失败被记录",
  );
  assert.equal(h.requests.at(-1)?.label, "回答1", "current 抛错不影响普通请求");

  // recall 超时:工具结果不可用,回合继续到最终回答。
  h.behavior.currentThrows = false;
  h.behavior.prepareThrows = false;
  h.behavior.recallHangs = true;
  h.respond(() =>
    fauxAssistantMessage([fauxToolCall("recall_memory", { handle: "h:x:y" })], {
      stopReason: "toolUse",
    }),
  );
  h.respondText("超时后的最终回答");
  await h.session().prompt("触发超时找回");
  await waitFor(
    () => h.observation.some((e) => e.operation === "fact_recall" && e.result === "timed_out"),
    "recall 超时分类",
  );
  const branch = h.session().sessionManager.getBranch();
  const toolResult = branch.find((e) => e.type === "message" && e.message.role === "toolResult");
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult), /cannot be retrieved/);
  assert.equal(h.requests.at(-1)?.label, "超时后的最终回答", "超时后回合继续完成");

  // 记忆模块失败后,compaction、branch 导航与 session 切换仍可完成。
  h.behavior.recallHangs = false;
  h.respondText("失败隔离压缩摘要");
  h.respondText("失败隔离压缩摘要-备用");
  await h.session().compact();
  assert.equal(h.session().sessionManager.getBranch().at(-1)?.type, "compaction");

  const firstUser = h
    .session()
    .sessionManager.getBranch()
    .find((e) => e.type === "message" && e.message.role === "user");
  assert.ok(firstUser);
  h.respondText("失败隔离导航摘要");
  h.respondText("失败隔离导航摘要-备用");
  const nav = await h.session().navigateTree(firstUser.id, { summarize: true });
  assert.equal(nav.cancelled, false, "branch 导航仍可完成");

  const switched = await h.runtime.newSession();
  assert.equal(switched.cancelled, false, "session 切换仍可完成");

  await h.runtime.dispose();
});

test("Observation 失败后,Pi 的模型请求、找回与关闭流程继续", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitForCues(h);

  h.observationControl.throws = true;
  h.respond((context) => {
    const match = /\\"handle\\":\\"(h:[^\\"]+)\\"/.exec(JSON.stringify(context.messages));
    assert.ok(match);
    return fauxAssistantMessage([fauxToolCall("recall_memory", { handle: match[1] })], {
      stopReason: "toolUse",
    });
  });
  h.respondText("回答2");
  await h.session().prompt("问题2");
  assert.equal(h.requests[1].hasCues, true, "Observation 失败不影响线索注入");
  const toolResult = h
    .session()
    .sessionManager.getBranch()
    .find((e) => e.type === "message" && e.message.role === "toolResult");
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult), /问题1/, "Observation 失败不影响事实找回");

  await h.runtime.dispose();
});
