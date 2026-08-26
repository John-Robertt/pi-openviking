/**
 * Composition Root：唯一装配点与 Pi 扩展入口。
 * factory 抛错会使 Pi 启动失败（真实运行确认：加载路径 exit 1），因此装配保持为
 * 无 I/O 的纯构造，且 catch 不向 Pi 传播；fail-open 不变量由各注册点的 guard 各自
 * 保证，装配中途失败留下的部分注册同样不阻断 Pi 主任务。
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
