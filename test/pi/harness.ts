/**
 * 真实 Pi 检查的共享 harness。
 *
 * 用本地确定性 faux provider(不访问外部模型)驱动真实的 Pi 运行链路:
 * createAgentSessionRuntime + DefaultResourceLoader + 内联扩展工厂。
 * 被测对象是 src/pi-boundary 的公共入口;Cue Provider 与 Retriever 是
 * 本目录内的受控实现,Observation 用数组捕获。
 *
 * 所有运行产物位于仓库 .dev/test/pi/ 内,可整体删除。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TestContext } from "node:test";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/compat";
import type {
  Cue,
  CueBudget,
  CueSet,
  Fact,
  MemoryScope,
  RecallResult,
  ScopedFacts,
} from "../../src/contracts/index.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ObservationEvent } from "../../src/observation/index.ts";
import { registerPiBoundary } from "../../src/pi-boundary/index.ts";

/** provider 实际收到的一次请求。 */
export interface ProviderRequest {
  /** 请求消息里是否出现注入的 Memory Cues 标记。 */
  readonly hasCues: boolean;
  /** 响应对应的标签(respondText 的文本或工具名),用于识别请求属于哪一步。 */
  readonly label?: string;
}

/** 跨 reload 共享的受控行为;实例本身在 reload 时重建。 */
export interface SharedBehavior {
  prepareThrows: boolean;
  prepareHangs: boolean;
  currentThrows: boolean;
  recallHangs: boolean;
  /** scopeId → 准备好的线索。 */
  readonly cueSets: Map<string, CueSet>;
}

export interface PrepareRecord {
  readonly scope: MemoryScope;
  readonly facts: ScopedFacts;
}

/** 受控 Cue Provider:prepare 从来源事实生成线索;current 只返回已备结果。 */
export class TestCueProvider {
  readonly prepareCalls: PrepareRecord[] = [];
  private readonly behavior: SharedBehavior;
  constructor(behavior: SharedBehavior) {
    this.behavior = behavior;
  }

  async prepare(
    scope: MemoryScope,
    facts: ScopedFacts,
    _budget: CueBudget,
    signal: AbortSignal,
  ): Promise<void> {
    this.prepareCalls.push({ scope, facts });
    if (this.behavior.prepareThrows) {
      throw new Error("受控 prepare 失败");
    }
    if (this.behavior.prepareHangs) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    signal.throwIfAborted();
    const cues: Cue[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await facts.readSequential(after, { characters: 100_000 }, signal);
      for (const fact of page.facts) {
        if (fact.role === "user") {
          cues.push({
            text: factText(fact).slice(0, 40),
            handle: `h:${scope.sessionId}:${fact.entryId}`,
          });
        }
      }
      if (page.next === undefined) {
        break;
      }
      after = page.next;
    }
    this.behavior.cueSets.set(scope.scopeId, { cues, kind: "complete" });
  }

  current(scope: MemoryScope, budget: CueBudget): CueSet | undefined {
    if (this.behavior.currentThrows) {
      throw new Error("受控 current 失败");
    }
    const prepared = this.behavior.cueSets.get(scope.scopeId);
    if (prepared === undefined) {
      return undefined;
    }
    // 遵守预算:数量与字符都不超过。
    const kept: Cue[] = [];
    let characters = 0;
    for (const cue of prepared.cues) {
      const size = cue.text.length + cue.handle.length + (cue.time?.length ?? 0);
      if (kept.length >= budget.count || characters + size > budget.characters) {
        break;
      }
      kept.push(cue);
      characters += size;
    }
    if (kept.length === 0) {
      return undefined;
    }
    return { cues: kept, kind: kept.length === prepared.cues.length ? "complete" : "sampled" };
  }
}

export interface RecallRecord {
  readonly handle: string;
  readonly scope: MemoryScope;
  readonly signal: AbortSignal;
}

/** 受控 Retriever:解释 h:<sessionId>:<entryId> 凭据并做范围检查。 */
export class TestRetriever {
  readonly calls: RecallRecord[] = [];
  private readonly behavior: SharedBehavior;
  constructor(behavior: SharedBehavior) {
    this.behavior = behavior;
  }

  async recall(
    scope: MemoryScope,
    facts: ScopedFacts,
    handle: string,
    budget: { characters: number },
    signal: AbortSignal,
  ): Promise<RecallResult> {
    this.calls.push({ handle, scope, signal });
    if (this.behavior.recallHangs) {
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const match = /^h:([^:]+):([^:]+)$/.exec(handle);
    if (match === null) {
      return { kind: "rejected" };
    }
    const [, sessionId, entryId] = match;
    if (sessionId !== scope.sessionId || !scope.visibleEntryIds.has(entryId)) {
      return { kind: "notFound" };
    }
    const fact = await facts.readById(entryId, signal);
    if (fact === undefined) {
      return { kind: "notFound" };
    }
    const length = fact.blocks.reduce(
      (total, block) => total + (block.type === "text" ? block.text.length : 0),
      0,
    );
    if (length > budget.characters) {
      return { kind: "unavailable" };
    }
    return { kind: "found", content: { blocks: fact.blocks } };
  }
}

function factText(fact: Fact): string {
  return fact.blocks
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

export interface PiHarness {
  readonly runtime: AgentSessionRuntime;
  readonly behavior: SharedBehavior;
  /** 当前扩展实例的替身;reload 后指向新实例。 */
  readonly current: { cueProvider: TestCueProvider; retriever: TestRetriever };
  readonly observation: ObservationEvent[];
  /** 置 true 后 Observation.record 抛错,用于失败隔离检查。 */
  readonly observationControl: { throws: boolean };
  readonly sessionLog: string[];
  readonly requests: ProviderRequest[];
  /** 当前扩展实例拿到的 Pi API;用于 appendEntry 等宿主动作。 */
  readonly piApi: { current?: ExtensionAPI };
  session(): AgentSession;
  /** 排队一条纯文本响应,并记录本次请求是否带注入线索。 */
  respondText(text: string): void;
  /** 排队一条工具调用响应。 */
  respondToolCall(name: string, args: Record<string, unknown>): void;
  /** 排队一个自定义响应工厂。 */
  respond(factory: FauxResponseFactory): void;
}

export async function createPiHarness(
  t: TestContext,
  options: { prepareDeadlineMs?: number; recallDeadlineMs?: number } = {},
): Promise<PiHarness> {
  const root = await mkdtemp(join(process.cwd(), ".dev", "test", "pi-"));
  const work = join(root, "work");
  const agentDir = join(root, "agent");
  const sessionDir = join(agentDir, "sessions");
  await mkdir(work, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  // 缩小 compaction 保留窗口,小 session 也能触发手动 compaction。
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: true, reserveTokens: 8, keepRecentTokens: 8 } }),
  );
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const faux = fauxProvider();
  const behavior: SharedBehavior = {
    prepareThrows: false,
    prepareHangs: false,
    currentThrows: false,
    recallHangs: false,
    cueSets: new Map(),
  };
  const current = {
    cueProvider: undefined as unknown as TestCueProvider,
    retriever: undefined as unknown as TestRetriever,
  };
  const observation: ObservationEvent[] = [];
  const observationControl = { throws: false };
  const sessionLog: string[] = [];
  const requests: ProviderRequest[] = [];

  const record = (factory: FauxResponseFactory, label?: string): FauxResponseFactory => {
    return (context, opts, state, model) => {
      requests.push({
        hasCues: JSON.stringify(context.messages).includes("<memory-cues>"),
        label,
      });
      return factory(context, opts, state, model);
    };
  };
  const piApi: PiHarness["piApi"] = {};

  const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: never) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        extensionFactories: [
          {
            name: "pi-boundary-under-test",
            factory: (pi: ExtensionAPI) => {
              piApi.current = pi;
              current.cueProvider = new TestCueProvider(behavior);
              current.retriever = new TestRetriever(behavior);
              registerPiBoundary(pi, {
                cueProvider: current.cueProvider,
                retriever: current.retriever,
                observation: {
                  record: (event) => {
                    if (observationControl.throws) {
                      throw new Error("受控 observation 失败");
                    }
                    observation.push(event);
                  },
                },
                cueBudget: { count: 10, characters: 2000 },
                recallBudget: { characters: 5000 },
                prepareDeadlineMs: options.prepareDeadlineMs ?? 10_000,
                recallDeadlineMs: options.recallDeadlineMs ?? 10_000,
              });
            },
          },
          {
            name: "session-log",
            factory: (pi: ExtensionAPI) => {
              for (const name of [
                "session_start",
                "session_shutdown",
                "session_before_switch",
                "session_before_fork",
                "session_before_tree",
                "session_tree",
                "session_before_compact",
                "session_compact",
                "session_compact_failed",
              ]) {
                (pi.on as (e: string, h: (ev: { reason?: string }, c: ExtensionContext) => void) => void)(
                  name,
                  (event, ctx) => {
                    sessionLog.push(
                      `${name}${event.reason ? `(${event.reason})` : ""} sid=${ctx.sessionManager.getSessionId()}`,
                    );
                  },
                );
              }
            },
          },
        ],
      },
    });
    services.modelRuntime.registerNativeProvider(faux.provider);
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: faux.getModel(),
      noTools: "builtin",
    });
    return { ...result, services, diagnostics: services.diagnostics };
  };

  const runtime = await createAgentSessionRuntime(createRuntime as never, {
    cwd: work,
    agentDir,
    sessionManager: SessionManager.create(work, sessionDir),
  });
  // 与 print 模式相同的绑定方式:替换 session 时 runtime 自动重绑定。
  const bind = async (): Promise<void> => {
    await runtime.session.bindExtensions({
      mode: "print",
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (opts) => runtime.newSession(opts),
        fork: async (entryId, opts) => ({ cancelled: (await runtime.fork(entryId, opts)).cancelled }),
        navigateTree: (targetId, opts) => runtime.session.navigateTree(targetId, opts),
        switchSession: (path, opts) => runtime.switchSession(path, opts),
        reload: () => runtime.session.reload(),
      },
    });
  };
  runtime.setRebindSession(bind);
  await bind();

  return {
    runtime,
    behavior,
    current,
    observation,
    sessionLog,
    requests,
    piApi,
    observationControl,
    session: () => runtime.session,
    respondText(text) {
      faux.appendResponses([record(() => fauxAssistantMessage(text), text)]);
    },
    respondToolCall(name, args) {
      faux.appendResponses([
        record(
          () => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
          name,
        ),
      ]);
    },
    respond(factory) {
      faux.appendResponses([record(factory)]);
    },
  };
}

/** 轮询等待条件成立,5 秒超时。 */
export async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`等待超时:${what}`);
    }
    await delay(5);
  }
}

/** 等待当前范围的线索准备成功完成且至少生成一条线索。 */
export function waitForCues(h: PiHarness): Promise<void> {
  return waitFor(
    () =>
      h.observation.some((e) => e.operation === "cue_preparation" && e.result === "success") &&
      [...h.behavior.cueSets.values()].some((set) => set.cues.length > 0),
    "线索准备完成",
  );
}
