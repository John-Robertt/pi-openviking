import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createManagedServerConfig } from "../shared/managed-server-config.mjs";

test("用户首次 setup 默认生成 Codex OAuth 的 gpt-5.6-luna VLM 配置", () => {
  const home = join("test-user", ".pi", "openviking");
  const config = createManagedServerConfig(home);

  assert.equal(config.storage.workspace, join(home, "data"));
  assert.deepEqual(config.vlm, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    temperature: 0.0,
    max_retries: 2,
  });
  assert.equal("api_key" in config.vlm, false);
  assert.equal("api_base" in config.vlm, false);
});
