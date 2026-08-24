import assert from "node:assert/strict";
import test from "node:test";

import {
  ArchiveIntegrityError,
  archiveContentHash,
  archiveId,
  archiveManifestBytes,
  buildArchiveManifest,
  parseArchiveManifest,
  planArchives,
} from "../shared/archive.mjs";
import { ArchiveManager, archiveStorageLocation } from "../shared/archive-store.mjs";
import { ContentConflictError } from "../shared/content-objects.mjs";
import { eventTokenWeight } from "../shared/context-weight.mjs";
import { RecordedEventAdapter } from "../shared/recorded-event-adapter.mjs";
import { recordedEventBytes } from "../shared/recorded-event.mjs";
import { projectPiEntries } from "../shared/recorded-event.mjs";
import {
  ARCHIVE_LINEAR_CHAIN,
  ARCHIVE_USER_ROOT as USER_ROOT,
  MemoryContentTransport,
  archiveEntryChain,
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
  // 按 UTF-8 字节折算：同样 10 个字符的 CJK 内容权重更高。
  assert.equal(eventTokenWeight({ payload: { part: { value: "中".repeat(10) } } }), 8);
  // 没有可分 part 的事件按其完整 entry 规范字节折算。
  assert.equal(eventTokenWeight({ payload: { entry: { type: "custom", data: "y".repeat(40) } } }), 17);
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

test("边界退回完整 Pi entry，未带 step 的多 part user message 不被拆开", () => {
  const entries = [
    {
      id: "multi-user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "message",
      message: { role: "user", content: [
        { type: "text", text: "a".repeat(4000) },
        { type: "text", text: "b".repeat(4000) },
      ] },
    },
    {
      id: "assistant", parentId: "multi-user", timestamp: "2026-01-01T00:00:01.000Z", type: "message",
      message: {
        role: "assistant", content: [{ type: "text", text: "c".repeat(4000) }],
        api: "test", provider: "test", model: "test",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
      },
    },
    {
      id: "tail", parentId: "assistant", timestamp: "2026-01-01T00:00:02.000Z", type: "message",
      message: { role: "user", content: "d".repeat(4000) },
    },
  ];
  const events = projectPiEntries(SESSION, entries);
  const plans = planArchives(events, { chunkTokenBudget: 1100, rawTailTokenBudget: 1000 });
  assert.equal(plans[0].endIndex, 1, "第一个 Archive 必须包含 multi-user 的全部 parts");
  for (const plan of plans) {
    const boundary = events[plan.endIndex];
    const next = events[plan.endIndex + 1];
    assert.notEqual(boundary.source.entryId, next?.source?.entryId, "Archive 边界拆开了一个 Pi entry");
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
  assert.equal(again.branch, "proof_reused");
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
    readEventIfExists: async (_sessionId, eventId) => ({
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

  const expanded = await manager.expand(SESSION, id);
  assert.deepEqual(expanded.events.map((event) => event.eventId), range.map((event) => event.eventId));
  assert.deepEqual(expanded.events.map(recordedEventBytes), range.map(recordedEventBytes));
});

test("每次展开都按会话位置重新验证 Archive", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const { archiveId: id } = await manager.commit(SESSION, range);

  await manager.expand(SESSION, id);
  await assert.rejects(
    () => manager.expand(`${SESSION}-other`, id),
    ArchiveIntegrityError,
    "成功结果不得绕过后续调用的 sessionId 位置校验",
  );

  const manifestUri = archiveStorageLocation(USER_ROOT, SESSION, id).manifestUri;
  const stored = transport.files.get(manifestUri);
  transport.files.delete(manifestUri);
  await assert.rejects(
    () => manager.expand(SESSION, id),
    ArchiveIntegrityError,
    "manifest 消失后不得返回先前展开结果",
  );

  transport.files.set(manifestUri, stored);
  const second = await manager.expand(SESSION, id);
  assert.deepEqual(second.events.map((event) => event.eventId), range.map((event) => event.eventId));
});

test("展开反证会失效进程内证明，恢复后才能重新缓存", async () => {
  const events = eventsOf();
  const { adapter, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const { archiveId: id } = await manager.commit(SESSION, range);
  assert.equal((await manager.commit(SESSION, range)).branch, "proof_reused");

  const readEvent = adapter.readEvent.bind(adapter);
  const readEventIfExists = adapter.readEventIfExists.bind(adapter);
  let contradicted = true;
  adapter.readEvent = async (...args) => {
    const stored = await readEvent(...args);
    return contradicted
      ? { ...stored, event: { ...stored.event, payload: { part: { type: "text", value: "contradiction" } } } }
      : stored;
  };
  adapter.readEventIfExists = async (...args) => {
    const stored = await readEventIfExists(...args);
    return contradicted && stored ? { ...stored, bytes: Buffer.from("contradiction") } : stored;
  };

  await assert.rejects(() => manager.expand(SESSION, id), ArchiveIntegrityError);
  await assert.rejects(() => manager.commit(SESSION, range), ArchiveIntegrityError,
    "显式反证后不得继续复用旧证明");

  contradicted = false;
  assert.equal((await manager.commit(SESSION, range)).branch, "already_committed");
  assert.equal((await manager.commit(SESSION, range)).branch, "proof_reused");
});

test("展开时事件被改写即失败，未提交的 archiveId 不可读", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const range = events.slice(0, 3);
  const { archiveId: id } = await manager.commit(SESSION, range);

  const eventUri = [...transport.files.keys()].find((uri) => uri.includes(`.${range[1].eventId}.json`));
  const original = transport.files.get(eventUri);
  transport.files.set(eventUri, Buffer.from(original.toString("utf8").replace(/x{8}/, "xxxxxxxy")));
  await assert.rejects(() => manager.expand(SESSION, id), ContentConflictError);
  transport.files.set(eventUri, original);

  const unknown = archiveId(SESSION, range[0].eventId, range[1].eventId, 2);
  await assert.rejects(() => manager.read(SESSION, unknown), ArchiveIntegrityError);
});

test("formArchives 按计划提交全部到期 Archive 并保持幂等", async () => {
  const events = eventsOf();
  const { transport, adapter, manager } = await storedManager(events);
  let proofReads = 0;
  const readEventIfExists = adapter.readEventIfExists.bind(adapter);
  adapter.readEventIfExists = async (...args) => {
    proofReads++;
    return readEventIfExists(...args);
  };
  const first = await manager.formArchives(SESSION, events);
  const firstProofReads = proofReads;
  assert.ok(firstProofReads > 0);
  assert.deepEqual(
    { planned: first.planned, created: first.created, committed: first.committed, pending: first.pending },
    { planned: 3, created: 3, committed: 3, pending: 0 },
  );
  const manifests = [...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/"));
  assert.equal(manifests.length, 3);

  const again = await manager.formArchives(SESSION, events);
  assert.equal(again.created, 0);
  assert.equal(again.committed, 3);
  assert.equal(proofReads, firstProofReads, "稳定 Archive 应复用同一进程内的来源证明");
  assert.equal([...transport.files.keys()].filter((uri) => uri.includes("/archives/v1/")).length, 3);

  const restarted = new ArchiveManager(transport, { userRoot: USER_ROOT, adapter, budgets: BUDGETS });
  const beforeRestartProof = proofReads;
  const afterRestart = await restarted.formArchives(SESSION, events);
  assert.equal(afterRestart.created, 0);
  assert.ok(proofReads > beforeRestartProof, "进程内证明不得跨 ArchiveManager 重启复用");

  transport.files.delete(manifests[0]);
  const recovered = await manager.formArchives(SESSION, events);
  assert.equal(recovered.created, 1, "丢失的 manifest 必须从当前事件重建而非命中进程缓存");
  assert.equal(recovered.committed, 3);
  assert.ok(transport.files.has(manifests[0]));
  assert.ok(proofReads > firstProofReads, "manifest 未知时必须重新证明来源事件");

  const firstPlan = planArchives(events, BUDGETS)[0];
  const referencedId = events[firstPlan.startIndex].eventId;
  const eventUri = [...transport.files.keys()].find((uri) => uri.includes(`.${referencedId}.json`));
  const eventBytes = transport.files.get(eventUri);
  const manifestBytes = transport.files.get(manifests[0]);
  await manager.formArchives(SESSION, events.slice(0, 1));
  transport.files.delete(eventUri);
  const invalid = await manager.formArchives(SESSION, events);
  assert.ok(invalid.committed < invalid.planned, "已提交 manifest 的引用事件缺失时不得继续报告 committed");
  assert.equal(invalid.reconciled, true, "明确缺失只排除对应 Archive");
  assert.match(invalid.lastFailure, /ArchiveIntegrityError/);
  assert.deepEqual(transport.files.get(manifests[0]), manifestBytes, "引用损坏不得改写 manifest");
  transport.files.set(eventUri, eventBytes);
});

test("切换分支后重算：另一条分支上的 Archive 必须全部提交，计数描述当前分支", async () => {
  const common = [{ role: "user", chars: 4000 }, { role: "assistant", chars: 4000 }];
  const tail = [{ role: "assistant", chars: 4000 }, { role: "assistant", chars: 4000 }, { role: "assistant", chars: 4000 }];
  const entries = (suffix) => {
    const chain = archiveEntryChain([...common, ...tail]);
    return chain.map((entry, index) => (index < common.length ? entry : {
      ...entry,
      id: `${suffix}-${entry.id}`,
      parentId: index === common.length ? chain[index - 1].id : `${suffix}-${chain[index - 1].id}`,
    }));
  };
  const eventsA = projectPiEntries(SESSION, entries("a"));
  const eventsB = projectPiEntries(SESSION, entries("b"));

  const transport = new MemoryContentTransport();
  const adapter = new RecordedEventAdapter(transport, { userRoot: USER_ROOT });
  await adapter.writeEvents(SESSION, eventsA);
  await adapter.writeEvents(SESSION, eventsB.filter((event) => !eventsA.some((other) => other.eventId === event.eventId)));
  const manager = new ArchiveManager(transport, { userRoot: USER_ROOT, adapter, budgets: BUDGETS });

  const onA = await manager.formArchives(SESSION, eventsA);
  const onB = await manager.formArchives(SESSION, eventsB);
  assert.ok(onA.planned > 0 && onB.planned > 0);

  for (const [label, events, result] of [["A", eventsA, onA], ["B", eventsB, onB]]) {
    const expected = planArchives(events, BUDGETS)
      .map((plan) => buildArchiveManifest(SESSION, events.slice(plan.startIndex, plan.endIndex + 1)).archiveId);
    const missing = expected.filter((id) => !transport.files.has(archiveStorageLocation(USER_ROOT, SESSION, id).manifestUri));
    assert.deepEqual(missing, [], `分支 ${label} 的 Archive 未全部提交`);
    assert.equal(result.committed, expected.length, `分支 ${label} 的已提交计数与当前分支计划不符`);
    assert.equal(result.pending, 0);
  }

  const withoutArchive = await manager.formArchives(SESSION, eventsA.slice(0, 1));
  assert.equal(withoutArchive.committed, 0);
  assert.equal(withoutArchive.lastArchiveId, null, "当前分支没有 Archive 时不得展示旧分支身份");
});

test("单个 Archive 的完整性冲突只停下它自己，后续独立 Archive 继续提交", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const plans = planArchives(events, BUDGETS);
  assert.ok(plans.length >= 3, "需要多个独立 Archive 才能证明失败被隔离");
  const blocked = buildArchiveManifest(SESSION, events.slice(plans[0].startIndex, plans[0].endIndex + 1));
  const location = archiveStorageLocation(USER_ROOT, SESSION, blocked.archiveId);
  transport.directories.add(location.shardRoot);
  transport.files.set(location.manifestUri, archiveManifestBytes({ ...blocked, contentHash: `sha256:${"c".repeat(64)}` }));

  const result = await manager.formArchives(SESSION, events);
  assert.equal(result.committed, plans.length - 1, "只有冲突的那一个 Archive 应当停下");
  assert.equal(result.pending, 1);
  assert.match(result.lastFailure, /ArchiveIntegrityError/);
  for (const plan of plans.slice(1)) {
    const id = buildArchiveManifest(SESSION, events.slice(plan.startIndex, plan.endIndex + 1)).archiveId;
    assert.ok(transport.files.has(archiveStorageLocation(USER_ROOT, SESSION, id).manifestUri), `${id} 未提交`);
  }
});

test("另一进程写入完全相同的字节时，unchanged 是接受证明而不是完整性错误", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const plan = planArchives(events, BUDGETS)[0];
  const range = events.slice(plan.startIndex, plan.endIndex + 1);
  const expected = buildArchiveManifest(SESSION, range);
  const location = archiveStorageLocation(USER_ROOT, SESSION, expected.archiveId);

  // 读到“不存在”之后、写入之前，另一进程提交了同一字节。
  let raced = false;
  const realStat = transport.statUri.bind(transport);
  transport.statUri = async (uri) => {
    const status = await realStat(uri);
    if (uri === location.manifestUri && !raced) {
      raced = true;
      transport.directories.add(location.shardRoot);
      transport.files.set(uri, archiveManifestBytes(expected));
      return { ok: true, exists: false, isDir: false, status: 200 };
    }
    return status;
  };
  const result = await manager.commit(SESSION, range);
  assert.equal(result.archiveId, expected.archiveId);
  assert.deepEqual(transport.files.get(location.manifestUri), archiveManifestBytes(expected));
});

test("路径占用在 Archive 操作内重试，恢复后不残留失败状态", async () => {
  const events = eventsOf();
  const { transport, manager } = await storedManager(events);
  const first = planArchives(events, BUDGETS)[0];
  const range = events.slice(first.startIndex, first.endIndex + 1);
  const location = archiveStorageLocation(USER_ROOT, SESSION, buildArchiveManifest(SESSION, range).archiveId);
  transport.busyOnce = location.manifestUri;

  const recovered = await manager.formArchives(SESSION, events);
  assert.equal(recovered.reconciled, true);
  assert.equal(recovered.committed, 3);
  assert.equal(recovered.lastFailure, null);
});
