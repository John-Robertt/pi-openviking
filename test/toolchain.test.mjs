import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  isToolchainPlatformSupported,
  OPENVIKING_SPEC,
  TOOLCHAIN,
  toolchainPaths,
  ZSTANDARD_SPEC,
} from "../shared/toolchain.mjs";

test("OPENVIKING_SPEC 由 pin 常量确定性组合", () => {
  assert.equal(OPENVIKING_SPEC, `openviking[local-embed]==${TOOLCHAIN.openvikingVersion}`);
  assert.equal(ZSTANDARD_SPEC, `zstandard==${TOOLCHAIN.zstandardVersion}`);
});

test("toolchainPaths 按平台生成正确布局", () => {
  const linux = toolchainPaths("/home/dev", { platformName: "linux" });
  assert.equal(linux.uvBin, "/home/dev/bin/uv");
  assert.equal(linux.venvPython, "/home/dev/venv/bin/python");
  assert.equal(linux.serverBin, "/home/dev/venv/bin/openviking-server");
  assert.equal(linux.pythonDir, "/home/dev/python");
  assert.equal(linux.uvCache, "/home/dev/cache/uv");

  // join 使用运行平台的分隔符；模拟 win32 时先归一化再比较。
  const win = toolchainPaths("C:\\dev", { platformName: "win32" });
  const norm = (p) => p.replace(/\\/g, "/");
  assert.equal(norm(win.uvBin), "C:/dev/bin/uv.exe");
  assert.equal(norm(win.venvPython), "C:/dev/venv/Scripts/python.exe");
  assert.equal(norm(win.serverBin), "C:/dev/venv/Scripts/openviking-server.exe");
});

test("平台支持矩阵覆盖六类目标并拒绝未知组合", () => {
  for (const key of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) {
    const [p, a] = key.split("-");
    assert.ok(isToolchainPlatformSupported(p, a), key);
  }
  assert.equal(isToolchainPlatformSupported("linux", "riscv64"), false);
  assert.equal(isToolchainPlatformSupported("freebsd", "x64"), false);
});

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function documentationFiles() {
  const files = readdirSync(REPO)
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(REPO, name));
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".md")) files.push(path);
    }
  };
  visit(join(REPO, "docs"));
  return files;
}

test("发布文档中的 OpenViking 与 Node 版本保持 toolchain pin 一致", () => {
  const engines = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).engines.node;
  const nodeVersion = engines.replace(/[^0-9.]/g, "");
  const stale = [];
  let openVikingOccurrences = 0;

  for (const file of documentationFiles()) {
    const text = readFileSync(file, "utf8");
    for (const [, found] of text.matchAll(/openviking(?:\[[^\]\s]*\])?(?:==)?[`\s]*`?(\d+\.\d+\.\d+)`?/gi)) {
      openVikingOccurrences += 1;
      if (found !== TOOLCHAIN.openvikingVersion) {
        stale.push(`${file}: OpenViking ${found} ≠ pin ${TOOLCHAIN.openvikingVersion}`);
      }
    }
    for (const [, found] of text.matchAll(/Node\.js[`\s]*`?(\d+\.\d+\.\d+)`?/g)) {
      if (found !== nodeVersion) stale.push(`${file}: Node.js ${found} ≠ engines ${nodeVersion}`);
    }
  }

  assert.ok(openVikingOccurrences > 0, "版本扫描未命中任何 OpenViking 版本号，正则可能已失效");
  assert.deepEqual(stale, []);
});
