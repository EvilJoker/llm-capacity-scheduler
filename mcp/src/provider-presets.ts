/**
 * Provider 预设：Web「添加 LLM」只让用户选厂商 + 填 API Key，其余字段由预设生成。
 *
 * 这是「不支持自定义 provider」阶段的唯一扩展点：加一家厂商 = 加一个 preset + 一个 adapter。
 * 预设里只写 provider 级的出厂参数（端点/families/换算率），不写模型版本：
 * 配额是按「模型族」计的，具体模型由执行器或 models catalog 决定，避免把会过期的
 * 版本号（如 MiniMax-M2.2）固化进配置。
 */

import type { Config, ProviderConfig } from "./config.js";

export interface VendorPreset {
  /** 厂商标识，前端 option value 与后端校验共用 */
  id: string;
  label: string;
  kind: ProviderConfig["kind"];
  /** 默认 provider 名；重名时自动加 -2/-3 后缀 */
  defaultName: string;
  /** 该厂商默认观测的模型族 */
  families: string[];
  buildOptions(apiKey: string): Record<string, unknown>;
}

export const VENDOR_PRESETS: VendorPreset[] = [
  {
    id: "minimax",
    label: "MiniMax",
    kind: "minimax",
    defaultName: "minimax",
    families: ["general"],
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
}

export interface AddProviderResult {
  config: Config;
  provider: ProviderConfig;
}

export function findVendor(id: string): VendorPreset | undefined {
  return VENDOR_PRESETS.find((vendor) => vendor.id === id);
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

  const name = uniqueProviderName(config, input.name?.trim() || vendor.defaultName);
  const provider: ProviderConfig = {
    name,
    kind: vendor.kind,
    enabled: true,
    options: vendor.buildOptions(apiKey),
  };
  const next: Config = structuredClone(config);
  next.providers = [...next.providers, provider];
  return { config: next, provider };
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
