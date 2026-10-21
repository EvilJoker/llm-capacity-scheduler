/** 容量观测层：provider adapter 注册表。加 provider = 加一个模块 + 一行注册。 */

import type { ProviderConfig } from "../config.js";
import type { Adapter, AdapterContext } from "./base.js";
import { MinimaxAdapter } from "./minimax.js";
import { MockAdapter } from "./mock.js";
import { PaygAdapter } from "./payg.js";

export type { Adapter, AdapterContext } from "./base.js";
export { unknownBucket } from "./base.js";
export { MinimaxAdapter, STATUS_UNLIMITED } from "./minimax.js";
export { PaygAdapter } from "./payg.js";
export { MockAdapter } from "./mock.js";

export function buildAdapters(config: ProviderConfig[], ctx: AdapterContext): Adapter[] {
  return config
    .filter((p) => p.enabled)
    .map((provider) => {
      switch (provider.kind) {
        case "minimax":
          return new MinimaxAdapter(provider.name, provider.options);
        case "payg":
          return new PaygAdapter(provider.name, provider.options);
        case "mock":
          return new MockAdapter(provider.name, provider.options, ctx);
        default:
          throw new Error(`未知 provider.kind: ${String(provider.kind)}`);
      }
    });
}
