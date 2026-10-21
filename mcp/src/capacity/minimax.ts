/**
 * MiniMax 容量适配器：fixed_grid 5h 窗口 + 周限额 unlimited。
 *
 * 实测字段（2026-10）：
 * - GET /v1/token_plan/remains，Bearer Subscription Key
 * - model_remains[]：general 为 5h 固定栅格，video 为日窗口
 * - *_remaining_percent 是剩余语义（0..100）
 * - *_status == 3 表示 unlimited（绝不能当 100%）
 * - base_resp.status_code != 0 是真实错误码
 */

import fs from "node:fs";
import path from "node:path";

import type { Bucket, CapacityWindow } from "../types.js";
import { unknownBucket, optBool, optNumber, optString, optStringArray } from "./base.js";
import type { Adapter } from "./base.js";

const RESOURCE_KIND: Record<string, string> = {
  general: "text_tokens",
  video: "video_clips",
};

export const STATUS_UNLIMITED = 3;

interface MinimaxItem {
  start_time?: number;
  end_time?: number;
  remains_time?: number;
  model_name?: string;
  current_interval_status?: number;
  current_interval_remaining_percent?: number;
  current_weekly_status?: number;
  current_weekly_remaining_percent?: number;
  weekly_start_time?: number;
  weekly_end_time?: number;
  [key: string]: unknown;
}

export class MinimaxAdapter implements Adapter {
  readonly name: string;
  private options: Record<string, unknown>;
  private cachedKey: string | null = null;

  constructor(name: string, options: Record<string, unknown>) {
    this.name = name;
    this.options = options;
  }

  private resolveApiKey(): string | null {
    if (this.cachedKey) return this.cachedKey;
    const envName = optString(this.options, "apiKeyEnv", "MINIMAX_API_KEY");
    if (envName && process.env[envName]) {
      this.cachedKey = process.env[envName]!.trim();
      return this.cachedKey;
    }
    const direct = optString(this.options, "apiKey");
    if (direct) {
      this.cachedKey = direct.trim();
      return this.cachedKey;
    }
    const file = optString(this.options, "apiKeyFile");
    if (file) {
      try {
        const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as Record<
          string,
          unknown
        >;
        const key = data.api_key ?? data.apiKey ?? data.token;
        if (typeof key === "string" && key) {
          this.cachedKey = key.trim();
          return this.cachedKey;
        }
      } catch {
        /* 读不到就继续 */
      }
    }
    return null;
  }

  async fetch(): Promise<Record<string, unknown>> {
    const key = this.resolveApiKey();
    if (!key) throw new Error("MiniMax API key 未配置（apiKey / apiKeyEnv / apiKeyFile）");
    const endpoint = optString(
      this.options,
      "endpoint",
      "https://api.minimaxi.com/v1/token_plan/remains",
    );
    const timeoutS = optNumber(this.options, "timeoutS", 20);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutS * 1000);
    try {
      const resp = await fetch(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: controller.signal,
      });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`MiniMax HTTP ${resp.status}: ${text.slice(0, 200)}`);
      const data = JSON.parse(text) as Record<string, unknown>;
      const base = (data.base_resp ?? {}) as Record<string, unknown>;
      if (Number(base.status_code ?? 0) !== 0) {
        throw new Error(
          `MiniMax API error ${String(base.status_code)}: ${String(base.status_msg ?? "")}`,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async observe(_now: number): Promise<Bucket[]> {
    const families = optStringArray(this.options, "families", ["general"]);
    const includeWeekly = optBool(this.options, "includeWeekly", false);
    let data: Record<string, unknown>;
    try {
      data = await this.fetch();
    } catch (error) {
      return families.map((family) =>
        unknownBucket(
          this.name,
          family,
          RESOURCE_KIND[family] ?? family,
          "pct",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }

    const buckets: Bucket[] = [];
    const seen = new Set<string>();
    const items = (data.model_remains ?? []) as MinimaxItem[];
    for (const item of items) {
      const family = String(item.model_name ?? "");
      if (!family) continue;
      if (families.length > 0 && !families.includes(family)) continue;
      seen.add(family);
      buckets.push(...this.intervalBuckets(family, item));
      if (includeWeekly) {
        const weekly = this.weeklyBucket(family, item);
        if (weekly) buckets.push(weekly);
      }
    }
    for (const family of families) {
      if (!seen.has(family)) {
        buckets.push(
          unknownBucket(
            this.name,
            family,
            RESOURCE_KIND[family] ?? family,
            "pct",
            "provider 响应中缺少该 family",
          ),
        );
      }
    }
    return buckets;
  }

  private intervalBuckets(family: string, item: MinimaxItem): Bucket[] {
    const resourceKind = RESOURCE_KIND[family] ?? family;
    const window: CapacityWindow = {
      lifecycle: "fixed_grid",
      startMs: msOrNull(item.start_time),
      endMs: msOrNull(item.end_time),
      unlimited: false,
    };
    if (item.current_interval_status === STATUS_UNLIMITED) {
      return [
        {
          provider: this.name,
          modelFamily: family,
          resourceKind,
          unit: "pct",
          window: { ...window, lifecycle: "unlimited", unlimited: true },
          remaining: null,
          source: "api",
          constraints: [],
          raw: { ...item },
        },
      ];
    }
    const remaining = item.current_interval_remaining_percent;
    return [
      {
        provider: this.name,
        modelFamily: family,
        resourceKind,
        unit: "pct",
        window,
        remaining: typeof remaining === "number" ? remaining : null,
        source: typeof remaining === "number" ? "api" : "unknown",
        constraints: [],
        raw: { ...item },
      },
    ];
  }

  private weeklyBucket(family: string, item: MinimaxItem): Bucket | null {
    const unlimited = item.current_weekly_status === STATUS_UNLIMITED;
    const remainingPct = item.current_weekly_remaining_percent;
    if (!unlimited && typeof remainingPct !== "number") return null;
    return {
      provider: this.name,
      modelFamily: family,
      resourceKind: `${RESOURCE_KIND[family] ?? family}_weekly`,
      unit: "pct",
      window: {
        lifecycle: unlimited ? "unlimited" : "calendar",
        startMs: msOrNull(item.weekly_start_time),
        endMs: msOrNull(item.weekly_end_time),
        unlimited,
      },
      remaining: unlimited ? null : (remainingPct as number),
      source: "api",
      constraints: [],
      raw: { ...item },
    };
  }
}

function msOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
