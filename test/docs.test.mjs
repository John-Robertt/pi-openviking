// 文档位置、命名与引用的静态检查。
//
// 覆盖 AGENTS.md“文档位置与命名”“引用与同步”的规则。检查区分大小写：macOS 的
// 文件系统大小写不敏感，会掩盖在 Linux 与 GitHub 上真实存在的断链。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

function filesUnder(relDir, accept) {
  const out = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (["node_modules", ".artifacts", ".dev", ".obs", ".git"].includes(entry.name)) continue;
        visit(rel);
      }
      else if (accept(rel)) out.push(rel);
    }
  };
  visit(relDir);
  return out;
}

function docsMarkdownFiles() {
  return filesUnder("docs", (file) => file.endsWith(".md"));
}

function markdownFiles() {
  const root = readdirSync(REPO).filter((name) => name.endsWith(".md"));
  return [...root, ...docsMarkdownFiles()];
}

function codeFiles() {
  const out = readdirSync(REPO)
    .filter((name) => /\.(mjs|ts|mts)$/.test(name));
  for (const dir of ["shared", "scripts", "lib", "test"]) {
    out.push(...filesUnder(dir, (file) => /\.(mjs|ts|mts)$/.test(file)));
  }
  return out;
}

test("根目录只保留自动发现的文档，其余全部在 docs/", () => {
  const rootMarkdown = readdirSync(REPO).filter((name) => name.endsWith(".md"));
  assert.deepEqual(rootMarkdown.sort(), [...ROOT_DOCS].sort());
});

test("docs/ 只保留当前总纲，v1 文档位于 docs/v1/", () => {
  const entries = readdirSync(join(REPO, "docs"), { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), ["design.md", "v1"]);
  assert.ok(entries.find((entry) => entry.name === "design.md")?.isFile());
  assert.ok(entries.find((entry) => entry.name === "v1")?.isDirectory());
});

test("docs/ 内目录和文档一律小写命名", () => {
  for (const file of docsMarkdownFiles()) {
    assert.match(file, /^docs\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\.md$/, `${file} 需为小写 .md 路径`);
  }
});

test("docs/ 内每份文档都声明架构定位、核心目标与职责边界", () => {
  const missing = [];
  for (const file of docsMarkdownFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    const start = text.indexOf("## 文档职责");
    if (start < 0) {
      missing.push(`${file}: 缺少“## 文档职责”`);
      continue;
    }
    const next = text.indexOf("\n## ", start + 1);
    const section = text.slice(start, next < 0 ? undefined : next);
    for (const field of ["架构定位", "核心目标", "职责边界"]) {
      if (!section.includes(field)) missing.push(`${file}: 文档职责缺少“${field}”`);
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
  for (const file of docsMarkdownFiles()) {
    assert.ok(table.includes(file), `${file} 未登记在权威事实路径表`);
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
  let occurrences = 0;
  for (const file of markdownFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const [, found] of text.matchAll(/openviking(?:\[[^\]\s]*\])?(?:==)?[`\s]*`?(\d+\.\d+\.\d+)`?/gi)) {
      occurrences += 1;
      if (found !== TOOLCHAIN.openvikingVersion) {
        stale.push(`${file}: OpenViking ${found} ≠ pin ${TOOLCHAIN.openvikingVersion}`);
      }
    }
    for (const [, found] of text.matchAll(/Node\.js[`\s]*`?(\d+\.\d+\.\d+)`?/g)) {
      if (found !== nodeVersion) stale.push(`${file}: Node.js ${found} ≠ engines ${nodeVersion}`);
    }
  }
  assert.ok(occurrences > 0, "版本扫描未命中任何 OpenViking 版本号，正则可能已失效");
  assert.deepEqual(stale, []);
});

test("代码引用的文档路径存在，且不写小节编号", () => {
  const problems = [];
  for (const file of codeFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const [, target] of text.matchAll(/(docs\/[A-Za-z0-9._/-]+\.md|README\.md|AGENTS\.md|CLAUDE\.md)/g)) {
      if (!existsExact(target)) problems.push(`${file}: 引用了不存在的 ${target}`);
    }
    for (const [match] of text.matchAll(/\.md\s*§\s*[0-9]/g)) {
      problems.push(`${file}: 文档引用不得写小节编号 (${match.trim()})`);
    }
  }
  assert.deepEqual(problems, []);
});
