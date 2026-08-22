import assert from "node:assert/strict";
import test from "node:test";

import { RecallManager } from "../recall.ts";
import { buildContextSearchBody, buildRecallBlock } from "../shared/recall-core.mjs";

function manager(block) {
  const recall = new RecallManager({}, { minQueryLength: 3 }, () => null);
  recall.cache = { block, promptText: "query" };
  return recall;
}

test("context search 使用配置的召回 token 预算", () => {
  assert.equal(buildContextSearchBody({ recallTokenBudget: 200 }).max_tokens, 200);
  assert.equal(buildContextSearchBody({ recallTokenBudget: 32_000 }).max_tokens, 32_000);
});

test("recall 只在实际修改 provider messages 时返回 injectedBlock", () => {
  const block = '<openviking-context source="recall">remembered</openviking-context>';
  const recall = manager(block);
  const messages = [{ role: "user", content: "current request", timestamp: 1 }];
  const result = recall.injectRecall(messages);
  assert.equal(result.injectedBlock, block);
  assert.match(result.messages[0].content, /^<openviking-context/);

  const alreadyInjected = recall.injectRecall([{ role: "user", content: result.messages[0].content }]);
  assert.equal(alreadyInjected.injectedBlock, null);

  const imageOnly = recall.injectRecall([{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }]);
  assert.equal(imageOnly.injectedBlock, null);
});

test("server assembled recall 过滤内部 namespace 后才形成 provider block", async () => {
  const records = [];
  const block = await buildRecallBlock(async (path) => {
    assert.equal(path, "/api/v1/search/search");
    return {
      ok: true,
      result: {
        rendered: "unsafe rendered aggregate",
        digest: "unsafe digest aggregate",
        entries: [
          { uri: "viking://user/dev/resources/project/readme.md", category: "resources", score: 0.9, text: "visible project fact" },
          { uri: "viking://user/dev/resources/.pi-openviking/recorded-events/v1/private", category: "resources", score: 0.99, text: "internal feedback" },
        ],
        stats: {},
      },
    };
  }, { recallTokenBudget: 2000 }, "project fact", {
    observation: { emit: (...values) => records.push(values) },
  });
  assert.match(block, /visible project fact/);
  assert.doesNotMatch(block, /internal feedback|\.pi-openviking|unsafe digest/);
  assert.ok(records.some(([stage, branch, accepted, rejected]) =>
    stage === "recall_filter" && branch === "filter_internal" && accepted === 1 && rejected === 1));
});

test("只有内部来源的 recall 不进入 provider context", async () => {
  const block = await buildRecallBlock(async () => ({
    ok: true,
    result: {
      rendered: "internal rendered aggregate",
      entries: [{
        uri: "viking://user/dev/resources/.pi-openviking/archives/v1/private",
        category: "resources",
        score: 1,
        text: "private archive feedback",
      }],
      stats: {},
    },
  }), { recallTokenBudget: 2000 }, "archive", { observation: { emit() {} } });
  assert.equal(block, null);
});

test("全部来源安全时仍由 entries 重建，不信任额外聚合正文或内部引用", async () => {
  const safeUri = "viking://user/dev/resources/project/notes.md";
  const block = await buildRecallBlock(async () => ({
    ok: true,
    result: {
      rendered: "unproven aggregate viking://user/dev/resources/.pi-openviking/private",
      digest: "unproven digest",
      entries: [{
        uri: safeUri,
        category: "resources",
        score: 0.8,
        text: "See viking://user/dev/resources/.pi-openviking/recorded-events/private",
      }],
      stats: {},
    },
  }), { recallTokenBudget: 2000 }, "project notes", { observation: { emit() {} } });
  assert.match(block, new RegExp(safeUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(block, /unproven|\.pi-openviking/);
});
