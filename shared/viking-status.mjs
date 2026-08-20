export const VIKING_STATUS_KEY = "openviking";

export function formatVikingFooter({ connected }) {
  return connected ? "OV ✓" : "OV ✗";
}

export function setVikingFooter(ctx, snapshot) {
  if (typeof ctx?.ui?.setStatus !== "function") return false;
  try {
    ctx.ui.setStatus(VIKING_STATUS_KEY, formatVikingFooter(snapshot));
    return true;
  } catch {
    return false;
  }
}

export function clearVikingFooter(ctx) {
  if (typeof ctx?.ui?.setStatus !== "function") return false;
  try {
    ctx.ui.setStatus(VIKING_STATUS_KEY, undefined);
    return true;
  } catch {
    return false;
  }
}

export function formatVikingCommand({ connected, sessionId, sync, observation }) {
  const acknowledgedLeaves = Array.isArray(sync?.acknowledgedLeaves) ? sync.acknowledgedLeaves : [];
  const pending = Math.max(0, Math.floor(Number(sync?.pendingEntries) || 0));
  const capability = sync?.capability === "ready" ? "可用" : sync?.capability === "mismatch" ? "不兼容" : "待探测";
  const observationText = observation?.state === "ready"
    ? `就绪（accepted=${Math.max(0, Number(observation.accepted) || 0)}，dropped=${Math.max(0, Number(observation.dropped) || 0)}）`
    : observation?.state === "incomplete"
      ? `不完整（${observation.reason || "unknown"}，accepted=${Math.max(0, Number(observation.accepted) || 0)}，dropped=${Math.max(0, Number(observation.dropped) || 0)}）`
      : observation?.state === "disabled" ? "关闭" : "未知";
  const lines = [
    `OpenViking：${connected ? "已连接" : "未连接"}`,
    "模式：完整事件记录",
    `会话：${sessionId || "尚未建立"}`,
    `来源：${sync?.source === "persistent-jsonl" ? "Pi JSONL" : sync?.source === "in-memory" ? "进程内 best-effort" : "尚未读取"}`,
    `适配器：content-api-v1（${capability}）`,
    `观察：${observationText}`,
    `ACK frontier：${acknowledgedLeaves.length} 个 leaves`,
    `待重放：${pending} 个 entry`,
    formatArchiveLine(sync?.archive),
    formatCheckpointLine(sync?.checkpoint),
  ];
  if (!connected && pending > 0) lines.push("主任务：fail-open，连接恢复后从 Pi 来源重放");
  if (sync?.lastFailure) lines.push(`最近同步失败：${sync.lastFailure}`);
  if (sync?.archive?.lastFailure) lines.push(`最近 Archive 失败：${sync.archive.lastFailure}`);
  if (sync?.checkpoint?.lastFailure) lines.push(`最近 checkpoint 失败：${sync.checkpoint.lastFailure}`);
  return lines.join("\n");
}

/** Archive 的提交状态、当前身份和待提交边界。 */
function formatArchiveLine(archive) {
  const committed = Math.max(0, Math.floor(Number(archive?.committed) || 0));
  const waiting = Math.max(0, Math.floor(Number(archive?.pending) || 0));
  const identity = typeof archive?.lastArchiveId === "string" && archive.lastArchiveId
    ? archive.lastArchiveId
    : "尚未形成";
  return `Archive：已提交 ${committed} 个，待提交 ${waiting} 个（最近 ${identity}）`;
}

function formatCheckpointLine(checkpoint) {
  const mode = checkpoint?.mode === "lagging" ? "消费落后"
    : checkpoint?.mode === "processing" ? "处理中"
      : checkpoint?.mode === "failed" ? "失败" : "已赶上";
  const consumed = Math.max(0, Math.floor(Number(checkpoint?.consumed) || 0));
  const pending = Math.max(0, Math.floor(Number(checkpoint?.pending) || 0));
  const tokens = Math.max(0, Math.floor(Number(checkpoint?.backlogTokens) || 0));
  const identity = typeof checkpoint?.lastCheckpointId === "string" && checkpoint.lastCheckpointId
    ? checkpoint.lastCheckpointId
    : "尚未生成";
  return `Checkpoint：${mode}，已消费 ${consumed} 个，积压 ${pending} 个 Archive / ${tokens} tokens（最近 ${identity}）`;
}
