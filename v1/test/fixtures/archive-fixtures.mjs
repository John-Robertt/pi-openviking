// Archive 测试共用的内存 Content 边界与带实测 usage 的事件链。

import { createHash } from "node:crypto";

import { projectPiEntries } from "../../shared/recorded-event.mjs";

export const ARCHIVE_USER_ROOT = "viking://user/test";

export class MemoryContentTransport {
  constructor(userRoot = ARCHIVE_USER_ROOT) {
    this.directories = new Set([`${userRoot}/resources`]);
    this.files = new Map();
    this.busyOnce = null;
  }

  async statUri(uri) {
    return {
      ok: true,
      exists: this.directories.has(uri) || this.files.has(uri),
      isDir: this.directories.has(uri),
      status: 200,
    };
  }

  async mkdirUri(uri) {
    this.directories.add(uri);
    return { ok: true, status: 200, result: { uri } };
  }

  async downloadBytes(uri) {
    const bytes = this.files.get(uri);
    if (!bytes) return { ok: false, status: 404, bytes: null };
    return { ok: true, status: 200, bytes: Buffer.from(bytes) };
  }

  async batchWrite(request) {
    const created = [];
    const updated = [];
    const unchanged = [];
    for (const operation of request.operations) {
      if (this.busyOnce && operation.uri === this.busyOnce) {
        this.busyOnce = null;
        return {
          ok: false,
          status: 409,
          error: { code: "CONFLICT", details: { resource: operation.uri, conflict_type: "path_busy", retryable: true } },
        };
      }
      const bytes = Buffer.from(operation.content_base64, "base64");
      const existing = this.files.get(operation.uri);
      if (operation.precondition.kind === "replace_if_hash") {
        const current = `sha256:${createHash("sha256").update(existing ?? Buffer.alloc(0)).digest("hex")}`;
        if (existing === undefined || current !== operation.precondition.base_hash) {
          return { ok: false, status: 409, error: { code: "CONFLICT", details: { resource: operation.uri } } };
        }
        this.files.set(operation.uri, bytes);
        updated.push(operation.uri);
        continue;
      }
      if (existing !== undefined) {
        if (existing.equals(bytes)) { unchanged.push(operation.uri); continue; }
        return { ok: false, status: 409, error: { code: "CONFLICT", details: { resource: operation.uri } } };
      }
      this.files.set(operation.uri, bytes);
      created.push(operation.uri);
    }
    return { ok: true, status: 200, result: { root_uri: request.root_uri, created, updated, unchanged } };
  }
}

/**
 * 依次追加的 Pi entry 链。`chars` 直接决定该事件的上下文权重（约 chars/4 token），
 * 使归档边界在测试中可以按预期位置断言。
 */
export function archiveEntryChain(specs) {
  const entries = [];
  let parentId = null;
  specs.forEach((spec, index) => {
    const id = `entry-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: `2026-08-19T00:00:${String(index).padStart(2, "0")}.000Z`,
      message: { role: spec.role, content: `${index}`.padEnd(spec.chars ?? 4000, "x") },
    });
    parentId = id;
  });
  return entries;
}

/** 每个事件权重 1000 token；累计压力 1000 / 2000 / 3000 / 4000 / 5000。 */
export const ARCHIVE_LINEAR_CHAIN = Object.freeze([
  { role: "user", chars: 4000 },
  { role: "assistant", chars: 4000 },
  { role: "toolResult", chars: 4000 },
  { role: "assistant", chars: 4000 },
  { role: "assistant", chars: 4000 },
]);

export function archiveEvents(sessionId, specs = ARCHIVE_LINEAR_CHAIN) {
  return projectPiEntries(sessionId, archiveEntryChain(specs));
}
