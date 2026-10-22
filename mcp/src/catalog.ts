/** Model 解析：v0.3 起模型由 provider 配置持有（options.dsh.defaultModel），不再用全局能力目录选型。 */

import type { ProviderConfig } from "./config.js";
import type { Bucket, Task } from "./types.js";

export interface ResolvedModel {
  model: string;
  family: string;
  context: number;
  qualityTier: string;
  unitPricePer1kTokens: number;
  /** true = 没有 provider 级模型配置，退化为 family（合成值） */
  synthetic: boolean;
}

interface DshOptions {
  route?: string;
  models?: string[];
  defaultModel?: string;
}

/**
 * 取该 provider 配置的模型；没有配置时退化为 family（配额本就按 family 计）。
 * 任务要求（minContext / modalities / qualityTier）在 v0.3 不参与选型：
 * 一个 provider 只配一个模型，跑的就是它。
 */
export function resolveModel(
  task: Task,
  bucket: Bucket,
  providers: ProviderConfig[],
): ResolvedModel {
  void task;
  const provider = providers.find((item) => item.name === bucket.provider);
  const dsh = provider?.options?.dsh as DshOptions | undefined;
  const configured = dsh?.defaultModel;
  const model =
    configured && (dsh?.models?.length ? dsh.models.includes(configured) : true)
      ? configured
      : typeof bucket.raw.defaultModel === "string" && bucket.raw.defaultModel
        ? bucket.raw.defaultModel
        : bucket.modelFamily;
  return {
    model,
    family: bucket.modelFamily,
    context: 0,
    qualityTier: "standard",
    unitPricePer1kTokens: 0,
    synthetic: !configured,
  };
}
