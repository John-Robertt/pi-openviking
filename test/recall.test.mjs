import assert from "node:assert/strict";
import test from "node:test";

import { RecallManager } from "../recall.ts";

function manager(block) {
  const recall = new RecallManager({}, { minQueryLength: 3 }, () => null);
  recall.cache = { block, promptText: "query" };
  return recall;
}

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
