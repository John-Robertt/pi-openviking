import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

test("package-lock 根元数据与 package.json 一致", () => {
  const root = lock.packages[""];
  assert.equal(lock.version, manifest.version);
  assert.equal(root.version, manifest.version);
  assert.deepEqual(root.engines, manifest.engines);
  assert.deepEqual(root.dependencies, manifest.dependencies);
  assert.deepEqual(root.devDependencies, manifest.devDependencies);
  assert.deepEqual(root.peerDependencies, manifest.peerDependencies);
});

test("peer 使用已验证最低版本且默认向前兼容", () => {
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    const match = /^>=(\d+\.\d+\.\d+)$/.exec(range);
    assert.ok(match, `${name} 必须只声明最低兼容版本`);
    const installed = lock.packages[`node_modules/${name}`]?.version;
    assert.ok(installed, `${name} 必须存在当前验证解析`);
    assert.ok(compareVersions(installed, match[1]) >= 0, `${name} 当前验证版本不得低于兼容基线`);
  }
});
