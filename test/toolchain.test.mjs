import assert from "node:assert/strict";
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
  assert.match(TOOLCHAIN.xxhashConstraint, /^xxhash<\d+$/);
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
