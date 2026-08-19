import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";

import { OBSERVATION_STAGE_REGISTRY, createObservation } from "../shared/observe.mjs";
import {
  missingExpectedRecords,
  observationRegistrySha256,
  parseObservationRun,
} from "./live/observation-evidence.mjs";

const ROOT = `test/.artifacts/observation-evidence-${process.pid}`;

test("完整 observation artifact 生成安全 summary，损坏记录不能伪造完整性", async () => {
  mkdirSync(ROOT, { recursive: true });
  const path = `${ROOT}/run.jsonl`;
  const observation = createObservation({ env: { OV_OBSERVE: path }, autoFinalize: false });
  observation.emit("sync_source", "in_memory", 2);
  const op = observation.begin("client_http", "/health", "GET", 1000);
  observation.end("client_http", op, "success", 200, "trace-safe");
  await observation.finish();

  const bytes = readFileSync(path);
  const parsed = parseObservationRun(bytes);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.summary.complete, true);
  assert.equal(parsed.summary.accepted, parsed.summary.seq.last);
  assert.match(parsed.summary.evidenceSha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(missingExpectedRecords(parsed.records, [
    { stage: "sync_source", data: { branch: "in_memory" } },
    { stage: "client_http", data: { phase: "end", outcome: "success", status: 200 } },
  ]), []);
  assert.deepEqual(missingExpectedRecords(parsed.records, [
    { stage: "client_http", data: { phase: "end", outcome: "http_error" } },
  ]), ["client_http#1"]);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.summary, "records"), false);

  const drifted = parsed.records.map((record) =>
    record.stage === "client_http" && record.data.phase === "end"
      ? { ...record, session: "a".repeat(64) }
      : record,
  );
  const driftedRun = parseObservationRun(Buffer.from(`${drifted.map(JSON.stringify).join("\n")}\n`));
  assert.ok(driftedRun.errors.some((error) => error.endsWith("session_mismatch")));

  const truncated = parseObservationRun(bytes.subarray(0, bytes.length - 2));
  assert.equal(truncated.summary.complete, false);
  assert.ok(truncated.errors.length > 0);
});

test("registry hash 绑定当前 active registry", () => {
  assert.ok(Object.keys(OBSERVATION_STAGE_REGISTRY).length > 0);
  assert.match(observationRegistrySha256(), /^[0-9a-f]{64}$/);
});

test.after(() => rmSync(ROOT, { recursive: true, force: true }));
