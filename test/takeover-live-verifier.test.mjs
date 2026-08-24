import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { TOOLCHAIN } from "../shared/toolchain.mjs";
import { checkManifestHash, sha256Hex } from "./live/live-support.mjs";

const manifestBytes = readFileSync("test/live/takeover.workloads.json");
const manifest = JSON.parse(manifestBytes);

test("takeover manifest/hash、身份与 live 入口一致", () => {
  assert.equal(checkManifestHash(manifestBytes, readFileSync("test/live/takeover.workloads.sha256", "utf8")), true);
  assert.equal(manifest.identities.openviking.version, TOOLCHAIN.openvikingVersion);
  assert.equal(
    sha256Hex(readFileSync(manifest.identities.modelProfile.path)),
    manifest.identities.modelProfile.sha256,
  );
  assert.deepEqual(manifest.identities.extensionLoadOrder, ["index.ts", "scripts/e2e-probe.ts"]);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(pkg.scripts["verify:takeover:live"], "node test/live/takeover-live.mjs");
  assert.equal(existsSync("test/live/takeover-live.mjs"), true);
});

test("takeover workloads 固定接管、重启/分支与容量/compaction fail-open", () => {
  assert.deepEqual(manifest.workloads.map((workload) => workload.id), [
    "w1-takeover-stable-prefix",
    "w2-restart-branch-fail-open",
    "w3-capacity-compaction-fail-open",
    "w4-oversized-checkpoint-recovery",
  ]);
  for (const workload of manifest.workloads) {
    assert.ok(workload.summary);
    assert.ok(workload.successCriteria.length > 0);
    assert.ok(workload.falsification.length > 0);
  }
  assert.equal(manifest.environment.extensionConfig.content.takeover.contextTokenThreshold, 1);
  assert.ok(manifest.environment.capacityMismatchChars > 0);
  assert.equal(manifest.environment.oversizedAtomicChars, 30000);
  assert.ok(manifest.thresholds.baseline.fullContextUsageTokens < manifest.thresholds.baseline.automaticHighWaterTokens);
});
