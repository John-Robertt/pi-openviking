import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OPERATIONS = [
  "cue_preparation",
  "cue_presentation",
  "fact_recall",
  "pi_compaction_failure",
] as const;

const RESULTS = [
  "success",
  "empty",
  "not_found",
  "rejected",
  "unavailable",
  "invalid_result",
  "over_budget",
  "failed",
  "timed_out",
  "cancelled",
  "superseded",
  "stale",
] as const;

/** 一次受观测操作属于哪一类动作。 */
export type ObservationOperation = (typeof OPERATIONS)[number];

/** 一次操作最终得到的结果。 */
export type ObservationResult = (typeof RESULTS)[number];

/** 一次受观测操作的脱敏事件，恰好包含五类允许的值。 */
export interface ObservationEvent {
  readonly runId: string;
  readonly scopeRef: string;
  readonly operation: ObservationOperation;
  readonly duration: number;
  readonly result: ObservationResult;
}

/** 单向的运行事件出口。 */
export interface Observation {
  record(event: ObservationEvent): void;
}

const OUTPUT_SEGMENTS = [".dev", "observation"] as const;

/** 字符集同时限定记录内容和输出文件名，事件因此不能把记录写出输出目录。 */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_PENDING_RECORDS_PER_RUN = 256;

const EVENT_FIELDS = [
  "runId",
  "scopeRef",
  "operation",
  "duration",
  "result",
] as const satisfies readonly (keyof ObservationEvent)[];

interface PendingRecord {
  readonly runId: string;
  readonly line: string;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function hasOnlyAllowedFields(event: ObservationEvent): boolean {
  const keys = Reflect.ownKeys(event);
  if (keys.length !== EVENT_FIELDS.length) {
    return false;
  }
  return keys.every(
    (key) => typeof key === "string" && (EVENT_FIELDS as readonly string[]).includes(key),
  );
}

function isRecordable(values: ObservationEvent): boolean {
  return (
    isIdentifier(values.scopeRef) &&
    (OPERATIONS as readonly string[]).includes(values.operation) &&
    typeof values.duration === "number" &&
    Number.isFinite(values.duration) &&
    values.duration >= 0 &&
    (RESULTS as readonly string[]).includes(values.result)
  );
}

/**
 * 建立一个运行事件出口。
 *
 * @param repositoryRoot 仓库位置。输出目录由本模块在这个位置内部确定。
 */
export function createObservation(repositoryRoot: string): Observation {
  const directory = join(repositoryRoot, ...OUTPUT_SEGMENTS);
  const stopped = new Set<string>();
  const pending: PendingRecord[] = [];
  // 容量按运行计算，与写入状态使用同一种划分。
  const pendingCounts = new Map<string, number>();
  let draining = false;

  function releasePending(runId: string): void {
    const count = pendingCounts.get(runId);
    if (count === undefined) {
      return;
    }
    if (count <= 1) {
      pendingCounts.delete(runId);
    } else {
      pendingCounts.set(runId, count - 1);
    }
  }

  async function write(item: PendingRecord): Promise<void> {
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, `${item.runId}.jsonl`), item.line, "utf8");
  }

  // 串行写入让同一运行的记录保持提交顺序，也让前一条的写入结果在下一条开始之前确定。
  async function drain(): Promise<void> {
    while (pending.length > 0) {
      const item = pending.shift()!;
      releasePending(item.runId);
      if (stopped.has(item.runId)) {
        continue;
      }
      try {
        await write(item);
      } catch {
        stopped.add(item.runId);
      }
    }
    draining = false;
  }

  function record(event: ObservationEvent): void {
    let runId: string | undefined;
    try {
      // 五类值各读一次。校验、输出位置和记录内容因此使用同一份取值，
      // 事件不能靠取值副作用让写入看到未经校验的标识符。
      const values: ObservationEvent = {
        runId: event.runId,
        scopeRef: event.scopeRef,
        operation: event.operation,
        duration: event.duration,
        result: event.result,
      };
      if (!isIdentifier(values.runId)) {
        return;
      }
      runId = values.runId;
      if (stopped.has(runId)) {
        return;
      }
      if (
        !hasOnlyAllowedFields(event) ||
        !isRecordable(values) ||
        (pendingCounts.get(runId) ?? 0) >= MAX_PENDING_RECORDS_PER_RUN
      ) {
        stopped.add(runId);
        return;
      }
      pendingCounts.set(runId, (pendingCounts.get(runId) ?? 0) + 1);
      pending.push({ runId, line: `${JSON.stringify(values)}\n` });
      if (!draining) {
        draining = true;
        void drain();
      }
    } catch {
      // 输入异常留在模块内；能够归属到运行时，该运行停止写入。
      if (runId !== undefined) {
        stopped.add(runId);
      }
    }
  }

  return { record };
}
