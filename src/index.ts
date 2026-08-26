/**
 * Composition Root：唯一装配点与 Pi 扩展入口。
 * factory 抛错会使 Pi 启动中止（exit 1），因此装配保持为无 I/O 的纯构造，且 catch
 * 不向 Pi 传播；fail-open 不变量由各注册点的 guard 各自保证，装配中途失败留下的
 * 部分注册同样不阻断 Pi 主任务。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config/index.js";
import { createObserver } from "./observation/index.js";
import { registerPiAdapter } from "./pi-adapter/index.js";

export default function (pi: ExtensionAPI): void {
  const observer = createObserver(resolveConfig(process.env).observation);
  const start = observer.now();
  try {
    registerPiAdapter(pi, { observer });
    observer.record({ operation: "assembly", stage: "compose", outcome: "ok", durationMs: observer.now() - start });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    observer.record({
      operation: "assembly",
      stage: "compose",
      outcome: "error",
      durationMs: observer.now() - start,
      error: message,
    });
    process.stderr.write(`pi-openviking: extension disabled, assembly failed: ${message}\n`);
  }
}
