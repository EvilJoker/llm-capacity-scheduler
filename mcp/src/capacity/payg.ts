/** PAYG / Credits 余额：depleting 生命周期（策略反转：价值 > 成本才跑）。 */

import fs from "node:fs";

import type { Bucket } from "../types.js";
import { optNumber, optString, unknownBucket } from "./base.js";
import type { Adapter } from "./base.js";

export class PaygAdapter implements Adapter {
  readonly name: string;
  private options: Record<string, unknown>;

  constructor(name: string, options: Record<string, unknown>) {
    this.name = name;
    this.options = options;
  }

  async observe(_now: number): Promise<Bucket[]> {
    const balance = this.readBalance();
    const family = optString(this.options, "modelFamily", "credits");
    if (balance === null) {
      return [unknownBucket(this.name, family, "money", "money", "余额不可知")];
    }
    return [
      {
        provider: this.name,
        modelFamily: family,
        resourceKind: "money",
        unit: "money",
        window: { lifecycle: "depleting", startMs: null, endMs: null, unlimited: false },
        remaining: balance,
        source: "api",
        constraints: [],
        raw: {
          currency: optString(this.options, "currency", "USD"),
          unitPricePer1kTokens: optNumber(this.options, "unitPricePer1kTokens", 0),
        },
      },
    ];
  }

  private readBalance(): number | null {
    const stateFile = optString(this.options, "stateFile");
    if (stateFile) {
      try {
        const data = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Record<string, unknown>;
        const balance = Number(data.balance);
        if (Number.isFinite(balance)) return balance;
      } catch {
        /* fallthrough */
      }
      return null;
    }
    const balance = this.options.balance;
    const n = typeof balance === "number" ? balance : Number(balance);
    return Number.isFinite(n) ? n : null;
  }
}
