import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { TOOLCHAIN } from "../shared/toolchain.mjs";
import { checkManifestHash, sha256Hex } from "./live/live-support.mjs";

const manifestBytes = readFileSync("test/live/budget.workloads.json");
const manifest = JSON.parse(manifestBytes);

test("budget manifest/hash、身份、默认预算与 live 入口一致", () => {
  assert.equal(checkManifestHash(
    manifestBytes,
    readFileSync("test/live/budget.workloads.sha256", "utf8"),
  ), true);
  assert.equal(manifest.identities.openviking.version, TOOLCHAIN.openvikingVersion);
  assert.equal(
    sha256Hex(readFileSync(manifest.identities.modelProfile.path)),
    manifest.identities.modelProfile.sha256,
  );
  assert.deepEqual(manifest.identities.extensionLoadOrder, ["index.ts", "scripts/e2e-probe.ts"]);
  assert.equal(manifest.environment.extensionConfig.takeover.contextTokenThreshold, 1);
  const defaults = JSON.parse(readFileSync("config.json", "utf8"));
  assert.deepEqual(defaults.archive, manifest.environment.extensionConfig.archive);
  assert.equal(defaults.takeover.enabled, manifest.environment.extensionConfig.takeover.enabled);
  assert.equal(defaults.takeover.checkpointTokenBudget, manifest.environment.extensionConfig.takeover.checkpointTokenBudget);
  assert.equal(defaults.takeover.contextTokenThreshold, 0);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["verify:budget:live"], "node test/live/budget-live.mjs");
  assert.equal(existsSync("test/live/budget-live.mjs"), true);
});

test("budget workloads 固定三类独立 100k+ 输入且每类重复三次", () => {
  assert.deepEqual(manifest.families.map((family) => family.id), ["tool-loop", "atomic", "branch"]);
  assert.equal(manifest.repetitions, 3);
  assert.equal(manifest.workloads.length, manifest.families.length * manifest.repetitions);
  for (const family of manifest.families) {
    assert.ok(family.summary);
    assert.ok(family.steps.length > 0);
    assert.ok(family.successCriteria.length > 0);
    assert.ok(family.falsification.length > 0);
    const repeats = manifest.workloads
      .filter((workload) => workload.family === family.id)
      .map((workload) => workload.repeat)
      .sort((left, right) => left - right);
    assert.deepEqual(repeats, [1, 2, 3]);
  }
  for (const workload of manifest.workloads) {
    assert.deepEqual(Object.keys(workload).sort(), ["family", "id", "repeat"]);
  }
  assert.ok(manifest.thresholds.minSourceTokens >= 100000);
  assert.ok(manifest.thresholds.minHeadroomTokens > 0);
  assert.ok(manifest.thresholds.minProviderHeadroomTokens > 0);
  assert.ok(manifest.thresholds.checkpointWallMs > 0);
  assert.equal(manifest.thresholds.baseline.status, "accepted");
  assert.ok(manifest.thresholds.baseline.results.providerWallMs.max > 0);
  assert.ok(manifest.thresholds.baseline.results.headroomTokens.min >= manifest.thresholds.minHeadroomTokens);
  assert.ok(
    manifest.thresholds.baseline.results.providerHeadroomTokens.min >=
      manifest.thresholds.minProviderHeadroomTokens,
  );
});
