// 文档位置、命名与引用的静态检查。
//
// 覆盖 AGENTS.md“文档位置与命名”“引用与同步”的规则。检查区分大小写：macOS 的
// 文件系统大小写不敏感，会掩盖在 Linux 与 GitHub 上真实存在的断链。
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOT_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md"];

/** 区分大小写地判断路径是否存在：逐段比对真实目录项。 */
function existsExact(relPath) {
  const parts = normalize(relPath).split("/").filter(Boolean);
  let current = REPO;
  for (const part of parts) {
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      return false;
    }
    if (!entries.includes(part)) return false;
    current = join(current, part);
  }
  return true;
}

function markdownFiles() {
  const root = readdirSync(REPO).filter((name) => name.endsWith(".md"));
  const docs = readdirSync(join(REPO, "docs")).map((name) => `docs/${name}`);
  return [...root, ...docs];
}

function codeFiles() {
  const out = [];
  for (const dir of ["", "shared", "scripts", "lib", "test"]) {
    const abs = dir ? join(REPO, dir) : REPO;
    for (const name of readdirSync(abs)) {
      if (/\.(mjs|ts|mts)$/.test(name)) out.push(dir ? `${dir}/${name}` : name);
    }
  }
  return out;
}

test("根目录只保留自动发现的文档，其余全部在 docs/", () => {
  const rootMarkdown = readdirSync(REPO).filter((name) => name.endsWith(".md"));
  assert.deepEqual(rootMarkdown.sort(), [...ROOT_DOCS].sort());
});

test("docs/ 内文档一律小写命名且保持扁平", () => {
  for (const name of readdirSync(join(REPO, "docs"))) {
    assert.match(name, /^[a-z0-9-]+\.md$/, `docs/${name} 需为小写 .md 文件`);
  }
});

test("docs/ 内每份文档都声明架构定位、核心目标与职责边界", () => {
  const missing = [];
  for (const name of readdirSync(join(REPO, "docs"))) {
    const text = readFileSync(join(REPO, "docs", name), "utf8");
    const start = text.indexOf("## 文档职责");
    if (start < 0) {
      missing.push(`docs/${name}: 缺少“## 文档职责”`);
      continue;
    }
    const next = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, next < 0 ? undefined : next);
    for (const field of ["架构定位", "核心目标", "职责边界"]) {
      if (!section.includes(field)) missing.push(`docs/${name}: 文档职责缺少“${field}”`);
    }
  }
  assert.deepEqual(missing, []);
});

test("文档间的相对链接全部可达（区分大小写）", () => {
  const broken = [];
  for (const file of markdownFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:\/\//.test(target)) continue;
      const resolved = normalize(join(dirname(file), target));
      if (!existsExact(resolved)) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], "存在断链");
});

test("权威事实路径表登记的文档全部存在", () => {
  const agents = readFileSync(join(REPO, "AGENTS.md"), "utf8");
  const table = agents.slice(agents.indexOf("## 权威事实路径"), agents.indexOf("## 最小系统心智模型"));
  const missing = [];
  for (const [, target] of table.matchAll(/\]\(\.\/([^)]+)\)/g)) {
    if (!existsExact(target)) missing.push(target);
  }
  assert.deepEqual(missing, []);
  // docs/ 下的每份文档都必须在表中登记，否则会失去维护与验证路径。
  for (const name of readdirSync(join(REPO, "docs"))) {
    assert.ok(table.includes(`docs/${name}`), `docs/${name} 未登记在权威事实路径表`);
  }
});

test("发布清单逐份显式列出且全部存在", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const docs = pkg.files.filter((entry) => entry.endsWith(".md"));
  assert.ok(docs.length > 0, "发布清单需要显式列出文档");
  assert.ok(!pkg.files.includes("docs/"), "不得用 docs/ 通配代替逐份列出");
  for (const entry of docs) assert.ok(existsExact(entry), `发布清单条目缺失: ${entry}`);
});

test("文档中的 OpenViking 与 Node 版本与安装 pin 一致", async () => {
  const { TOOLCHAIN } = await import("../shared/toolchain.mjs");
  const engines = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).engines.node;
  const nodeVersion = engines.replace(/[^0-9.]/g, "");
  const stale = [];
  for (const file of markdownFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    // 文档正文保留可读的版本号；此处保证它们不会与唯一 pin 脱节。
    for (const [, found] of text.matchAll(/OpenViking[`\s]*`?(\d+\.\d+\.\d+)`?/g)) {
      if (found !== TOOLCHAIN.openvikingVersion) {
        stale.push(`${file}: OpenViking ${found} ≠ pin ${TOOLCHAIN.openvikingVersion}`);
      }
    }
    for (const [, found] of text.matchAll(/Node\.js[`\s]*`?(\d+\.\d+\.\d+)`?/g)) {
      if (found !== nodeVersion) stale.push(`${file}: Node.js ${found} ≠ engines ${nodeVersion}`);
    }
  }
  assert.deepEqual(stale, []);
});

test("代码引用的文档路径存在，且不写小节编号", () => {
  const problems = [];
  for (const file of codeFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const [, target] of text.matchAll(/((?:docs\/)?[A-Za-z0-9._-]+\.md)/g)) {
      // viking:// 命名空间内的记忆文件不是仓库文档
      if (!/^(docs\/|README|AGENTS|CLAUDE)/.test(target)) continue;
      if (!existsExact(target)) problems.push(`${file}: 引用了不存在的 ${target}`);
    }
    for (const [match] of text.matchAll(/\.md\s*§\s*[0-9]/g)) {
      problems.push(`${file}: 文档引用不得写小节编号 (${match.trim()})`);
    }
  }
  assert.deepEqual(problems, []);
});
