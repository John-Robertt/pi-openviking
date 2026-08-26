/**
 * Composition Root：唯一装配点与 Pi 扩展入口，持有本次运行实例的 activation。
 * factory 同步创建全部依赖并注册 callback；装配期间 callback 保持 inert（收到事件直接返回，
 * 不执行扩展工作），全部步骤成功后一次性切换为 active。任一步骤失败时运行实例保持 inert，
 * 已注册 callback 不执行任何工作；catch 不向 Pi 传播（factory 抛错会使 Pi 启动中止）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "./config/index.ts";
import { createObserver } from "./observation/index.ts";
import { registerPiAdapter } from "./pi-adapter/index.ts";

export default function (pi: ExtensionAPI): void {
  let active = false;
  // disabled 兜底：即使 observer 构造失败，catch 路径的 record 也是安全的 no-op。
  let observer = createObserver(null);
  try {
    observer = createObserver(resolveConfig(process.env).observation);
    const start = observer.now();
    registerPiAdapter(pi, { observer, active: () => active });
    active = true;
    observer.record({ operation: "assembly", stage: "compose", outcome: "ok", durationMs: observer.now() - start });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    observer.record({ operation: "assembly", stage: "compose", outcome: "error", durationMs: 0, error: message });
    process.stderr.write(`pi-openviking: extension disabled, assembly failed: ${message}\n`);
  }
}
