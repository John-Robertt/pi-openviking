import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(REPO, "src");

/** design.md「依赖规则」在 src/ 的静态表达：各模块目录允许引用的其他模块目录。 */
const ALLOWED_IMPORTS = {
  "index.ts": ["config", "observation", "pi-adapter"],
  "pi-adapter": ["observation"],
  observation: [],
  config: [],
};

function moduleOf(file) {
  const rel = relative(SRC, file);
  return rel.includes("/") ? rel.split("/")[0] : rel;
}

function* walk(dir) {
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (name.isDirectory()) yield* walk(path);
    else if (name.name.endsWith(".ts")) yield path;
  }
}

test("依赖边界：src 模块只引用 design.md 允许的依赖方向", () => {
  const violations = [];
  for (const file of walk(SRC)) {
    const from = moduleOf(file);
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(/from\s+"(\.[^"]+)"/g)) {
      const target = moduleOf(join(file, "..", match[1]));
      if (target === from) continue;
      const allowed = ALLOWED_IMPORTS[from] ?? [];
      if (!allowed.includes(target)) violations.push(`${relative(REPO, file)} -> ${target}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("声明一致：package.json 的扩展入口与 dev.mjs wrapper 目标指向同一文件", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.pi.extensions.length, 1);
  const entry = join(REPO, pkg.pi.extensions[0]);
  assert.ok(existsSync(entry), `${pkg.pi.extensions[0]} 不存在`);
  const devMjs = readFileSync(join(REPO, "scripts/dev.mjs"), "utf8");
  const spelled = pkg.pi.extensions[0].replace(/^\.\//, "");
  const segments = spelled.split("/").map((s) => `"${s}"`).join(", ");
  assert.ok(
    devMjs.includes(spelled) || devMjs.includes(segments),
    "dev.mjs 未引用同一入口",
  );
});
