/** 策略：reserve 时间函数、时间门、强度、准入（含付费反转）。 */

import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../config.js";
import type { PolicyConfig } from "../config.js";
import {
  BurnBeforeExpiryPolicy,
  ReserveFunction,
  UsageModel,
  taskScore,
} from "../policy.js";
import type { Bucket, Task } from "../types.js";
import { makeTask } from "./helpers.js";

const DT = (h: number, m = 0, day = 21): number => new Date(2026, 9, day, h, m).getTime();

function policy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  const base = defaultConfig().policy;
  return { ...base, ...overrides, usage: { ...base.usage, ...(overrides.usage ?? {}) } };
}

function bucket(overrides: Partial<Bucket> = {}): Bucket {
  return {
    provider: "mock",
    modelFamily: "general",
    resourceKind: "text_tokens",
    unit: "pct",
    window: { lifecycle: "fixed_grid", startMs: DT(10), endMs: DT(15), unlimited: false },
    remaining: 80,
    source: "mock",
    constraints: [],
    raw: {},
    ...overrides,
  };
}

function decide(p: BurnBeforeExpiryPolicy, b: Bucket, task: Task, now: number, extra: { committed?: number; runningCount?: number; selfBusy?: boolean } = {}) {
  return p.decide({
    bucket: b,
    task,
    now,
    committed: extra.committed ?? 0,
    runningCount: extra.runningCount ?? 0,
    selfBusy: extra.selfBusy ?? false,
  });
}

test("自用率曲线：工作时段 8%/h，空闲 0.5%/h", () => {
  const usage = new UsageModel(policy().usage);
  assert.equal(usage.isWorkTime(DT(10)), true);
  assert.equal(usage.isWorkTime(DT(19, 30)), false);
  assert.equal(usage.isWorkTime(DT(8, 59)), false);
  assert.equal(usage.isWorkTime(new Date(2026, 9, 24, 12).getTime()), false); // 周六
  assert.equal(usage.ratePctPerHour(DT(12)), 8);
  assert.equal(usage.ratePctPerHour(DT(23)), 0.5);
});

test("预期自用量跨边界积分：06:00–11:00 = 3h 空闲 + 2h 工作 = 17.5", () => {
  const usage = new UsageModel(policy().usage);
  assert.ok(Math.abs(usage.expectedSelfUsagePct(DT(6), DT(11)) - 17.5) < 1e-9);
  assert.ok(Math.abs(usage.expectedSelfUsagePct(DT(22), new Date(2026, 9, 22, 2).getTime()) - 2) < 1e-9);
});

test("reserve：工作时段中段高、尾段落到下限、深夜低", () => {
  const reserve = new ReserveFunction(policy());
  const b = bucket();
  assert.ok(Math.abs(reserve.reservePct(b, DT(10)) - 40) < 1e-9); // 5h × 8%/h
  assert.ok(Math.abs(reserve.reservePct(b, DT(14, 45)) - 5) < 1e-9); // 2% → 托底 5
  assert.equal(reserve.reservePct(b, DT(14, 0)), 8); // 1h × 8%/h
});

test("reserve：unlimited=0，窗口结束不可知=100，付费=0", () => {
  const reserve = new ReserveFunction(policy());
  assert.equal(reserve.reservePct(bucket({ window: { lifecycle: "unlimited", startMs: null, endMs: null, unlimited: true } }), DT(12)), 0);
  assert.equal(
    reserve.reservePct(bucket({ window: { lifecycle: "fixed_grid", startMs: DT(10), endMs: null, unlimited: false } }), DT(10)),
    100,
  );
  assert.equal(
    reserve.reservePct(bucket({ window: { lifecycle: "depleting", startMs: null, endMs: null, unlimited: false }, unit: "money" }), DT(12)),
    0,
  );
});

test("时间门：工作时段中段等待，尾段开烧，空闲时段立刻开烧", () => {
  const p = new BurnBeforeExpiryPolicy(policy());
  assert.equal(p.scheduleAllows(bucket(), DT(12)).reason, "work_hours_wait");
  assert.equal(p.scheduleAllows(bucket(), DT(14, 35)).reason, "burn_lead");
  assert.equal(
    p.scheduleAllows(
      bucket({ window: { lifecycle: "fixed_grid", startMs: DT(20), endMs: new Date(2026, 9, 22, 1).getTime(), unlimited: false } }),
      DT(20, 5),
    ).reason,
    "idle_time",
  );
});

test("窗口装得下才开跑", () => {
  const p = new BurnBeforeExpiryPolicy(policy());
  const task = makeTask({ spec: { cmd: ["node", "-e", "1"], expectedDurationS: 1800 } });
  assert.equal(p.windowFits(bucket(), task, DT(14, 35)), false); // 25min < 30min
  assert.equal(p.windowFits(bucket(), task, DT(12)), true);
});

test("强度：剩余量 + 高峰降档 + 桶并发约束", () => {
  const p = new BurnBeforeExpiryPolicy(policy());
  assert.equal(p.slots(bucket({ remaining: 90 }), DT(12)), 2); // 3 档被 maxConcurrentPerBucket=2 截断
  assert.equal(p.slots(bucket({ remaining: 50 }), DT(12)), 2);
  assert.equal(p.slots(bucket({ remaining: 20 }), DT(12)), 1);
  assert.equal(p.slots(bucket({ remaining: 10 }), DT(12)), 0);
  assert.equal(p.slots(bucket({ remaining: 90 }), DT(16)), 1); // 高峰 ×0.5
  assert.equal(
    p.slots(bucket({ remaining: 90, constraints: [{ kind: "concurrency", value: 1 }] }), DT(12)),
    1,
  );
});

test("准入：工作时段拒绝、尾段准入、reserve 到线拒绝", () => {
  const p = new BurnBeforeExpiryPolicy(policy());
  const task = makeTask({ resources: {} });

  const mid = decide(p, bucket(), task, DT(12));
  assert.equal(mid.admit, false);
  assert.equal(mid.reason, "work_hours_wait");

  const tail = decide(p, bucket({ remaining: 20 }), task, DT(14, 45));
  assert.equal(tail.admit, true);
  assert.equal(tail.reserve, 5);
  assert.equal(tail.est, 4.5); // 3% × 1.5

  const low = decide(p, bucket({ remaining: 8 }), task, DT(14, 45));
  assert.equal(low.admit, false);
  assert.equal(low.reason, "reserve");

  const committed = decide(p, bucket({ remaining: 20 }), task, DT(14, 45), { committed: 12 });
  assert.equal(committed.admit, false);
  assert.equal(committed.reason, "reserve");
});

test("准入：unknown / unlimited / window_too_short / self_busy 都不烧", () => {
  const p = new BurnBeforeExpiryPolicy(policy());
  const task = makeTask({ spec: { cmd: ["node", "-e", "1"], expectedDurationS: 1 } });
  assert.equal(decide(p, bucket({ remaining: null, source: "unknown" }), task, DT(14, 45)).reason, "unknown");
  assert.equal(
    decide(p, bucket({ window: { lifecycle: "unlimited", startMs: null, endMs: null, unlimited: true } }), task, DT(14, 45)).reason,
    "unlimited",
  );
  const long = makeTask({ spec: { cmd: ["node", "-e", "1"], expectedDurationS: 1800 } });
  assert.equal(decide(p, bucket(), long, DT(14, 45)).reason, "window_too_short");
  assert.equal(decide(p, bucket(), task, DT(14, 45), { selfBusy: true }).reason, "self_busy");
});

test("付费型：价值 > 成本才准入", () => {
  const p = new BurnBeforeExpiryPolicy(policy({ valuePointsPerCurrency: 100 }));
  const paid = bucket({
    window: { lifecycle: "depleting", startMs: null, endMs: null, unlimited: false },
    unit: "money",
    remaining: 5,
    raw: { unitPricePer1kTokens: 0.002 },
  });
  const cheap = decide(p, paid, makeTask({ resources: { text_tokens: 50000 } }), DT(12)); // cost 0.1 → 阈值 10，value 50
  assert.equal(cheap.admit, true);

  const lowValue = decide(p, paid, makeTask({ resources: { text_tokens: 50000 }, value: 5 }), DT(12));
  assert.equal(lowValue.reason, "not_worth_cost");

  const poor = decide(p, bucket({ ...paid, remaining: 0.01 }), makeTask({ resources: { text_tokens: 50000 } }), DT(12));
  assert.equal(poor.reason, "balance");
});

test("排序分数：deadline 越近越高、checkpoint 提权", () => {
  const p = policy();
  const now = DT(12);
  const base = taskScore(makeTask({ value: 10 }), now, p);
  const urgent = taskScore(makeTask({ value: 10, deadlineMs: now + 60_000 }), now, p);
  const cp = taskScore(makeTask({ value: 10, checkpoint: { sessionId: "session-abc", updatedAt: now } }), now, p);
  assert.ok(urgent > base);
  assert.ok(cp > base);
});
