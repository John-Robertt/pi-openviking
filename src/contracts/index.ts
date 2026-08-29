/**
 * 跨模块公共数据契约。
 *
 * 本文件是 docs/design.md「模块交接契约」的代码形式:模块之间只用这里的
 * 数据和入口交接业务内容。契约不含任何 Pi SDK 或外部 SDK 类型,也不导入
 * 任何运行模块。
 */

/** 项目自己的内容块:一段文本或一张图片(base64 数据与 MIME 类型)。 */
export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/**
 * 一次模块调用使用的不可变访问快照。
 *
 * 只能由 Pi Boundary 建立;模型参数不能创建、替换或扩大它。范围标识在同一
 * branch 正常追加和 compaction 时保持,在成功 branch 导航、session 替换或
 * 扩展 reload 后更换。同一范围标识下,可见 entry 集合随当前路径增长。
 */
export interface MemoryScope {
  /** 区分运行实例以及 branch 导航前后结果的内部代号。 */
  readonly scopeId: string;
  /** Pi 当前 session 的稳定 ID。 */
  readonly sessionId: string;
  /** 当前 getBranch() 完整祖先路径中全部 entry 的 ID。 */
  readonly visibleEntryIds: ReadonlySet<string>;
}

/** 来源事实在会话中的角色。 */
export type FactRole = "user" | "assistant" | "toolResult";

/**
 * 一条来源事实:会话中实际发生的一段内容(用户与模型的消息、工具调用及其
 * 结果)。标识是 Pi 的 entry ID,在当前 MemoryScope 内稳定。
 */
export interface Fact {
  readonly entryId: string;
  readonly role: FactRole;
  /** 工具结果事实对应的工具名;其他角色没有。 */
  readonly toolName?: string;
  /** 事实发生时间,Unix 毫秒。 */
  readonly timestamp: number;
  readonly blocks: readonly ContentBlock[];
}

/** 顺序读取返回的一页事实。 */
export interface FactPage {
  readonly facts: readonly Fact[];
  /**
   * 下次继续读取时作为 `after` 传入的值;本页已覆盖到路径末尾时为
   * undefined。等于本页最后一条事实的 entryId。
   */
  readonly next?: string;
}

/**
 * 字符预算。计量方式按使用处约定:
 * - 事实与完整事实:全部文本块的 text 字符数之和(图片块不参与计量,
 *   只能完整交付或不交付);
 * - 线索集:每条线索的 text、time(如有)与 handle 字符数之和。
 */
export interface CharacterBudget {
  readonly characters: number;
}

/**
 * 当前 MemoryScope 内的来源事实读取入口。只读;范围在建立时固定。
 * 标识指向不可见 entry、非来源事实或不存在的 entry 时视为未找到。
 */
export interface ScopedFacts {
  /**
   * 按会话顺序从 `after`(不含)之后读取预算内的一段。剩余事实存在时至少
   * 交付一条(即使它自身超过预算),此后按预算停止。
   */
  readSequential(
    after: string | undefined,
    budget: CharacterBudget,
    signal?: AbortSignal,
  ): Promise<FactPage>;
  /** 按标识读取单条事实;未找到时返回 undefined。 */
  readById(entryId: string, signal?: AbortSignal): Promise<Fact | undefined>;
}

/**
 * 可序列化的找回凭据。由 Cue Provider 生成,Pi Boundary 原样传递,
 * Retriever 负责解释。系统其他部分不读取它的内部格式。
 */
export type RecallHandle = string;

/** 一条历史线索。 */
export interface Cue {
  /** 一句用于识别事件的简短内容。 */
  readonly text: string;
  /** 事件时间或时间区间的可读表示,可无。 */
  readonly time?: string;
  readonly handle: RecallHandle;
}

/** 准备加入模型上下文的线索集。 */
export interface CueSet {
  readonly cues: readonly Cue[];
  /** 模型如何理解这组线索:完整清单,还是预算内的采样结果。 */
  readonly kind: "complete" | "sampled";
}

/** 线索数量与展示字符预算。字符计量见 CharacterBudget。 */
export interface CueBudget {
  readonly count: number;
  readonly characters: number;
}

/** 一条完整事实,用项目自己的内容块表示。 */
export interface RetrievedContent {
  readonly blocks: readonly ContentBlock[];
}

/**
 * 一次找回的结果。事实不能完整放入结果预算时返回 unavailable,
 * 不会把截断内容当作完整事实。
 */
export type RecallResult =
  | { readonly kind: "found"; readonly content: RetrievedContent }
  | { readonly kind: "notFound" }
  | { readonly kind: "rejected" }
  | { readonly kind: "unavailable" };

/**
 * 历史线索提供者。准备结果的准备方法与缓存属于模块内部;`current` 只返回
 * 本地已有结果,不等待新的生成过程。
 */
export interface CueProvider {
  prepare(
    scope: MemoryScope,
    facts: ScopedFacts,
    budget: CueBudget,
    signal: AbortSignal,
  ): Promise<void>;
  /** 返回当前已经可用的 CueSet;没有可用线索时返回 undefined。 */
  current(scope: MemoryScope, budget: CueBudget): CueSet | undefined;
}

/** 线索所指完整事实的提供者。 */
export interface Retriever {
  recall(
    scope: MemoryScope,
    facts: ScopedFacts,
    handle: RecallHandle,
    budget: CharacterBudget,
    signal: AbortSignal,
  ): Promise<RecallResult>;
}
