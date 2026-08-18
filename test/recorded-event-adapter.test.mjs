import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_MAX_FILE_BYTES,
  BATCH_MAX_OPERATIONS,
  BATCH_MAX_TOTAL_BYTES,
  RecordedEventAdapter,
  RecordedEventConflictError,
  RecordedEventSyncError,
  recordedEventStorageLocation,
} from "../shared/recorded-event-adapter.mjs";
import { contentHash, projectPiEntries, recordedEventBytes, recordedEventId } from "../shared/recorded-event.mjs";
import { buildPhase0LongTrace } from "./fixtures/phase0-long-trace.mjs";

const OPENVIKING_MAX_OPERATIONS = 128;
const OPENVIKING_MAX_FILE_BYTES = 8 * 1024 * 1024;
const OPENVIKING_MAX_BATCH_BYTES = 16 * 1024 * 1024;

class MemoryContentTransport {
  constructor() {
    this.directories = new Set(["viking://user/test/resources"]);
    this.files = new Map();
    this.requests = [];
    this.failCommitOnce = false;
    this.omitConfirmation = false;
    this.corruptDownload = false;
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
    const parent = uri.slice(0, uri.lastIndexOf("/"));
    if (!this.directories.has(parent)) return { ok: false, status: 404 };
    if (this.files.has(uri)) return { ok: false, status: 409 };
    this.directories.add(uri);
    return { ok: true, result: { uri }, status: 200 };
  }

  async batchWrite(request) {
    this.requests.push(structuredClone(request));
    assert.ok(request.operations.length <= OPENVIKING_MAX_OPERATIONS);
    const decoded = request.operations.map((operation) => ({
      ...operation,
      bytes: Buffer.from(operation.content_base64, "base64"),
    }));
    assert.ok(decoded.every((operation) => operation.bytes.length <= OPENVIKING_MAX_FILE_BYTES));
    assert.ok(decoded.reduce((sum, operation) => sum + operation.bytes.length, 0) <= OPENVIKING_MAX_BATCH_BYTES);
    assert.ok(decoded.every((operation) => operation.precondition.kind === "create_if_absent"));
    assert.equal(request.wait, false);

    if (this.failCommitOnce && decoded.some((operation) => operation.uri.endsWith(".commit.json"))) {
      this.failCommitOnce = false;
      return { ok: false, status: 500, error: { message: "injected commit failure" } };
    }

    const created = [];
    const unchanged = [];
    for (const operation of decoded) {
      const existing = this.files.get(operation.uri);
      if (existing) {
        if (!existing.equals(operation.bytes)) {
          return { ok: false, status: 409, error: { code: "CONFLICT", details: { resource: operation.uri } } };
        }
        unchanged.push(operation.uri);
      } else {
        this.files.set(operation.uri, operation.bytes);
        created.push(operation.uri);
      }
    }
    if (this.omitConfirmation) {
      this.omitConfirmation = false;
      created.pop();
    }
    return {
      ok: true,
      status: 200,
      result: {
        root_uri: request.root_uri,
        created,
        updated: [],
        unchanged,
        queue_status: null,
      },
    };
  }

  async downloadBytes(uri) {
    const bytes = this.files.get(uri);
    if (!bytes) return { ok: false, status: 404 };
    const result = Buffer.from(bytes);
    if (this.corruptDownload && result.length > 0) result[0] ^= 0xff;
    return { ok: true, status: 200, bytes: result };
  }
}

function adapter(transport) {
  return new RecordedEventAdapter(transport, { userRoot: "viking://user/test" });
}

function generatedEvent(sessionId, index, data = "") {
  const source = {
    system: "pi",
    sessionId,
    entryId: `generated-entry-${index}`,
    parentEntryId: index === 0 ? null : `generated-entry-${index - 1}`,
    entryType: "message",
    partType: "text",
    partIndex: 0,
  };
  const payload = { data };
  return {
    schemaVersion: 1,
    eventId: recordedEventId(source),
    parentId: null,
    contentHash: contentHash(payload),
    occurredAt: "2026-08-18T00:00:00.000Z",
    source,
    payload,
  };
}

function eventWithByteLength(sessionId, index, byteLength) {
  const empty = generatedEvent(sessionId, index);
  const overhead = recordedEventBytes(empty).length;
  assert.ok(byteLength >= overhead);
  const event = generatedEvent(sessionId, index, "x".repeat(byteLength - overhead));
  assert.equal(recordedEventBytes(event).length, byteLength);
  return event;
}

test("adapter 限制符合 OpenViking 0.4.13 Content API 协议值", () => {
  assert.equal(BATCH_MAX_OPERATIONS, OPENVIKING_MAX_OPERATIONS);
  assert.equal(BATCH_MAX_FILE_BYTES, OPENVIKING_MAX_FILE_BYTES);
  assert.equal(BATCH_MAX_TOTAL_BYTES, OPENVIKING_MAX_BATCH_BYTES);
});

test("direct 事件按确定性隐藏 URI 写入并同字节幂等重放", async () => {
  const trace = buildPhase0LongTrace();
  const event = projectPiEntries(trace.sessionId, trace.shorter)[0];
  const transport = new MemoryContentTransport();
  const writer = adapter(transport);
  const location = recordedEventStorageLocation("viking://user/test", trace.sessionId, event.eventId);

  assert.match(location.directUri, /\/resources\/\.pi-openviking\/recorded-events\/v1\/[0-9a-f]{64}\/[0-9a-f]{2}\/\.evt_[0-9a-f]{64}\.json$/);
  assert.deepEqual(await writer.writeEvents(trace.sessionId, [event]), {
    acceptedEventIds: [event.eventId],
    capabilityVerified: true,
  });
  assert.deepEqual(transport.files.get(location.directUri), recordedEventBytes(event));

  assert.deepEqual(await writer.writeEvents(trace.sessionId, [event]), {
    acceptedEventIds: [event.eventId],
    capabilityVerified: true,
  });
  assert.equal(transport.requests.at(-1).operations[0].uri, location.directUri);
});

test("direct 事件在 127/128/129 项边界拆分批次", async () => {
  for (const count of [127, 128, 129]) {
    const sessionId = `operation-boundary-${count}`;
    const events = Array.from(
      { length: count },
      (_, index) => generatedEvent(sessionId, index, `event-${index}`),
    );
    const transport = new MemoryContentTransport();
    await adapter(transport).writeEvents(sessionId, events);
    const expected = count <= 128 ? [count] : [128, 1];
    assert.deepEqual(transport.requests.map((request) => request.operations.length), expected);
    assert.match(transport.requests[0].root_uri, /\/recorded-events\/v1\/[0-9a-f]{64}$/);
  }
});

test("direct 事件在 8 MiB 和 16 MiB 的前一值、边界值、后一值拆分", async () => {
  const cases = [
    { name: "below", sizes: [OPENVIKING_MAX_FILE_BYTES, OPENVIKING_MAX_FILE_BYTES - 1], expected: [2] },
    { name: "exact", sizes: [OPENVIKING_MAX_FILE_BYTES, OPENVIKING_MAX_FILE_BYTES], expected: [2] },
  ];

  for (const sample of cases) {
    const sessionId = `byte-boundary-${sample.name}`;
    const events = sample.sizes.map((size, index) => eventWithByteLength(sessionId, index, size));
    const transport = new MemoryContentTransport();
    await adapter(transport).writeEvents(sessionId, events);
    assert.deepEqual(transport.requests.map((request) => request.operations.length), sample.expected);
    const total = events.reduce((sum, event) => sum + recordedEventBytes(event).length, 0);
    assert.equal(total, OPENVIKING_MAX_BATCH_BYTES + (sample.name === "below" ? -1 : 0));
  }

  const sessionId = "byte-boundary-above";
  const tail = generatedEvent(sessionId, 2, "after-limit");
  const tailBytes = recordedEventBytes(tail).length;
  const events = [
    eventWithByteLength(sessionId, 0, OPENVIKING_MAX_FILE_BYTES),
    eventWithByteLength(sessionId, 1, OPENVIKING_MAX_FILE_BYTES - tailBytes + 1),
    tail,
  ];
  assert.equal(events.reduce((sum, event) => sum + recordedEventBytes(event).length, 0), OPENVIKING_MAX_BATCH_BYTES + 1);
  const transport = new MemoryContentTransport();
  await adapter(transport).writeEvents(sessionId, events);
  assert.deepEqual(transport.requests.map((request) => request.operations.length), [2, 1]);
});

test("同 event ID 不同规范字节返回完整性冲突且严格拒绝缺失确认", async () => {
  const trace = buildPhase0LongTrace();
  const event = projectPiEntries(trace.sessionId, trace.shorter)[0];
  const transport = new MemoryContentTransport();
  const writer = adapter(transport);
  const location = recordedEventStorageLocation("viking://user/test", trace.sessionId, event.eventId);
  await writer.writeEvents(trace.sessionId, [event]);

  const changed = structuredClone(event);
  changed.payload.part.value.text = "changed bytes";
  changed.contentHash = contentHash(changed.payload);
  await assert.rejects(
    () => writer.writeEvents(trace.sessionId, [changed]),
    (error) => error instanceof RecordedEventConflictError && error.uri === location.directUri,
  );

  const secondTransport = new MemoryContentTransport();
  secondTransport.omitConfirmation = true;
  await assert.rejects(() => adapter(secondTransport).writeEvents(trace.sessionId, [event]), RecordedEventSyncError);

  const corruptTransport = new MemoryContentTransport();
  corruptTransport.corruptDownload = true;
  await assert.rejects(
    () => adapter(corruptTransport).writeEvents(trace.sessionId, [event]),
    /direct byte verification failed/,
  );
});

test("8 MiB + 1 byte 事件只在 chunks 回读验证和 commit marker 后确认", async () => {
  const sessionId = "chunk-boundary-session";
  const event = eventWithByteLength(sessionId, 0, OPENVIKING_MAX_FILE_BYTES + 1);
  const transport = new MemoryContentTransport();
  transport.failCommitOnce = true;
  const writer = adapter(transport);
  const location = recordedEventStorageLocation("viking://user/test", sessionId, event.eventId);

  await assert.rejects(() => writer.writeEvents(sessionId, [event]), /batch-write failed/);
  assert.equal(transport.files.has(location.commitUri), false);
  assert.equal(transport.files.has(location.claimUri), true);
  assert.equal([...transport.files].filter(([uri]) => uri.includes(".chunk-")).length, 3);

  assert.deepEqual(await writer.writeEvents(sessionId, [event]), {
    acceptedEventIds: [event.eventId],
    capabilityVerified: true,
  });
  assert.equal(transport.files.has(location.commitUri), true);
  assert.equal(transport.files.has(location.directUri), false);
});
