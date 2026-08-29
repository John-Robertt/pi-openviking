/**
 * 真实 Pi 检查:context 注入的可见性、持久化边界与 compaction 隔离。
 * 对应 docs/modules/pi-boundary.md「真实 Pi 检查」相关条目。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createPiHarness, waitForCues } from "./harness.ts";

test("context 注入对 provider 可见、不写入 session,并覆盖工具完成后的后续请求", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1");
  await h.session().prompt("问题1:调查认证模块");
  await waitForCues(h);
  assert.equal(h.requests[0].hasCues, false, "第一个请求发生时还没有线索");

  // 第二轮:provider 从注入的线索中取出 handle 并调用 recall_memory。
  h.respond((context) => {
    const match = /\\"handle\\":\\"(h:[^\\"]+)\\"/.exec(JSON.stringify(context.messages));
    assert.ok(match, "注入的线索消息应包含 recall handle");
    return fauxAssistantMessage([fauxToolCall("recall_memory", { handle: match[1] })], {
      stopReason: "toolUse",
    });
  });
  h.respondText("最终回答");
  await h.session().prompt("问题2:继续");

  assert.equal(h.requests[1].hasCues, true, "普通请求带注入线索");
  assert.equal(h.requests[2].hasCues, true, "工具完成后的后续请求也带注入线索");

  // 工具结果包含完整事实正文。
  const toolResult = h
    .session()
    .sessionManager.getBranch()
    .find(
      (e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "recall_memory",
    );
  assert.ok(toolResult, "session 中有 recall_memory 的工具结果");
  assert.match(JSON.stringify(toolResult), /问题1:调查认证模块/);

  // 注入是临时的:session 中没有线索消息落盘。
  const persisted = h.session().sessionManager.getEntries();
  assert.equal(
    persisted.some(
      (e) =>
        (e.type === "custom_message" || e.type === "message") &&
        JSON.stringify(e).includes("<memory-cues>"),
    ),
    false,
    "Memory Cues 不写入 session",
  );

  const recall = h.observation.find((e) => e.operation === "fact_recall");
  assert.equal(recall?.result, "success");
});

test("compaction 摘要请求不接收 Memory Cues 注入,compaction 后注入恢复", async (t: TestContext) => {
  const h = await createPiHarness(t);
  for (let i = 1; i <= 4; i += 1) {
    h.respondText(`回答${i},补充一些内容让上下文增长。`);
    await h.session().prompt(`问题${i}:带有足够长度的内容 padding padding padding`);
  }
  await waitForCues(h);

  h.respondText("COMPACT-摘要-1");
  h.respondText("COMPACT-摘要-2");
  h.respondText("COMPACT-摘要-3");
  const result = await h.session().compact();
  assert.match(result.summary, /COMPACT-摘要/);

  const compactionRequests = h.requests.filter((r) => r.label?.startsWith("COMPACT-摘要"));
  assert.ok(compactionRequests.length >= 1, "compaction 至少产生一次摘要请求");
  for (const request of compactionRequests) {
    assert.equal(request.hasCues, false, "compaction 摘要请求不接收线索注入");
  }

  const branch = h.session().sessionManager.getBranch();
  assert.equal(branch.at(-1)?.type, "compaction", "compaction entry 追加在当前路径尾部");

  h.respondText("压缩后的回答");
  await h.session().prompt("压缩后的问题");
  assert.equal(h.requests.at(-1)?.hasCues, true, "compaction 后普通请求恢复注入");
});
