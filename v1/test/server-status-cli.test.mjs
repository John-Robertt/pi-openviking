import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { createManagedServerState } from "../shared/managed-server-state.mjs";


test("status 对旧服务降级标记，并在当前代理损坏时保留运行快照", { skip: process.platform === "win32" }, async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ healthy: true, version: "test", auth_mode: "dev" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const home = mkdtempSync(join(process.cwd(), ".test-server-status-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const ovHome = join(home, ".pi", "openviking");
  mkdirSync(ovHome, { recursive: true });
  const { port } = server.address();
  const config = {
    storage: { workspace: "/test/data" },
    server: { host: "127.0.0.1", port },
    embedding: { dense: { provider: "local", model: "embed-old", dimension: 512 } },
    vlm: { provider: "openai", model: "vlm-old", api_key: "vlm-secret" },
  };
  const proxy = { http: "http://user:proxy-secret@proxy.test:8080", https: "", noProxy: "127.0.0.1" };
  writeFileSync(join(ovHome, "ov.conf"), JSON.stringify(config));
  writeFileSync(join(ovHome, "server.pid"), String(process.pid));
  writeFileSync(join(home, ".pi", "pi-openviking.jsonc"), JSON.stringify({ managedServer: { proxy } }));

  const runStatus = () => new Promise((resolve) => {
    execFile(
      process.execPath,
      [join(process.cwd(), "scripts", "cli.mjs"), "server", "status"],
      { env: { ...process.env, HOME: home, USERPROFILE: home } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });

  const legacy = await runStatus();
  assert.equal(legacy.code, 1);
  assert.match(legacy.stdout, /health:\s+PROBE OK/);
  assert.match(legacy.stdout, /当前配置地址探测；与受管进程的关联未确认/);
  assert.match(legacy.stdout, /当前配置；运行态未确认/);

  const state = createManagedServerState({ pid: process.pid, config, proxy });
  writeFileSync(join(ovHome, "server-state.json"), JSON.stringify(state));
  writeFileSync(join(home, ".pi", "pi-openviking.jsonc"), "{broken");
  const invalidProxy = await runStatus();
  assert.equal(invalidProxy.code, 0);
  assert.match(invalidProxy.stdout, /proxy:\s+HTTP enabled（已注入；当前配置无效，需修复并重启/);
  assert.equal(invalidProxy.stdout.includes("proxy-secret"), false);

  writeFileSync(join(ovHome, "ov.conf"), '{"vlm":{"api_key":"config-parse-secret"},BROKEN');
  const invalidConfig = await runStatus();
  assert.equal(invalidConfig.code, 0);
  assert.match(invalidConfig.stdout, /config:\s+INVALID \(.+ov\.conf: JSON 格式无效\)/);
  assert.equal(invalidConfig.stdout.includes("config-parse-secret"), false);
});
