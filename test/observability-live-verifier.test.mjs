import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { OBSERVATION_STAGE_REGISTRY } from "../shared/observe.mjs";
import { collectObservedRuns, waitForRecallFixture } from "./live/observability-live.mjs";
import { observationRegistrySha256 } from "./live/observation-evidence.mjs";
import { checkManifestHash } from "./live/live-support.mjs";

const manifestBytes = readFileSync("test/live/observability.workloads.json");
const manifest = JSON.parse(manifestBytes.toString("utf8"));

test("observability manifest/hash 绑定当前 registry", () => {
  assert.equal(checkManifestHash(manifestBytes, readFileSync("test/live/observability.workloads.sha256", "utf8")), true);
  assert.equal(manifest.identities.registry.sha256, observationRegistrySha256());
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
  const live = new Set([
    "observe_run_start",
    "observe_run_end",
    ...manifest.workloads.flatMap((workload) => workload.expectedRecords.map((expected) => expected.stage)),
  ]);
  const deterministic = new Set(manifest.deterministicStages);
  assert.equal(deterministic.size, manifest.deterministicStages.length, "deterministic stage 不得重复");
  assert.deepEqual([...deterministic].filter((stage) => !active.has(stage)), [], "deterministic stage 必须在 registry 内");
  assert.deepEqual([...live].filter((stage) => deterministic.has(stage)), [], "同一 stage 只保留一个权威验证路径");
  assert.deepEqual([...active].filter((stage) => !live.has(stage) && !deterministic.has(stage)), [],
    "manifest 必须覆盖 registry 全集");
  assert.ok(Number.isInteger(manifest.thresholds.fixtureMs) && manifest.thresholds.fixtureMs > 0);
  assert.ok(Number.isInteger(manifest.thresholds.fixturePollMs) && manifest.thresholds.fixturePollMs > 0);
  assert.ok(manifest.thresholds.fixturePollMs < manifest.thresholds.fixtureMs);
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

test("recall fixture 只以目标 resource 的真实检索命中为就绪证据", async () => {
  const calls = [];
  const responses = [
    [{ uri: "viking://user/test/resources/fixture.md", context_type: "memory", score: 1 }],
    [{ uri: "viking://user/test/resources/other.md", context_type: "resource", score: 1 }],
    [{ uri: "viking://user/test/resources/fixture.md", context_type: "resource", score: 0.9 }],
  ];
  const client = {
    find: async (query, options) => {
      calls.push({ query, options });
      return responses.shift() ?? [];
    },
    fetchJSON: async () => assert.fail("就绪路径不应读取诊断端点"),
  };
  const result = await waitForRecallFixture(client, {
    query: "fixture query",
    targetUri: "viking://user/test/resources",
    expectedUri: "viking://user/test/resources/fixture.md",
    timeoutMs: 100,
    pollMs: 1,
  });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.match.uri, "viking://user/test/resources/fixture.md");
  assert.equal(calls[0].query, "fixture query");
  assert.equal(calls[0].options.targetUri, "viking://user/test/resources");
  assert.equal(calls[0].options.topK, 10);
  assert.ok(calls[0].options.timeoutMs > 0 && calls[0].options.timeoutMs <= 100);
});

test("recall fixture 超时受统一 deadline 约束并返回队列与模型诊断", async () => {
  const client = {
    find: async () => [],
    fetchJSON: async (path) => ({ ok: true, result: { status: path.endsWith("/queue") ? "queue-state" : "model-state" } }),
  };
  const result = await waitForRecallFixture(client, {
    query: "missing",
    targetUri: "viking://user/test/resources",
    expectedUri: "viking://user/test/resources/missing.md",
    timeoutMs: 3,
    pollMs: 1,
  });
  assert.equal(result.ready, false);
  assert.ok(result.attempts >= 1);
  assert.equal(result.diagnostics.queue, "queue-state");
  assert.equal(result.diagnostics.models, "model-state");
});

test("observation baseline 不把 fixture 建立证据计作 Pi observation run", () => {
  const observation = { seq: { last: 12 } };
  const runs = collectObservedRuns([
    { id: "success", summary: { runs: [
      { label: "recall-fixture", ready: true, elapsedMs: 10 },
      { label: "pi-run", ms: 20, observation },
    ] } },
  ]);
  assert.deepEqual(runs, [{ workload: "success", run: { label: "pi-run", ms: 20, observation } }]);
});

test("package 暴露独立 observability gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["verify:observability:live"], "node test/live/observability-live.mjs");
});
