// Archive 在 OpenViking 上的提交点。
//
// 规则本身见 `docs/spec.md` 的“Archive 是一个原子对象”。这里只记录它们为什么不能更简单：
// 实测中一次 batch-write 的多个对象逐个变为可见，进程崩溃还会在目标 URI 上留下 0 字节
// 内容，因此“写成功”与“对象存在”都不能作为接受证明，原子性只能由唯一提交点加内容自证
// 提供，而不能依赖服务端写入语义。

import { createHash } from "node:crypto";

import {
  ArchiveIntegrityError,
  archiveContentHash,
  archiveId,
  archiveManifestBytes,
  buildArchiveManifest,
  parseArchiveManifest,
  eventTokenWeight,
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

const ARCHIVE_STORAGE_VERSION = 1;
const ARCHIVE_STORAGE_SEGMENT = `archives/v${ARCHIVE_STORAGE_VERSION}`;
const ARCHIVE_STORAGE_DOMAIN = "pi-openviking/archive-storage";
const ARCHIVE_ID_PATTERN = /^arc_[0-9a-f]{64}$/;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** 一个会话的 Archive 命名空间根。 */
export function archiveSessionRoot(userRoot, sessionId) {
  const root = String(userRoot || "").replace(/\/+$/, "");
  if (!/^viking:\/\/user\/[^/]+$/.test(root)) throw new TypeError("Archive storage requires a bound user root");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
  const sessionKey = createHash("sha256")
    .update(canonicalJsonBytes([ARCHIVE_STORAGE_DOMAIN, ARCHIVE_STORAGE_VERSION, "session", sessionId]))
    .digest("hex");
  return `${root}/resources/.pi-openviking/${ARCHIVE_STORAGE_SEGMENT}/${sessionKey}`;
}

export function archiveStorageLocation(userRoot, sessionId, id) {
  if (!ARCHIVE_ID_PATTERN.test(id)) throw new TypeError(`invalid archiveId: ${id}`);
  const sessionRoot = archiveSessionRoot(userRoot, sessionId);
  const shardRoot = `${sessionRoot}/${id.slice(4, 6)}`;
  return { sessionRoot, shardRoot, manifestUri: `${shardRoot}/.${id}.json` };
}

export class ArchiveManager {
  constructor(transport, { userRoot, adapter, budgets, observation = processObservation }) {
    this.transport = transport;
    this.userRoot = userRoot;
    this.adapter = adapter;
    this.budgets = budgets;
    this.observe = observation;
    this.createdDirectories = new Set();
    // 已在本进程确认提交的 archiveId。键必须是身份而不是位置：分支切换后同一下标
    // 指向不同事件，按位置缓存会让另一条分支上的 Archive 被静默跳过。
    this.confirmed = new Set();
    this.expandedCache = new Map();
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
   * 计划只由事件自身的上下文权重决定，因此重复调用得到同一组 Archive；提交是幂等的，
   * 已确认的 Archive 只做一次读回自证。计数取自当前来源重算出的计划，不是进程内累加，
   * 因此换分支或重启后仍然描述当前分支的真实进度。
   */
  async formArchives(sessionId, events) {
    const previous = { ...this.state };
    let planned = 0;
    let created = 0;
    const archives = [];
    try {
      const plans = planArchives(events, this.budgets).map((plan) => ({
        ...plan,
        archiveId: archiveId(
          sessionId,
          events[plan.startIndex].eventId,
          events[plan.endIndex].eventId,
          plan.endIndex - plan.startIndex + 1,
        ),
      }));
      planned = plans.length;
      // lastFailure 描述本轮：本轮出现的任何失败都会重新写入，因此持续存在的冲突会被
      // 持续报告，而不会被同一轮里其他 Archive 的成功抹掉。
      this.state.lastFailure = null;
      this.state.committed = plans.filter((plan) => this.confirmed.has(plan.archiveId)).length;
      this.state.pending = planned - this.state.committed;
      this.observe.emit("archive_plan", planned, this.state.pending, events.length);
      for (const plan of plans) {
        const range = events.slice(plan.startIndex, plan.endIndex + 1);
        const descriptor = {
          manifest: buildArchiveManifest(sessionId, range),
          tokenCount: range.reduce((sum, event) => sum + eventTokenWeight(event), 0),
        };
        if (this.confirmed.has(plan.archiveId)) {
          archives.push(descriptor);
          continue;
        }
        try {
          const result = await this.commit(sessionId, range);
          this.confirmed.add(result.archiveId);
          archives.push({ ...descriptor, manifest: result.manifest });
          this.state.committed += 1;
          this.state.pending = Math.max(0, this.state.pending - 1);
          this.state.lastArchiveId = result.archiveId;
          if (result.branch !== "already_committed") created++;
        } catch (error) {
          // 各 Archive 是彼此独立的自证对象，范围互不重叠。绑定到某一个 archiveId 的
          // 完整性冲突只让那一个 Archive 停下；传输类失败对后续必然同样失败，中止本轮。
          if (!(error instanceof ArchiveIntegrityError)) throw error;
          this.recordFailure(error, "manifest_integrity", "skip_archive");
        }
      }
    } catch (error) {
      this.recordFailure(error, "commit", "pending_retry");
    }
    if (previous.committed !== this.state.committed || previous.pending !== this.state.pending) {
      this.observe.emit("archive_state", "change", previous, this.state);
    }
    return { planned, created, archives, ...this.status };
  }

  /** Archive 失败不改变已经持久化的事件和 ACK：只记录处置，Pi 主任务继续。 */
  recordFailure(error, errorCode, branch) {
    this.state.lastFailure = `${error?.name || "Error"}: ${error?.message || String(error)}`;
    this.observe.emit("archive_failure", error, errorCode, "abort_operation", branch,
      this.state.committed, this.state.pending);
  }

  async commit(sessionId, events) {
    const manifest = buildArchiveManifest(sessionId, events);
    const bytes = archiveManifestBytes(manifest);
    const location = archiveStorageLocation(this.userRoot, sessionId, manifest.archiveId);

    const existing = await this.readManifestBytes(location.manifestUri);
    if (existing && existing.equals(bytes)) {
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
    // create_if_absent 返回 unchanged 表示另一进程已写入完全相同的字节；这正是最强的
    // 接受证明，不是完整性错误。读回自证仍然照常执行。
    const accepted = existing ? result.updated.size === 1 : result.created.size + result.unchanged.size === 1;
    if (!accepted) {
      throw new ContentWriteError(`OpenViking did not accept the Archive manifest write: ${location.manifestUri}`);
    }

    const stored = await this.readManifestBytes(location.manifestUri);
    if (!stored || !stored.equals(bytes)) {
      throw new ArchiveIntegrityError("Archive manifest read-back does not match the committed bytes", manifest.archiveId);
    }
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
    // 逐项字节相等已经蕴含聚合 hash 相等；这里只需再证明被收录的范围本身是一条连续链，
    // 因为 manifest 的构造不检查连续性。
    assertEventChain(stored, manifest);
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
    // Archive 是不可变自证对象，archiveId 由内容身份决定：同一 archiveId 的展开结果在进程内
    // 永久有效。checkpoint 轮询期间会反复展开同一 Archive，缓存避免重复下载与逐事件 hash。
    // 失败不缓存——传输类失败必须能在下一轮重试。
    const cached = this.expandedCache.get(archiveId);
    if (cached) return cached;
    const pending = this.expandUncached(sessionId, archiveId);
    this.expandedCache.set(archiveId, pending);
    pending.catch(() => this.expandedCache.delete(archiveId));
    return pending;
  }

  async expandUncached(sessionId, archiveId) {
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
  for (let index = 1; index < events.length; index++) {
    if (events[index].parentId !== events[index - 1].eventId) {
      throw new ArchiveIntegrityError(`archived events are not contiguous at ${events[index].eventId}`, manifest.archiveId);
    }
    if (events[index].source?.sessionId !== manifest.sessionId) {
      throw new ArchiveIntegrityError(`archived event belongs to another session: ${events[index].eventId}`, manifest.archiveId);
    }
  }
}
