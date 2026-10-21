/** 引擎端到端：工作时段不烧 → 尾段开烧 → 烧到 reserve 停；窗口抢占、路由注入、验收。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { Engine } from "../engine.js";
import { Store } from "../store.js";
import { bucketKey } from "../types.js";
import {
  FakeClock,
  buildEngine,
  drain,
  makeConfig,
  makeTask,
  sleep,
  tmpDir,
  waitForTask,
  waitUntil,
} from "./helpers.js";

const NODE = process.execPath;
const WED_14_00 = new Date(2026, 9, 21, 14, 0).getTime();
const WED_14_35 = new Date(2026, 9, 21, 14, 35).getTime();

function burnTask() {
  return makeTask({
    cmd: [NODE, "-e", "require('fs').writeFileSync('out.txt','burned')"],
    spec: { expectedDurationS: 1, timeoutS: 30, expectArtifacts: ["out.txt"] },
  });
}

test("端到端：14:00 等待 → 14:35 开烧 → 烧到 reserve 停 → 产物落盘", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_00);
  const config = makeConfig({
    dir,
    policy: { windowGraceSeconds: 1, safetyFactor: 2, defaultEstPct: 3, maxConcurrentPerBucket: 2 },
  });
  const engine = buildEngine(config, clock, dir);
  const tasks = Array.from({ length: 20 }, () => burnTask());
  for (const task of tasks) engine.store.submit(task);

  const mid = await engine.tick();
  assert.equal(mid.spawned.length, 0);
  assert.ok(mid.decisions.some((d) => d.reason === "work_hours_wait"));
  assert.ok(tasks.every((t) => ["queued", "deferred"].includes(engine.store.getTask(t.id)!.state)));

  clock.set(WED_14_35);
  const tail = await engine.tick();
  assert.equal(tail.spawned.length, 2);

  await drain(engine, clock);

  const succeeded = tasks.filter((t) => engine.store.getTask(t.id)!.state === "succeeded");
  assert.ok(succeeded.length >= 8 && succeeded.length <= 14, `succeeded=${succeeded.length}`);
  const buckets = await engine.observeNow(clock.now());
  const remaining = buckets[0].remaining ?? 0;
  assert.ok(remaining >= 5, `remaining=${remaining} 不能烧穿 reserve`);
  assert.ok(remaining <= 32, `remaining=${remaining} 应该在 reserve 附近停`);

  // reserve 守住：再 tick 也不继续烧
  for (let i = 0; i < 3; i += 1) {
    const report = await engine.tick();
    assert.equal(report.spawned.length, 0);
    clock.advance(5000);
  }

  // 产物与验收
  const okTask = succeeded[0];
  const run = engine.store.runsForTask(okTask.id).find((r) => r.status === "succeeded");
  assert.ok(run);
  assert.equal(run?.verified, true);
  assert.ok(run?.artifacts.includes("out.txt"));
  assert.ok(fs.existsSync(path.join(run!.runDir, "out.txt")));
  assert.equal(fs.readFileSync(path.join(run!.runDir, "out.txt"), "utf8"), "burned");
});

test("空闲时段：一刷新就烧", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(new Date(2026, 9, 21, 20, 5).getTime());
  const config = makeConfig({
    dir,
    providers: [
      {
        name: "mock",
        kind: "mock",
        enabled: true,
        options: { family: "general", start: "20:00", end: "01:00", initialRemaining: 90, burnPerRun: 6 },
      },
    ],
    policy: { windowGraceSeconds: 1 },
  });
  const engine = buildEngine(config, clock, dir);
  const task = burnTask();
  engine.store.submit(task);
  const report = await engine.tick();
  assert.equal(report.spawned.length, 1);
  const state = await waitForTask(engine, clock, task.id);
  assert.equal(state, "succeeded");
});

test("窗口装不下：expectedDuration 太大 → window_too_short 不开跑", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_35);
  const config = makeConfig({ dir, policy: { windowGraceSeconds: 1 } });
  const engine = buildEngine(config, clock, dir);
  const task = makeTask({
    cmd: [NODE, "-e", "1"],
    spec: { expectedDurationS: 1800, timeoutS: 30 },
  });
  engine.store.submit(task);
  const report = await engine.tick();
  assert.equal(report.spawned.length, 0);
  assert.ok(report.decisions.some((d) => d.reason === "window_too_short"));
});

test("没有可用容量：任务留在队列，reason=no_bucket", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_35);
  const config = makeConfig({ dir });
  const store = Store.open(config.engine.stateFile);
  const engine = new Engine({
    config,
    baseDir: dir,
    store,
    clock: clock.now,
    adapters: [],
    runners: undefined,
  });
  const task = makeTask({ cmd: [NODE, "-e", "1"] });
  store.submit(task);
  const report = await engine.tick();
  assert.equal(report.spawned.length, 0);
  assert.equal(report.decisions[0].reason, "no_bucket");
  assert.ok(["queued", "deferred"].includes(store.getTask(task.id)!.state));
});

test("窗口边界：在飞 run 被抢占为 interrupted 并重排（attempts+1）", async () => {
  const dir = tmpDir();
  const start = new Date(2026, 9, 21, 14, 55).getTime();
  const clock = new FakeClock(start);
  const config = makeConfig({
    dir,
    providers: [
      {
        name: "mock",
        kind: "mock",
        enabled: true,
        options: {
          family: "general",
          startAt: start - 60_000,
          endAt: start + 3000,
          initialRemaining: 80,
          burnPerRun: 0,
        },
      },
    ],
    policy: { windowGraceSeconds: 1, maxAttempts: 3 },
  });
  const engine = buildEngine(config, clock, dir);
  const task = makeTask({
    cmd: [NODE, "-e", "setTimeout(()=>{}, 5000)"],
    spec: { expectedDurationS: 1, timeoutS: 30 },
  });
  engine.store.submit(task);

  const spawnReport = await engine.tick();
  assert.equal(spawnReport.spawned.length, 1);

  clock.advance(5000);
  const report = await engine.tick();
  assert.equal(report.interrupted.length, 1);
  const runs = engine.store.runsForTask(task.id);
  assert.equal(runs[0].status, "interrupted");
  const after = engine.store.getTask(task.id)!;
  assert.equal(after.state, "queued");
  assert.equal(after.attempts, 1);
  assert.ok(after.nextEligibleAtMs !== null);
});

test("Assignment 路由注入：任务能拿到 LCS_PROVIDER / LCS_MODEL", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_35);
  const config = makeConfig({ dir, policy: { windowGraceSeconds: 1 } });
  const engine = buildEngine(config, clock, dir);
  const task = makeTask({
    cmd: [
      NODE,
      "-e",
      "require('fs').writeFileSync('env.txt', [process.env.LCS_PROVIDER, process.env.LCS_MODEL, process.env.LCS_ASSIGNMENT_ID].join('/'))",
    ],
    spec: { expectedDurationS: 1, timeoutS: 30, expectArtifacts: ["env.txt"] },
  });
  engine.store.submit(task);
  const report = await engine.tick();
  assert.equal(report.spawned.length, 1);
  assert.equal(report.spawned[0].provider, "mock");
  const state = await waitForTask(engine, clock, task.id);
  assert.equal(state, "succeeded");
  const run = engine.store.runsForTask(task.id)[0];
  assert.equal(fs.readFileSync(path.join(run.runDir, "env.txt"), "utf8"), "mock/general/" + run.assignmentId);
});

test("验收失败 → failed（maxAttempts=1）", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_35);
  const config = makeConfig({ dir, policy: { windowGraceSeconds: 1, maxAttempts: 1 } });
  const engine = buildEngine(config, clock, dir);
  const task = makeTask({
    cmd: [NODE, "-e", "require('fs').writeFileSync('out.txt','x')"],
    spec: {
      expectedDurationS: 1,
      timeoutS: 30,
      expectArtifacts: ["out.txt"],
      verifyCmd: [NODE, "-e", "process.exit(3)"],
    },
  });
  engine.store.submit(task);
  await engine.tick();
  const state = await waitForTask(engine, clock, task.id);
  assert.equal(state, "failed");
  const run = engine.store.runsForTask(task.id)[0];
  assert.equal(run.verified, false);
  assert.match(String(run.error), /verifier/);
});

test("幂等键：重复提交只有一个任务", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_35);
  const config = makeConfig({ dir });
  const engine = buildEngine(config, clock, dir);
  const task = makeTask({ cmd: [NODE, "-e", "1"] });
  const first = engine.store.submit(task);
  const second = engine.store.submit({ ...makeTask({ cmd: [NODE, "-e", "1"] }), idempotencyKey: task.idempotencyKey });
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
});

test("采样与决策记录：tick 后 snapshot 可解释", async () => {
  const dir = tmpDir();
  const clock = new FakeClock(WED_14_00);
  const config = makeConfig({ dir });
  const engine = buildEngine(config, clock, dir);
  await engine.tick();
  const snapshot = engine.snapshot() as {
    buckets: unknown[];
    scheduler: { tickCount: number };
    recentDecisions: unknown[];
  };
  assert.equal(snapshot.scheduler.tickCount, 1);
  assert.equal(snapshot.buckets.length, 1);
  assert.ok(clock.now() > 0);
  await sleep(1);
});
