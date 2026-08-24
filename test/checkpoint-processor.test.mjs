import assert from "node:assert/strict";
import test from "node:test";

import { buildArchiveManifest } from "../shared/archive.mjs";
import { OpenVikingCheckpointProcessor } from "../shared/checkpoint-processor.mjs";
import { validateCheckpointOverview } from "../shared/checkpoint.mjs";
import { archiveEvents } from "./fixtures/archive-fixtures.mjs";
import { checkpointOverview } from "./fixtures/checkpoint-fixtures.mjs";

const events = archiveEvents("processor-session", [{ role: "user", chars: 20 }]);
const manifest = buildArchiveManifest("processor-session", events);
const TASK_ID = `cptask_${"a".repeat(64)}`;
const OVERVIEW = checkpointOverview("complete checkpoint processing");

function response(ok, result = null, status = ok ? 200 : 404, error = null) {
  return { ok, result, status, error };
}

test("processor 通过公开 Session/Task API 提交并读取 Working Memory", async () => {
  const calls = [];
  let created = false;
  const client = {
    userRoot: "viking://user/test",
    async getSession() {
      calls.push("getSession");
      return created ? response(true, { message_count: 0, commit_count: 0 }) : response(false, null, 404, { code: "NOT_FOUND" });
    },
    async addMessage(_id, role, content) { created = true; calls.push("addMessage"); assert.equal(role, "user"); assert.match(content, /sourceArchive/); return true; },
    async commitSession() { calls.push("commitSession"); return response(true, { task_id: "provider-task" }); },
    async listTasks() { throw new Error("commit response already has task id"); },
    async getTask() { calls.push("getTask"); return response(true, { status: "completed" }); },
    async getSessionContext() { calls.push("getSessionContext"); return response(true, { latest_archive_overview: OVERVIEW }); },
  };
  const processor = new OpenVikingCheckpointProcessor(client);
  const result = await processor.advance({ taskId: TASK_ID, manifest, loadEvents: async () => events, previousCheckpoint: null });
  assert.equal(result.status, "completed");
  assert.equal(result.overview, validateCheckpointOverview(OVERVIEW));
  assert.deepEqual(calls, ["getSession", "addMessage", "commitSession", "getTask", "getSessionContext"]);
});

test("processor 从持久 Session 的 task 列表恢复，不重复写输入或 commit", async () => {
  const calls = [];
  const client = {
    userRoot: "viking://user/test",
    async getSession() { calls.push("getSession"); return response(true, { message_count: 0, commit_count: 1 }); },
    async createSession() { throw new Error("must not create"); },
    async addMessage() { throw new Error("must not add"); },
    async commitSession() { throw new Error("must not commit"); },
    async listTasks() { calls.push("listTasks"); return response(true, [{ task_id: "provider-task", created_at: 1 }]); },
    async getTask() { calls.push("getTask"); return response(true, { status: "running", created_at: 12.5 }); },
  };
  const processor = new OpenVikingCheckpointProcessor(client);
  const result = await processor.advance({ taskId: TASK_ID, manifest, loadEvents: async () => events, previousCheckpoint: null });
  assert.equal(result.status, "processing");
  assert.equal(result.taskCreatedAtMs, 12500, "悬挂判定需要服务器侧 task 创建时刻");
  assert.deepEqual(calls, ["getSession", "listTasks", "getTask"]);
});

test("processor 只把 OpenViking 明确终态失败返回为 checkpoint failure", async () => {
  const client = {
    userRoot: "viking://user/test",
    async getSession() { return response(true, { message_count: 0, commit_count: 1 }); },
    async listTasks() { return response(true, [{ task_id: "provider-task", created_at: 1 }]); },
    async getTask() { return response(true, { status: "failed", error: "Authorization: Bearer sk-review-secret" }); },
  };
  const processor = new OpenVikingCheckpointProcessor(client);
  const result = await processor.advance({ taskId: TASK_ID, manifest, loadEvents: async () => events, previousCheckpoint: null });
  assert.equal(result.status, "failed");
  assert.equal(result.error.errorCode, "task_failed");
  assert.equal(result.error.message, "checkpoint VLM task failed");
});

test("processor 拒绝缺少统一 continuation 契约的非空输出", async () => {
  const client = {
    userRoot: "viking://user/test",
    async getSession() { return response(true, { message_count: 1, commit_count: 1 }); },
    async listTasks() { return response(true, [{ task_id: "provider-task", created_at: 1 }]); },
    async getTask() { return response(true, { status: "completed" }); },
    async getSessionContext() {
      return response(true, { latest_archive_overview: "# Session Summary\n\n**Overview**: 1 turns, 1 messages" });
    },
  };
  const processor = new OpenVikingCheckpointProcessor(client);
  const result = await processor.advance({ taskId: TASK_ID, manifest, loadEvents: async () => events, previousCheckpoint: null });
  assert.equal(result.status, "failed");
  assert.equal(result.error.errorCode, "invalid_output");
});

test("processor 在任一媒体没有非空语义摘要时保留同一 request 等待恢复", async () => {
  const imageEvents = archiveEvents("processor-media", [{ role: "user", chars: 20 }]);
  imageEvents[0].source.partType = "image";
  imageEvents[0].payload.part = {
    container: "message.content",
    form: "array",
    count: 1,
    value: { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
  };
  const imageManifest = buildArchiveManifest("processor-media", imageEvents);
  let added = 0;
  const client = {
    userRoot: "viking://user/test",
    async statUri() { return { ok: true, exists: true, isDir: true, status: 200 }; },
    async getSession() { return response(true, { message_count: 0, commit_count: 0 }); },
    async fetchJSON(_path, options) {
      const body = JSON.parse(options.body);
      const uri = body.operations[0].uri;
      return response(true, { root_uri: body.root_uri, created: [uri], updated: [], unchanged: [] });
    },
    async abstract() { return null; },
    async addMessage() { added++; return true; },
    async commitSession() { return response(true, { task_id: "provider-task" }); },
    async getTask() { return response(true, { status: "completed" }); },
    async getSessionContext() { return response(true, { latest_archive_overview: OVERVIEW }); },
  };
  const processor = new OpenVikingCheckpointProcessor(client);
  const result = await processor.advance({ taskId: TASK_ID, manifest: imageManifest, loadEvents: async () => imageEvents, previousCheckpoint: null });
  assert.equal(result.status, "pending");
  assert.equal(result.error.errorCode, "media_prepare");
  assert.equal(added, 0);
});

test("processor 只有在所属 Session 与媒体根都确认不存在时才报告清理完成", async () => {
  const taskId = `cptask_${"a".repeat(64)}`;
  const partial = new OpenVikingCheckpointProcessor({
    userRoot: "viking://user/test",
    async deleteSession() { return response(true, {}); },
    async getSession() { return response(false, null, 404, { code: "NOT_FOUND" }); },
    async delete() { return false; },
    async statUri() { return { ok: true, exists: true, isDir: true, status: 200 }; },
  });
  assert.equal(await partial.cleanup(taskId), false);

  const complete = new OpenVikingCheckpointProcessor({
    userRoot: "viking://user/test",
    async deleteSession() { return response(true, {}); },
    async getSession() { return response(false, null, 404, { code: "NOT_FOUND" }); },
    async delete() { return true; },
    async statUri() { return { ok: true, exists: false, isDir: false, status: 404 }; },
  });
  assert.equal(await complete.cleanup(taskId), true);
});

test("processor 清理时先取消非终态 provider task，再删除 Session 与媒体根", async () => {
  const taskId = `cptask_${"b".repeat(64)}`;
  const order = [];
  const processor = new OpenVikingCheckpointProcessor({
    userRoot: "viking://user/test",
    async listTasks(resourceId) {
      assert.equal(resourceId, taskId);
      return response(true, [
        { task_id: "provider-hung", status: "running" },
        { task_id: "provider-done", status: "completed" },
      ]);
    },
    async cancelTask(id) { order.push(`cancel:${id}`); return response(true, {}); },
    async deleteSession() { order.push("deleteSession"); return response(true, {}); },
    async delete() { order.push("deleteMedia"); return true; },
    async getSession() { return response(false, null, 404, { code: "NOT_FOUND" }); },
    async statUri() { return { ok: true, exists: false, isDir: false, status: 404 }; },
  });
  assert.equal(await processor.cleanup(taskId), true);
  assert.deepEqual(order, ["cancel:provider-hung", "deleteSession", "deleteMedia"],
    "只有非终态 task 需要取消，且取消必须先于删除");
});
