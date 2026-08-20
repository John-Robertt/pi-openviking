// test/live-verifier.test.mjs — verify:phase0:live 的确定性静态检查。
//
// live gate 的正确性由真实运行证明；这里只覆盖不依赖真实边界的部分：
// manifest 与固定 hash 的一致性（防止 manifest 被改而未重新固定）、manifest 引用
// 路径存在、纯决策函数（seededString / checkManifestHash / derivePassed /
// conflictBytesOf / createRpcLineParser / ackFileKey / buildLivePiInvocation）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { seededString } from "./live/phase0-live.mjs";
import {
  ackFileKey,
  buildLivePiInvocation,
  checkManifestHash,
  conflictBytesOf,
  createRpcLineParser,
  derivePassed,
  sha256Hex,
} from "./live/live-support.mjs";
import { canonicalJsonBytes } from "../shared/canonical-json.mjs";
import { TOOLCHAIN } from "../shared/toolchain.mjs";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifestBytes = readFileSync(join(REPO, "test/live/phase0.workloads.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));

test("manifest 字节 hash 与固定 .sha256 文件一致", () => {
  const hashText = readFileSync(join(REPO, "test/live/phase0.workloads.sha256"), "utf8");
  assert.ok(checkManifestHash(manifestBytes, hashText), "manifest 被修改后必须重新固定 hash");
});

test("manifest 引用的路径与身份在当前仓库存在", () => {
  for (const rel of manifest.identities.extensionLoadOrder) {
    assert.ok(existsSync(join(REPO, rel)), `缺少扩展 ${rel}`);
  }
  assert.ok(existsSync(join(REPO, manifest.identities.modelProfile.path)));
  assert.ok(existsSync(join(REPO, manifest.identities.pi.binPath)));
  const profileBytes = readFileSync(join(REPO, manifest.identities.modelProfile.path));
  assert.equal(sha256Hex(profileBytes), manifest.identities.modelProfile.sha256);
  const piPkg = JSON.parse(readFileSync(join(REPO, "node_modules", manifest.identities.pi.package, "package.json"), "utf8"));
  assert.equal(piPkg.version, manifest.identities.pi.version);
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.scripts["verify:phase0:live"], "node test/live/phase0-live.mjs");
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

test("live Pi invocation 按任务模型与 provider override 隔离凭证", () => {
  const profile = {
    taskModel: { provider: "task-provider", model: "task-model", apiKeyEnv: "TASK_API_KEY" },
    vlm: { provider: "vlm-provider", model: "vlm-model", apiKeyEnv: "VLM_API_KEY" },
  };
  const common = {
    piBin: "/repo/pi",
    extensionLoadOrder: ["index.ts"],
    sessionId: "session-1",
    runDir: "/repo/run",
    endpoint: "http://127.0.0.1:19331",
    openviking: { account: "dev", user: "dev" },
    profile,
    taskApiKey: "selected-task-key",
    turn: 0,
    baseEnv: { PATH: "/usr/bin", TASK_API_KEY: "inherited-task", VLM_API_KEY: "inherited-vlm" },
  };
  const task = buildLivePiInvocation(common);
  assert.equal(task.args[task.args.indexOf("--provider") + 1], "task-provider");
  assert.equal(task.env.TASK_API_KEY, "selected-task-key");
  assert.equal(task.env.VLM_API_KEY, undefined);

  const override = { provider: "scripted", model: "scripted-model", apiKeyEnv: "SCRIPTED_API_KEY" };
  const overridden = buildLivePiInvocation({
    ...common,
    provider: override,
    baseEnv: { ...common.baseEnv, SCRIPTED_API_KEY: "inherited-scripted" },
  });
  assert.equal(overridden.args[overridden.args.indexOf("--provider") + 1], "scripted");
  assert.equal(overridden.env.TASK_API_KEY, undefined);
  assert.equal(overridden.env.VLM_API_KEY, undefined);
  assert.equal(overridden.env.SCRIPTED_API_KEY, undefined);

  const explicitOverride = buildLivePiInvocation({
    ...common,
    provider: override,
    baseEnv: { ...common.baseEnv, SCRIPTED_API_KEY: "inherited-scripted" },
    extraEnv: { SCRIPTED_API_KEY: "selected-scripted" },
  });
  assert.equal(explicitOverride.env.TASK_API_KEY, undefined);
  assert.equal(explicitOverride.env.VLM_API_KEY, undefined);
  assert.equal(explicitOverride.env.SCRIPTED_API_KEY, "selected-scripted");
});

test("checkManifestHash 拒绝格式错误与不匹配", () => {
  assert.equal(checkManifestHash(manifestBytes, "not-a-hash"), false);
  assert.equal(checkManifestHash(manifestBytes, "0".repeat(64)), false);
  assert.equal(checkManifestHash(Buffer.from("x"), "b".repeat(64)), false);
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

test("derivePassed 只由全部断言派生", () => {
  assert.equal(derivePassed([]), false);
  assert.equal(derivePassed([{ pass: true }]), true);
  assert.equal(derivePassed([{ pass: true }, { pass: false }]), false);
});

test("conflictBytesOf 确定性单字节变更", () => {
  const bytes = Buffer.from("hello world");
  const conflict = conflictBytesOf(bytes);
  assert.equal(conflict.length, bytes.length);
  assert.notDeepEqual(conflict, bytes);
  assert.deepEqual(conflictBytesOf(bytes), conflict);
  assert.deepEqual(bytes, Buffer.from("hello world"), "不得修改入参");
});

test("createRpcLineParser 只按 LF 分帧并容忍不可解析行", () => {
  const parse = createRpcLineParser();
  assert.deepEqual(parse('{"type":"a"}\r\n{"type":"b'), [{ type: "a" }]);
  const rest = parse('"}\nnot-json\n{"type":"c"}\n');
  assert.equal(rest[0].type, "b");
  assert.equal(rest[1].type, "__unparsed");
  assert.equal(rest[2].type, "c");
  // U+2028/U+2029 不是分帧符：含它们的 JSON 字符串保持一条记录
  const parse2 = createRpcLineParser();
  const withSeparator = parse2('{"type":"x","s":"a\u2028b"}\n');
  assert.equal(withSeparator.length, 1);
  assert.equal(withSeparator[0].s, "a\u2028b");
});

test("ackFileKey 与 sync 层 ACK target 规范数组契约一致", () => {
  const key = ackFileKey("http://127.0.0.1:19331", "dev", "dev--pi-s1", "s1");
  const expected = createHash("sha256")
    .update(canonicalJsonBytes(["pi-openviking/sync-ack", 1, { endpoint: "http://127.0.0.1:19331", account: "dev", user: "dev--pi-s1" }, "s1"]))
    .digest("hex");
  assert.equal(key, expected);
  assert.match(key, /^[0-9a-f]{64}$/);
});
