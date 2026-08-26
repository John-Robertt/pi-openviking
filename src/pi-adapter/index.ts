/**
 * Pi Adapter：Pi 生命周期、会话快照、system-context 与模型工具的唯一边界。
 * 生命周期注册点与 active/inert 边界先于链路逻辑建立；各链路按 docs/roadmap.md 阶段接入。
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Observer } from "../observation/index.ts";

export interface PiAdapterDeps {
  observer: Observer;
  /** Composition Root 持有的激活状态；false 时 callback 直接返回，不执行扩展工作。 */
  active: () => boolean;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function registerPiAdapter(pi: ExtensionAPI, deps: PiAdapterDeps): void {
  const { observer, active } = deps;
  /** 当前 session 的关联身份（sessionId），由 session_start 捕获；仅用于观察关联。 */
  let session: string | undefined;

  /**
   * guard 只做两件事：inert 时直接返回；把每次调用的结构化证据交给 observer。
   * 异常在记录后原样抛出，由 Pi 原生扩展错误路径报告与隔离，本模块不替代它。
   * handler 内的扩展工作必须是有界本地工作，不等待后台外部任务。
   * 记录关联的 session 取 handler 执行后的当前身份；handler 可返回身份覆盖，用于记录
   * 刚刚结束的身份（session_shutdown：记录属于已结束的 session，之后的事件不再关联它）。
   */
  function guard<E>(
    operation: string,
    fn: (event: E, ctx: ExtensionContext) => undefined | string | Promise<undefined | string>,
  ): (event: E, ctx: ExtensionContext) => Promise<void> {
    return async (event: E, ctx: ExtensionContext) => {
      if (!active()) return;
      const start = observer.now();
      try {
        const identity = (await fn(event, ctx)) ?? session;
        observer.record({
          operation,
          stage: "handle",
          outcome: "ok",
          durationMs: observer.now() - start,
          session: identity,
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
        throw cause;
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
    // 记录关联刚结束的 session，之后的事件不再属于它（如 /reload 重建前）。
    guard("session_shutdown", () => {
      const ended = session;
      session = undefined;
      return ended;
    }),
  );
}
