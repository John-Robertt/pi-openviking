// docs/documentation.md 定义的文档位置、命名、引用与发布路径检查。
// 检查区分大小写，避免大小写不敏感文件系统掩盖真实断链。
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const ROOT_DOCS = ["README.md", "AGENTS.md", "CLAUDE.md"];
const SKIP_DIRS = new Set(["node_modules", ".artifacts", ".dev", ".obs", ".git"]);

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
        if (!SKIP_DIRS.has(entry.name)) visit(rel);
      } else if (accept(rel)) {
        out.push(rel);
      }
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
  const out = readdirSync(REPO).filter((name) => /\.(mjs|ts|mts)$/.test(name));
  for (const dir of ["shared", "scripts", "lib", "test"]) {
    out.push(...filesUnder(dir, (file) => /\.(mjs|ts|mts)$/.test(file)));
  }
  return out;
}

test("根目录只保留自动发现的 Markdown 文档", () => {
  const rootMarkdown = readdirSync(REPO).filter((name) => name.endsWith(".md"));
  assert.deepEqual(rootMarkdown.sort(), [...ROOT_DOCS].sort());
});

test("docs/ 包含文档架构入口", () => {
  const entries = readdirSync(join(REPO, "docs"), { withFileTypes: true });
  assert.ok(entries.find((entry) => entry.name === "design.md")?.isFile());
  assert.ok(entries.find((entry) => entry.name === "documentation.md")?.isFile());
});

test("docs/ 路径使用小写名称且内容为 Markdown", () => {
  const visit = (dir) => {
    for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        assert.match(entry.name, /^[a-z0-9-]+$/, `${dir}/${entry.name} 需为小写目录名`);
        visit(`${dir}/${entry.name}`);
      } else {
        assert.match(entry.name, /^[a-z0-9-]+\.md$/, `${dir}/${entry.name} 需为小写 .md 文件`);
      }
    }
  };
  visit("docs");
});

test("文档间的相对链接全部可达", () => {
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

test("发布清单声明的文档路径存在", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  const publishedDocs = pkg.files.filter((entry) => entry.endsWith(".md"));
  assert.ok(publishedDocs.length > 0, "发布清单需要包含文档入口");
  for (const entry of publishedDocs) {
    assert.ok(existsExact(entry), `发布清单条目缺失: ${entry}`);
  }
});

test("代码引用的仓库文档路径全部存在", () => {
  const problems = [];
  for (const file of codeFiles()) {
    const text = readFileSync(join(REPO, file), "utf8");
    for (const [, target] of text.matchAll(/(docs\/[A-Za-z0-9._/-]+\.md|README\.md|AGENTS\.md|CLAUDE\.md)/g)) {
      if (!existsExact(target)) problems.push(`${file}: 引用了不存在的 ${target}`);
    }
  }
  assert.deepEqual(problems, []);
});
