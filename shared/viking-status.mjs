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
  ];
  if (!connected && pending > 0) lines.push("主任务：fail-open，连接恢复后从 Pi 来源重放");
  if (sync?.lastFailure) lines.push(`最近同步失败：${sync.lastFailure}`);
  return lines.join("\n");
}
