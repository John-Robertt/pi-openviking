import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLivePiInvocation,
  checkManifestHash,
  cleanupRemote,
  conflictBytesOf,
  createRpcLineParser,
  derivePassed,
} from "./live/live-support.mjs";

test("live Pi invocation 按任务模型与 provider override 隔离凭证", () => {
  const profile = {
    taskModel: { provider: "task-provider", model: "task-model", credentialKind: "api_key", apiKeyEnv: "TASK_API_KEY" },
    vlm: { provider: "vlm-provider", model: "vlm-model", credentialKind: "api_key", apiKeyEnv: "VLM_API_KEY" },
  };
  const common = {
    piBin: "/repo/pi",
    extensionLoadOrder: ["index.ts"],
    sessionId: "session-1",
    runDir: "/repo/run",
    endpoint: "http://127.0.0.1:19331",
    openviking: { account: "dev", user: "dev" },
    profile,
    taskApiKey: "selected-task-key",
    turn: 0,
    baseEnv: { PATH: "/usr/bin", TASK_API_KEY: "inherited-task", VLM_API_KEY: "inherited-vlm" },
  };
  const task = buildLivePiInvocation(common);
  assert.equal(task.args[task.args.indexOf("--provider") + 1], "task-provider");
  assert.equal(task.env.TASK_API_KEY, "selected-task-key");
  assert.equal(task.env.VLM_API_KEY, undefined);

  const oauth = buildLivePiInvocation({
    ...common,
    profile: {
      ...profile,
      taskModel: { provider: "openai-codex", model: "gpt-5.6-luna", credentialKind: "oauth" },
    },
  });
  assert.equal(oauth.env.TASK_API_KEY, undefined);

  const provider = { provider: "scripted", model: "scripted-model", apiKeyEnv: "SCRIPTED_API_KEY" };
  const overridden = buildLivePiInvocation({
    ...common,
    provider,
    baseEnv: { ...common.baseEnv, SCRIPTED_API_KEY: "inherited-scripted" },
  });
  assert.equal(overridden.args[overridden.args.indexOf("--provider") + 1], "scripted");
  assert.equal(overridden.env.TASK_API_KEY, undefined);
  assert.equal(overridden.env.VLM_API_KEY, undefined);
  assert.equal(overridden.env.SCRIPTED_API_KEY, undefined);

  const explicitOverride = buildLivePiInvocation({
    ...common,
    provider,
    baseEnv: { ...common.baseEnv, SCRIPTED_API_KEY: "inherited-scripted" },
    extraEnv: { SCRIPTED_API_KEY: "selected-scripted" },
  });
  assert.equal(explicitOverride.env.TASK_API_KEY, undefined);
  assert.equal(explicitOverride.env.VLM_API_KEY, undefined);
  assert.equal(explicitOverride.env.SCRIPTED_API_KEY, "selected-scripted");
});

test("manifest hash 只接受匹配的 sha256", () => {
  const bytes = Buffer.from("manifest");
  assert.equal(checkManifestHash(bytes, "not-a-hash"), false);
  assert.equal(checkManifestHash(bytes, "0".repeat(64)), false);
});

test("passed 只由非空且全部通过的断言派生", () => {
  assert.equal(derivePassed([]), false);
  assert.equal(derivePassed([{ pass: true }]), true);
  assert.equal(derivePassed([{ pass: true }, { pass: false }]), false);
});

test("远端清理只删除 marker 证明的产品根，目录骨架留给持久对象验证", async () => {
  const userRoot = "viking://user/dev--pi-session";
  const markerBytes = Buffer.from("owner");
  const deleted = [];
  const checks = [];
  const cleanup = await cleanupRemote({
    check: (...args) => checks.push(args),
  }, {
    workloadId: "cleanup-fixture",
    workload: {},
    userRoot,
    markerUri: `${userRoot}/resources/.pi-openviking/.live-owner.json`,
    markerBytes,
    client: { downloadBytes: async () => ({ ok: true, bytes: Buffer.from(markerBytes), status: 200 }) },
    cleanupClient: {
      delete: async (uri) => { deleted.push(uri); return true; },
      statUri: async () => ({ ok: true, exists: false, isDir: false, status: 404 }),
    },
  }, ["written-object"], null);

  assert.deepEqual(deleted, [`${userRoot}/resources/.pi-openviking`]);
  assert.deepEqual(cleanup.residuals, []);
  assert.equal(checks.at(-1)[1], "cleanup.remote");
  assert.equal(checks.at(-1)[4], true);
});

test("冲突 fixture 确定性改变一个字节且不修改输入", () => {
  const bytes = Buffer.from("hello world");
  const conflict = conflictBytesOf(bytes);
  assert.equal(conflict.length, bytes.length);
  assert.notDeepEqual(conflict, bytes);
  assert.deepEqual(conflictBytesOf(bytes), conflict);
  assert.deepEqual(bytes, Buffer.from("hello world"));
});

test("RPC parser 只按 LF 分帧并保留不可解析记录", () => {
  const parse = createRpcLineParser();
  assert.deepEqual(parse('{"type":"a"}\r\n{"type":"b'), [{ type: "a" }]);
  const rest = parse('"}\nnot-json\n{"type":"c"}\n');
  assert.equal(rest[0].type, "b");
  assert.equal(rest[1].type, "__unparsed");
  assert.equal(rest[2].type, "c");

  const parseWithSeparator = createRpcLineParser();
  const records = parseWithSeparator('{"type":"x","s":"a\u2028b"}\n');
  assert.equal(records.length, 1);
  assert.equal(records[0].s, "a\u2028b");
});
