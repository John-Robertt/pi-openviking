import { createHash } from "node:crypto";

import { syncAckFileKey } from "../../shared/sync-ack.mjs";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checkManifestHash(manifestBytes, hashFileText) {
  const expected = String(hashFileText || "").trim();
  return /^[0-9a-f]{64}$/.test(expected) && sha256Hex(manifestBytes) === expected;
}

export function derivePassed(assertions) {
  return assertions.length > 0 && assertions.every((assertion) => assertion.pass === true);
}

export function conflictBytesOf(bytes) {
  const copy = Buffer.from(bytes);
  copy[copy.length - 1] = copy[copy.length - 1] ^ 0x01;
  return copy;
}

export function ackFileKey(endpoint, account, user, sessionId) {
  return syncAckFileKey({ endpoint, account, user }, sessionId);
}

export class AssertionLog {
  constructor(output = process.stderr) {
    this.items = [];
    this.output = output;
  }

  check(workload, id, expected, actual, pass, detail) {
    const entry = { workload, id, expected, actual, pass: pass === true };
    if (detail !== undefined) entry.delta = String(detail).slice(0, 400);
    this.items.push(entry);
    const mark = entry.pass ? "✓" : "✗";
    this.output.write(`  ${mark} [${workload}] ${id}: expected=${truncate(expected)} actual=${truncate(actual)}${entry.pass ? "" : ` (${entry.delta ?? ""})`}\n`);
    return entry.pass;
  }

  fail(workload, id, error) {
    const errorClass = typeof error?.name === "string" ? error.name : "Error";
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : null;
    const status = Number.isInteger(error?.status) ? error.status : null;
    return this.check(workload, id, "no exception", errorClass, false,
      [code ? `code=${code}` : "", status !== null ? `status=${status}` : ""].filter(Boolean).join(" ") || undefined);
  }
}

function truncate(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text && text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function createRpcLineParser() {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const out = [];
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push({ type: "__unparsed", line: line.slice(0, 200) });
      }
    }
    return out;
  };
}
