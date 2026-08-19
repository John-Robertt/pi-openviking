import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "../../shared/canonical-json.mjs";
import {
  OBSERVATION_SCHEMA_VERSION,
  OBSERVATION_STAGE_REGISTRY,
  validateObservationRecord,
} from "../../shared/observe.mjs";

export function observationRegistrySha256() {
  return createHash("sha256").update(canonicalJsonBytes(OBSERVATION_STAGE_REGISTRY)).digest("hex");
}

export function parseObservationRun(bytes) {
  const raw = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const errors = [];
  const records = [];
  const text = raw.toString("utf8");
  const lines = text.split("\n");
  if (lines.at(-1) !== "") errors.push("artifact_missing_final_newline");
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      const checked = validateObservationRecord(record);
      if (!checked.ok) errors.push(`record_${index + 1}_${checked.reason}`);
      records.push(record);
    } catch {
      errors.push(`record_${index + 1}_json`);
    }
  }

  if (records.length === 0) errors.push("run_empty");
  const first = records[0];
  const last = records.at(-1);
  if (first?.stage !== "observe_run_start") errors.push("run_start_missing");
  if (last?.stage !== "observe_run_end") errors.push("run_end_missing");

  const run = first?.run ?? null;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.run !== run) errors.push(`record_${index + 1}_run_mismatch`);
    if (record.seq !== index + 1) errors.push(`record_${index + 1}_seq`);
  }

  if (last?.stage === "observe_run_end") {
    if (last.data?.accepted !== last.seq - 1) errors.push("accepted_mismatch");
    if (last.data?.dropped !== 0) errors.push("dropped_nonzero");
  }

  const open = new Map();
  for (const record of records) {
    if (record.kind !== "boundary") continue;
    if (record.data?.phase === "begin") {
      if (open.has(record.op)) errors.push(`op_${record.op}_duplicate_begin`);
      open.set(record.op, { stage: record.stage, session: record.session });
    } else if (record.data?.phase === "end") {
      const opened = open.get(record.op);
      if (!opened) errors.push(`op_${record.op}_end_without_begin`);
      else {
        if (opened.stage !== record.stage) errors.push(`op_${record.op}_stage_mismatch`);
        if (opened.session !== record.session) errors.push(`op_${record.op}_session_mismatch`);
        open.delete(record.op);
      }
    }
  }
  for (const op of open.keys()) errors.push(`op_${op}_unfinished`);

  const stageCounts = {};
  const kindCounts = {};
  const outcomeCounts = {};
  for (const record of records) {
    stageCounts[record.stage] = (stageCounts[record.stage] || 0) + 1;
    kindCounts[record.kind] = (kindCounts[record.kind] || 0) + 1;
    const outcome = record.kind === "failure"
      ? `${record.data?.errorCode ?? "unknown"}/${record.data?.branch ?? "unknown"}`
      : record.data?.outcome ?? record.data?.branch ?? record.data?.disposition ?? record.data?.mode;
    if (typeof outcome === "string") {
      const key = `${record.stage}:${outcome}`;
      outcomeCounts[key] = (outcomeCounts[key] || 0) + 1;
    }
  }

  return {
    records,
    errors,
    summary: {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      run,
      seq: records.length ? { first: records[0].seq, last: records.at(-1).seq } : null,
      stageCounts,
      kindCounts,
      outcomeCounts,
      accepted: last?.stage === "observe_run_end" ? last.data.accepted + 1 : null,
      dropped: last?.stage === "observe_run_end" ? last.data.dropped : null,
      complete: errors.length === 0,
      evidenceSha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    },
  };
}

function containsSubset(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (actual === null || typeof actual !== "object" || Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(expected)) {
    return actual.length === expected.length && expected.every((value, index) => containsSubset(actual[index], value));
  }
  return Object.entries(expected).every(([key, value]) => containsSubset(actual[key], value));
}

export function missingExpectedRecords(records, expectations) {
  return expectations.flatMap((expectation, index) => {
    const matched = records.some((record) =>
      record.stage === expectation.stage && containsSubset(record.data, expectation.data),
    );
    return matched ? [] : [`${expectation.stage}#${index + 1}`];
  });
}
