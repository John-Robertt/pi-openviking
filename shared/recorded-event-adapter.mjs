import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "./canonical-json.mjs";
import { recordedEventBytes } from "./recorded-event.mjs";

export const BATCH_MAX_OPERATIONS = 128;
export const BATCH_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const BATCH_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const EVENT_CHUNK_BYTES = 4 * 1024 * 1024;

const STORAGE_DOMAIN = "pi-openviking/recorded-event-storage";
const CREATE_IF_ABSENT = { kind: "create_if_absent" };

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function requireEventId(eventId) {
  if (!/^evt_[0-9a-f]{64}$/.test(eventId)) throw new TypeError(`invalid RecordedEvent eventId: ${eventId}`);
  return eventId;
}

function joinUri(root, segment) {
  return `${root.replace(/\/+$/, "")}/${segment}`;
}

function parentUri(uri) {
  return uri.slice(0, uri.lastIndexOf("/"));
}

export function recordedEventStorageLocation(userRoot, sessionId, eventId) {
  const root = String(userRoot || "").replace(/\/+$/, "");
  if (!/^viking:\/\/user\/[^/]+$/.test(root)) throw new TypeError("RecordedEvent storage requires a bound user root");
  if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
  requireEventId(eventId);
  const sessionKey = createHash("sha256")
    .update(canonicalJsonBytes([STORAGE_DOMAIN, 1, "session", sessionId]))
    .digest("hex");
  const digest = eventId.slice(4);
  const sessionRoot = `${root}/resources/.pi-openviking/recorded-events/v1/${sessionKey}`;
  const shardRoot = `${sessionRoot}/${digest.slice(0, 2)}`;
  return {
    sessionKey,
    sessionRoot,
    shardRoot,
    directUri: `${shardRoot}/.${eventId}.json`,
    claimUri: `${shardRoot}/.${eventId}.claim.json`,
    chunkUri: (index) => `${shardRoot}/.${eventId}.chunk-${String(index).padStart(6, "0")}.bin`,
    commitUri: `${shardRoot}/.${eventId}.commit.json`,
  };
}

export class RecordedEventConflictError extends Error {
  constructor(message, uri) {
    super(message);
    this.name = "RecordedEventConflictError";
    this.uri = uri;
  }
}

export class RecordedEventSyncError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RecordedEventSyncError";
    Object.assign(this, details);
  }
}

function strictBatchResult(response, rootUri, expectedUris) {
  if (!response?.ok) {
    if (response?.status === 409) {
      const uri = response.error?.details?.resource || response.error?.resource || expectedUris[0];
      throw new RecordedEventConflictError("RecordedEvent bytes conflict with an existing OpenViking object", uri);
    }
    throw new RecordedEventSyncError("OpenViking batch-write failed", {
      status: Number(response?.status || 0),
      error: response?.error,
    });
  }
  const result = response.result;
  if (!result || result.root_uri !== rootUri || !Array.isArray(result.created) ||
      !Array.isArray(result.updated) || !Array.isArray(result.unchanged) || result.updated.length !== 0) {
    throw new RecordedEventSyncError("OpenViking batch-write returned an invalid result");
  }
  const accepted = [...result.created, ...result.unchanged];
  if (new Set(accepted).size !== accepted.length || accepted.some((uri) => typeof uri !== "string")) {
    throw new RecordedEventSyncError("OpenViking batch-write returned duplicate or invalid URIs");
  }
  const expected = [...expectedUris].sort();
  const actual = [...accepted].sort();
  if (expected.length !== actual.length || expected.some((uri, index) => uri !== actual[index])) {
    throw new RecordedEventSyncError("OpenViking batch-write did not confirm every requested URI");
  }
}

function planBatches(objects) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const object of objects) {
    if (object.bytes.length > BATCH_MAX_FILE_BYTES) {
      throw new RecordedEventSyncError(`OpenViking object exceeds 8 MiB: ${object.uri}`);
    }
    if (current.length >= BATCH_MAX_OPERATIONS || bytes + object.bytes.length > BATCH_MAX_TOTAL_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(object);
    bytes += object.bytes.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class RecordedEventAdapter {
  constructor(transport, { userRoot }) {
    this.transport = transport;
    this.userRoot = userRoot;
    this.createdDirectories = new Set();
    this.byteReadVerified = false;
  }

  async ensureDirectory(uri) {
    if (this.createdDirectories.has(uri)) return;
    const status = await this.transport.statUri(uri);
    if (status?.ok && status.exists) {
      if (!status.isDir) throw new RecordedEventConflictError("RecordedEvent directory path is a file", uri);
      this.createdDirectories.add(uri);
      return;
    }
    const created = await this.transport.mkdirUri(uri);
    if (!created?.ok) {
      const raced = await this.transport.statUri(uri);
      if (!raced?.ok || !raced.exists || !raced.isDir) {
        throw new RecordedEventSyncError(`OpenViking mkdir failed: ${uri}`, {
          status: Number(created?.status || 0),
          error: created?.error,
        });
      }
    }
    this.createdDirectories.add(uri);
  }

  async ensureShard(shardRoot) {
    const resourceRoot = `${this.userRoot.replace(/\/+$/, "")}/resources`;
    const relative = shardRoot.slice(resourceRoot.length).split("/").filter(Boolean);
    let current = resourceRoot;
    for (const segment of relative) {
      current = joinUri(current, segment);
      await this.ensureDirectory(current);
    }
  }

  async assertRepresentationAbsent(uri, message) {
    const status = await this.transport.statUri(uri);
    if (!status?.ok) throw new RecordedEventSyncError(`OpenViking stat failed: ${uri}`, { status: status?.status || 0 });
    if (status.exists) throw new RecordedEventConflictError(message, uri);
  }

  async writeObjects(rootUri, objects) {
    for (const directory of new Set(objects.map((object) => parentUri(object.uri)))) {
      await this.ensureShard(directory);
    }
    for (const batch of planBatches(objects)) {
      const operations = batch.map((object) => ({
        uri: object.uri,
        content_base64: object.bytes.toString("base64"),
        precondition: CREATE_IF_ABSENT,
      }));
      const response = await this.transport.batchWrite({
        root_uri: rootUri,
        operations,
        wait: false,
      });
      strictBatchResult(response, rootUri, batch.map((object) => object.uri));
    }
  }


  async writeChunked(event, location, bytes) {
    await this.assertRepresentationAbsent(location.directUri, "direct representation already exists for event");
    const chunks = [];
    for (let offset = 0, index = 0; offset < bytes.length; offset += EVENT_CHUNK_BYTES, index++) {
      const content = bytes.subarray(offset, Math.min(bytes.length, offset + EVENT_CHUNK_BYTES));
      chunks.push({
        index,
        uri: location.chunkUri(index),
        byteLength: content.length,
        contentHash: sha256(content),
        bytes: content,
      });
    }
    const claim = {
      schemaVersion: 1,
      type: "recorded-event-claim",
      eventId: event.eventId,
      eventHash: sha256(bytes),
      byteLength: bytes.length,
      chunks: chunks.map(({ index, uri, byteLength, contentHash }) => ({ index, uri, byteLength, contentHash })),
    };
    const claimBytes = canonicalJsonBytes(claim);
    await this.writeObjects(location.sessionRoot, [{ uri: location.claimUri, bytes: claimBytes }]);
    await this.writeObjects(location.sessionRoot, chunks.map((chunk) => ({ uri: chunk.uri, bytes: chunk.bytes })));

    const downloaded = [];
    for (const chunk of chunks) {
      const response = await this.transport.downloadBytes(chunk.uri);
      if (!response?.ok || !Buffer.isBuffer(response.bytes) ||
          response.bytes.length !== chunk.byteLength || sha256(response.bytes) !== chunk.contentHash) {
        throw new RecordedEventSyncError(`OpenViking chunk verification failed: ${chunk.uri}`);
      }
      downloaded.push(response.bytes);
    }
    const reconstructed = Buffer.concat(downloaded);
    if (reconstructed.length !== claim.byteLength || sha256(reconstructed) !== claim.eventHash) {
      throw new RecordedEventSyncError(`OpenViking event verification failed: ${event.eventId}`);
    }
    this.byteReadVerified = true;

    const commit = {
      schemaVersion: 1,
      type: "recorded-event-commit",
      eventId: event.eventId,
      claimHash: sha256(claimBytes),
    };
    await this.writeObjects(location.sessionRoot, [{ uri: location.commitUri, bytes: canonicalJsonBytes(commit) }]);
  }

  async writeEvents(sessionId, events) {
    const direct = [];
    const chunked = [];
    for (const event of events) {
      requireEventId(event?.eventId);
      if (event?.source?.sessionId !== sessionId) {
        throw new RecordedEventSyncError(`RecordedEvent session mismatch: ${event?.eventId || "unknown"}`);
      }
      const bytes = recordedEventBytes(event);
      const location = recordedEventStorageLocation(this.userRoot, sessionId, event.eventId);
      if (bytes.length <= BATCH_MAX_FILE_BYTES) direct.push({ event, location, bytes });
      else chunked.push({ event, location, bytes });
    }

    for (const item of direct) {
      await this.assertRepresentationAbsent(item.location.claimUri, "chunked representation already exists for event");
    }
    if (direct.length > 0) {
      await this.writeObjects(
        direct[0].location.sessionRoot,
        direct.map((item) => ({ uri: item.location.directUri, bytes: item.bytes })),
      );
    }
    if (direct.length > 0 && !this.byteReadVerified) {
      const sample = direct[0];
      const downloaded = await this.transport.downloadBytes(sample.location.directUri);
      if (!downloaded?.ok || !Buffer.isBuffer(downloaded.bytes) || !downloaded.bytes.equals(sample.bytes)) {
        throw new RecordedEventSyncError(`OpenViking direct byte verification failed: ${sample.location.directUri}`);
      }
      this.byteReadVerified = true;
    }
    for (const item of chunked) await this.writeChunked(item.event, item.location, item.bytes);

    return {
      acceptedEventIds: events.map((event) => event.eventId),
      capabilityVerified: this.byteReadVerified,
    };
  }
}
