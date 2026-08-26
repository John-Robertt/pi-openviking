/**
 * Observation：统一结构化运行证据。Observer 只做关联、脱敏与 sink 输出，不做业务决策。
 *
 * 两条结构约束直接对应阶段验收：
 * - 未请求观察时零副作用：disabled observer 不触发时钟、序列化与文件系统调用；
 * - 脱敏由事件 schema 保证：事件字段全部是元数据，没有可携带用户正文、图片或凭证的字段。
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

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
  readonly active: boolean;
  readonly status: ObserverStatus;
  /** 降级原因（首个失败），供状态查询组合；未降级时为 undefined。 */
  readonly failure: string | undefined;
  /** active 时返回时钟值，disabled 时返回 0 且不触发时钟调用。 */
  now(): number;
  record(event: ObservationEvent): void;
}

const DISABLED: Observer = Object.freeze({
  active: false,
  status: "disabled",
  failure: undefined,
  now: () => 0,
  record: () => {},
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

/**
 * 创建 observer。spec 为 null 时返回共享的 disabled 实例。
 * sink 或 schema 失败只使观察降级：status 转为 degraded、failure 记录首个原因、
 * 后续 record 不再产生副作用，产品返回值与调用顺序不受影响。
 */
export function createObserver(spec: { file: string } | null): Observer {
  if (spec === null) return DISABLED;
  const runId = randomUUID();
  let status: ObserverStatus = "active";
  let failure: string | undefined;
  return {
    active: true,
    get status() {
      return status;
    },
    get failure() {
      return failure;
    },
    now: () => Date.now(),
    record(event: ObservationEvent): void {
      if (status !== "active") return;
      try {
        validateEvent(event);
        appendFileSync(spec.file, `${JSON.stringify({ runId, ts: Date.now(), ...event })}\n`);
      } catch (cause) {
        status = "degraded";
        failure = messageOf(cause);
        process.stderr.write(`pi-openviking: observation degraded: ${failure}\n`);
      }
    },
  };
}
