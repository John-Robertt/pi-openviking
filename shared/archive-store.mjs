// Archive 在 OpenViking 上的提交点。
//
// 实测事实：一次 batch-write 的多个对象逐个变为可见，进程崩溃还会在目标 URI 上留下
// 0 字节内容。因此 Archive 的原子性不能来自服务端写入语义，而由三条规则共同提供：
//
// 1. 唯一提交点——事件已经是同步层确认过的 immutable 对象，Archive 只写一个 manifest；
// 2. 内容自证——manifest 必须能复算出自己的 `archiveId` 与规范字节，崩溃残留因此
//    等价于“不存在”；
// 3. 残留替换——未通过自证的字节从来不是 Archive，恢复时按其实际 hash 替换它，
//    已自证但范围不同的 manifest 才是真正的完整性冲突。

import { createHash } from "node:crypto";

import {
  ArchiveIntegrityError,
  archiveContentHash,
  archiveManifestBytes,
  buildArchiveManifest,
  parseArchiveManifest,
  planArchives,
} from "./archive.mjs";
import { canonicalJsonBytes } from "./canonical-json.mjs";
import {
  CREATE_IF_ABSENT,
  ContentWriteError,
  ensureDirectoryChain,
  replaceIfHash,
  writeContentObjects,
} from "./content-objects.mjs";
import { observation as processObservation } from "./observe.mjs";
import { recordedEventBytes } from "./recorded-event.mjs";

export const ARCHIVE_STORAGE_VERSION = 1;
const ARCHIVE_STORAGE_SEGMENT = `archives/v${ARCHIVE_STORAGE_VERSION}`;
const ARCHIVE_STORAGE_DOMAIN = "pi-openviking/archive-storage";
const ARCHIVE_ID_PATTERN = /^arc_[0-9a-f]{64}$/;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function archiveStorageLocation(userRoot, sessionId, archiveId) {
  const root = String(userRoot || "").replace(/\/+$/, "");
  if (!/^viking:\/\/user\/[^/]+$/.test(root)) throw new TypeError("Archive storage requires a bound user root");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
  if (!ARCHIVE_ID_PATTERN.test(archiveId)) throw new TypeError(`invalid archiveId: ${archiveId}`);
  const sessionKey = createHash("sha256")
    .update(canonicalJsonBytes([ARCHIVE_STORAGE_DOMAIN, ARCHIVE_STORAGE_VERSION, "session", sessionId]))
    .digest("hex");
  const digest = archiveId.slice(4);
  const sessionRoot = `${root}/resources/.pi-openviking/${ARCHIVE_STORAGE_SEGMENT}/${sessionKey}`;
  const shardRoot = `${sessionRoot}/${digest.slice(0, 2)}`;
  return {
    sessionKey,
    sessionRoot,
    shardRoot,
    manifestUri: `${shardRoot}/.${archiveId}.json`,
  };
}

export class ArchiveManager {
  constructor(transport, { userRoot, adapter, budgets, observation = processObservation }) {
    this.transport = transport;
    this.userRoot = userRoot;
    this.adapter = adapter;
    this.budgets = budgets;
    this.observe = observation;
    this.createdDirectories = new Set();
    this.committed = new Map();
    this.state = { committed: 0, lastArchiveId: null, pending: 0, lastFailure: null };
  }

  get status() {
    return { ...this.state };
  }

  observeFinalState() {
    this.observe.emit("archive_state", "snapshot", this.state, null);
  }

  /**
   * 在一条已确认事件链上形成全部到期的 Archive。
   *
   * 计划只由事件自身携带的实测 token 决定，因此重复调用得到同一组 Archive；提交是
   * 幂等的，已提交的 Archive 只做一次读回自证。
   */
  async formArchives(sessionId, events) {
    const previous = { ...this.state };
    let planned = 0;
    let created = 0;
    try {
      const plans = planArchives(events, this.budgets);
      planned = plans.length;
      this.state.pending = plans.filter((plan) => !this.committed.has(plan.endIndex)).length;
      this.observe.emit("archive_plan", plans.length, this.state.pending, events.length);
      for (const plan of plans) {
        if (this.committed.has(plan.endIndex)) continue;
        const result = await this.commit(sessionId, events.slice(plan.startIndex, plan.endIndex + 1));
        this.committed.set(plan.endIndex, result.archiveId);
        this.state.committed = this.committed.size;
        this.state.lastArchiveId = result.archiveId;
        this.state.pending = Math.max(0, this.state.pending - 1);
        this.state.lastFailure = null;
        if (result.branch !== "already_committed") created++;
      }
    } catch (error) {
      // Archive 失败不改变已经持久化的事件和 ACK：状态退回待重试，Pi 主任务继续。
      this.state.lastFailure = `${error?.name || "Error"}: ${error?.message || String(error)}`;
      this.observe.emit(
        "archive_failure",
        error,
        error instanceof ArchiveIntegrityError ? "manifest_integrity" : "commit",
        "abort_operation",
        "pending_retry",
        this.state.committed,
        this.state.pending,
      );
    }
    if (previous.committed !== this.state.committed || previous.pending !== this.state.pending) {
      this.observe.emit("archive_state", "change", previous, this.state);
    }
    return { planned, created, ...this.status };
  }

  async commit(sessionId, events) {
    const manifest = buildArchiveManifest(sessionId, events);
    const bytes = archiveManifestBytes(manifest);
    const location = archiveStorageLocation(this.userRoot, sessionId, manifest.archiveId);

    const existing = await this.readManifestBytes(location.manifestUri);
    if (existing && existing.equals(bytes)) {
      parseArchiveManifest(existing);
      this.observe.emit("archive_commit", "already_committed", manifest.eventCount);
      return { archiveId: manifest.archiveId, branch: "already_committed", manifest };
    }
    if (existing) {
      let selfProving = true;
      try {
        parseArchiveManifest(existing);
      } catch {
        selfProving = false;
      }
      if (selfProving) {
        throw new ArchiveIntegrityError(
          "archiveId is already bound to a different manifest",
          manifest.archiveId,
        );
      }
    }

    await this.proveReferencedEvents(sessionId, manifest, events);
    await ensureDirectoryChain(
      this.transport,
      `${this.userRoot.replace(/\/+$/, "")}/resources`,
      location.shardRoot,
      this.createdDirectories,
    );
    const precondition = existing ? replaceIfHash(sha256(existing)) : CREATE_IF_ABSENT;
    const result = await writeContentObjects(this.transport, location.sessionRoot, [
      { uri: location.manifestUri, bytes, precondition },
    ]);
    if (existing ? result.updated.size !== 1 : result.created.size !== 1) {
      throw new ArchiveIntegrityError("Archive manifest was not accepted as the expected write", manifest.archiveId);
    }

    const stored = await this.readManifestBytes(location.manifestUri);
    if (!stored || !stored.equals(bytes)) {
      throw new ArchiveIntegrityError("Archive manifest read-back does not match the committed bytes", manifest.archiveId);
    }
    parseArchiveManifest(stored);
    const branch = existing ? "repaired_residue" : "created";
    this.observe.emit("archive_commit", branch, manifest.eventCount);
    return { archiveId: manifest.archiveId, branch, manifest };
  }

  /**
   * Archive 的接受证明：逐项回读被引用的事件并复算身份、顺序与聚合 hash。
   *
   * 写出时的正确性不能替代该证明——Archive 一旦可见就代表“manifest 与全部引用同时
   * 有效”，这个断言只能由读路径产生。
   */
  async proveReferencedEvents(sessionId, manifest, events) {
    const stored = [];
    for (const event of events) {
      const readBack = await this.adapter.readEvent(sessionId, event.eventId);
      if (!readBack.bytes.equals(recordedEventBytes(event))) {
        throw new ArchiveIntegrityError(`stored event bytes differ from the archived event: ${event.eventId}`, manifest.archiveId);
      }
      stored.push(readBack.event);
    }
    assertEventChain(stored, manifest);
    if (archiveContentHash(stored) !== manifest.contentHash) {
      throw new ArchiveIntegrityError("archived events do not recompute the manifest content hash", manifest.archiveId);
    }
  }

  async readManifestBytes(uri) {
    const status = await this.transport.statUri(uri);
    if (!status?.ok) throw new ContentWriteError(`OpenViking stat failed: ${uri}`, { status: status?.status || 0 });
    if (!status.exists) return null;
    const response = await this.transport.downloadBytes(uri);
    if (!response?.ok || !Buffer.isBuffer(response.bytes)) {
      throw new ContentWriteError(`OpenViking download failed: ${uri}`);
    }
    return response.bytes;
  }

  /** 按 `archiveId` 确定性读取 manifest，读到的字节必须自证。 */
  async read(sessionId, archiveId) {
    const location = archiveStorageLocation(this.userRoot, sessionId, archiveId);
    const bytes = await this.readManifestBytes(location.manifestUri);
    if (!bytes) throw new ArchiveIntegrityError(`Archive is not committed: ${archiveId}`, archiveId);
    const manifest = parseArchiveManifest(bytes);
    if (manifest.archiveId !== archiveId || manifest.sessionId !== sessionId) {
      throw new ArchiveIntegrityError("Archive manifest does not belong to the requested location", archiveId);
    }
    return manifest;
  }

  /**
   * 按 manifest materialize 全部事件并重新验证。
   *
   * 事件序列不写进 manifest：每个事件自己携带 `parentId`，从 `lastEventId` 沿链回溯
   * `eventCount` 步即可确定顺序，manifest 因而保持常数大小，且展开结果由不可变事件
   * 自身证明。
   */
  async expand(sessionId, archiveId) {
    const manifest = await this.read(sessionId, archiveId);
    const reversed = [];
    let cursor = manifest.lastEventId;
    for (let index = 0; index < manifest.eventCount; index++) {
      if (typeof cursor !== "string") {
        throw new ArchiveIntegrityError("archived event chain ends before the manifest event count", archiveId);
      }
      const { event } = await this.adapter.readEvent(sessionId, cursor);
      reversed.push(event);
      cursor = event.parentId;
    }
    const events = reversed.reverse();
    assertEventChain(events, manifest);
    if (archiveContentHash(events) !== manifest.contentHash) {
      throw new ArchiveIntegrityError("expanded events do not recompute the manifest content hash", archiveId);
    }
    return { manifest, events };
  }
}

function assertEventChain(events, manifest) {
  if (events.length !== manifest.eventCount) {
    throw new ArchiveIntegrityError("archived event count does not match the manifest", manifest.archiveId);
  }
  if (events[0].eventId !== manifest.firstEventId || events.at(-1).eventId !== manifest.lastEventId) {
    throw new ArchiveIntegrityError("archived event boundaries do not match the manifest", manifest.archiveId);
  }
  if ((events.at(-1).stepId ?? null) !== manifest.lastStepId) {
    throw new ArchiveIntegrityError("archived step boundary does not match the manifest", manifest.archiveId);
  }
  for (let index = 1; index < events.length; index++) {
    if (events[index].parentId !== events[index - 1].eventId) {
      throw new ArchiveIntegrityError(`archived events are not contiguous at ${events[index].eventId}`, manifest.archiveId);
    }
    if (events[index].source?.sessionId !== manifest.sessionId) {
      throw new ArchiveIntegrityError(`archived event belongs to another session: ${events[index].eventId}`, manifest.archiveId);
    }
  }
}
