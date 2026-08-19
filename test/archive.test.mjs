import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveIntegrityError,
  archiveContentHash,
  archiveId,
  archiveManifestBytes,
  buildArchiveManifest,
  eventTokenWeight,
  parseArchiveManifest,
  planArchives,
} from "../shared/archive.mjs";
import { ArchiveManager, archiveStorageLocation } from "../shared/archive-store.mjs";
import { ContentBusyError, ContentConflictError } from "../shared/content-objects.mjs";
import { RecordedEventAdapter } from "../shared/recorded-event-adapter.mjs";
import { recordedEventBytes } from "../shared/recorded-event.mjs";
import {
  ARCHIVE_LINEAR_CHAIN,
  ARCHIVE_USER_ROOT as USER_ROOT,
  MemoryContentTransport,
  archiveEvents,
} from "./fixtures/archive-fixtures.mjs";

const SESSION = "archive-session";
const BUDGETS = { chunkTokenBudget: 1000, rawTailTokenBudget: 1000 };

function eventsOf(specs = ARCHIVE_LINEAR_CHAIN) {
  return archiveEvents(SESSION, specs);
}

async function storedManager(events, budgets = BUDGETS) {
  const transport = new MemoryContentTransport();
  const adapter = new RecordedEventAdapter(transport, { userRoot: USER_ROOT });
  await adapter.writeEvents(SESSION, events);
  return { transport, adapter, manager: new ArchiveManager(transport, { userRoot: USER_ROOT, adapter, budgets }) };
}

test("archiveId 由会话与事件范围确定，范围不同即身份不同", () => {
  const events = eventsOf();
  const first = archiveId(SESSION, events[0].eventId, events[2].eventId, 3);
  assert.match(first, /^arc_[0-9a-f]{64}$/);
  assert.equal(first, archiveId(SESSION, events[0].eventId, events[2].eventId, 3));
  assert.notEqual(first, archiveId(SESSION, events[0].eventId, events[3].eventId, 4));
  assert.notEqual(first, archiveId("other-session", events[0].eventId, events[2].eventId, 3));
  assert.throws(() => archiveId(SESSION, events[0].eventId, events[2].eventId, 0), TypeError);
});

test("聚合 hash 覆盖事件的完整字节与顺序", () => {
  const events = eventsOf();
  const range = events.slice(0, 3);
  assert.equal(archiveContentHash(range), archiveContentHash(range.slice()));
  assert.notEqual(archiveContentHash(range), archiveContentHash([range[1], range[0], range[2]]));
  assert.notEqual(archiveContentHash(range), archiveContentHash(range.slice(0, 2)));
});

test("manifest 必须自证：非 JSON、空字节、字段篡改和非规范字节都不是 Archive", () => {
  const events = eventsOf().slice(0, 3);
  const manifest = buildArchiveManifest(SESSION, events);
  const bytes = archiveManifestBytes(manifest);
  assert.deepEqual(parseArchiveManifest(bytes), manifest);

  assert.throws(() => parseArchiveManifest(Buffer.alloc(0)), ArchiveIntegrityError);
  assert.throws(() => parseArchiveManifest(bytes.subarray(0, bytes.length - 5)), ArchiveIntegrityError);
  assert.throws(
    () => parseArchiveManifest(archiveManifestBytes({ ...manifest, eventCount: manifest.eventCount + 1 })),
    ArchiveIntegrityError,
  );
  assert.throws(
    () => parseArchiveManifest(Buffer.from(`${JSON.stringify(manifest)} `)),
    ArchiveIntegrityError,
  );
  assert.throws(
    () => parseArchiveManifest(archiveManifestBytes({ ...manifest, extra: 1 })),
    ArchiveIntegrityError,
  );
});

test("事件权重度量的是进入上下文的内容，不依赖 provider 是否报告计量", () => {
  const events = eventsOf();
  for (const event of events) assert.equal(eventTokenWeight(event), 1000);
  assert.equal(eventTokenWeight({ payload: { part: { value: "x".repeat(10) } } }), 3);
  // 没有可分 part 的事件按其完整 entry 规范字节折算，仍然确定。
  const opaque = { payload: { entry: { type: "custom", data: "y".repeat(40) } } };
  assert.equal(eventTokenWeight(opaque), eventTokenWeight(opaque));
  assert.ok(eventTokenWeight(opaque) > 10);
});

test("Archive 边界落在压力轴的绝对位置，后续增长不移动既有边界", () => {
  const events = eventsOf();
  const plans = planArchives(events, BUDGETS);
  assert.deepEqual(plans, [
    { startIndex: 0, endIndex: 0 },
    { startIndex: 1, endIndex: 2 },
    { startIndex: 3, endIndex: 3 },
  ]);

  const grown = eventsOf([...ARCHIVE_LINEAR_CHAIN, { role: "assistant", chars: 4000 }]);
  const grownPlans = planArchives(grown, BUDGETS);
  assert.deepEqual(grownPlans.slice(0, plans.length), plans);
  assert.ok(grownPlans.length > plans.length);
});

test("压力不足时不形成 Archive", () => {
  assert.deepEqual(planArchives(eventsOf([{ role: "user", chars: 400 }, { role: "assistant", chars: 400 }]), BUDGETS), []);
  assert.deepEqual(planArchives([], BUDGETS), []);
});

test("边界退回 step 起点之前，tool call/result 不被拆开", () => {
  const events = eventsOf([
    { role: "user", chars: 4000 },
    { role: "assistant", chars: 4000 },
    { role: "toolResult", chars: 4000 },
    { role: "toolResult", chars: 4000 },
    { role: "assistant", chars: 4000 },
  ]);
  const stepId = events[1].stepId;
  assert.equal(events[2].stepId, stepId);
  assert.equal(events[3].stepId, stepId);
  const plans = planArchives(events, BUDGETS);
  for (const plan of plans) {
    const boundary = events[plan.endIndex];
    const next = events[plan.endIndex + 1];
    assert.ok(!next || !boundary.stepId || next.stepId !== boundary.stepId, "Archive 边界拆开了一个 step");
  }
});

test("提交建立唯一 manifest 对象，重复提交幂等且不产生第二个逻辑对象", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const first = await manager.commit(SESSION, range);
  assert.equal(first.branch, "created");

  const location = archiveStorageLocation(USER_ROOT, SESSION, first.archiveId);
  assert.match(location.manifestUri, /\/resources\/\.pi-openviking\/archives\/v1\/[0-9a-f]{64}\/[0-9a-f]{2}\/\.arc_[0-9a-f]{64}\.json$/);
  const manifestFiles = [...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/"));
  assert.deepEqual(manifestFiles, [location.manifestUri]);

  const again = await manager.commit(SESSION, range);
  assert.equal(again.branch, "already_committed");
  assert.equal(again.archiveId, first.archiveId);
  assert.deepEqual([...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/")), manifestFiles);
});

test("崩溃残留字节不是 Archive：按实际 hash 替换后恢复同一 archiveId", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const expected = buildArchiveManifest(SESSION, range);
  const location = archiveStorageLocation(USER_ROOT, SESSION, expected.archiveId);
  transport.directories.add(location.shardRoot);
  transport.files.set(location.manifestUri, Buffer.alloc(0));

  const repaired = await manager.commit(SESSION, range);
  assert.equal(repaired.branch, "repaired_residue");
  assert.equal(repaired.archiveId, expected.archiveId);
  assert.deepEqual(transport.files.get(location.manifestUri), archiveManifestBytes(expected));
});

test("同一 archiveId 上已自证但内容不同的 manifest 是完整性冲突", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const expected = buildArchiveManifest(SESSION, range);
  const location = archiveStorageLocation(USER_ROOT, SESSION, expected.archiveId);
  const foreign = archiveManifestBytes({ ...expected, contentHash: `sha256:${"b".repeat(64)}` });
  transport.directories.add(location.shardRoot);
  transport.files.set(location.manifestUri, foreign);

  await assert.rejects(() => manager.commit(SESSION, range), ArchiveIntegrityError);
  assert.deepEqual(transport.files.get(location.manifestUri), foreign);
});

test("接受证明来自回读：引用事件缺失或字节不符时 Archive 不可见", async () => {
  const events = eventsOf();
  const transport = new MemoryContentTransport();
  const adapter = new RecordedEventAdapter(transport, { userRoot: USER_ROOT });
  const manager = new ArchiveManager(transport, { userRoot: USER_ROOT, adapter, budgets: BUDGETS });
  const range = events.slice(0, 3);

  await assert.rejects(() => manager.commit(SESSION, range));
  const location = archiveStorageLocation(USER_ROOT, SESSION, buildArchiveManifest(SESSION, range).archiveId);
  assert.equal(transport.files.has(location.manifestUri), false);

  await adapter.writeEvents(SESSION, events);
  const mismatched = {
    readEvent: async (_sessionId, eventId) => ({
      event: events.find((event) => event.eventId === eventId),
      bytes: Buffer.from("not-the-stored-bytes"),
    }),
  };
  const strayManager = new ArchiveManager(transport, { userRoot: USER_ROOT, adapter: mismatched, budgets: BUDGETS });
  await assert.rejects(() => strayManager.commit(SESSION, range), ArchiveIntegrityError);
});

test("按 archiveId 展开得到确定且完整的源事件序列", async () => {
  const events = eventsOf();
  const { manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const { archiveId: id } = await manager.commit(SESSION, range);

  const manifest = await manager.read(SESSION, id);
  assert.equal(manifest.eventCount, 3);
  assert.equal(manifest.firstEventId, range[0].eventId);
  assert.equal(manifest.lastEventId, range.at(-1).eventId);
  assert.equal(manifest.lastStepId, range.at(-1).stepId ?? null);

  const expanded = await manager.expand(SESSION, id);
  assert.deepEqual(expanded.events.map((event) => event.eventId), range.map((event) => event.eventId));
  assert.deepEqual(expanded.events.map(recordedEventBytes), range.map(recordedEventBytes));
});

test("展开时事件被改写即失败，未提交的 archiveId 不可读", async () => {
  const events = eventsOf();
  const { transport, manager, adapter } = await storedManager(events);
  const range = events.slice(0, 3);
  const { archiveId: id } = await manager.commit(SESSION, range);

  const eventUri = [...transport.files.keys()].find((uri) => uri.includes(`.${range[1].eventId}.json`));
  const original = transport.files.get(eventUri);
  transport.files.set(eventUri, Buffer.from(original.toString("utf8").replace(/x{8}/, "xxxxxxxy")));
  await assert.rejects(() => manager.expand(SESSION, id), ContentConflictError);
  transport.files.set(eventUri, original);

  const unknown = archiveId(SESSION, range[0].eventId, range[1].eventId, 2);
  await assert.rejects(() => manager.read(SESSION, unknown), ArchiveIntegrityError);
  assert.ok(adapter);
});

test("formArchives 按计划提交全部到期 Archive 并保持幂等", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const first = await manager.formArchives(SESSION, events);
  assert.deepEqual(
    { planned: first.planned, created: first.created, committed: first.committed, pending: first.pending },
    { planned: 3, created: 3, committed: 3, pending: 0 },
  );
  const manifests = [...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/"));
  assert.equal(manifests.length, 3);

  const again = await manager.formArchives(SESSION, events);
  assert.equal(again.created, 0);
  assert.equal(again.committed, 3);
  assert.equal([...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/")).length, 3);
});

test("路径占用是可重试失败：Archive 保持待提交，已确认事件不受影响", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const first = planArchives(events, BUDGETS)[0];
  const range = events.slice(first.startIndex, first.endIndex + 1);
  const location = archiveStorageLocation(USER_ROOT, SESSION, buildArchiveManifest(SESSION, range).archiveId);
  transport.busyOnce = location.manifestUri;

  const busy = await manager.formArchives(SESSION, events);
  assert.equal(busy.committed, 0);
  assert.match(busy.lastFailure, /ContentBusyError/);
  assert.equal([...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/")).length, 0);

  const recovered = await manager.formArchives(SESSION, events);
  assert.equal(recovered.committed, 3);
  assert.equal(recovered.lastFailure, null);
});

test("路径占用直接暴露为可重试错误，不冒充完整性冲突", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  transport.busyOnce = archiveStorageLocation(USER_ROOT, SESSION, buildArchiveManifest(SESSION, range).archiveId).manifestUri;
  await assert.rejects(() => manager.commit(SESSION, range), (error) =>
    error instanceof ContentBusyError && !(error instanceof ArchiveIntegrityError));
});
