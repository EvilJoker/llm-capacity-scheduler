/**
 * Mock provider：本地演示与测试用。
 *
 * 余量随「该桶已成功的 run 数」线性下降，用来在 Web 控制台里完整演示
 * 「工作时段不烧 → 尾段开烧 → 烧到 reserve 停」。
 *
 * options:
 *   family / resourceKind / unit / lifecycle
 *   initialRemaining=80, burnPerRun=6
 *   remaining=<number>   静态余量（覆盖动态计算）
 *   start="10:00" | end="15:00"   窗口（HH:mm 取今天；也可写 ISO 字符串）
 *   startAt=<epoch ms> / endAt=<epoch ms>
 *   source="mock"
 */

import type { Bucket, CapacityWindow, Lifecycle, Unit } from "../types.js";
import { bucketKey } from "../types.js";
import type { Store } from "../store.js";
import { atMinutes, parseHHMM } from "../util.js";
import { optBool, optNumber, optString } from "./base.js";
import type { Adapter, AdapterContext } from "./base.js";

const VALID_LIFECYCLES: Lifecycle[] = [
  "fixed_grid",
  "rolling_on_first_use",
  "calendar",
  "depleting",
  "unlimited",
];

export class MockAdapter implements Adapter {
  readonly name: string;
  private options: Record<string, unknown>;
  private store?: Store;

  constructor(name: string, options: Record<string, unknown>, ctx: AdapterContext = {}) {
    this.name = name;
    this.options = options;
    this.store = ctx.store;
  }

  async observe(now: number): Promise<Bucket[]> {
    const family = optString(this.options, "family", "general");
    const resourceKind = optString(this.options, "resourceKind", "text_tokens");
    const unit = optString(this.options, "unit", "pct") as Unit;
    const lifecycleOption = optString(this.options, "lifecycle", "fixed_grid");
    const lifecycle = (VALID_LIFECYCLES.includes(lifecycleOption as Lifecycle)
      ? lifecycleOption
      : "fixed_grid") as Lifecycle;
    const unlimited = optBool(this.options, "unlimited", lifecycle === "unlimited");
    const window = this.buildWindow(now, lifecycle, unlimited);

    const staticRemaining = this.options.remaining;
    const base: Bucket = {
      provider: this.name,
      modelFamily: family,
      resourceKind,
      unit,
      window,
      remaining: null,
      source: "mock",
      constraints: [],
      raw: { ...this.options },
    };

    if (typeof staticRemaining === "number") {
      base.remaining = staticRemaining;
      return [base];
    }
    if (unlimited) {
      base.remaining = null;
      return [base];
    }
    const initial = optNumber(this.options, "initialRemaining", 80);
    const burn = optNumber(this.options, "burnPerRun", 6);
    const completed = this.store ? this.store.completedRunsCount(bucketKey(base)) : 0;
    base.remaining = Math.max(0, initial - completed * burn);
    return [base];
  }

  private buildWindow(now: number, lifecycle: Lifecycle, unlimited: boolean): CapacityWindow {
    const startAt = optNumber(this.options, "startAt", NaN);
    const endAt = optNumber(this.options, "endAt", NaN);
    let startMs: number | null = Number.isFinite(startAt) ? startAt : null;
    let endMs: number | null = Number.isFinite(endAt) ? endAt : null;

    const startText = optString(this.options, "start");
    const endText = optString(this.options, "end");
    if (startMs === null && startText) startMs = parseWindowPoint(now, startText);
    if (endMs === null && endText) {
      endMs = parseWindowPoint(now, endText);
      if (startMs !== null && endMs <= startMs) endMs += 24 * 3600 * 1000;
    }
    if (lifecycle === "depleting" || lifecycle === "unlimited") {
      return { lifecycle, startMs, endMs, unlimited };
    }
    if (startMs === null && endMs !== null) startMs = endMs - 5 * 3600 * 1000;
    if (endMs === null && startMs !== null) endMs = startMs + 5 * 3600 * 1000;
    return { lifecycle, startMs, endMs, unlimited };
  }
}

function parseWindowPoint(now: number, text: string): number {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return Date.parse(text);
  if (/^\d{1,2}:\d{2}$/.test(text)) {
    const minutes = parseHHMM(text);
    // 若给的是窗口起点之前的时刻（例如已过 15:00），仍取当天，由调用方负责
    return atMinutes(now, minutes);
  }
  return now;
}

