/**
 * Composition Root：唯一装配点与 Pi 扩展入口。
 * factory 抛错会使 Pi 启动失败（真实运行确认：加载路径 exit 1），因此装配保持为
 * 无 I/O 的纯构造；万一失败，退化为零注册的 fail-open 状态而非阻断 Pi。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiAdapter } from "./pi-adapter/index.js";

export default function (pi: ExtensionAPI): void {
  try {
    registerPiAdapter(pi);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`pi-openviking: extension disabled, assembly failed: ${message}\n`);
  }
}
