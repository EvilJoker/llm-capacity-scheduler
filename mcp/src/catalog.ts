/** Model Catalog：把“可用 LLM”拆成「能力匹配」+「容量可用」两件事。 */

import type { ModelConfig, Config } from "./config.js";
import type { Bucket, Task } from "./types.js";

const QUALITY_ORDER: Record<string, number> = { cheap: 0, standard: 1, best: 2 };

export interface ResolvedModel {
  model: string;
  family: string;
  context: number;
  qualityTier: string;
  unitPricePer1kTokens: number;
  synthetic: boolean;
}

/** 按能力筛出该桶可用的模型；catalog 为空时退化为 family 本身（零配置可用）。 */
export function resolveModel(
  task: Task,
  bucket: Bucket,
  models: ModelConfig[],
): ResolvedModel | null {
  const req = task.requirements;
  const minContext = req.minContext ?? 0;
  const modalities = req.modalities ?? ["text"];
  const requiredQuality = req.qualityTier ? (QUALITY_ORDER[req.qualityTier] ?? 0) : 0;

  const candidates = models
    .filter((m) => m.provider === bucket.provider)
    .filter((m) => (req.modelFamily ? m.family === req.modelFamily : m.family === bucket.modelFamily))
    .filter((m) => m.context >= minContext)
    .filter((m) => modalities.every((mod) => m.modalities.includes(mod)))
    .filter((m) => (QUALITY_ORDER[m.qualityTier] ?? 0) >= requiredQuality)
    .sort((a, b) => (QUALITY_ORDER[b.qualityTier] ?? 0) - (QUALITY_ORDER[a.qualityTier] ?? 0));

  if (candidates.length > 0) {
    const best = candidates[0];
    return {
      model: best.model,
      family: best.family,
      context: best.context,
      qualityTier: best.qualityTier,
      unitPricePer1kTokens: best.unitPricePer1kTokens,
      synthetic: false,
    };
  }
  // 没有 catalog 条目：如果没有硬性能力要求，就用桶的 family 兜底
  if (minContext > 0) return null;
  const defaultModel = bucket.raw.defaultModel;
  return {
    model: typeof defaultModel === "string" && defaultModel ? defaultModel : bucket.modelFamily,
    family: bucket.modelFamily,
    context: 0,
    qualityTier: "standard",
    unitPricePer1kTokens: 0,
    synthetic: true,
  };
}

export function resolveModelForConfig(
  task: Task,
  bucket: Bucket,
  config: Config,
): ResolvedModel | null {
  return resolveModel(task, bucket, config.models);
}
