/**
 * Pi Adapter：Pi 生命周期、会话快照、system-context 与模型工具的唯一边界。
 * 生命周期注册点与 fail-open 边界先于链路逻辑建立；各链路按 docs/roadmap.md 阶段接入。
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Observer } from "../observation/index.ts";

export interface PiAdapterDeps {
  observer: Observer;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function registerPiAdapter(pi: ExtensionAPI, deps: PiAdapterDeps): void {
  const { observer } = deps;
  /** 当前 session 的关联身份（sessionId），由 session_start 捕获；仅用于观察关联。 */
  let session: string | undefined;

  /**
   * 任一注册点经 guard 获得 fail-open 语义：链路失败被转化为有界结果，不向 Pi 传播；
   * 诊断输出为 stderr 单行（与 Pi 自身扩展错误通道一致），并按 operation 记录结构化事件。
   * 计时经 observer.now()，未请求观察时不产生时钟调用。
   */
  function guard<E>(
    operation: string,
    fn: (event: E, ctx: ExtensionContext) => void | Promise<void>,
  ): (event: E, ctx: ExtensionContext) => Promise<void> {
    return async (event: E, ctx: ExtensionContext) => {
      const start = observer.now();
      try {
        await fn(event, ctx);
        observer.record({
          operation,
          stage: "handle",
          outcome: "ok",
          durationMs: observer.now() - start,
          session,
        });
      } catch (cause) {
        observer.record({
          operation,
          stage: "handle",
          outcome: "error",
          durationMs: observer.now() - start,
          session,
          error: messageOf(cause),
        });
        process.stderr.write(`pi-openviking: ${operation} failed: ${messageOf(cause)}\n`);
      }
    };
  }

  pi.on(
    "session_start",
    guard("session_start", (_event: SessionStartEvent, ctx) => {
      session = ctx.sessionManager.getSessionId();
    }),
  );
  pi.on(
    "session_shutdown",
    guard("session_shutdown", () => {}),
  );
}
