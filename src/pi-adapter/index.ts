/**
 * Pi Adapter：Pi 生命周期、来源 entries、compaction、context 与模型工具的唯一边界。
 *
 * 本模块只做有界本地工作，异常在记录观察后原样抛出，由 Pi 原生扩展错误路径报告。
 * 两个模块间接缝（onSourceEntries、resolveCueSet）由 Composition Root 装配；
 * 缺省时对应工作不发生——「会话事实同步」与「Compaction 记忆线索」阶段会接入真实实现。
 */
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionCompactEvent,
  SessionEntry,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { CUES_CUSTOM_TYPE, formatCueContext, type CueSet } from "../contracts/cue-set.ts";
import type { Observer } from "../observation/index.ts";

export interface PiAdapterDeps {
  observer: Observer;
  /** Composition Root 持有的激活状态；false 时 callback 直接返回，不执行扩展工作。 */
  active: () => boolean;
  /** Fact Synchronizer 的接入点：接收 Pi 已接受的来源 entries 全量快照（原值、原顺序）。 */
  onSourceEntries?: (entries: SessionEntry[]) => void;
  /**
   * Cue Provider 结果的接入点：session_compact 时返回已经生成的 CueSet，无结果返回 undefined。
   * 「Compaction 记忆线索」阶段把它替换为任务式来源（before_compact 启动、compact 提交或取消）。
   */
  resolveCueSet?: (event: SessionCompactEvent, ctx: ExtensionContext) => CueSet | undefined;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 来源事实 = Pi 已接受的全部 entries，排除扩展自身的 CueSet custom entry。 */
function collectSourceEntries(entries: SessionEntry[]): SessionEntry[] {
  return entries.filter((entry) => !(entry.type === "custom" && entry.customType === CUES_CUSTOM_TYPE));
}

export function registerPiAdapter(pi: ExtensionAPI, deps: PiAdapterDeps): void {
  const { observer, active } = deps;
  /** 当前 session 的关联身份（sessionId），由 session_start 捕获；仅用于观察关联。 */
  let session: string | undefined;

  /**
   * guard 只做两件事：inert 时直接返回；把每次调用的结构化证据交给 observer。
   * fn 的返回值原样交给 Pi（如 context hook 的 messages）。recordSession 用于记录
   * 刚刚结束的身份（session_shutdown：记录属于已结束的 session，之后的事件不再关联它）。
   * 异常在记录后原样抛出，由 Pi 原生扩展错误路径报告与隔离，本模块不替代它。
   */
  function guard<E, R>(
    operation: string,
    fn: (
      event: E,
      ctx: ExtensionContext,
      recordSession: (session: string) => void,
    ) => R | Promise<R>,
  ): (event: E, ctx: ExtensionContext) => Promise<R | undefined> {
    return async (event: E, ctx: ExtensionContext) => {
      if (!active()) return undefined;
      const start = observer.now();
      let endedSession: string | undefined;
      const recordSession = (value: string) => {
        endedSession = value;
      };
      try {
        const result = await fn(event, ctx, recordSession);
        observer.record({
          operation,
          stage: "handle",
          outcome: "ok",
          durationMs: observer.now() - start,
          session: endedSession ?? session,
        });
        return result;
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

  function deliverSourceEntries(ctx: ExtensionContext): void {
    deps.onSourceEntries?.(collectSourceEntries(ctx.sessionManager.getEntries()));
  }

  pi.on(
    "session_start",
    guard("session_start", (_event: SessionStartEvent, ctx) => {
      session = ctx.sessionManager.getSessionId();
    }),
  );
  pi.on(
    "session_shutdown",
    guard("session_shutdown", (_event, _ctx, recordSession) => {
      const ended = session;
      session = undefined;
      if (ended !== undefined) recordSession(ended);
    }),
  );

  // turn_end 时本 turn 新接受的 entries 已落进 session；compaction entry 由 session_compact 覆盖。
  pi.on(
    "turn_end",
    guard("turn_end", (_event, ctx) => {
      deliverSourceEntries(ctx);
    }),
  );

  pi.on(
    "session_compact",
    guard("session_compact", (event: SessionCompactEvent, ctx) => {
      // compaction entry 已被 Pi 接受，同属来源事实。
      deliverSourceEntries(ctx);
      const cueSet = deps.resolveCueSet?.(event, ctx);
      if (!cueSet) return;
      // 只提交仍有效的结果（design.md 运行步骤）：runtime active 由 guard 保证；结果引用的
      // 最后一条 entry 必须仍在当前路径。本阶段来源是同步调用，tree 导航不可能插入其中，
      // false 分支要到「Compaction 记忆线索」阶段的任务式异步来源才真实可达。
      const onPath = ctx.sessionManager.getBranch().some((entry) => entry.id === cueSet.lastUsedEntryId);
      if (!onPath) return;
      pi.appendEntry(CUES_CUSTOM_TYPE, cueSet);
    }),
  );

  // 只在普通 provider 请求中临时呈现当前路径的有效 CueSet：CueSet custom entry 不产生
  // LLM 消息（Pi 语义），compaction 的 summary 调用不经过 context hook（Pi 实现），
  // 因此这里的注入不会进入后续 compaction。
  pi.on(
    "context",
    guard("context", (event: ContextEvent, ctx): { messages: ContextEvent["messages"] } | undefined => {
      const entries = ctx.sessionManager.buildContextEntries();
      const cueEntry = entries.findLast(
        (entry) => entry.type === "custom" && entry.customType === CUES_CUSTOM_TYPE,
      );
      // data 在 Pi 侧是 unknown；先按 CueSet 解读再做形状校验，校验不过就不投影。
      const cueSet = (cueEntry?.type === "custom" ? cueEntry.data : undefined) as CueSet | undefined;
      if (
        cueSet === undefined ||
        !Array.isArray(cueSet.cues) ||
        typeof cueSet.lastUsedEntryId !== "string"
      ) {
        return undefined;
      }
      const coveredAt = ctx.sessionManager.getEntry(cueSet.lastUsedEntryId)?.timestamp;
      const text = formatCueContext(cueSet, coveredAt);
      return {
        messages: [...event.messages, { role: "user", content: text, timestamp: Date.now() }],
      };
    }),
  );
}
