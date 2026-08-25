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

test("OVClient 严格传输 Content、filesystem 与 Resource API", async () => {
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
    if (request.url === "/api/v1/resources") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", result: { root_uri: "viking://resources/imported" } }));
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
    assert.deepEqual(
      await client.addResource("https://example.test", { reason: "current project source" }),
      { root_uri: "viking://resources/imported" },
    );
    const resourceRequest = requests.find((request) => request.url === "/api/v1/resources");
    assert.deepEqual(JSON.parse(resourceRequest.body), {
      path: "https://example.test", reason: "current project source",
    });
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

test("未配置用户时只按服务端身份解析 space，不枚举 viking://user", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/api/v1/system/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", result: { user: "resolved-user" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", result: [{ name: "someone-else", isDir: true }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  const client = new OVClient({ ...config(endpoint), user: "" });
  try {
    assert.equal(await client.resolveUserSpace(), "resolved-user");
    // 枚举 viking://user 会看到其他用户的 space；解析身份不得依赖它。
    assert.deepEqual(requests, ["/api/v1/system/status"]);
    assert.equal(client.memorySpace, "");
    client.bindUser("resolved-user");
    assert.equal(client.memorySpace, "resolved-user");
    assert.equal(client.userRoot, "viking://user/resolved-user");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("服务端未给出身份时回落到 default", async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", result: {} }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new OVClient({ ...config(`http://127.0.0.1:${server.address().port}`), user: "" });
  try {
    assert.equal(await client.resolveUserSpace(), "default");
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("OVClient 严格传输 checkpoint Session/Task 生命周期", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    const result = request.url.includes("/tasks?") ? []
      : request.url.endsWith("/commit") ? { task_id: "provider-task" }
        : request.url.endsWith("/context?token_budget=123") ? { latest_archive_overview: "ready" }
          : {};
    response.end(JSON.stringify({ status: "ok", result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new OVClient(config(`http://127.0.0.1:${server.address().port}`));
  try {
    assert.equal(await client.createSession("task/id"), true);
    assert.equal((await client.getSession("task/id")).ok, true);
    assert.equal(await client.addMessage("task/id", "user", "input"), true);
    assert.equal((await client.commitSession("task/id")).result.task_id, "provider-task");
    assert.deepEqual((await client.listTasks("task/id")).result, []);
    assert.equal((await client.getTask("provider/id")).ok, true);
    assert.equal((await client.getSessionContext("task/id", 123)).result.latest_archive_overview, "ready");
    assert.equal((await client.deleteSession("task/id")).ok, true);
    assert.ok(requests.some((item) => item.method === "GET" && item.url === "/api/v1/sessions/task%2Fid"));
    assert.ok(requests.some((item) => item.method === "POST" && item.url === "/api/v1/sessions/task%2Fid/commit" && JSON.parse(item.body).keep_recent_count === 0));
    assert.ok(requests.some((item) => item.url === "/api/v1/tasks?task_type=session_commit&resource_id=task%2Fid&limit=20"));
    assert.ok(requests.some((item) => item.method === "DELETE" && item.url === "/api/v1/sessions/task%2Fid"));
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
