import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChildEnv,
  buildDevServerConfig,
  createRunFiles,
  isDevServerProcess,
  piWrapperSource,
  verifyRunFiles,
} from "../scripts/dev.mjs";

const profile = {
  taskVlm: {
    provider: "test-provider",
    model: "test-model",
    apiBase: "https://example.test",
    credentialKind: "api_key",
    apiKeyEnv: "TEST_API_KEY",
  },
  embedding: { dense: { provider: "local", model: "test-embed", dimension: 128 } },
};

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ov-dev-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("buildDevServerConfig 使用 profile 字段且凭证为环境占位符", () => {
  const config = buildDevServerConfig(profile);
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(typeof config.server.port, "number");
  assert.equal(config.vlm.provider, "test-provider");
  assert.equal(config.vlm.model, "test-model");
  assert.equal(config.vlm.api_base, "https://example.test");
  assert.equal(config.vlm.api_key, "${TEST_API_KEY}");
  assert.equal(config.embedding.dense.provider, "local");
  assert.equal(config.embedding.dense.model, "test-embed");
  assert.equal(config.embedding.dense.dimension, 128);
  assert.ok(config.embedding.dense.cache_dir.includes("models"));
  assert.ok(config.storage.workspace.includes("data"));
});

test("createRunFiles/verifyRunFiles 往返一致", () => {
  withTmpDir((dir) => {
    createRunFiles(dir, { pid: 12345, config: buildDevServerConfig(profile) });
    const result = verifyRunFiles(dir);
    assert.equal(result.ok, true);
    assert.equal(result.state.pid, 12345);
    assert.ok(result.state.configFingerprint);
  });
});

test("verifyRunFiles 拒绝缺失、篡改和版本不符", () => {
  withTmpDir((dir) => {
    assert.equal(verifyRunFiles(dir).ok, false); // 无 marker

    createRunFiles(dir, { pid: 12345, config: {} });

    // 篡改 marker nonce
    writeFileSync(join(dir, "owner.marker"), `pi-openviking-dev\n${"0".repeat(32)}\n`);
    assert.equal(verifyRunFiles(dir).reason, "marker 与状态文件 nonce 不一致");

    // marker 格式非法
    writeFileSync(join(dir, "owner.marker"), "anything\n");
    assert.equal(verifyRunFiles(dir).reason, "owner.marker 内容不符合预期格式");

    // 状态版本不符
    writeFileSync(join(dir, "owner.marker"), `pi-openviking-dev\n${"1".repeat(32)}\n`);
    writeFileSync(
      join(dir, "server-state.json"),
      JSON.stringify({ version: "other", nonce: "1".repeat(32), pid: 1 }),
    );
    assert.equal(verifyRunFiles(dir).reason, "状态文件版本不匹配");
  });
});

test("isDevServerProcess 按命令行核对进程身份", () => {
  const conf = "/repo/.dev/runs/openviking/ov.conf";
  assert.equal(isDevServerProcess(`openviking-server --config ${conf} `, conf), true);
  assert.equal(isDevServerProcess("/usr/bin/python other.py", conf), false);
  assert.equal(isDevServerProcess(`openviking-server --config /other/ov.conf`, conf), false);
  assert.equal(isDevServerProcess(null, conf), true); // 平台无法核对时退化
});

test("verifyRunFiles 核对 expectedPid 与状态文件一致", () => {
  withTmpDir((dir) => {
    createRunFiles(dir, { pid: 12345, config: {} });
    assert.equal(verifyRunFiles(dir, { expectedPid: 12345 }).ok, true);
    assert.equal(verifyRunFiles(dir, { expectedPid: 999 }).reason, "状态文件 pid 与 server.pid 不一致");
  });
});

test("buildChildEnv 清除继承的 OPENVIKING_* 并应用显式值", () => {
  const base = {
    PATH: "/usr/bin",
    OPENVIKING_URL: "http://127.0.0.1:1933",
    OPENVIKING_API_KEY: "user-key",
    OPENVIKING_BASE_URL: "http://127.0.0.1:1933",
  };
  const env = buildChildEnv({ OPENVIKING_BASE_URL: "http://127.0.0.1:19331", OPENVIKING_ACCOUNT: "dev" }, base);
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OPENVIKING_URL, undefined);
  assert.equal(env.OPENVIKING_API_KEY, undefined);
  assert.equal(env.OPENVIKING_BASE_URL, "http://127.0.0.1:19331");
  assert.equal(env.OPENVIKING_ACCOUNT, "dev");
});

test("pi wrapper 相对路径指向仓库 index.ts", () => {
  assert.ok(piWrapperSource().includes('export { default } from "../../../../index.ts"'));
});
