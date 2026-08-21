import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EXTENSION_CONFIG_DEFAULTS, validateExtensionConfig } from "../shared/config-schema.mjs";
import { parseJsoncObject } from "../shared/jsonc.mjs";

test("出厂 config.json 与唯一目标 schema 一致", async () => {
  const file = JSON.parse(await readFile("config.json", "utf8"));
  assert.deepEqual(validateExtensionConfig(file), EXTENSION_CONFIG_DEFAULTS);
});

test("配置拒绝未知字段并返回完整路径", () => {
  assert.throws(() => validateExtensionConfig({ takeover: { foo: true } }), /takeover\.foo/);
  assert.throws(() => validateExtensionConfig({ archive: { chunkTokenBudget: "20000" } }), /archive\.chunkTokenBudget/);
  assert.throws(() => validateExtensionConfig({ managedServer: { proxy: { token: "secret" } } }), /managedServer\.proxy\.token/);
  assert.throws(() => validateExtensionConfig({ unexpected: true }), /unexpected/);
});

test("召回 token 预算与 OpenViking Context API 上限一致", () => {
  assert.equal(validateExtensionConfig({ recallTokenBudget: 32_000 }).recallTokenBudget, 32_000);
  assert.throws(() => validateExtensionConfig({ recallTokenBudget: 32_001 }), /recallTokenBudget/);
});

test("JSONC 损坏不会静默回退，注释与尾逗号保持字符串内容", () => {
  const parsed = parseJsoncObject(`{
    // comment
    "bypassPatterns": ["https://example.test/a,//b",],
  }`, "test.jsonc");
  assert.deepEqual(parsed, { bypassPatterns: ["https://example.test/a,//b"] });
  assert.throws(() => parseJsoncObject('{ "enabled": ', "broken.jsonc"), /broken\.jsonc: JSONC 格式无效/);
});
