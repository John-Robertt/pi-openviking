/**
 * pi-memory gate 探针：resolveCueSet 抛出异常，验证 callback 失败沿 Pi 原生扩展错误路径
 * 报告，且 compaction 结果与 Pi 主流程不受影响、不保存 CueSet。
 * Pi 的扩展加载器不解析相对模块路径，仓库模块按 probe 位置推出的绝对路径动态导入。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const { registerPiAdapter } = await import(join(REPO, "src/pi-adapter/index.ts"));
const { createObserver } = await import(join(REPO, "src/observation/index.ts"));
const { resolveConfig } = await import(join(REPO, "src/config/index.ts"));

export default function (pi) {
  registerPiAdapter(pi, {
    observer: createObserver(resolveConfig(process.env).observation),
    active: () => true,
    onSourceEntries: () => {},
    resolveCueSet: () => {
      throw new Error("gate injection: cue resolution failure");
    },
  });
}
