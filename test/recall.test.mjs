import assert from "node:assert/strict";
import test from "node:test";

import { RecallManager } from "../recall.ts";
import { buildContextSearchBody } from "../shared/recall-core.mjs";

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
