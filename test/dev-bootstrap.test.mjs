import assert from "node:assert/strict";
import { test } from "node:test";
import { isNodeVersionSupported, loadModelProfile, validateModelProfile } from "../scripts/dev.mjs";

test("提交的 dev/model-profile.json 通过校验", () => {
  // 只断言校验通过，不复制具体模型身份值（权威在 dev/model-profile.json）。
  const profile = loadModelProfile();
  assert.equal(typeof profile.taskVlm.provider, "string");
  assert.equal(typeof profile.embedding.dense.dimension, "number");
});

test("validateModelProfile 拒绝缺失或非法字段", () => {
  const valid = {
    taskVlm: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiBase: "https://api.deepseek.com",
      credentialKind: "api_key",
      apiKeyEnv: "DEEPSEEK_API_KEY",
    },
    embedding: { dense: { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: 512 } },
  };
  assert.deepEqual(validateModelProfile(valid), []);

  const noEnv = structuredClone(valid);
  delete noEnv.taskVlm.apiKeyEnv;
  assert.ok(validateModelProfile(noEnv).some((p) => p.includes("apiKeyEnv")));

  const oauth = structuredClone(valid);
  oauth.taskVlm.credentialKind = "oauth";
  assert.ok(validateModelProfile(oauth).some((p) => p.includes("credentialKind")));

  const badDim = structuredClone(valid);
  badDim.embedding.dense.dimension = "512";
  assert.ok(validateModelProfile(badDim).some((p) => p.includes("dimension")));

  assert.ok(validateModelProfile({}).length > 0);
  assert.ok(validateModelProfile(null).length > 0);
});

test("isNodeVersionSupported 按 engines 下限比较", () => {
  assert.equal(isNodeVersionSupported("v22.19.0", ">=22.19.0"), true);
  assert.equal(isNodeVersionSupported("v22.18.9", ">=22.19.0"), false);
  assert.equal(isNodeVersionSupported("v24.0.0", ">=22.19.0"), true);
  assert.equal(isNodeVersionSupported("v22.19.0", "^22.19.0"), false);
});
