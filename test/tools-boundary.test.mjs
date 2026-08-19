// session-scoped 模式下 viking_* 工具的命名空间边界。
//
// 覆盖 AGENTS.md 的保证：所有接收或返回 viking:// URI 的工具执行都绑定用户与会话
// 边界校验。用真实 registerTools 与 OVClient 对本地服务器执行，断言工具的判定结果
// 和它实际发出的请求——破坏性操作必须在越界时不发出请求。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { OVClient } from "../client.ts";
import { registerTools, VIKING_TOOL_NAMES } from "../tools.ts";

const MY_USER = "dev--pi-MY";
const MY_ROOT = `viking://user/${MY_USER}`;
const OUTSIDE = "viking://user/dev--pi-OTHER/memories/secret.md";

/** 桩服务器故意忽略 target_uri 并返回越界命中，用于验证扩展自身的核验。 */
async function harness({ sessionScopedMemory = true, sync = { sessionId: "pi-x" } } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      path: req.url.split("?")[0],
      query: decodeURIComponent(req.url.split("?")[1] || ""),
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });
    const json = (payload) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/health") return json({ status: "ok", result: { healthy: true } });
    if (req.url === "/api/v1/search/find") {
      return json({
        status: "ok",
        result: { memories: [{ uri: OUTSIDE, score: 0.95, abstract: "另一会话的记忆" }], resources: [], skills: [], total: 1 },
      });
    }
    if (req.url.startsWith("/api/v1/content/")) return json({ status: "ok", result: "content body" });
    return json({ status: "ok", result: {} });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const client = new OVClient({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    apiKey: "", account: "dev", user: MY_USER, peerId: "", userAgent: "test",
    sessionScopedMemory, recallMaxContentChars: 500,
  });
  await client.health();

  const tools = new Map();
  registerTools({ registerTool: (tool) => tools.set(tool.name, tool) }, client, sync);

  const run = async (name, params) => {
    requests.length = 0;
    const result = await tools.get(name).execute("id", params, new AbortController().signal, () => {}, {});
    return { text: result.content?.[0]?.text ?? "", requests: [...requests] };
  };
  const close = async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  };
  return { run, close, tools };
}

test("注册的工具集合与系统提示引用的名称一致", async () => {
  const { tools, close } = await harness();
  try {
    assert.deepEqual([...tools.keys()], [...VIKING_TOOL_NAMES]);
  } finally {
    await close();
  }
});

test("越界删除在发出请求前被拒绝：URI 直接指定与搜索命中两条路径", async () => {
  const { run, close } = await harness();
  try {
    const byUri = await run("viking_forget", { uri: OUTSIDE });
    assert.match(byUri.text, /^Refused:/);
    assert.deepEqual(byUri.requests, [], "越界 URI 不得发出任何请求");

    const byQuery = await run("viking_forget", { query: "别人的秘密" });
    assert.match(byQuery.text, /^Refused:/);
    // 搜索限定在绑定根内；服务端仍返回越界命中时，删除前的复核必须拦住它。
    assert.equal(byQuery.requests.length, 1);
    assert.equal(byQuery.requests[0].path, "/api/v1/search/find");
    assert.equal(byQuery.requests[0].body.target_uri, MY_ROOT);
    assert.ok(
      !byQuery.requests.some((request) => request.method === "DELETE"),
      "越界命中不得发出 DELETE",
    );
  } finally {
    await close();
  }
});

test("搜索范围夹回绑定根，且越界结果不返回给模型", async () => {
  const { run, close } = await harness();
  try {
    // 前缀相同但属于另一命名空间的 scope 不得被当作合法子路径。
    const result = await run("viking_search", { query: "x", scope: `${MY_ROOT}-EVIL/memories` });
    assert.equal(result.requests[0].body.target_uri, MY_ROOT);
    assert.equal(result.text, "No results found.", "服务端返回的越界命中必须被过滤");
  } finally {
    await close();
  }
});

test("越界读取与浏览被拒绝，绑定根内放行", async () => {
  const { run, close } = await harness();
  try {
    assert.match((await run("viking_read", { uri: OUTSIDE, level: "full" })).text, /^Refused:/);
    assert.match((await run("viking_browse", { action: "list", uri: "viking://" })).text, /^Refused:/);

    const inside = await run("viking_browse", { action: "list" });
    assert.equal(inside.requests[0].query, `uri=${MY_ROOT}`, "未指定 URI 时浏览绑定根");
  } finally {
    await close();
  }
});

test("Archive 展开只接受本会话命名空间内的合法 archiveId", async () => {
  const expansions = [];
  const { run, close } = await harness({
    sync: {
      sessionId: "pi-x",
      async expandArchive(archiveId) {
        expansions.push(archiveId);
        return {
          manifest: {
            archiveId,
            eventCount: 1,
            firstEventId: `evt_${"1".repeat(64)}`,
            lastEventId: `evt_${"1".repeat(64)}`,
            contentHash: `sha256:${"2".repeat(64)}`,
          },
          events: [{ payload: { entry: { id: "entry-0" } } }],
        };
      },
    },
  });
  try {
    for (const rejected of ["", "pi-someone-else", "../user/dev--pi-OTHER/memories", `arc_${"z".repeat(64)}`]) {
      const result = await run("viking_archive_expand", { archive_id: rejected });
      assert.match(result.text, /^Refused:/);
      assert.deepEqual(result.requests, [], "形状非法的 archiveId 不得发出请求");
    }
    assert.deepEqual(expansions, [], "拒绝路径不得触达 Archive 存储");

    const own = await run("viking_archive_expand", { archive_id: `arc_${"a".repeat(64)}` });
    assert.match(own.text, new RegExp(`^archive arc_a{64}\\nevents 1 `));
    assert.deepEqual(expansions, [`arc_${"a".repeat(64)}`]);
  } finally {
    await close();
  }
});

test("关闭 session 隔离时不施加命名空间边界", async () => {
  const { run, close } = await harness({ sessionScopedMemory: false });
  try {
    const result = await run("viking_read", { uri: OUTSIDE, level: "full" });
    assert.doesNotMatch(result.text, /^Refused:/);
    assert.equal(result.requests[0].query, `uri=${OUTSIDE}`);
  } finally {
    await close();
  }
});
