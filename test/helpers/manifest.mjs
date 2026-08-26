/** gate manifest 的规范化与 hash 固定：纯确定性函数，live verifier 与 repo 测试共用。 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestHash(manifest) {
  const { hash: _hash, ...rest } = manifest;
  return `sha256:${createHash("sha256").update(canonicalize(rest)).digest("hex")}`;
}

export function loadManifest(gateDir) {
  const manifest = JSON.parse(readFileSync(join(gateDir, "workloads.json"), "utf8"));
  if (manifest.hash !== manifestHash(manifest)) {
    throw new Error("manifest hash 不符：workloads.json 被修改且未重新固定 hash");
  }
  return manifest;
}
