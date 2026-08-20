import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildChildEnv,
  buildDevPiArgs,
  buildDevServerConfig,
  createRunFiles,
  ensurePiAuthBridge,
  executeVlmProbe,
  isDevServerProcess,
  piWrapperSource,
  verifyDevServerConfig,
  verifyRunFiles,
} from "../scripts/dev.mjs";

const profile = {
  taskModel: {
    provider: "task-provider",
    model: "task-model",
    credentialKind: "api_key",
    apiKeyEnv: "TASK_API_KEY",
  },
  vlm: {
    provider: "vlm-provider",
    model: "vlm-model",
    apiBase: "https://memory.example.test",
    credentialKind: "api_key",
    apiKeyEnv: "VLM_API_KEY",
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

test("buildDevServerConfig 只使用 profile.vlm 且凭证为环境占位符", () => {
  const config = buildDevServerConfig(profile);
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(typeof config.server.port, "number");
  assert.equal(config.vlm.provider, "vlm-provider");
  assert.equal(config.vlm.model, "vlm-model");
  assert.equal(config.vlm.api_base, "https://memory.example.test");
  assert.equal(config.vlm.api_key, "${VLM_API_KEY}");
  assert.equal(config.embedding.dense.provider, "local");
  assert.equal(config.embedding.dense.model, "test-embed");
  assert.equal(config.embedding.dense.dimension, 128);
  assert.ok(config.embedding.dense.cache_dir.includes("models"));
  assert.ok(config.storage.workspace.includes("data"));
});

test("buildDevServerConfig 为 OAuth VLM 省略 api_key", () => {
  const oauth = structuredClone(profile);
  oauth.vlm = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    apiBase: "https://chatgpt.com/backend-api/codex",
    credentialKind: "oauth",
  };
  const config = buildDevServerConfig(oauth);
  assert.equal(config.vlm.provider, "openai-codex");
  assert.equal(config.vlm.model, "gpt-5.6-luna");
  assert.equal(config.vlm.api_key, undefined);
});

test("buildDevPiArgs 只使用 profile.taskModel 并拒绝命令行覆盖", () => {
  assert.deepEqual(
    buildDevPiArgs(profile, ["--thinking", "off"]),
    ["--provider", "task-provider", "--model", "task-model", "--models", "task-provider/task-model", "--thinking", "off"],
  );
  for (const args of [["--provider", "other"], ["--model=other"], ["--models", "other/*"], ["--api-key=secret"]]) {
    assert.throws(() => buildDevPiArgs(profile, args), /不能覆盖/);
  }
});

test("verifyDevServerConfig 核对状态、ov.conf 与 profile 期望配置", () => {
  withTmpDir((dir) => {
    const expected = buildDevServerConfig(profile);
    createRunFiles(dir, { pid: 12345, config: expected });
    writeFileSync(join(dir, "ov.conf"), JSON.stringify(expected));
    let state = verifyRunFiles(dir).state;
    assert.equal(verifyDevServerConfig(dir, state, expected).ok, true);

    const changed = { ...expected, vlm: { ...expected.vlm, model: "changed-model" } };
    writeFileSync(join(dir, "ov.conf"), JSON.stringify(changed));
    assert.equal(verifyDevServerConfig(dir, state, expected).reason, "状态文件配置指纹与 ov.conf 不一致");

    createRunFiles(dir, { pid: 12345, config: changed });
    writeFileSync(join(dir, "ov.conf"), JSON.stringify(changed));
    state = verifyRunFiles(dir).state;
    assert.equal(verifyDevServerConfig(dir, state, expected).reason, "运行配置与当前开发模型身份不一致");
  });
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

test("buildChildEnv 只保留当前子进程职责所需的模型凭证", () => {
  const base = {
    PATH: "/usr/bin",
    OPENVIKING_URL: "http://127.0.0.1:1933",
    OPENVIKING_API_KEY: "user-key",
    OPENVIKING_BASE_URL: "http://127.0.0.1:1933",
    TASK_API_KEY: "inherited-task-key",
    VLM_API_KEY: "inherited-vlm-key",
  };
  const modelCredentialEnvs = [profile.taskModel.apiKeyEnv, profile.vlm.apiKeyEnv];
  const serviceEnv = buildChildEnv({
    OPENVIKING_BASE_URL: "http://127.0.0.1:19331",
    OPENVIKING_ACCOUNT: "dev",
    VLM_API_KEY: "selected-vlm-key",
  }, base, modelCredentialEnvs);
  assert.equal(serviceEnv.PATH, "/usr/bin");
  assert.equal(serviceEnv.OPENVIKING_URL, undefined);
  assert.equal(serviceEnv.OPENVIKING_API_KEY, undefined);
  assert.equal(serviceEnv.OPENVIKING_BASE_URL, "http://127.0.0.1:19331");
  assert.equal(serviceEnv.OPENVIKING_ACCOUNT, "dev");
  assert.equal(serviceEnv.TASK_API_KEY, undefined);
  assert.equal(serviceEnv.VLM_API_KEY, "selected-vlm-key");

  const piEnv = buildChildEnv({ TASK_API_KEY: "selected-task-key" }, base, modelCredentialEnvs);
  assert.equal(piEnv.TASK_API_KEY, "selected-task-key");
  assert.equal(piEnv.VLM_API_KEY, undefined);
});

test("ensurePiAuthBridge 只引用用户 OAuth auth.json 并可安全撤销", () => {
  withTmpDir((dir) => {
    const sourceDir = join(dir, "global-pi");
    const targetDir = join(dir, "isolated-pi");
    const source = join(sourceDir, "auth.json");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(source, "{}", { mode: 0o600 });

    const oauth = { provider: "openai-codex", credentialKind: "oauth" };
    const env = { PI_CODING_AGENT_DIR: sourceDir };
    const target = ensurePiAuthBridge(oauth, targetDir, env);
    const sourceStat = statSync(source);
    const targetStat = statSync(target);
    assert.equal(targetStat.dev, sourceStat.dev);
    assert.equal(targetStat.ino, sourceStat.ino);
    assert.equal(ensurePiAuthBridge(oauth, targetDir, env), target);

    ensurePiAuthBridge({ credentialKind: "api_key" }, targetDir, env);
    assert.equal(existsSync(target), false);
  });
});

test("executeVlmProbe 证明真实 Session/Task 输出并清理所属 session", async () => {
  const calls = [];
  const client = {
    async getSession() { calls.push("getSession"); return { ok: false, status: 404, result: null }; },
    async createSession() { calls.push("createSession"); return true; },
    async addMessage() { calls.push("addMessage"); return true; },
    async commitSession() { calls.push("commitSession"); return { ok: true, result: { task_id: "task-1" } }; },
    async getTask() {
      calls.push("getTask");
      return { ok: true, result: { task_id: "task-1", resource_id: "probe-session", task_type: "session_commit", status: "completed" } };
    },
    async getSessionContext() { calls.push("getSessionContext"); return { ok: true, result: { latest_archive_overview: "OK" } }; },
    async deleteSession() { calls.push("deleteSession"); return { ok: true, result: null }; },
  };

  const result = await executeVlmProbe(client, { sessionId: "probe-session", pollMs: 0 });
  assert.equal(result.sessionId, "probe-session");
  assert.equal(result.taskId, "task-1");
  assert.equal(result.outputBytes, 2);
  assert.deepEqual(calls, [
    "getSession", "createSession", "addMessage", "commitSession", "getTask",
    "getSessionContext", "getTask", "deleteSession", "getSession",
  ]);
});

test("executeVlmProbe 在提交失败后仍清理已创建 session", async () => {
  let reads = 0;
  const calls = [];
  const client = {
    async getSession() { reads += 1; calls.push("getSession"); return { ok: false, status: 404, result: null }; },
    async createSession() { calls.push("createSession"); return true; },
    async addMessage() { calls.push("addMessage"); return true; },
    async commitSession() { calls.push("commitSession"); return { ok: false, result: null }; },
    async deleteSession() { calls.push("deleteSession"); return { ok: true, result: null }; },
  };

  await assert.rejects(
    executeVlmProbe(client, { sessionId: "probe-session", pollMs: 0 }),
    /commit 未返回 task_id/,
  );
  assert.equal(reads, 2);
  assert.deepEqual(calls, ["getSession", "createSession", "addMessage", "commitSession", "deleteSession", "getSession"]);
});

test("executeVlmProbe 超时时只取消 ownership 已证明的 active task", async () => {
  let sessionReads = 0;
  let taskReads = 0;
  let cancelled = false;
  const client = {
    async getSession() { sessionReads += 1; return { ok: false, status: 404, result: null }; },
    async createSession() { return true; },
    async addMessage() { return true; },
    async commitSession() { return { ok: true, result: { task_id: "task-1" } }; },
    async getTask() {
      taskReads += 1;
      return {
        ok: true,
        result: {
          task_id: "task-1", resource_id: "probe-session", task_type: "session_commit",
          status: cancelled ? "cancelled" : "running",
        },
      };
    },
    async fetchJSON() { cancelled = true; return { ok: true, result: null }; },
    async deleteSession() { return { ok: true, result: null }; },
  };

  await assert.rejects(
    executeVlmProbe(client, { sessionId: "probe-session", timeoutMs: 1, pollMs: 2 }),
    /未完成/,
  );
  assert.equal(cancelled, true);
  assert.ok(taskReads >= 3);
  assert.equal(sessionReads, 2);
});

test("pi wrapper 相对路径指向仓库 index.ts", () => {
  assert.ok(piWrapperSource().includes('export { default } from "../../../../index.ts"'));
});
