export const VIKING_STATUS_KEY = "openviking";

/**
 * Format the compact OpenViking status shown in Pi's footer.
 * The footer intentionally exposes only the latest health-probe result.
 */
function formatCount(value) {
  const count = Math.max(0, Math.round(Number(value) || 0));
  return String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatVikingFooter({ connected }) {
  return connected ? "OV ✓" : "OV ✗";
}

/** Set the extension-owned footer entry using Pi's keyed status API. */
export function setVikingFooter(ctx, snapshot) {
  if (typeof ctx?.ui?.setStatus !== "function") return false;
  try {
    ctx.ui.setStatus(VIKING_STATUS_KEY, formatVikingFooter(snapshot));
    return true;
  } catch {
    return false;
  }
}

/** Clear the extension-owned footer entry. */
export function clearVikingFooter(ctx) {
  if (typeof ctx?.ui?.setStatus !== "function") return false;
  try {
    ctx.ui.setStatus(VIKING_STATUS_KEY, undefined);
    return true;
  } catch {
    return false;
  }
}

/** Format the on-demand `/viking` snapshot. */
export function formatVikingCommand({ connected, sessionId, added, threshold, keepRecentTurns, takeover }) {
  const synced = Math.max(0, Math.floor(Number(added) || 0));
  const trigger = Math.max(0, Math.round(Number(threshold) || 0));
  const lines = [
    `OpenViking：${connected ? "已连接" : "未连接"}`,
    `模式：${takeover ? "上下文接管" : "同步与召回"}`,
    `会话：${sessionId || "尚未建立"}`,
    `最近捕获：${synced} 条消息`,
  ];

  if (!takeover) {
    lines.push(`自动提交阈值：${formatCount(trigger)} tokens`);
    return lines.join("\n");
  }

  const covered = Math.max(0, Math.floor(Number(takeover.coveredUserTurns) || 0));
  const total = Math.max(covered, Math.floor(Number(takeover.lastSeenUserTurns) || 0));
  const recent = total - covered;
  if (covered > 0) {
    lines.push(`上下文：${covered} 个旧用户轮次已归档，${recent} 个最近用户轮次保留原文`);
  } else if (total > 0) {
    lines.push(`上下文：${total} 个用户轮次保留原文`);
  } else {
    lines.push("上下文：尚无用户轮次");
  }

  const pendingTokens = Math.max(0, Math.round(Number(takeover.pendingTokens) || 0));
  const retainedTurns = Math.max(1, Math.floor(Number(keepRecentTurns) || 0));
  lines.push(pendingTokens > 0
    ? `待确认内容：约 ${formatCount(pendingTokens)} tokens`
    : "待确认内容：无");
  lines.push(`自动归档条件：待确认内容达到 ${formatCount(trigger)} tokens，且用户轮次超过 ${retainedTurns}`);

  const pending = takeover.pendingArchive;
  const confirmedId = takeover.confirmedArchive?.archiveId || "";
  if (pending) {
    const pendingId = pending.archiveId || "";
    lines.push(pendingId ? `归档：等待确认 ${pendingId}` : "归档：等待确认");
    if (!pendingId && pending.taskId) lines.push(`任务：${pending.taskId}`);
    if (confirmedId) lines.push(`最近确认：${confirmedId}`);
  } else if (takeover.awaitingCommitDrain) {
    lines.push("归档：正在核验已有提交任务，期间不会重复提交");
    if (confirmedId) lines.push(`最近确认：${confirmedId}`);
  } else if (confirmedId) {
    lines.push(`归档：已确认 ${confirmedId}`);
  } else {
    lines.push("归档：尚无");
  }

  return lines.join("\n");
}
