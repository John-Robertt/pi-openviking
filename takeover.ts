import type { OVClient } from "./client.js";
import type { OVConfig } from "./config.js";
import type { SyncCommitOptions, SyncManager } from "./sync.js";
import { TakeoverCore } from "./lib/takeover-core.mjs";

function archiveIdFromUri(uri: string): string {
  const value = uri.trim().replace(/\/+$/, "");
  const archiveId = value.slice(value.lastIndexOf("/") + 1);
  return /^archive_\d+$/.test(archiveId) ? archiveId : "";
}

export function createTakeoverManager(opts: {
  pi: any;
  client: OVClient;
  sync: SyncManager;
  config: OVConfig;
  log?: (message: string) => void;
}): TakeoverCore {
  const { pi, client, sync, config } = opts;
  return new TakeoverCore({
    config,
    io: {
      flush: () => sync.flushForTakeover(),
      commit: async (commitOpts?: SyncCommitOptions) => {
        const recoverable = commitOpts?.queueOnFailure === false;
        const before = recoverable && sync.sessionId
          ? await client.listSessionCommitTasks(sync.sessionId)
          : null;
        if (recoverable && !before) return null;

        const result = await sync.commit(commitOpts);
        if (result?.status !== "transport_unknown") return result;
        if (!sync.sessionId) return { status: "outcome_unknown" };

        const after = await client.listSessionCommitTasks(sync.sessionId);
        if (!after) return { status: "outcome_unknown" };
        const previousIds = new Set(before?.map((task) => task.task_id) ?? []);
        const created = after.filter((task) => !previousIds.has(task.task_id));
        if (created.length !== 1) return { status: "outcome_unknown" };
        const task = created[0];
        return {
          status: "accepted",
          archived: true,
          task_id: task.task_id,
          archive_uri: typeof task.result?.archive_uri === "string" ? task.result.archive_uri : null,
        };
      },
      checkArchive: async (pending: { taskId: string; archiveId: string; archiveUri: string }) => {
        if (!sync.sessionId) return { status: "pending" };
        const task = await client.getTask(pending.taskId);
        if (
          task &&
          (task.task_id !== pending.taskId || task.task_type !== "session_commit" || task.resource_id !== sync.sessionId)
        ) return { status: "failed" };
        if (task && ["failed", "cancelled"].includes(task.status)) {
          return { status: "failed" };
        }
        if (task && task.status !== "completed") return { status: "pending" };

        const taskArchiveUri = typeof task?.result?.archive_uri === "string"
          ? task.result.archive_uri
          : pending.archiveUri;
        const taskArchiveId = archiveIdFromUri(taskArchiveUri);
        if (!taskArchiveId) return task ? { status: "failed" } : { status: "pending" };
        if (pending.archiveUri && taskArchiveUri !== pending.archiveUri) return { status: "failed" };
        if (pending.archiveId && taskArchiveId !== pending.archiveId) return { status: "failed" };

        const archive = await client.getSessionArchive(sync.sessionId, taskArchiveId);
        if (archive && archive.archive_id !== taskArchiveId) return { status: "failed" };
        const overview = archive?.overview?.trim() ?? "";
        return overview
          ? { status: "ready", archiveUri: taskArchiveUri, archiveId: taskArchiveId, overview }
          : { status: "pending" };
      },
      hasActiveCommit: async () => {
        if (!sync.sessionId) return false;
        const tasks = await client.listSessionCommitTasks(sync.sessionId);
        if (!tasks) return true;
        return tasks.some((task) => ["pending", "running", "cancelling"].includes(task.status));
      },
      persistEntry: (customType: string, data: any) => {
        if (typeof pi?.appendEntry === "function") {
          pi.appendEntry(customType, data);
        }
      },
      getWatermark: () => sync.syncedCount,
      log: opts.log,
    },
  });
}
