import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { OVClient } from "../client.ts";

function config(endpoint) {
  return {
    endpoint,
    apiKey: "",
    account: "",
    user: "default",
    peerId: "",
    userAgent: "test",
  };
}

test("OVClient 严格传输 batch-write、stat、mkdir 和 raw download", async () => {
  const requests = [];
  let healthy = false;
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(body).toString("utf8") });

    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", result: { healthy } }));
      return;
    }
    if (request.url.startsWith("/api/v1/content/download")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0, 1, 2, 255]));
      return;
    }
    if (request.url.startsWith("/api/v1/fs/stat")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "error", error: { code: "NOT_FOUND" } }));
      return;
    }
    if (request.url === "/api/v1/fs/mkdir") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", result: { uri: "created" } }));
      return;
    }
    if (request.url === "/api/v1/content/batch-write") {
      const parsed = JSON.parse(Buffer.concat(body).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        status: "ok",
        result: {
          root_uri: parsed.root_uri,
          created: parsed.operations.map((operation) => operation.uri),
          updated: [],
          unchanged: [],
          queue_status: null,
        },
      }));
      return;
    }
    if (request.url === "/slow") return;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "error" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const client = new OVClient(config(`http://127.0.0.1:${address.port}`));
  try {
    assert.equal(await client.health(), false);
    healthy = true;
    assert.equal(await client.health(), true);
    const batch = await client.batchWrite({
      root_uri: "root",
      operations: [{ uri: "root/.event.json", content_base64: "e30=", precondition: { kind: "create_if_absent" } }],
      wait: false,
    });
    assert.equal(batch.ok, true);
    assert.deepEqual(batch.result.created, ["root/.event.json"]);
    assert.deepEqual(await client.statUri("missing"), { ok: true, exists: false, isDir: false, status: 404 });
    assert.equal((await client.mkdirUri("created")).ok, true);
    assert.deepEqual((await client.downloadBytes("binary")).bytes, Buffer.from([0, 1, 2, 255]));
    const batchRequest = requests.find((request) => request.url === "/api/v1/content/batch-write");
    assert.equal(JSON.parse(batchRequest.body).wait, false);

    const startedAt = Date.now();
    const slowRequest = client.fetchJSON("/slow", undefined, 30000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await client.close(true);
    assert.equal((await slowRequest).ok, false);
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
