/**
 * pi-memory gate 探针：以真实 registerPiAdapter 装配，注入两项测试驱动——
 * 固定 CueSet（cues 来自 gate 输入，lastUsedEntryId 取 compaction entry 的 parentId，
 * 即压缩前当前路径的最后一条 entry）与来源 entries 收集记录。
 * 另注册两个只读捕获 handler：compaction preparation 与普通 provider payload
 * 是否携带 cue 标记。全部证据写入 GATE_EVIDENCE_DIR（运行目录，gate 结束时清理）。
 * Pi 的扩展加载器不解析相对模块路径，仓库模块一律按 probe 位置推出的绝对路径动态导入。
 */
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const { registerPiAdapter } = await import(join(REPO, "src/pi-adapter/index.ts"));
const { createObserver } = await import(join(REPO, "src/observation/index.ts"));
const { resolveConfig } = await import(join(REPO, "src/config/index.ts"));
const { canonicalize } = await import(join(REPO, "test/helpers/manifest.mjs"));

const input = JSON.parse(readFileSync(process.env.GATE_INPUT, "utf8"));
const evidenceDir = process.env.GATE_EVIDENCE_DIR;
// JSON round-trip：内存对象可能带 undefined 值字段，JSONL 落盘会丢弃它们；先归一化再 hash，
// 使探针与 verifier（读 session 文件）对同一 entry 得到同一 canonical 表示。
const hash = (value) =>
  createHash("sha256").update(canonicalize(JSON.parse(JSON.stringify(value)))).digest("hex");
const append = (name, value) => appendFileSync(`${evidenceDir}/${name}`, `${JSON.stringify(value)}\n`);

export default function (pi) {
  registerPiAdapter(pi, {
    observer: createObserver(resolveConfig(process.env).observation),
    active: () => true,
    // 收集证据只留 id/type/hash，不带用户正文；verifier 对 Pi session 文件重算同一序列比对。
    onSourceEntries: (entries) =>
      append(
        "collected.jsonl",
        entries.map((entry) => ({ id: entry.id, type: entry.type, h: hash(entry) })),
      ),
    resolveCueSet: (event) => ({
      cues: input.cues,
      lastUsedEntryId: event.compactionEntry.parentId,
    }),
  });
  pi.on("session_before_compact", (event) => {
    const text =
      JSON.stringify(event.preparation.messagesToSummarize) +
      JSON.stringify(event.preparation.turnPrefixMessages);
    append("scans.jsonl", { hook: "before_compact", marker: text.includes(input.marker) });
  });
  pi.on("before_provider_request", (event) => {
    const text = JSON.stringify(event.payload);
    // 当前 prompt 是 payload 中最后出现的那个（此前 prompt 可能残留在 compaction summary 中）。
    let prompt = -1;
    let lastAt = -1;
    input.prompts.forEach((p, i) => {
      const at = text.lastIndexOf(p);
      if (at > lastAt) {
        lastAt = at;
        prompt = i;
      }
    });
    append("scans.jsonl", { hook: "provider_request", marker: text.includes(input.marker), prompt });
  });
}
