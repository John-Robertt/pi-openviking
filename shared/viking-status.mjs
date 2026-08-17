export const VIKING_STATUS_KEY = "openviking";

/**
 * Format the compact OpenViking status shown in Pi's footer.
 * `connected` is the latest health-probe result; takeover data is local session state.
 */
export function formatVikingFooter({ connected, added, sessionId, threshold, takeover }) {
  const pending = takeover
    ? ` · ctx ${takeover.coveredUserTurns ?? 0} · ~${takeover.pendingTokens ?? 0}/${threshold}`
    : ` · ✎ ${threshold}`;
  return `${connected ? "OV ✓" : "OV ✗"} · ↩${added}${pending} · ${sessionId ? sessionId.slice(0, 12) : "none"}`;
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
export function formatVikingCommand({ connected, sessionId, takeover }) {
  const waitingId = takeover?.pendingArchive?.archiveId || takeover?.pendingArchive?.taskId;
  const waiting = waitingId ? `, waiting ${waitingId}` : "";
  const takeoverInfo = takeover
    ? ` | takeover: ${takeover.coveredUserTurns ?? 0}/${takeover.lastSeenUserTurns ?? 0} turns archived, ~${takeover.pendingTokens ?? 0} tokens pending${waiting}`
    : "";
  const sid = sessionId ? `${sessionId.slice(0, 12)}...` : "none";
  return `OpenViking: ${connected ? "connected" : "disconnected"} | session: ${sid}${takeoverInfo}`;
}
