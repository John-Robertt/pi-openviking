import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_NO_PROXY,
  buildManagedServerEnv,
  parseManagedServerProxy,
} from "../shared/managed-server-env.mjs";

test("代理配置缺省时明确禁用代理并保留本地 NO_PROXY", () => {
  const proxy = parseManagedServerProxy("{}");
  assert.deepEqual(proxy, { http: "", https: "", noProxy: DEFAULT_NO_PROXY });

  const parent = {
    PATH: "/bin",
    HTTP_PROXY: "http://parent-http:8080",
    https_proxy: "http://parent-https:8080",
    All_Proxy: "http://parent-all:8080",
    no_proxy: "parent.local",
  };
  const env = buildManagedServerEnv(parent, proxy);

  assert.deepEqual(parent, {
    PATH: "/bin",
    HTTP_PROXY: "http://parent-http:8080",
    https_proxy: "http://parent-https:8080",
    All_Proxy: "http://parent-all:8080",
    no_proxy: "parent.local",
  });
  assert.deepEqual(env, { PATH: "/bin", NO_PROXY: DEFAULT_NO_PROXY });
});

test("显式 JSONC 配置只写入 OpenViking 子进程环境", () => {
  const proxy = parseManagedServerProxy(`{
    // 仅供受管 OpenViking 服务使用
    "managedServer": {
      "proxy": {
        "http": "http://127.0.0.1:7890",
        "https": "https://proxy.example:8443",
        "noProxy": "127.0.0.1,localhost,ollama.local",
      },
    },
  }`);
  const parent = { PATH: "/bin", http_proxy: "http://old:1", NO_PROXY: "old.local" };
  const env = buildManagedServerEnv(parent, proxy);

  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(env.HTTPS_PROXY, "https://proxy.example:8443");
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost,ollama.local");
  assert.equal("http_proxy" in env, false);
  assert.equal(parent.http_proxy, "http://old:1");
  assert.equal(parent.NO_PROXY, "old.local");
});

test("JSONC 尾逗号处理不修改字符串内容", () => {
  const proxy = parseManagedServerProxy(`{
    "managedServer": { "proxy": { "noProxy": "literal,}" } },
  }`);
  assert.equal(proxy.noProxy, "literal,}");
});

test("未配置 proxy 子对象时仍使用无代理默认值", () => {
  assert.deepEqual(parseManagedServerProxy('{"managedServer": {}}'), {
    http: "",
    https: "",
    noProxy: DEFAULT_NO_PROXY,
  });
});

test("拒绝 null 或其他非字符串代理值", () => {
  for (const field of ["http", "https"]) {
    assert.throws(
      () => parseManagedServerProxy(`{"managedServer":{"proxy":{"${field}":null}}}`),
      new RegExp(`proxy\\.${field} 必须是字符串`),
    );
  }
});

test("在 restart 前拒绝不能写入子进程环境的 NUL 字符", () => {
  const nul = String.fromCharCode(0);
  const http = JSON.stringify({ managedServer: { proxy: { http: `http://proxy${nul}.invalid` } } });
  const noProxy = JSON.stringify({ managedServer: { proxy: { noProxy: `localhost${nul}example` } } });
  assert.throws(() => parseManagedServerProxy(http), /包含无效字符/);
  assert.throws(() => parseManagedServerProxy(noProxy), /包含无效字符/);
});

test("拒绝未知字段和非 HTTP 代理 URL，且错误不回显凭证", () => {
  const unknownSecret = "secret-field";
  assert.throws(
    () => parseManagedServerProxy(`{"managedServer":{"proxy":{"${unknownSecret}":"x"}}}`),
    (error) => {
      assert.match(error.message, /包含未知字段/);
      assert.equal(error.message.includes(unknownSecret), false);
      return true;
    },
  );

  assert.throws(
    () => parseManagedServerProxy(`{"managedServer":{"${unknownSecret}":{}}}`),
    (error) => /managedServer 包含未知字段/.test(error.message) && !error.message.includes(unknownSecret),
  );

  const secret = "secret-password";
  assert.throws(
    () => parseManagedServerProxy(`{"managedServer":{"proxy":{"https":"socks5://user:${secret}@proxy:1080"}}}`),
    (error) => {
      assert.match(error.message, /仅支持 http:\/\/ 或 https:\/\//);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test("拒绝损坏的 JSONC，避免静默绕过代理配置", () => {
  assert.throws(() => parseManagedServerProxy('{"managedServer":'), /JSONC 格式无效/);
  assert.throws(
    () => parseManagedServerProxy('{"managedServer":{"proxy":{"http":"http://proxy:8080"}}}/*'),
    /JSONC 格式无效/,
  );
});
