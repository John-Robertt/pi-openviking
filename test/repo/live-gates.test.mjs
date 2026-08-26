import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestHash } from "../helpers/manifest.mjs";

const LIVE = fileURLToPath(new URL("../live/", import.meta.url));

const REQUIRED_KEYS = ["gate", "identity", "falsification", "hash"];

function* gates() {
  for (const entry of readdirSync(LIVE, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "helpers" && existsSync(join(LIVE, entry.name, "workloads.json"))) {
      yield entry.name;
    }
  }
}

test("live gate manifest：hash 固定且必要字段齐全", () => {
  const found = [...gates()];
  assert.ok(found.length > 0, "未发现任何 live gate");
  for (const gate of found) {
    const manifest = JSON.parse(readFileSync(join(LIVE, gate, "workloads.json"), "utf8"));
    for (const key of REQUIRED_KEYS) assert.ok(key in manifest, `${gate}: 缺少 ${key}`);
    assert.equal(manifest.hash, manifestHash(manifest), `${gate}: hash 未固定`);
  }
});
