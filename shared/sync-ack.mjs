import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJsonBytes } from "./canonical-json.mjs";

export const SYNC_ACK_IDENTITY_VERSION = 1;
const SYNC_ACK_DOMAIN = "pi-openviking/sync-ack";

export function syncAckFileKey(target, sessionId) {
  return createHash("sha256")
    .update(canonicalJsonBytes([SYNC_ACK_DOMAIN, SYNC_ACK_IDENTITY_VERSION, target, sessionId]))
    .digest("hex");
}

export function normalizeSyncAck(value) {
  const leaves = Array.isArray(value?.acknowledgedLeaves)
    ? value.acknowledgedLeaves.filter((leaf) => typeof leaf === "string" && leaf.length > 0)
    : [];
  return { acknowledgedLeaves: [...new Set(leaves)].sort() };
}

export function isAncestorEntry(ancestorId, descendantId, parentById) {
  let current = descendantId;
  const visited = new Set();
  while (typeof current === "string") {
    if (current === ancestorId) return true;
    if (visited.has(current)) throw new Error(`Pi entry parent cycle at: ${current}`);
    visited.add(current);
    current = parentById.get(current) ?? null;
  }
  return false;
}

export function isEntryAcknowledged(ack, entryId, parentById) {
  return normalizeSyncAck(ack).acknowledgedLeaves
    .some((leaf) => isAncestorEntry(entryId, leaf, parentById));
}

export function advanceSyncAck(ack, entryId, parentById) {
  if (!parentById.has(entryId)) throw new Error(`cannot acknowledge unknown Pi entry: ${entryId}`);
  const current = normalizeSyncAck(ack).acknowledgedLeaves;
  if (current.some((leaf) => isAncestorEntry(entryId, leaf, parentById))) {
    return { acknowledgedLeaves: current };
  }
  const leaves = current.filter((leaf) => !isAncestorEntry(leaf, entryId, parentById));
  leaves.push(entryId);
  return normalizeSyncAck({ acknowledgedLeaves: leaves });
}

export async function readSyncAck(path) {
  try {
    return normalizeSyncAck(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { acknowledgedLeaves: [] };
    throw new Error(`SyncAck is invalid: ${error?.message || String(error)}`);
  }
}

export async function writeSyncAck(path, ack) {
  const normalized = normalizeSyncAck(ack);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return normalized;
}
