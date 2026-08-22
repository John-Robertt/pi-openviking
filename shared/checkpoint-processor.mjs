import { openVikingApiPath } from "./openviking-api.mjs";
import { acceptBatchResult, ContentWriteError, ensureDirectoryChain } from "./content-objects.mjs";
import { embeddedImages, renderCheckpointInput, validateCheckpointOverview } from "./checkpoint.mjs";
import { observation as processObservation } from "./observe.mjs";

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "cancelled"]);
const MEDIA_WAIT_MS = 180_000;
function mediaExtension(mimeType) {
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/gif": return "gif";
    default: return "png";
  }
}

function taskError(task) {
  const cancelled = task?.status === "cancelled";
  return {
    errorClass: "protocol",
    errorCode: cancelled ? "task_cancelled" : "task_failed",
    message: cancelled ? "checkpoint VLM task was cancelled" : "checkpoint VLM task failed",
  };
}

export class OpenVikingCheckpointProcessor {
  constructor(client, { observation = processObservation } = {}) {
    this.client = client;
    this.observe = observation;
    this.createdDirectories = new Set();
  }

  async advance({ taskId, manifest, events, previousCheckpoint }) {
    const op = this.observe.begin("checkpoint_process", events.length, embeddedImages(events).length);
    let outcome = "processing";
    try {
      const session = await this.client.getSession(taskId);
      const sessionMissing = !session.ok && (session.status === 404 || session.error?.code === "NOT_FOUND");
      if (!sessionMissing && (!session.ok || !session.result)) {
        return { status: "pending", error: { errorClass: "transport", errorCode: "session_read", message: "checkpoint session is unavailable" } };
      }

      const messageCount = Math.max(0, Number(session.result?.message_count) || 0);
      const commitCount = Math.max(0, Number(session.result?.commit_count) || 0);
      let providerTaskId = null;

      if (messageCount === 0 && commitCount === 0) {
        const media = await this.prepareMedia(taskId, events);
        if (!media) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "media_prepare", message: "checkpoint media preparation is pending" } };
        }
        const input = renderCheckpointInput(manifest, events, previousCheckpoint, media);
        const added = await this.client.addMessage(taskId, "user", input);
        if (!added) return { status: "pending", error: { errorClass: "transport", errorCode: "message_add", message: "checkpoint input submission is pending" } };
      }

      if (commitCount === 0) {
        const committed = await this.client.commitSession(taskId);
        if (!committed.ok) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "session_commit", message: "checkpoint VLM submission is pending" } };
        }
        providerTaskId = typeof committed.result?.task_id === "string" ? committed.result.task_id : null;
      }

      if (!providerTaskId) {
        const listed = await this.client.listTasks(taskId);
        if (!listed.ok || !Array.isArray(listed.result)) {
          return { status: "pending", error: { errorClass: "transport", errorCode: "task_list", message: "checkpoint task status is unavailable" } };
        }
        const tasks = [...listed.result].sort((a, b) => Number(b?.created_at || 0) - Number(a?.created_at || 0));
        providerTaskId = typeof tasks[0]?.task_id === "string" ? tasks[0].task_id : null;
      }
      if (!providerTaskId) {
        return { status: "pending", error: { errorClass: "protocol", errorCode: "task_missing", message: "checkpoint commit returned no task" } };
      }

      const taskResponse = await this.client.getTask(providerTaskId);
      if (!taskResponse.ok || !taskResponse.result) {
        return { status: "pending", error: { errorClass: "transport", errorCode: "task_read", message: "checkpoint task status is unavailable" } };
      }
      const task = taskResponse.result;
      if (!TERMINAL_TASK_STATES.has(task.status)) return { status: "processing" };
      if (task.status !== "completed") {
        outcome = "failed";
        return { status: "failed", error: taskError(task) };
      }

      const context = await this.client.getSessionContext(taskId);
      const overview = context.ok && typeof context.result?.latest_archive_overview === "string"
        ? context.result.latest_archive_overview.trim()
        : "";
      if (!overview) {
        outcome = "failed";
        return {
          status: "failed",
          error: { errorClass: "protocol", errorCode: "empty_output", message: "checkpoint VLM completed without a working-memory overview" },
        };
      }
      let normalizedOverview;
      try {
        normalizedOverview = validateCheckpointOverview(overview);
      } catch {
        outcome = "failed";
        return {
          status: "failed",
          error: { errorClass: "protocol", errorCode: "invalid_output", message: "checkpoint VLM completed without a valid unified continuation" },
        };
      }
      outcome = "completed";
      return { status: "completed", overview: normalizedOverview };
    } finally {
      this.observe.end("checkpoint_process", op, outcome);
    }
  }

  async prepareMedia(taskId, events) {
    const images = embeddedImages(events);
    if (images.length === 0) return [];
    const userRoot = this.client.userRoot;
    const taskRoot = `${userRoot}/resources/.pi-openviking/checkpoint-inputs/v1/${taskId}`;
    await ensureDirectoryChain(this.client, `${userRoot}/resources`, taskRoot, this.createdDirectories);
    const media = [];
    for (const [index, image] of images.entries()) {
      const uri = `${taskRoot}/image-${String(index).padStart(4, "0")}.${mediaExtension(image.mimeType)}`;
      const response = await this.client.fetchJSON(
        openVikingApiPath("/content/batch-write"),
        {
          method: "POST",
          body: JSON.stringify({
            root_uri: taskRoot,
            operations: [{
              uri,
              content_base64: image.bytes.toString("base64"),
              precondition: { kind: "create_if_absent" },
            }],
            wait: true,
          }),
        },
        MEDIA_WAIT_MS,
      );
      // 响应判定收敛到协议层：形状、root_uri 与 URI 全覆盖由 acceptBatchResult 保证，
      // 失败以 ContentWriteError 体系分类。create_if_absent 下 updated 意味着服务端改写了
      // 字节，VLM 输入不再可信，按协议失败处理而不是静默接受。
      const accepted = acceptBatchResult(response, taskRoot, [uri]);
      if (accepted.updated.has(uri)) {
        throw new ContentWriteError("OpenViking modified a checkpoint media object", { uri });
      }
      const abstract = await this.client.abstract(uri);
      if (typeof abstract !== "string" || !abstract.trim()) return null;
      media.push({
        eventId: image.eventId,
        mimeType: image.mimeType,
        byteLength: image.bytes.length,
        contentHash: image.contentHash,
        abstract: abstract.trim(),
      });
    }
    return media;
  }

  async cleanup(taskId) {
    if (!/^cptask_[0-9a-f]{64}$/.test(taskId)) throw new TypeError("checkpoint cleanup requires a task id");
    const userRoot = String(this.client.userRoot || "").replace(/\/+$/, "");
    if (!/^viking:\/\/user\/[^/]+$/.test(userRoot)) throw new TypeError("checkpoint cleanup requires a bound user root");
    const taskRoot = `${userRoot}/resources/.pi-openviking/checkpoint-inputs/v1/${taskId}`;
    await this.client.deleteSession(taskId);
    await this.client.delete(taskRoot, true);
    const [session, media] = await Promise.all([
      this.client.getSession(taskId),
      this.client.statUri(taskRoot),
    ]);
    const sessionGone = !session.ok && (session.status === 404 || session.error?.code === "NOT_FOUND");
    const mediaGone = media?.ok === true && media.exists === false;
    return sessionGone && mediaGone;
  }
}
