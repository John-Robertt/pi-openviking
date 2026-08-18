/**
 * Probe extension for live e2e runs.
 *
 * The verifier loads this extension last and passes an exclusively opened
 * artifact file descriptor. The probe never resolves or owns filesystem paths.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fstatSync, writeSync } from "node:fs";

export default function (pi: ExtensionAPI) {
  const rawFd = process.env.OV_E2E_FD;
  if (!rawFd) return;
  if (!/^(?:[3-9]|[1-9][0-9]{1,2})$/.test(rawFd)) {
    throw new Error("OV_E2E_FD must be an inherited file descriptor between 3 and 999");
  }

  const fd = Number(rawFd);
  const stat = fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new Error("OV_E2E_FD must reference a regular file private to the current user");
  }

  const turn = process.env.OV_E2E_TURN ?? "0";
  if (!/^(0|[1-9][0-9]{0,8})$/.test(turn)) {
    throw new Error("OV_E2E_TURN must be a non-negative decimal integer");
  }

  let n = 0;
  let capturedSessionId: string | undefined;

  const writeRecord = (record: unknown) => {
    const serialized = JSON.stringify(record);
    if (serialized === undefined) throw new Error("probe record is not JSON-serializable");
    const bytes = Buffer.from(`${serialized}\n`);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("probe artifact write made no progress");
      offset += written;
    }
  };

  const captureSessionId = (ctx: { sessionManager?: { getSessionId?: () => string } }) => {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (!sessionId) return;
    if (capturedSessionId && capturedSessionId !== sessionId) {
      throw new Error("Pi session ID changed during a live probe segment");
    }
    if (!capturedSessionId) {
      capturedSessionId = sessionId;
      writeRecord({ kind: "session", sessionId });
    }
  };

  pi.on("session_start", async (_event, ctx) => captureSessionId(ctx));
  pi.on("before_agent_start", async (_event, ctx) => captureSessionId(ctx));
  pi.on("before_provider_request", async (event) => {
    n++;
    writeRecord({ kind: "providerPayload", turn: Number(turn), index: n, payload: event.payload });
  });
}
