/**
 * Pi Adapter：Pi 生命周期、会话快照、system-context 与模型工具的唯一边界。
 * 生命周期注册点与 fail-open 边界先于链路逻辑建立；各链路按 docs/roadmap.md 阶段接入。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 任一注册点经 guard 获得 fail-open 语义：链路失败被转化为有界结果，不向 Pi 传播；
 * 诊断输出为 stderr 单行。
 */
function guard(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`pi-openviking: ${name} failed: ${message}\n`);
    }
  };
}

export function registerPiAdapter(pi: ExtensionAPI): void {
  pi.on(
    "session_start",
    guard("session_start", async () => {}),
  );
  pi.on(
    "session_shutdown",
    guard("session_shutdown", async () => {}),
  );
}
