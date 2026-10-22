/**
 * Provider 预设：Web「添加 LLM」只让用户选厂商、填 API Key、选模型，其余字段由预设生成。
 *
 * 这是「不支持自定义 provider」阶段的唯一扩展点：加一家厂商 = 加一个 preset + 一个 adapter。
 * 预设里只写 provider 级的出厂参数（端点/协议/模型列表），不写模型版本以外的可变项；
 * 厂商参数（route/api/baseURL/apiKeyEnv/models）一律由预设写死，用户不可修改，
 * 只有「用哪个模型」是用户可选的（见 D13/D14）。
 */

import type { Config, ProviderConfig } from "./config.js";

export interface VendorDshPreset {
  /** dsh 里的路由名（= agent-default-model.provider） */
  route: string;
  /** 协议：anthropic-messages / openai-completions */
  api: string;
  baseURL: string;
  /** LCS 注入 Key 时使用的环境变量名（与用户自己 dsh 配置里的变量隔离） */
  apiKeyEnv: string;
  /** 该路由可用的模型 id（dsh 侧按此声明模型目录） */
  models: string[];
  /** 默认模型（用户可在 provider 卡片里改，但必须 ∈ models） */
  defaultModel: string;
  displayName?: string;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
}

export interface VendorPreset {
  /** 厂商标识，前端 option value 与后端校验共用 */
  id: string;
  label: string;
  kind: ProviderConfig["kind"];
  /** 默认 provider 名；重名时自动加 -2/-3 后缀 */
  defaultName: string;
  /** 该厂商默认观测的模型族（容量口径） */
  families: string[];
  /** dsh 路由预设（只读） */
  dsh: VendorDshPreset;
  buildOptions(apiKey: string): Record<string, unknown>;
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: "minimax",
    label: "MiniMax",
    kind: "minimax",
    defaultName: "minimax",
    families: ["general"],
    dsh: {
      route: "minimax",
      api: "anthropic-messages",
      baseURL: "https://api.minimaxi.com/anthropic",
      apiKeyEnv: "LCS_MINIMAX_API_KEY",
      models: ["MiniMax-M3.1-Flash[1m]"],
      defaultModel: "MiniMax-M3.1-Flash[1m]",
      displayName: "MiniMax (M3)",
      defaultContextWindow: 1048576,
      defaultMaxTokens: 65536,
    },
    buildOptions: (apiKey) => ({
      apiKey,
      // 显式清空 env/file：用户在 UI 填的 Key 优先，避免被同名环境变量覆盖
      apiKeyEnv: "",
      apiKeyFile: "",
      endpoint: "https://api.minimaxi.com/v1/token_plan/remains",
      families: ["general"],
      includeWeekly: false,
      textTokensPerPct: 50000,
      timeoutS: 20,
    }),
  },
];

export interface AddProviderInput {
  vendor: string;
  apiKey: string;
  /** 可选；只为区分多个 Key，不影响调度语义 */
  name?: string;
  /** 可选；用户选择的模型（必须在厂商预设的模型列表内） */
  model?: string;
}

export interface AddProviderResult {
  config: Config;
  provider: ProviderConfig;
}

export function findVendor(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find((vendor) => vendor.id === id);
}

/** 按 provider kind 找厂商预设（迁移时给老 provider 补 dsh 段用）。 */
export function findVendorByKind(kind: ProviderConfig["kind"]): VendorPreset | undefined {
  return VENDOR_PRESETS.find((vendor) => vendor.kind === kind);
}

/** 纯函数：返回追加了 provider 的新配置（不落盘、不校验）。 */
export function addProvider(config: Config, input: AddProviderInput): AddProviderResult {
  const vendor = findVendor(String(input.vendor ?? "").trim());
  if (!vendor) {
    const supported = VENDOR_PRESETS.map((v) => `${v.id}（${v.label}）`).join("、");
    throw new Error(`暂不支持的厂商: ${String(input.vendor ?? "")}；当前支持: ${supported}`);
  }
  const apiKey = String(input.apiKey ?? "").trim();
  if (!apiKey) throw new Error("请填写 API Key");
  const model = input.model?.trim();
  if (model && !vendor.dsh.models.includes(model)) {
    throw new Error(`厂商 ${vendor.label} 不支持模型 ${model}；可选: ${vendor.dsh.models.join("、")}`);
  }

  const name = uniqueProviderName(config, input.name?.trim() || vendor.defaultName);
  const provider: ProviderConfig = {
    name,
    kind: vendor.kind,
    enabled: true,
    options: {
      ...vendor.buildOptions(apiKey),
      dsh: { ...vendor.dsh, defaultModel: model || vendor.dsh.defaultModel },
    },
  };
  const next: Config = structuredClone(config);
  next.providers = [...next.providers, provider];
  return { config: next, provider };
}

/** 纯函数：移除一个 provider（连同它在 models 目录里的条目），返回新配置。 */
export function removeProvider(config: Config, name: string): RemoveProviderResult {
  const target = name.trim();
  const provider = config.providers.find((item) => item.name === target);
  if (!provider) throw new Error(`provider 不存在: ${target}`);
  const next: Config = structuredClone(config);
  next.providers = next.providers.filter((item) => item.name !== target);
  next.models = next.models.filter((model) => model.provider !== target);
  return { config: next, provider };
}

export interface RemoveProviderResult {
  config: Config;
  provider: ProviderConfig;
}

function uniqueProviderName(config: Config, requested: string): string {
  const used = new Set(config.providers.map((provider) => provider.name));
  const base =
    requested
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "") || "llm";
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
