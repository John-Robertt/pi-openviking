import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CHECKPOINT_MODEL, CHECKPOINT_PROMPT_VERSION } from "../shared/checkpoint.mjs";
import { TOOLCHAIN } from "../shared/toolchain.mjs";
import { checkManifestHash, sha256Hex } from "./live/live-support.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifestPath = join(REPO, "test/live/checkpoint.workloads.json");
const hashPath = join(REPO, "test/live/checkpoint.workloads.sha256");
const bytes = readFileSync(manifestPath);
const manifest = JSON.parse(bytes.toString("utf8"));

test("checkpoint manifest/hash、身份与 live 入口一致", () => {
  assert.ok(checkManifestHash(bytes, readFileSync(hashPath, "utf8")));
  assert.equal(manifest.identities.openviking.version, TOOLCHAIN.openvikingVersion);
  const profile = readFileSync(join(REPO, manifest.identities.modelProfile.path));
  assert.equal(sha256Hex(profile), manifest.identities.modelProfile.sha256);
  assert.ok(manifest.mechanism.modelField.includes(CHECKPOINT_MODEL));
  assert.equal(manifest.mechanism.promptVersion, CHECKPOINT_PROMPT_VERSION);
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json")));
  assert.equal(pkg.scripts["verify:checkpoint:live"], "node test/live/checkpoint-live.mjs");
  assert.ok(existsSync(join(REPO, "test/live/checkpoint-live.mjs")));
});

test("checkpoint workload 固定成功、证伪、真实 VLM 与阈值", () => {
  assert.deepEqual(manifest.workloads.map((workload) => workload.id), [
    "w1-checkpoint-formation",
    "w2-multimodal-checkpoint",
    "w3-failure-retry",
    "w4-restart-backlog",
  ]);
  for (const workload of manifest.workloads) {
    assert.ok(workload.summary);
    assert.ok(workload.successCriteria.length > 0);
    assert.ok(workload.falsification.length > 0);
  }
  assert.ok(manifest.thresholds.baseline.runs.length >= 4);
  assert.ok(manifest.thresholds.checkpointWallMs > 0);
  assert.match(manifest.environment.credentials, /受管 OpenViking/);
});
