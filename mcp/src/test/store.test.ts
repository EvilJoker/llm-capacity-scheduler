/** Store：幂等、状态迁移、采样、校准、持久化。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { Store } from "../store.js";
import type { Bucket, Run } from "../types.js";
import { makeTask, tmpDir } from "./helpers.js";

test("幂等键：重复 submit 返回同一任务", () => {
  const store = Store.open(`${tmpDir()}/state.json`);
  const first = store.submit({ ...makeTask(), idempotencyKey: "same-key" });
  const second = store.submit({ ...makeTask(), idempotencyKey: "same-key" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
});

test("状态迁移是原子的（from 不匹配则失败）", () => {
  const store = Store.open(`${tmpDir()}/state.json`);
  const { task } = store.submit(makeTask());
  assert.equal(store.transition(task.id, ["submitted"], "queued"), true);
  assert.equal(store.getTask(task.id)?.state, "queued");
  assert.equal(store.transition(task.id, ["submitted"], "running"), false);
  assert.equal(store.getTask(task.id)?.state, "queued");
});

test("deadline 过期", () => {
  const store = Store.open(`${tmpDir()}/state.json`);
  const now = Date.now();
  const late = store.submit(makeTask({ deadlineMs: now - 1000 })).task;
  const future = store.submit(makeTask({ deadlineMs: now + 100000 })).task;
  assert.equal(store.expireTasks(now), 1);
  assert.equal(store.getTask(late.id)?.state, "expired");
  assert.equal(store.getTask(future.id)?.state, "submitted");
});

test("runs 统计：committed / runningCount / completed", () => {
  const store = Store.open(`${tmpDir()}/state.json`);
  const task = store.submit(makeTask()).task;
  const run: Run = {
    id: "run_1",
    taskId: task.id,
    assignmentId: "asg_1",
    provider: "mock",
    model: "general",
    runner: "shell",
    bucketKey: "mock/general/text_tokens/w",
    est: 6,
    pid: 123,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    exitCode: null,
    verified: null,
    artifacts: [],
    usage: {},
    quotaDelta: null,
    runDir: "/tmp/x",
    logPath: "/tmp/x/stdout.log",
    windowEndMs: null,
  };
  store.addRun(run);
  assert.deepEqual(store.committedByBucket(), { "mock/general/text_tokens/w": 6 });
  assert.deepEqual(store.runningCountByBucket(), { "mock/general/text_tokens/w": 1 });
  store.updateRun(run.id, { status: "succeeded", endedAt: Date.now() });
  assert.deepEqual(store.committedByBucket(), {});
  assert.equal(store.completedRunsCount("mock/general/text_tokens/w"), 1);
});

test("采样：严格 before、按桶过滤", () => {
  const store = Store.open(`${tmpDir()}/state.json`);
  const b: Bucket = {
    provider: "mock",
    modelFamily: "general",
    resourceKind: "text_tokens",
    unit: "pct",
    window: { lifecycle: "fixed_grid", startMs: null, endMs: null, unlimited: false },
    remaining: 80,
    source: "mock",
    constraints: [],
    raw: {},
  };
  const t1 = 1000;
  const t2 = 2000;
  store.recordSamples([b], t1, 100);
  b.remaining = 70;
  store.recordSamples([b], t2, 100);
  const key = "mock/general/text_tokens/fixed_grid:-:-:-";
  assert.equal(store.lastSampleBefore(key, t2)?.remaining, 80);
  assert.equal(store.lastSampleBefore(key, t1), undefined);
  assert.equal(store.recentSamples(key, t1).length, 2);
});

test("校准 EWMA", () => {
  const store = Store.open(`${tmpDir()}/state.json`);
  assert.deepEqual(store.calibrationUpdate("cls", "mock", "bucket", 6), { ewma: 6, n: 1 });
  const second = store.calibrationUpdate("cls", "mock", "bucket", 4);
  assert.ok(Math.abs(second.ewma - (0.7 * 6 + 0.3 * 4)) < 1e-9);
  assert.equal(second.n, 2);
});

test("持久化：重新打开文件后状态还在", () => {
  const file = `${tmpDir()}/state.json`;
  const store = Store.open(file);
  const { task } = store.submit(makeTask({ value: 77 }));
  store.persist();
  assert.ok(fs.existsSync(file));
  const reopened = Store.open(file);
  assert.equal(reopened.getTask(task.id)?.value, 77);
});
