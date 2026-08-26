import test from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../../src/config/index.ts";

test("未设置 PI_OPENVIKING_OBSERVE 时 observation 为 null", () => {
  assert.equal(resolveConfig({}).observation, null);
});

test("PI_OPENVIKING_OBSERVE 为空白时 observation 为 null", () => {
  assert.equal(resolveConfig({ PI_OPENVIKING_OBSERVE: "  " }).observation, null);
});

test("PI_OPENVIKING_OBSERVE 为路径时启用 observation", () => {
  assert.deepEqual(resolveConfig({ PI_OPENVIKING_OBSERVE: "/tmp/x.jsonl" }).observation, { file: "/tmp/x.jsonl" });
});
test("路径两端空白被去除", () => {
  assert.deepEqual(resolveConfig({ PI_OPENVIKING_OBSERVE: " /tmp/x.jsonl " }).observation, { file: "/tmp/x.jsonl" });
});

test("相对路径被拒绝（装配失败入口）", () => {
  assert.throws(() => resolveConfig({ PI_OPENVIKING_OBSERVE: "obs.jsonl" }), /absolute path/);
});
