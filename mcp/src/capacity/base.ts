/** 容量适配器契约：失败不抛异常，返回 source="unknown" 的桶（策略不烧）。 */

import type { Bucket, Unit } from "../types.js";
import type { Store } from "../store.js";

export interface AdapterContext {
  store?: Store;
}

export interface Adapter {
  readonly name: string;
  observe(now: number): Promise<Bucket[]>;
}

export function unknownBucket(
  provider: string,
  modelFamily: string,
  resourceKind: string,
  unit: Unit = "pct",
  error?: string,
): Bucket {
  return {
    provider,
    modelFamily,
    resourceKind,
    unit,
    window: { lifecycle: "fixed_grid", startMs: null, endMs: null, unlimited: false },
    remaining: null,
    source: "unknown",
    constraints: [],
    raw: error ? { error } : {},
  };
}

export function optString(
  options: Record<string, unknown>,
  key: string,
  fallback = "",
): string {
  const v = options[key];
  return typeof v === "string" ? v : fallback;
}

export function optNumber(
  options: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = options[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function optBool(
  options: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = options[key];
  return typeof v === "boolean" ? v : fallback;
}

export function optStringArray(
  options: Record<string, unknown>,
  key: string,
  fallback: string[],
): string[] {
  const v = options[key];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return fallback;
}
