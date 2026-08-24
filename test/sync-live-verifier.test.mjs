// test/sync-live-verifier.test.mjs — verify:sync:live 的确定性静态检查。
//
// live gate 的正确性由真实运行证明；这里只覆盖 sync manifest、seed 与 ACK identity。
// 共享 verifier 骨架由 test/live-support.test.mjs 验证。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { seededString } from "./live/sync-live.mjs";
import {
  ackFileKey,
  checkManifestHash,
  probePiHost,
  sha256Hex,
} from "./live/live-support.mjs";
import { canonicalJsonBytes } from "../shared/canonical-json.mjs";
import { TOOLCHAIN } from "../shared/toolchain.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifestBytes = readFileSync(join(REPO, "test/live/sync.workloads.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));

test("manifest 字节 hash 与固定 .sha256 文件一致", () => {
  const hashText = readFileSync(join(REPO, "test/live/sync.workloads.sha256"), "utf8");
  assert.ok(checkManifestHash(manifestBytes, hashText), "manifest 被修改后必须重新固定 hash");
});

test("manifest 历史身份有效且当前 Pi host 满足兼容边界", () => {
  for (const rel of manifest.identities.extensionLoadOrder) {
    assert.ok(existsSync(join(REPO, rel)), `缺少扩展 ${rel}`);
  }
  assert.ok(existsSync(join(REPO, manifest.identities.modelProfile.path)));
  assert.ok(
    manifest.identities.pi.binPath.startsWith(`node_modules/${manifest.identities.pi.package}/`),
    "manifest 的 Pi CLI 路径必须是历史验证包内的相对路径",
  );
  const profileBytes = readFileSync(join(REPO, manifest.identities.modelProfile.path));
  assert.equal(sha256Hex(profileBytes), manifest.identities.modelProfile.sha256);
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const peerRange = pkg.peerDependencies?.[manifest.identities.pi.package];
  const piHost = probePiHost(REPO, manifest.identities.pi.package, peerRange);
  assert.ok(
    piHost.versionSupported,
    `当前 Pi ${piHost.version ?? piHost.error} 不满足 peer ${peerRange}`,
  );
  assert.ok(piHost.binPath, piHost.error ?? "当前 Pi CLI 不存在");
  assert.ok(
    piHost.cliVersionMatches,
    piHost.error ?? `当前 Pi CLI 报告 ${piHost.reportedVersion ?? "无版本"}，metadata 为 ${piHost.version}`,
  );
  assert.equal(pkg.scripts["verify:sync:live"], "node test/live/sync-live.mjs");
  // manifest 声明的服务身份必须与安装 pin 一致。gate 的 preflight 会用真实 /health 再核一次，
  // 这里把同一事实提前到 npm test，使升级 pin 后立即知道 manifest 需要随基线一并重做。
  assert.equal(
    manifest.identities.openviking.version,
    TOOLCHAIN.openvikingVersion,
    "manifest 的 OpenViking 版本与 shared/toolchain.mjs 的安装 pin 不一致",
  );
  assert.equal(manifest.identities.node.engines, pkg.engines.node);
});

test("manifest workload 结构完整：成功标准、证伪条件与阈值决策规则齐备", () => {
  assert.ok(manifest.workloads.length >= 1);
  for (const w of manifest.workloads) {
    assert.ok(w.id && w.summary, "workload 需要 id/summary");
    assert.ok(Array.isArray(w.steps) && w.steps.length > 0, `${w.id} 缺少 steps`);
    assert.ok(Array.isArray(w.successCriteria) && w.successCriteria.length > 0, `${w.id} 缺少成功标准`);
    assert.ok(Array.isArray(w.falsification) && w.falsification.length > 0, `${w.id} 缺少证伪条件`);
  }
  for (const key of ["piRunWallMs", "agentSettledMs", "syncNotifyMs", "devUpMs", "cleanupSettleMs"]) {
    assert.ok(Number.isFinite(manifest.thresholds[key]) && manifest.thresholds[key] > 0, `缺少阈值 ${key}`);
  }
  assert.ok(manifest.thresholds.baseline?.runs?.length >= 1, "缺少 baseline 实测记录");
});

test("seededString 确定性、长度与字符集", () => {
  const a = seededString("seed", 1000);
  const b = seededString("seed", 1000);
  const c = seededString("other", 1000);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 1000);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(seededString("seed", 0), "");
  assert.throws(() => seededString("seed", -1), TypeError);
  // manifest 固定的 blob 参数必须产生 >8MiB 的规范事件字节（进入 chunked 表示）
  const blob = seededString(manifest.workloads[0].inputs.blobSeed, manifest.workloads[0].inputs.blobChars);
  assert.equal(blob.length, 8392704);
  assert.ok(Buffer.byteLength(JSON.stringify(blob)) > 8 * 1024 * 1024);
});

test("ackFileKey 与 sync 层 ACK target 规范数组契约一致", () => {
  const key = ackFileKey("http://127.0.0.1:19331", "dev", "dev--pi-s1", "s1");
  const expected = createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/sync-ack", 1, { endpoint: "http://127.0.0.1:19331", account: "dev", user: "dev--pi-s1" }, "s1"]))
    .digest("hex");
  assert.equal(key, expected);
  assert.match(key, /^[0-9a-f]{64}$/);
});
