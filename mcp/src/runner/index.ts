/** 执行器层：v0.3 只保留 dsh（唯一执行器），任务串行执行。 */

import type { Config, ProviderConfig } from "../config.js";
import { dshOptionsOf } from "../dsh-profile.js";
import { resolveProviderKey } from "../provider-key.js";
import type { RunnerName } from "../types.js";
import type { Runner } from "./base.js";
import { DshRunner, type DshRouteLike } from "./dsh.js";

export type { Runner } from "./base.js";
export { DshRunner } from "./dsh.js";
export { parseDshEvents } from "./events.js";

export type RunnerMap = Partial<Record<RunnerName, Runner>>;

/** provider → dsh 路由（只保留带 dsh 段且启用的 provider）。 */
export function collectRunnerRoutes(config: Config): Record<string, DshRouteLike> {
  const routes: Record<string, DshRouteLike> = {};
  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    const dsh = dshOptionsOf(provider);
    if (!dsh) continue;
    routes[provider.name] = {
      route: dsh.route,
      apiKeyEnv: dsh.apiKeyEnv,
      defaultModel: dsh.defaultModel,
      models: dsh.models,
    };
  }
  return routes;
}

/** provider → Key（明文；仅用于注入子进程环境变量）。 */
export function collectProviderKeys(config: Config): Record<string, string | null> {
  const keys: Record<string, string | null> = {};
  for (const provider of config.providers as ProviderConfig[]) {
    keys[provider.name] = resolveProviderKey(provider.options ?? {});
  }
  return keys;
}

export function buildRunners(config: Config, baseDir: string): RunnerMap {
  const runners: RunnerMap = {};
  if (!config.runners.dsh.enabled) return runners;
  runners.dsh = new DshRunner({
    baseDir,
    artifactsDir: config.engine.artifactsDir,
    defaultTimeoutS: config.runners.dsh.timeoutS,
    dsh: config.runners.dsh,
    routes: collectRunnerRoutes(config),
    keys: collectProviderKeys(config),
  });
  return runners;
}
