import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createObservation,
  type Observation,
  type ObservationEvent,
} from "../../../src/observation/index.ts";

const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const workspaceParent = join(repositoryRoot, ".dev", "test");

const WAIT_TIMEOUT_MS = 5000;

interface Fixture {
  readonly root: string;
  readonly directory: string;
  readonly observation: Observation;
}

/** 每个测试在 `.dev/` 内使用自己的仓库位置，因此互不影响，并且属于可删除产物。 */
async function setup(t: TestContext): Promise<Fixture> {
  await mkdir(workspaceParent, { recursive: true });
  const root = await mkdtemp(join(workspaceParent, "observation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    directory: join(root, ".dev", "observation"),
    observation: createObservation(root),
  };
}

function event(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    runId: "run-a",
    scopeRef: "scope-1",
    operation: "cue_preparation",
    duration: 12,
    result: "success",
    ...overrides,
  };
}

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter((line) => line.length > 0);
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** 通过记录内容而不是文件名判断归属，因此检查不依赖实现的文件命名。 */
async function readRecords(directory: string, runId: string): Promise<Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const path of await listFiles(directory)) {
    for (const line of await readLines(path)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.runId === runId) {
        records.push(parsed);
      }
    }
  }
  return records;
}

async function outputFileFor(directory: string, runId: string): Promise<string> {
  for (const path of await listFiles(directory)) {
    const lines = await readLines(path);
    if (lines.some((line) => (JSON.parse(line) as { runId: string }).runId === runId)) {
      return path;
    }
  }
  throw new Error(`没有找到 ${runId} 的输出文件`);
}

/** 等待某个运行的记录达到指定条数；串行写入使它同时成为“更早提交的记录已经处理完”的栅栏。 */
async function waitForRecords(
  directory: string,
  runId: string,
  count: number,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  for (;;) {
    const records = await readRecords(directory, runId);
    if (records.length >= count) {
      return records;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待超时：${runId} 只有 ${records.length} 条记录，期望 ${count} 条`);
    }
    await delay(5);
  }
}

async function exists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

test("合法事件写出恰好包含五类允许值的记录", async (t) => {
  const { directory, observation } = await setup(t);

  observation.record(event({ operation: "fact_recall", duration: 0, result: "not_found" }));

  const [record] = await waitForRecords(directory, "run-a", 1);
  assert.deepEqual(record, {
    runId: "run-a",
    scopeRef: "scope-1",
    operation: "fact_recall",
    duration: 0,
    result: "not_found",
  });
});

test("实现写出的文件只出现在给定仓库位置的输出目录内部", async (t) => {
  const { root, directory, observation } = await setup(t);

  observation.record(event({ runId: "run-a" }));
  observation.record(event({ runId: "run-b" }));
  await waitForRecords(directory, "run-a", 1);
  await waitForRecords(directory, "run-b", 1);

  const written = await listFiles(root);
  assert.equal(written.length, 2, `期望两个输出文件，实际：${written.join(", ")}`);
  for (const path of written) {
    assert.equal(dirname(path), directory, `${path} 写在了输出目录之外`);
  }
});

test("标识符在校验之后改变取值，也不能改变记录的写入位置", async (t) => {
  const { root, directory, observation } = await setup(t);

  // 事件可以用取值副作用让校验和写入看到不同的标识符。
  let reads = 0;
  const shifting = {
    get runId() {
      reads += 1;
      return reads === 1 ? "run-shifting" : "../../escaped";
    },
    scopeRef: "scope-1",
    operation: "cue_preparation",
    duration: 1,
    result: "success",
  } as unknown as ObservationEvent;

  observation.record(shifting);
  observation.record(event({ runId: "run-fence" }));
  await waitForRecords(directory, "run-fence", 1);

  for (const path of await listFiles(root)) {
    assert.equal(dirname(path), directory, `${path} 写在了输出目录之外`);
  }
});

test("写入发生在 record 返回之后", async (t) => {
  const { directory, observation } = await setup(t);

  observation.record(event());
  assert.equal(await exists(directory), false, "record 返回时不应已经完成写入");

  await waitForRecords(directory, "run-a", 1);
});

test("同一运行的记录按提交顺序写入它自己的文件", async (t) => {
  const { directory, observation } = await setup(t);

  observation.record(event({ runId: "run-a", duration: 1 }));
  observation.record(event({ runId: "run-b", duration: 10 }));
  observation.record(event({ runId: "run-a", duration: 2 }));
  observation.record(event({ runId: "run-b", duration: 20 }));
  observation.record(event({ runId: "run-a", duration: 3 }));

  await waitForRecords(directory, "run-a", 3);
  await waitForRecords(directory, "run-b", 2);

  assert.deepEqual(
    (await readRecords(directory, "run-a")).map((record) => record.duration),
    [1, 2, 3],
  );
  assert.deepEqual(
    (await readRecords(directory, "run-b")).map((record) => record.duration),
    [10, 20],
  );
  for (const path of await listFiles(directory)) {
    const owners = new Set(
      (await readLines(path)).map((line) => (JSON.parse(line) as { runId: string }).runId),
    );
    assert.equal(owners.size, 1, `${path} 混入了多个运行的记录`);
  }
});

test("无法识别所属运行的输入直接结束，不产生记录", async (t) => {
  const { directory, observation } = await setup(t);

  const unidentifiable: unknown[] = [
    ...["", "run a", "../escape", "run/a", "run.a", "x".repeat(65)].map((runId) =>
      event({ runId }),
    ),
    null,
    undefined,
    42,
    "event",
  ];
  for (const input of unidentifiable) {
    observation.record(input as ObservationEvent);
  }
  observation.record(event({ runId: "run-fence" }));
  await waitForRecords(directory, "run-fence", 1);

  const written = await listFiles(directory);
  assert.deepEqual(written.length, 1, `除栅栏记录外不应产生文件：${written.join(", ")}`);
  assert.equal(await exists(join(directory, "..", "escape.jsonl")), false);
});

test("超出输入限制的值不产生记录，并停止该运行的写入", async (t) => {
  const { directory, observation } = await setup(t);

  const invalidEvents: ObservationEvent[] = [
    event({ runId: "run-scope", scopeRef: "scope 1" }),
    event({ runId: "run-scope-empty", scopeRef: "" }),
    event({ runId: "run-operation", operation: "unknown" as ObservationEvent["operation"] }),
    event({ runId: "run-result", result: "unknown" as ObservationEvent["result"] }),
    event({ runId: "run-negative", duration: -1 }),
    event({ runId: "run-nan", duration: Number.NaN }),
    event({ runId: "run-infinite", duration: Number.POSITIVE_INFINITY }),
    { ...event({ runId: "run-extra" }), note: "用户正文" } as unknown as ObservationEvent,
  ];

  for (const invalid of invalidEvents) {
    observation.record(invalid);
    observation.record(event({ runId: invalid.runId }));
  }
  observation.record(event({ runId: "run-fence" }));
  await waitForRecords(directory, "run-fence", 1);

  for (const invalid of invalidEvents) {
    assert.deepEqual(
      await readRecords(directory, invalid.runId),
      [],
      `${invalid.runId} 不应产生记录`,
    );
  }
});

test("首次写入失败关闭同一运行的后续写入，其他运行保持可写", async (t) => {
  const { directory, observation } = await setup(t);

  observation.record(event({ runId: "run-broken", duration: 1 }));
  observation.record(event({ runId: "run-open", duration: 1 }));
  await waitForRecords(directory, "run-broken", 1);
  await waitForRecords(directory, "run-open", 1);

  // 用目录占住 run-broken 的输出路径，使它的下一次写入必然失败。
  const brokenFile = await outputFileFor(directory, "run-broken");
  await rm(brokenFile);
  await mkdir(brokenFile);

  observation.record(event({ runId: "run-broken", duration: 2 }));
  observation.record(event({ runId: "run-open", duration: 2 }));
  await waitForRecords(directory, "run-open", 2);

  // 路径恢复可用后仍然没有新记录，说明通道关闭后不再访问存储。
  await rm(brokenFile, { recursive: true });
  observation.record(event({ runId: "run-broken", duration: 3 }));
  observation.record(event({ runId: "run-open", duration: 3 }));
  await waitForRecords(directory, "run-open", 3);

  assert.equal(await exists(brokenFile), false, "关闭后的运行不应重建输出文件");
  assert.deepEqual(await readRecords(directory, "run-broken"), []);
  assert.deepEqual(
    (await readRecords(directory, "run-open")).map((record) => record.duration),
    [1, 2, 3],
  );
});

test("待处理记录达到上限后，已排队的记录一并丢弃，其他运行继续写入", async (t) => {
  const { directory, observation } = await setup(t);

  // 同步提交期间没有任何写入能够完成，队列因此必然累积到上限。提交量需要大于实现设定的上限。
  const submitted = 400;
  for (let index = 0; index < submitted; index += 1) {
    observation.record(event({ runId: "run-flood", duration: index }));
  }
  observation.record(event({ runId: "run-fence", duration: 1 }));
  await waitForRecords(directory, "run-fence", 1);

  // 只有进入写入的第一条留下记录，排队中的记录随停止写入一并丢弃。
  assert.deepEqual(
    (await readRecords(directory, "run-flood")).map((record) => record.duration),
    [0],
    "记录应当停在最后一条成功写入的位置",
  );

  observation.record(event({ runId: "run-flood", duration: submitted }));
  observation.record(event({ runId: "run-fence", duration: 2 }));
  assert.deepEqual(
    (await waitForRecords(directory, "run-fence", 2)).map((record) => record.duration),
    [1, 2],
    "灌满队列的运行不应影响其他运行",
  );

  assert.deepEqual(
    (await readRecords(directory, "run-flood")).map((record) => record.duration),
    [0],
    "停止写入后该运行不应再产生记录",
  );
});
