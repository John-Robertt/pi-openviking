import assert from "node:assert/strict";
import test from "node:test";
import {
  configFingerprint,
  createManagedServerState,
  parseManagedServerState,
  proxyFingerprint,
  summarizeServerConfig,
} from "../shared/managed-server-state.mjs";

const config = {
  storage: { workspace: "/data/openviking" },
  server: { host: "0.0.0.0", port: 1933, root_api_key: "server-secret" },
  embedding: {
    dense: {
      provider: "local",
      model: "bge-small-zh-v1.5-f16",
      dimension: 512,
      api_key: "embedding-secret",
    },
  },
  vlm: {
    provider: "openai",
    model: "gpt-test",
    api_key: "vlm-secret",
    api_base: "https://user:pass@example.test/private?token=secret",
  },
};

const proxy = {
  http: "http://proxy-user:proxy-secret@proxy.test:8080",
  https: "https://proxy-user:proxy-secret@proxy.test:8443",
  noProxy: "127.0.0.1,localhost",
};

test("服务端配置摘要仅保留状态展示所需字段", () => {
  assert.deepEqual(summarizeServerConfig(config), {
    endpoint: "http://127.0.0.1:1933",
    embedding: { provider: "local", model: "bge-small-zh-v1.5-f16", dimension: "512" },
    vlm: { provider: "openai", model: "gpt-test", credential: "API key configured" },
    storage: "/data/openviking",
  });
});

test("运行状态快照不持久化服务端或代理凭证", () => {
  const state = createManagedServerState({
    pid: 123,
    startedAt: "2026-08-17T06:04:15.000Z",
    config,
    proxy,
  });
  const serialized = JSON.stringify(state);

  assert.equal(serialized.includes("server-secret"), false);
  assert.equal(serialized.includes("embedding-secret"), false);
  assert.equal(serialized.includes("vlm-secret"), false);
  assert.equal(serialized.includes("proxy-secret"), false);
  assert.deepEqual(state.proxy, { http: true, https: true });
  assert.equal(parseManagedServerState(serialized)?.pid, 123);
});

test("配置指纹忽略 JSON 对象顺序但检测语义变化", () => {
  const reordered = {
    vlm: { api_base: config.vlm.api_base, api_key: config.vlm.api_key, model: "gpt-test", provider: "openai" },
    embedding: config.embedding,
    server: { root_api_key: "server-secret", port: 1933, host: "0.0.0.0" },
    storage: config.storage,
  };
  assert.equal(configFingerprint(reordered), configFingerprint(config));
  assert.notEqual(configFingerprint({ ...config, vlm: { ...config.vlm, model: "gpt-new" } }), configFingerprint(config));
});

test("代理指纹检测完整代理配置但快照只保留启用状态", () => {
  assert.equal(proxyFingerprint({ ...proxy }), proxyFingerprint(proxy));
  assert.notEqual(proxyFingerprint({ ...proxy, noProxy: "localhost" }), proxyFingerprint(proxy));
});

test("损坏或不兼容的运行状态快照安全降级", () => {
  assert.equal(parseManagedServerState("not json"), null);
  assert.equal(parseManagedServerState('{"version":2,"pid":123}'), null);
  assert.equal(parseManagedServerState('{"version":1,"pid":0}'), null);
});
