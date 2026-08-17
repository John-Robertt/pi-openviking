import assert from "node:assert/strict";
import test from "node:test";

import { createStatusRefresh } from "../shared/status-refresh.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("状态刷新合并并发检查并只发布一次", async () => {
  const pending = deferred();
  let refreshes = 0;
  const published = [];
  const controller = createStatusRefresh({
    refresh: () => {
      refreshes++;
      return pending.promise;
    },
    publish: (value) => published.push(value),
    onError: assert.fail,
    intervalMs: 5000,
  });

  const first = controller.run();
  const second = controller.run();
  assert.equal(first, second);
  assert.equal(refreshes, 0, "refresh starts in a microtask");
  await Promise.resolve();
  assert.equal(refreshes, 1);

  pending.resolve(true);
  assert.equal(await first, true);
  assert.deepEqual(published, [true]);
});

test("停止时等待在途刷新并抑制晚到状态发布", async () => {
  const pending = deferred();
  const published = [];
  const errors = [];
  const controller = createStatusRefresh({
    refresh: () => pending.promise,
    publish: (value) => published.push(value),
    onError: (error) => errors.push(error),
    intervalMs: 5000,
  });

  const running = controller.run();
  const stopping = controller.stop();
  pending.resolve(false);
  await Promise.all([running, stopping]);

  assert.deepEqual(published, []);
  assert.deepEqual(errors, []);
});

test("刷新失败可在下一次检查重试", async () => {
  const expected = new Error("offline");
  const published = [];
  let attempts = 0;
  const controller = createStatusRefresh({
    refresh: async () => {
      attempts++;
      if (attempts === 1) throw expected;
      return true;
    },
    publish: (value) => published.push(value),
    onError: () => {},
    intervalMs: 5000,
  });

  await assert.rejects(controller.run(), expected);
  assert.equal(await controller.run(), true);
  assert.deepEqual(published, [true]);
});

test("定时刷新只启动一次并在停止时释放", async () => {
  let scheduled;
  let schedules = 0;
  let cleared = null;
  let unrefs = 0;
  const timer = { unref: () => unrefs++ };
  const controller = createStatusRefresh({
    refresh: async () => true,
    publish: () => {},
    onError: assert.fail,
    intervalMs: 5000,
    setIntervalFn: (callback, interval) => {
      scheduled = { callback, interval };
      schedules++;
      return timer;
    },
    clearIntervalFn: (value) => {
      cleared = value;
    },
  });

  controller.start();
  controller.start();
  assert.equal(schedules, 1);
  assert.equal(scheduled.interval, 5000);
  assert.equal(unrefs, 1);

  await controller.stop();
  assert.equal(cleared, timer);
});
