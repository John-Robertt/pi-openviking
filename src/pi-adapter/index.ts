/**
 * Pi Adapter：Pi 生命周期、会话快照、system-context 与模型工具的唯一边界。
 * 当前切片：生命周期注册点与 fail-open 边界；快照构造与 context/工具接入由
 * docs/roadmap.md 后续阶段填充，注册方式不变。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (...args: never[]) => Promise<void>;

/**
 * 任一注册点经 guard 获得 fail-open 语义：链路失败被转化为有界结果，不向 Pi 传播。
 * 诊断在 observation 建立前走 stderr——结构化 sink 接入后替换此通道。
 */
function guard<H extends Handler>(name: string, fn: H): H {
  return (async (...args: Parameters<H>) => {
    try {
      await fn(...args);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`pi-openviking: ${name} failed: ${message}\n`);
    }
  }) as H;
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
