import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { OBSERVATION_STAGE_REGISTRY } from "../shared/observe.mjs";
import { observationRegistrySha256 } from "./live/observation-evidence.mjs";
import { checkManifestHash } from "./live/live-support.mjs";

const manifestBytes = readFileSync("test/live/observability.workloads.json");
const manifest = JSON.parse(manifestBytes.toString("utf8"));

test("observability manifest/hash/registry 是同一当前 active stage 集", () => {
  assert.equal(checkManifestHash(manifestBytes, readFileSync("test/live/observability.workloads.sha256", "utf8")), true);
  assert.equal(manifest.identities.registry.sha256, observationRegistrySha256());
  const evidence = new Set([
    "observe_run_start",
    "observe_run_end",
    ...manifest.deterministicStages,
    ...manifest.workloads.flatMap((workload) => workload.expectedRecords.map((expected) => expected.stage)),
  ]);
  assert.deepEqual([...evidence].sort(), Object.keys(OBSERVATION_STAGE_REGISTRY).sort());
  const deterministicSource = readFileSync("test/observability-integration.test.mjs", "utf8");
  for (const stage of manifest.deterministicStages) {
    assert.match(deterministicSource, new RegExp(`record\\.stage === ["']${stage}["']`));
  }
});

test("observability workload 具有成功标准、证伪条件和 registry 内 stage", () => {
  const active = new Set(Object.keys(OBSERVATION_STAGE_REGISTRY));
  assert.ok(manifest.workloads.length >= 2);
  for (const workload of manifest.workloads) {
    assert.ok(workload.id && workload.summary);
    assert.ok(workload.successCriteria.length > 0);
    assert.ok(workload.falsification.length > 0);
    assert.ok(workload.expectedRecords.length > 0);
    for (const expected of workload.expectedRecords) {
      assert.ok(active.has(expected.stage), `${workload.id} 引用未知 stage ${expected.stage}`);
      assert.equal(typeof expected.data, "object");
      assert.ok(Object.keys(expected.data).length > 0);
    }
  }
  const baseline = manifest.thresholds.baseline;
  assert.ok(baseline.measuredAt && baseline.expected.disabled && baseline.expected.enabled);
  assert.equal(baseline.runs.length, 5);
  for (const run of baseline.runs) {
    assert.ok(Number.isInteger(run.observedMs) && run.observedMs >= 0);
    assert.ok(Number.isInteger(run.observedRecords) && run.observedRecords > 0);
    assert.ok(run.observedMs <= run.maxMs);
    assert.ok(run.observedRecords >= run.minRecords && run.observedRecords <= run.maxRecords);
  }
});

test("package 暴露独立 observability gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["verify:observability:live"], "node test/live/observability-live.mjs");
});
