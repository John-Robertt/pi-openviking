import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { probeServerHealth } from "../shared/server-health.mjs";

test("健康检查只接受 2xx 且 healthy=true 的结构化响应", async (t) => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/ok/health") {
      res.end(JSON.stringify({ status: "ok", healthy: true, version: "1.2.3", auth_mode: "dev" }));
    } else if (req.url === "/unhealthy/health") {
      res.end(JSON.stringify({ status: "error", healthy: false }));
    } else if (req.url === "/not-found/health") {
      res.statusCode = 404;
      res.end(JSON.stringify({ healthy: true }));
    } else if (req.url === "/large/health") {
      res.end(JSON.stringify({ healthy: true, padding: "x".repeat(70 * 1024) }));
    } else if (req.url === "/trickle/health") {
      res.write('{"healthy":');
      const timer = setInterval(() => res.write(" "), 10);
      res.on("close", () => clearInterval(timer));
    } else {
      res.end("not json");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}`;

  assert.deepEqual(await probeServerHealth(`${endpoint}/ok`), {
    ok: true,
    statusCode: 200,
    data: { status: "ok", healthy: true, version: "1.2.3", auth_mode: "dev" },
  });
  assert.equal((await probeServerHealth(`${endpoint}/unhealthy`)).ok, false);
  assert.equal((await probeServerHealth(`${endpoint}/not-found`)).ok, false);
  assert.equal((await probeServerHealth(`${endpoint}/malformed`)).ok, false);
  assert.equal((await probeServerHealth(`${endpoint}/large`)).ok, false);
  const startedAt = Date.now();
  assert.equal((await probeServerHealth(`${endpoint}/trickle`, { timeoutMs: 50 })).ok, false);
  assert.ok(Date.now() - startedAt < 500, "持续响应也必须受绝对超时限制");
});
