/**
 * 真实 Pi 检查:getBranch 祖先语义、来源事实过滤与 fork 的 session 边界。
 * 对应 docs/modules/pi-boundary.md「真实 Pi 检查」相关条目。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createPiHarness, waitFor, waitForCues } from "./harness.ts";

test("getBranch 在追加、compaction、导航与 reopen 后保持完整祖先路径", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1,补充内容让上下文增长 padding padding");
  await h.session().prompt("问题1,补充内容 padding padding padding");
  h.respondText("回答2,补充内容让上下文增长 padding padding");
  await h.session().prompt("问题2,补充内容 padding padding padding");

  const sm = () => h.session().sessionManager;
  const ids = () => sm().getBranch().map((e) => e.id);

  // 同一 branch 追加:路径增长,顺序为根到叶,叶是最后一条。
  const afterTwo = ids();
  const firstUser = sm().getBranch().find((e) => e.type === "message" && e.message.role === "user");
  assert.ok(firstUser);
  assert.equal(sm().getBranch().at(-1)?.id, sm().getLeafId());
  assert.ok(afterTwo.indexOf(firstUser.id) < afterTwo.length - 1);

  // compaction:旧 entry 全部保留在祖先路径,compaction entry 追加在尾部。
  h.respondText("压缩摘要");
  h.respondText("压缩摘要-备用");
  await h.session().compact();
  const afterCompact = ids();
  assert.ok(afterTwo.every((id) => afterCompact.includes(id)), "compaction 不删除旧 entry");
  assert.equal(sm().getBranch().at(-1)?.type, "compaction");

  // 带 summary 的 branch 导航:branch_summary 进入新路径,被放弃路径离开当前路径。
  h.respondText("分支摘要");
  h.respondText("分支摘要-备用");
  const abandonedIds = afterCompact.filter((id) => id !== firstUser.id && afterCompact.indexOf(id) > afterCompact.indexOf(firstUser.id));
  const nav = await h.session().navigateTree(firstUser.id, { summarize: true });
  assert.equal(nav.cancelled, false);
  const afterNav = sm().getBranch();
  const summaryEntry = afterNav.find((e) => e.type === "branch_summary");
  assert.ok(summaryEntry, "新路径包含 branch_summary entry");
  assert.equal(afterNav.at(-1)?.id, summaryEntry.id, "branch_summary 追加在新路径尾部");
  assert.equal(afterNav.some((e) => e.id === summaryEntry.fromId), false, "fromId 不在当前路径");
  for (const id of abandonedIds) {
    assert.equal(afterNav.some((e) => e.id === id), false, "被放弃路径不在当前祖先路径");
  }
  assert.ok(h.sessionLog.some((l) => l.startsWith("session_before_tree")));
  assert.ok(h.sessionLog.some((l) => l.startsWith("session_tree")));

  // reopen(切走再切回同一 session 文件):session ID 与路径恢复。
  const file = sm().getSessionFile();
  assert.ok(file);
  const sessionIdBefore = sm().getSessionId();
  const branchBefore = ids();
  await h.runtime.newSession();
  assert.notEqual(h.session().sessionManager.getSessionId(), sessionIdBefore);
  await h.runtime.switchSession(file);
  assert.equal(sm().getSessionId(), sessionIdBefore, "reopen 恢复 session ID");
  assert.deepEqual(ids(), branchBefore, "reopen 恢复当前路径");
});

test("compaction、branch summary 与扩展写入的 custom entry 不作为来源事实交付", async (t: TestContext) => {
  const h = await createPiHarness(t);
  for (let i = 1; i <= 3; i += 1) {
    h.respondText(`回答${i} 内容内容内容内容内容`);
    await h.session().prompt(`问题${i} 内容内容内容内容内容`);
  }

  const sm = h.session().sessionManager;
  const firstUser = sm.getBranch().find((e) => e.type === "message" && e.message.role === "user");
  assert.ok(firstUser);
  h.respondText("分支摘要");
  h.respondText("分支摘要-备用");
  await h.session().navigateTree(firstUser.id, { summarize: true });

  // 导航后先追加内容再压缩:compaction 与 branch summary 才同在当前路径。
  h.respondText("导航后回答1 内容内容内容内容内容");
  await h.session().prompt("导航后问题1 内容内容内容内容内容");
  h.respondText("导航后回答2 内容内容内容内容内容");
  await h.session().prompt("导航后问题2 内容内容内容内容内容");
  h.respondText("压缩摘要");
  h.respondText("压缩摘要-备用");
  h.respondText("压缩摘要-备用2");
  await h.session().compact();
  h.piApi.current?.appendEntry("extension-test-state", { marker: true });

  // 触发一次新的准备,读取它收到的 facts。
  const prepareBefore = h.current.cueProvider.prepareCalls.length;
  h.respondText("触发准备的回答");
  await h.session().prompt("触发准备的问题");
  await waitFor(
    () => h.current.cueProvider.prepareCalls.length > prepareBefore,
    "新的线索准备",
  );

  const branch = sm.getBranch();
  const compactionId = branch.find((e) => e.type === "compaction")?.id;
  const summaryId = branch.find((e) => e.type === "branch_summary")?.id;
  const customId = branch.find((e) => e.type === "custom")?.id;
  assert.ok(compactionId && summaryId && customId, "三类 entry 都在当前路径");

  const call = h.current.cueProvider.prepareCalls.at(-1)!;
  // 它们在范围内(可见),但不是来源事实。
  for (const id of [compactionId, summaryId, customId]) {
    assert.equal(call.scope.visibleEntryIds.has(id), true, `${id} 在当前路径可见`);
    assert.equal(await call.facts.readById(id), undefined, `${id} 不作为来源事实交付`);
  }
  const page = await call.facts.readSequential(undefined, { characters: 1_000_000 });
  assert.ok(page.facts.length > 0);
  assert.ok(
    page.facts.every((fact) => ![compactionId, summaryId, customId].includes(fact.entryId)),
    "顺序读取不含摘要与扩展 entry",
  );
});

test("fork 产生新 session ID;复制的 entry ID 不能沿用旧 session 的 handle", async (t: TestContext) => {
  const h = await createPiHarness(t);
  h.respondText("回答1");
  await h.session().prompt("问题1");
  await waitForCues(h);

  const sm = () => h.session().sessionManager;
  const oldSessionId = sm().getSessionId();
  const firstUser = sm().getBranch().find((e) => e.type === "message" && e.message.role === "user");
  assert.ok(firstUser);

  const fork = await h.runtime.fork(firstUser.id, { position: "at" });
  assert.equal(fork.cancelled, false);
  const newSessionId = sm().getSessionId();
  assert.notEqual(newSessionId, oldSessionId, "fork 产生新 session ID");
  const forkedIds = sm().getBranch().map((e) => e.id);
  assert.ok(forkedIds.includes(firstUser.id), "fork 复制了原 entry ID");

  // 用旧 session 的 handle 找回:范围不含旧 session,结果不是 found。
  h.respondToolCall("recall_memory", { handle: `h:${oldSessionId}:${firstUser.id}` });
  h.respondText("结束");
  await h.session().prompt("尝试用旧 handle 找回");

  const toolResult = sm()
    .getBranch()
    .find((e) => e.type === "message" && e.message.role === "toolResult");
  assert.ok(toolResult);
  assert.match(JSON.stringify(toolResult), /No fact/, "旧 session 的 handle 不能找回");
  assert.ok(
    !JSON.stringify(toolResult).includes("问题1"),
    "旧 session 的事实正文不能进入新 session",
  );
  const recall = h.observation.findLast((e) => e.operation === "fact_recall");
  assert.equal(recall?.result, "not_found");
});
