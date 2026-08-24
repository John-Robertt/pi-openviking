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
async function harness({
  sessionScopedMemory = true, sync = { sessionId: "pi-x" }, foundUri = OUTSIDE, resourceRoot = OUTSIDE,
} = {}) {
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
        result: { memories: [{ uri: foundUri, score: 0.95, abstract: "匹配结果" }], resources: [], skills: [], total: 1 },
      });
    }
    if (req.url === "/api/v1/resources") return json({ status: "ok", result: { root_uri: resourceRoot } });
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
    return { text: result.content?.[0]?.text ?? "", result, requests: [...requests] };
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

test("内部事实命名空间不可由 viking_forget 删除", async () => {
  const internal = `${MY_ROOT}/resources/.pi-openviking/recorded-events/v1/hidden/.event.json`;
  const { run, close } = await harness({ foundUri: internal });
  try {
    const byUri = await run("viking_forget", { uri: internal });
    assert.match(byUri.text, /^Refused:/);
    assert.deepEqual(byUri.requests, [], "内部事实 URI 不得发出 DELETE");

    const duplicateSlash = internal.replace("/resources/", "/resources//");
    const invalid = await run("viking_forget", { uri: duplicateSlash });
    assert.match(invalid.text, /^Refused:/);
    assert.deepEqual(invalid.requests, [], "重复斜杠不是合法 canonical URI");

    const byQuery = await run("viking_forget", { query: "内部事实" });
    assert.match(byQuery.text, /^Refused:/);
    assert.equal(byQuery.requests.length, 1, "搜索本身仍需执行一次");
    assert.ok(!byQuery.requests.some((request) => request.method === "DELETE"));

    const memory = await run("viking_forget", { uri: `${MY_ROOT}/memories/outdated.md` });
    assert.match(memory.text, /^Deleted:/);
    assert.ok(memory.requests.some((request) => request.method === "DELETE"), "普通记忆仍可删除");
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

test("current-user shorthand 规范化后校验并以 canonical URI 执行", async () => {
  const shorthand = "viking://user/memories/current.md";
  const canonical = `${MY_ROOT}/memories/current.md`;
  const { run, close } = await harness({ foundUri: shorthand });
  try {
    const read = await run("viking_read", { uri: shorthand, level: "full" });
    assert.equal(read.requests[0].query, `uri=${canonical}`);

    const browse = await run("viking_browse", { action: "stat", uri: shorthand });
    assert.equal(browse.requests[0].query, `uri=${canonical}`);

    const search = await run("viking_search", { query: "current" });
    assert.match(search.text, new RegExp(canonical));
    assert.equal(search.result.details.results[0].uri, canonical);

    const forget = await run("viking_forget", { uri: shorthand });
    assert.equal(forget.text, `Deleted: ${canonical}`);
    assert.match(forget.requests[0].query, new RegExp(`^uri=${canonical}`));
  } finally {
    await close();
  }
});

test("URI path 字节不被工具层解码，所有模式都拒绝非法 URI", async () => {
  const { run, close } = await harness();
  try {
    for (const suffix of ["a%25b", "%3Fchild", "中文.md"]) {
      const input = `viking://user/memories/${suffix}`;
      const result = await run("viking_read", { uri: input, level: "full" });
      assert.equal(result.requests[0].query, `uri=${MY_ROOT}/memories/${suffix}`);
    }
  } finally {
    await close();
  }

  const shared = await harness({ sessionScopedMemory: false });
  try {
    for (const [tool, params] of [
      ["viking_read", { uri: "not-a-viking-uri", level: "full" }],
      ["viking_browse", { action: "stat", uri: "viking://user//broken" }],
      ["viking_search", { query: "x", scope: "not-a-viking-uri" }],
    ]) {
      const result = await shared.run(tool, params);
      assert.match(result.text, /^Refused:/);
      assert.deepEqual(result.requests, []);
    }
  } finally {
    await shared.close();
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

test("资源导入在会话隔离模式拒绝，关闭隔离后按服务身份执行", async () => {
  const scopedHarness = await harness();
  try {
    const result = await scopedHarness.run("viking_add_resource", { url: "https://example.test" });
    assert.match(result.text, /^Refused:/);
    assert.deepEqual(result.requests, [], "无法绑定会话资源命名空间时不得产生全局副作用");
  } finally {
    await scopedHarness.close();
  }

  const resourceUri = "viking://resources/imported";
  const sharedHarness = await harness({ sessionScopedMemory: false, resourceRoot: resourceUri });
  try {
    const result = await sharedHarness.run("viking_add_resource", {
      url: "https://example.test", reason: "current project source",
    });
    assert.equal(result.text, `Ingested: ${resourceUri}`);
    assert.deepEqual(result.requests[0].body, {
      path: "https://example.test", reason: "current project source",
    });
  } finally {
    await sharedHarness.close();
  }

  const malformedHarness = await harness({ sessionScopedMemory: false, resourceRoot: "not-a-viking-uri" });
  try {
    const result = await malformedHarness.run("viking_add_resource", { url: "https://example.test" });
    assert.match(result.text, /^Failed to ingest:/);
    assert.equal(result.result.details, undefined);
  } finally {
    await malformedHarness.close();
  }
});

test("Archive 展开只接受本会话命名空间内的合法 archiveId，输出为受限事件索引", async () => {
  const expansions = [];
  const archiveId = `arc_${"a".repeat(64)}`;
  const { run, close } = await harness({
    sync: {
      sessionId: "pi-x",
      listArchives: () => Array.from({ length: 52 }, (_, index) => ({
        manifest: {
          archiveId: index === 0 ? archiveId : `arc_${index.toString(16).padStart(64, "0")}`,
          eventCount: 2,
          firstEventId: `evt_${"1".repeat(64)}`,
          lastEventId: `evt_${"3".repeat(64)}`,
          contentHash: `sha256:${"2".repeat(64)}`,
        },
        tokenCount: 1234,
      })),
      eventStorageUri: () => null,
      async expandArchive(id) {
        expansions.push(id);
        return {
          manifest: {
            archiveId: id,
            eventCount: 2,
            firstEventId: `evt_${"1".repeat(64)}`,
            lastEventId: `evt_${"3".repeat(64)}`,
            contentHash: `sha256:${"2".repeat(64)}`,
          },
          events: [
            {
              eventId: `evt_${"1".repeat(64)}`, occurredAt: "2026-08-24T05:39:17.985Z",
              source: { entryType: "message" },
              payload: { entry: { id: "entry-0", message: { role: "assistant" } }, part: { form: "scalar", value: "planning the next step" } },
            },
            {
              eventId: `evt_${"3".repeat(64)}`, occurredAt: "2026-08-24T05:39:18.985Z",
              source: { entryType: "custom" },
              payload: { entry: { id: "entry-1", customType: "x".repeat(500) }, part: { form: "array", value: { text: "exit 0" } } },
            },
          ],
        };
      },
    },
  });
  try {
    for (const rejected of ["pi-someone-else", "../user/dev--pi-OTHER/memories", `arc_${"z".repeat(64)}`]) {
      const result = await run("viking_archive_expand", { archive_id: rejected });
      assert.match(result.text, /^Refused:/);
      assert.deepEqual(result.requests, [], "形状非法的 archiveId 不得发出请求");
    }
    assert.deepEqual(expansions, [], "拒绝路径不得触达 Archive 存储");

    // 无参数是发现路径：列出本会话 Archive，不触达 expand。
    const listing = await run("viking_archive_expand", {});
    assert.match(listing.text, /knows 52 committed archive\(s\); showing 1-50/);
    assert.match(listing.text, new RegExp(archiveId));
    assert.doesNotMatch(listing.text, new RegExp(`arc_${(51).toString(16).padStart(64, "0")}`));
    const listingTail = await run("viking_archive_expand", { offset: 50, limit: 2 });
    assert.match(listingTail.text, /showing 51-52/);
    assert.deepEqual(expansions, [], "列表路径不得触达 Archive 存储");

    const own = await run("viking_archive_expand", { archive_id: archiveId });
    assert.match(own.text, new RegExp(`^archive arc_a{64}\\nevents 2 `));
    assert.match(own.text, /showing 1-2 of 2/);
    assert.match(own.text, /message\/assistant weight≈\d+ tokens/);
    assert.match(own.text, /excerpt: "planning the next step"/);
    assert.match(own.text, /custom\/x+… weight≈/);
    assert.doesNotMatch(own.text, new RegExp("x".repeat(500)), "索引标签必须有硬上限");
    assert.doesNotMatch(own.text, /entry-0/, "索引不得包含完整 payload 字段");
    assert.match(own.text, /oversized chunked entries have no single read URI/);
    assert.doesNotMatch(own.text, /^\s*read:/m, "没有 direct 表示的事件不得伪造可读 URI");
    assert.deepEqual(expansions, [archiveId]);

    const page = await run("viking_archive_expand", { archive_id: archiveId, offset: 1, limit: 1 });
    assert.match(page.text, /showing 2-2 of 2/);
    assert.doesNotMatch(page.text, /planning the next step/);

    const exhausted = await run("viking_archive_expand", { archive_id: archiveId, offset: 99, limit: 1 });
    assert.match(exhausted.text, /showing none of 2/);
    assert.doesNotMatch(exhausted.text, /showing 100-2/);
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

    const ordinaryDelete = await run("viking_forget", { uri: OUTSIDE });
    assert.match(ordinaryDelete.text, /^Deleted:/, "关闭隔离后普通跨用户记忆仍可删除");

    const otherInternal = "viking://user/other/resources/.pi-openviking/archives/v1/.manifest.json";
    const protectedDelete = await run("viking_forget", { uri: otherInternal });
    assert.match(protectedDelete.text, /^Refused:/);
    assert.deepEqual(protectedDelete.requests, [], "任何用户的内部事实都不得由记忆工具删除");
  } finally {
    await close();
  }
});

test("关闭隔离时仍拒绝 OpenViking user shorthand 指向的内部事实", async () => {
  const shorthand = "viking://user/resources/.pi-openviking/recorded-events/v1/.event.json";
  const { run, close } = await harness({ sessionScopedMemory: false, foundUri: shorthand });
  try {
    const direct = await run("viking_forget", { uri: shorthand });
    assert.match(direct.text, /^Refused:/);
    assert.deepEqual(direct.requests, []);

    const searched = await run("viking_forget", { query: "internal event" });
    assert.match(searched.text, /^Refused:/);
    assert.equal(searched.requests.length, 1);
    assert.ok(!searched.requests.some((request) => request.method === "DELETE"));
  } finally {
    await close();
  }
});
