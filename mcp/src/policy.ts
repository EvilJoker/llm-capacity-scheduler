/**
 * 策略层：reserve(t) 时间函数 + 准入控制 + 强度映射。
 *
 * 目标函数：把会作废的容量在正确的时间、以正确的强度烧掉；
 * 策略对 `unknown` 的默认动作永远是「不烧」。
 */

import type { PolicyConfig, UsageConfig, PeakWindowConfig } from "./config.js";
import type { Bucket, Decision, Task } from "./types.js";
import { bucketShortKey, isPaid, isPerishable } from "./types.js";
import { atMinutes, clamp, isoWeekday, minutesOfDay, parseHHMM, startOfNextDay } from "./util.js";

export class UsageModel {
  private workStartMin: number;
  private workEndMin: number;

  constructor(private usage: UsageConfig) {
    this.workStartMin = parseHHMM(usage.workStart);
    this.workEndMin = parseHHMM(usage.workEnd);
  }

  isWorkTime(ms: number): boolean {
    if (!this.usage.workdays.includes(isoWeekday(ms))) return false;
    const minute = minutesOfDay(ms);
    return minute >= this.workStartMin && minute < this.workEndMin;
  }

  ratePctPerHour(ms: number): number {
    return this.isWorkTime(ms)
      ? this.usage.workRatePctPerHour
      : this.usage.offhoursRatePctPerHour;
  }

  /** 从 start 到 end 的预期自用量（百分点），按边界分段积分。 */
  expectedSelfUsagePct(startMs: number, endMs: number): number {
    if (endMs <= startMs) return 0;
    let total = 0;
    let cursor = startMs;
    let guard = 0;
    while (cursor < endMs && guard < 24 * 14) {
      guard += 1;
      const next = this.nextBoundary(cursor, endMs);
      total += ((next - cursor) / 3_600_000) * this.ratePctPerHour(cursor);
      cursor = next;
    }
    return total;
  }

  private nextBoundary(cursor: number, endMs: number): number {
    const tomorrow = startOfNextDay(cursor);
    const candidates = [
      endMs,
      tomorrow,
      atMinutes(cursor, this.workStartMin),
      atMinutes(cursor, this.workEndMin),
      atMinutes(tomorrow, this.workStartMin),
      atMinutes(tomorrow, this.workEndMin),
    ];
    const future = candidates.filter((c) => c > cursor);
    return Math.min(...future);
  }
}

export class PeakSchedule {
  constructor(private windows: PeakWindowConfig[]) {}

  match(ms: number): PeakWindowConfig | undefined {
    const day = isoWeekday(ms);
    const minute = minutesOfDay(ms);
    return this.windows.find((w) => {
      if (!w.days.includes(day)) return false;
      const start = parseHHMM(w.start);
      const end = parseHHMM(w.end);
      return minute >= start && minute < end;
    });
  }

  isPeak(ms: number): boolean {
    return this.match(ms) !== undefined;
  }

  slotsFactor(ms: number): number {
    return this.match(ms)?.slotsFactor ?? 1;
  }

  reserveMultiplier(ms: number): number {
    return this.match(ms)?.reserveMultiplier ?? 1;
  }
}

export class ReserveFunction {
  readonly usage: UsageModel;
  readonly peaks: PeakSchedule;

  constructor(private policy: PolicyConfig) {
    this.usage = new UsageModel(policy.usage);
    this.peaks = new PeakSchedule(policy.peakWindows);
  }

  reservePct(bucket: Bucket, now: number): number {
    if (bucket.window.unlimited || bucket.window.lifecycle === "unlimited") return 0;
    if (isPaid(bucket)) return 0;
    if (bucket.window.endMs === null) return 100;
    let expected = this.usage.expectedSelfUsagePct(now, bucket.window.endMs);
    expected *= this.peaks.reserveMultiplier(now);
    return clamp(Math.max(expected, this.policy.minReservePct));
  }

  isWithinBurnLead(bucket: Bucket, now: number): boolean {
    if (bucket.window.endMs === null) return false;
    return (bucket.window.endMs - now) / 60000 <= this.policy.burnLeadMinutes;
  }
}

export interface DecideInput {
  bucket: Bucket;
  task: Task;
  now: number;
  committed: number;
  runningCount: number;
  selfBusy: boolean;
  calibration?: number;
}

export class BurnBeforeExpiryPolicy {
  readonly reserveFn: ReserveFunction;
  readonly usage: UsageModel;
  readonly peaks: PeakSchedule;

  constructor(readonly policy: PolicyConfig) {
    this.reserveFn = new ReserveFunction(policy);
    this.usage = this.reserveFn.usage;
    this.peaks = this.reserveFn.peaks;
  }

  estimateUsage(task: Task, bucket: Bucket, calibration?: number): number {
    const resources = task.resources;
    let base: number | undefined;
    if (typeof resources.estPct === "number") {
      base = resources.estPct;
    } else if (typeof resources[`${bucket.resourceKind}Pct`] === "number") {
      base = resources[`${bucket.resourceKind}Pct`];
    } else if (typeof resources.text_tokens === "number") {
      const perPctRaw = bucket.raw.textTokensPerPct;
      const perPct = typeof perPctRaw === "number" && perPctRaw > 0 ? perPctRaw : 50000;
      base = resources.text_tokens / perPct;
    }
    if (base === undefined) base = calibration ?? this.policy.defaultEstPct;
    return Math.max(0, base) * this.policy.safetyFactor;
  }

  estimateCost(task: Task, bucket: Bucket): number {
    if (typeof task.resources.estCost === "number") return task.resources.estCost;
    const tokens = task.resources.text_tokens ?? 0;
    const priceRaw = bucket.raw.unitPricePer1kTokens;
    const price = typeof priceRaw === "number" ? priceRaw : 0;
    return (tokens / 1000) * price;
  }

  /** 强度：并发槽位（由剩余量 + 高峰降档 + provider 约束决定）。 */
  slots(bucket: Bucket, now: number): number {
    if (isPaid(bucket)) return Math.max(0, this.policy.maxConcurrentPerBucket);
    const pct = bucket.remaining ?? 0;
    let slots = pct > 70 ? 3 : pct > 40 ? 2 : pct > 15 ? 1 : 0;
    const factor = this.peaks.slotsFactor(now);
    if (factor < 1 && slots > 0) slots = Math.max(1, Math.floor(slots * factor));
    let cap = this.policy.maxConcurrentPerBucket;
    for (const constraint of bucket.constraints) {
      if (constraint.kind === "concurrency" && constraint.value) {
        cap = Math.min(cap, Math.floor(constraint.value));
      }
    }
    return Math.max(0, Math.min(slots, cap));
  }

  /** 三条时间规则：尾段必烧 / 非工作时段立刻烧 / 工作时段中段等待。 */
  scheduleAllows(bucket: Bucket, now: number): { ok: boolean; reason: string } {
    if (this.reserveFn.isWithinBurnLead(bucket, now)) return { ok: true, reason: "burn_lead" };
    if (!this.usage.isWorkTime(now)) return { ok: true, reason: "idle_time" };
    if (this.policy.workHoursOpportunistic) return { ok: true, reason: "opportunistic" };
    return { ok: false, reason: "work_hours_wait" };
  }

  /** 窗口装得下才开跑：避免跨窗口串账。 */
  windowFits(bucket: Bucket, task: Task, now: number): boolean {
    if (bucket.window.endMs === null) return true;
    if (isPaid(bucket) || bucket.window.unlimited) return true;
    const requiredS = (task.spec.expectedDurationS ?? 300) + this.policy.windowGraceSeconds;
    return (bucket.window.endMs - now) / 1000 >= requiredS;
  }

  decide(input: DecideInput): Decision {
    const { bucket, task, now, committed, runningCount, selfBusy, calibration } = input;
    const deny = (reason: string, extra: Partial<Decision> = {}): Decision => ({
      admit: false,
      reason,
      est: extra.est ?? 0,
      reserve: extra.reserve ?? 0,
      excess: extra.excess ?? 0,
      slots: extra.slots ?? 0,
    });

    if (bucket.window.unlimited || bucket.window.lifecycle === "unlimited") {
      return deny("unlimited");
    }
    if (!bucketKnown(bucket)) return deny("unknown");
    if (task.value < 0) return deny("value");
    if (selfBusy) return deny("self_busy");
    if (!this.windowFits(bucket, task, now)) return deny("window_too_short");

    if (isPaid(bucket)) {
      const cost = this.estimateCost(task, bucket);
      const balance = bucket.remaining ?? 0;
      const excess = balance - committed - cost;
      const slots = this.slots(bucket, now);
      if (cost <= 0) return deny("no_cost_estimate", { est: cost, excess, slots });
      const threshold = cost * this.policy.valuePointsPerCurrency;
      if (task.value < threshold) {
        return deny("not_worth_cost", { est: cost, excess, slots });
      }
      if (excess < 0) return deny("balance", { est: cost, excess, slots });
      if (runningCount >= slots) return deny("slots", { est: cost, excess, slots });
      return { admit: true, reason: "admit", est: cost, reserve: 0, excess, slots };
    }

    if (!isPerishable(bucket)) return deny("not_schedulable");
    if (bucket.window.endMs === null) return deny("no_window_end");

    const reserve = this.reserveFn.reservePct(bucket, now);
    const remaining = bucket.remaining ?? 0;
    const excess = remaining - committed - reserve;
    const est = this.estimateUsage(task, bucket, calibration);

    const schedule = this.scheduleAllows(bucket, now);
    if (!schedule.ok) {
      return deny(schedule.reason, { est, reserve, excess, slots: this.slots(bucket, now) });
    }
    if (excess < est) return deny("reserve", { est, reserve, excess, slots: this.slots(bucket, now) });
    const slots = this.slots(bucket, now);
    if (runningCount >= slots) return deny("slots", { est, reserve, excess, slots });
    return { admit: true, reason: "admit", est, reserve, excess, slots };
  }
}

function bucketKnown(bucket: Bucket): boolean {
  return bucket.remaining !== null && bucket.source !== "unknown";
}

export function taskScore(task: Task, now: number, policy: PolicyConfig): number {
  const est = task.resources.estPct ?? policy.defaultEstPct;
  const density = task.value / Math.max(est, 1e-9);
  let urgency = 1;
  if (task.deadlineMs !== null) {
    const horizon = 24 * 3600 * 1000;
    const left = task.deadlineMs - now;
    urgency = 1 + 2 * clamp(1 - left / horizon, 0, 1);
  }
  const checkpointBonus = task.checkpoint ? 1.5 : 1;
  return density * urgency * checkpointBonus * (1 + task.priorityBoost);
}

export function bucketLabel(bucket: Bucket): string {
  return bucketShortKey(bucket);
}
