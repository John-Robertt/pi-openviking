/**
 * Observation：统一结构化运行证据。Observer 只做关联、脱敏与 sink 输出，不做业务决策。
 *
 * 三条结构约束直接对应阶段验收：
 * - 未请求观察时零副作用：disabled observer 不触发时钟、序列化与文件系统调用；
 * - 脱敏由事件 schema 保证：事件字段全部是元数据，没有可携带用户正文、图片或凭证的字段；
 * - record 只做校验与入队：sink 写入在调用返回之后批量完成，不延长产品 callback；
 *   Pi RPC 以 process.exit 结束进程（事件循环不再执行回调），进程退出前同步 drain 一次。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";

export type ObservationOutcome = "ok" | "error";

export interface ObservationEvent {
  operation: string;
  stage: string;
  outcome: ObservationOutcome;
  durationMs: number;
  session?: string;
  error?: string;
}

export type ObserverStatus = "disabled" | "active" | "degraded";

export interface Observer {
  readonly status: ObserverStatus;
  /** 降级原因（首个失败），供诊断和验证使用；未降级时为 undefined。 */
  readonly failure: string | undefined;
  /** active 时返回时钟值，disabled 时返回 0 且不触发时钟调用。 */
  now(): number;
  record(event: ObservationEvent): void;
  /** 等待已入队记录全部写入 sink；产品 callback 不调用，供验证使用。 */
  flush(): Promise<void>;
}

const DISABLED: Observer = Object.freeze({
  status: "disabled",
  failure: undefined,
  now: () => 0,
  record: () => {},
  flush: () => Promise.resolve(),
});

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function validateEvent(event: ObservationEvent): void {
  if (typeof event.operation !== "string" || event.operation.length === 0) {
    throw new Error("event.operation must be a non-empty string");
  }
  if (typeof event.stage !== "string" || event.stage.length === 0) {
    throw new Error("event.stage must be a non-empty string");
  }
  if (event.outcome !== "ok" && event.outcome !== "error") {
    throw new Error("event.outcome must be ok|error");
  }
  if (typeof event.durationMs !== "number" || !Number.isFinite(event.durationMs) || event.durationMs < 0) {
    throw new Error("event.durationMs must be a finite non-negative number");
  }
  if (event.session !== undefined && typeof event.session !== "string") {
    throw new Error("event.session must be a string");
  }
  if (event.error !== undefined && typeof event.error !== "string") {
    throw new Error("event.error must be a string");
  }
}

/** 各运行实例的退出 drain；进程只退出一次，因此全部 observer 共用一个 exit hook。 */
const exitDrains = new Set<() => void>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const drain of exitDrains) drain();
  });
}

/**
 * 创建 observer。spec 为 null 时返回共享的 disabled 实例。
 * sink 或 schema 失败只使观察降级：status 转为 degraded、failure 记录首个原因、
 * 清空未写队列且后续 record 不再产生副作用，产品返回值与调用顺序不受影响。
 */
export function createObserver(spec: { file: string } | null): Observer {
  if (spec === null) return DISABLED;
  const file = spec.file;
  installExitHook();
  const runId = randomUUID();
  let status: ObserverStatus = "active";
  let failure: string | undefined;
  let queue: string[] = [];
  /** 已离队但尚未落盘的批次；进程退出时必须先于 queue 写出，保证不丢、不乱序。 */
  let inFlight: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let scheduled = false;

  const degrade = (cause: unknown) => {
    if (status === "degraded") return;
    status = "degraded";
    failure = messageOf(cause);
    queue = [];
    inFlight = null;
    process.stderr.write(`pi-openviking: observation degraded: ${failure}\n`);
  };

  exitDrains.add(() => {
    const lines = (inFlight ?? "") + queue.join("");
    queue = [];
    inFlight = null;
    if (!lines) return;
    try {
      appendFileSync(file, lines);
    } catch {
      // 进程正在退出，降级路径已无法执行，丢弃剩余记录。
    }
  });

  async function drain(): Promise<void> {
    while (status === "active" && queue.length > 0) {
      inFlight = queue.join("");
      queue = [];
      try {
        await appendFile(file, inFlight);
        inFlight = null;
      } catch (cause) {
        degrade(cause);
      }
    }
  }

  // 链尾兜底：degrade 内部的诊断输出即使失败，也不能让 flush 链保持 rejected
  //（后续 void flush() 会产生 unhandled rejection）。
  const flush = (): Promise<void> => {
    chain = chain.then(drain).catch(() => {});
    return chain;
  };
  return {
    get status() {
      return status;
    },
    get failure() {
      return failure;
    },
    // 单调时钟：Date.now() 受 NTP 回拨影响会产生负 durationMs 并触发误降级；
    // 「Compaction 记忆线索」阶段的重叠测量也要求单调时钟（docs/verification.md）。
    now: () => performance.now(),
    record(event: ObservationEvent): void {
      if (status !== "active") return;
      try {
        validateEvent(event);
      } catch (cause) {
        degrade(cause);
        return;
      }
      queue.push(`${JSON.stringify({ runId, ts: Date.now(), ...event })}\n`);
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          scheduled = false;
          void flush();
        });
      }
    },
    flush,
  };
}
