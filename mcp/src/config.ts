/** 配置：默认值 / JSON 读写 / 路径解析 / 密钥脱敏 / 校验。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findVendorByKind } from "./provider-presets.js";
import { atomicWriteFileSync, deepMerge, parseHHMM, readJsonFile, resolvePath } from "./util.js";
import type { RunnerName } from "./types.js";

export interface WebConfig {
  enabled: boolean;
  host: string;
  port: number;
}

export interface EngineConfig {
  tickSeconds: number;
  stateFile: string;
  artifactsDir: string;
  /** 每 task 固定工作目录的根（dsh session 按 cwd 绑定） */
  workDir: string;
  maxParallel: number;
  /** dsh 会话保留天数（超过则清理会话目录与投影缓存） */
  sessionRetentionDays: number;
  web: WebConfig;
}

export interface UsageConfig {
  workdays: number[];
  workStart: string;
  workEnd: string;
  workRatePctPerHour: number;
  offhoursRatePctPerHour: number;
}

export interface PeakWindowConfig {
  days: number[];
  start: string;
  end: string;
  slotsFactor: number;
  reserveMultiplier: number;
}

export interface PolicyConfig {
  name: string;
  burnLeadMinutes: number;
  minReservePct: number;
  safetyFactor: number;
  defaultEstPct: number;
  calibrationMinSamples: number;
  maxConcurrentPerBucket: number;
  workHoursOpportunistic: boolean;
  activityLookbackMinutes: number;
  activityDropThresholdPct: number;
  valuePointsPerCurrency: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
  windowPreempt: boolean;
  /** 开跑前要求窗口剩余时间至少比预估时长多出的安全余量（秒） */
  windowGraceSeconds: number;
  usage: UsageConfig;
  peakWindows: PeakWindowConfig[];
}

export type ProviderKind = "minimax" | "payg" | "mock";

export interface ProviderConfig {
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface ModelConfig {
  provider: string;
  model: string;
  family: string;
  context: number;
  modalities: string[];
  qualityTier: "cheap" | "standard" | "best";
  unitPricePer1kTokens: number;
}

export interface DshRunnerConfig {
  enabled: boolean;
  command: string;
  /** dsh profile 名（LCS 自建 profile，写在 ~/.dsh/profiles/<profile>） */
  profile: string;
  /** 运行期 --patch 缓存目录（每 (route, model) 一个文件） */
  patchDir: string;
  /** 默认超时（秒），task.spec.timeoutS 可覆盖 */
  timeoutS: number;
  /** 恒为 1：v0.3 串行执行 */
  maxParallel: number;
}

export interface RunnersConfig {
  default: RunnerName;
  dsh: DshRunnerConfig;
}

export interface McpConfig {
  serverName: string;
}

export interface Config {
  version: 2;
  engine: EngineConfig;
  policy: PolicyConfig;
  providers: ProviderConfig[];
  models: ModelConfig[];
  runners: RunnersConfig;
  mcp: McpConfig;
}

export interface LoadedConfig {
  config: Config;
  /** 配置文件绝对路径 */
  path: string;
  /** 配置文件所在目录，用于解析相对路径 */
  baseDir: string;
  exists: boolean;
}

const DEFAULT_MAX_SAMPLES = 5000;
export const MAX_SAMPLES = DEFAULT_MAX_SAMPLES;

export function defaultConfig(): Config {
  return {
    version: 2,
    engine: {
      tickSeconds: 60,
      stateFile: "~/.lcs/state.json",
      artifactsDir: "~/.lcs/artifacts",
      workDir: "~/.lcs/work",
      maxParallel: 1,
      sessionRetentionDays: 7,
      web: { enabled: true, host: "127.0.0.1", port: 7788 },
    },
    policy: {
      name: "burn_before_expiry",
      burnLeadMinutes: 30,
      minReservePct: 5,
      safetyFactor: 1.5,
      defaultEstPct: 3,
      calibrationMinSamples: 3,
      maxConcurrentPerBucket: 2,
      workHoursOpportunistic: false,
      activityLookbackMinutes: 10,
      activityDropThresholdPct: 1,
      valuePointsPerCurrency: 100,
      maxAttempts: 2,
      retryBackoffSeconds: 60,
      windowPreempt: true,
      windowGraceSeconds: 60,
      usage: {
        workdays: [1, 2, 3, 4, 5],
        workStart: "09:00",
        workEnd: "19:30",
        workRatePctPerHour: 8,
        offhoursRatePctPerHour: 0.5,
      },
      peakWindows: [
        { days: [1, 2, 3, 4, 5], start: "15:00", end: "17:30", slotsFactor: 0.5, reserveMultiplier: 1 },
      ],
    },
    providers: [
      {
        name: "minimax",
        kind: "minimax",
        enabled: true,
        options: {
          apiKey: "",
          apiKeyEnv: "MINIMAX_API_KEY",
          apiKeyFile: "~/.mmx/config.json",
          endpoint: "https://api.minimaxi.com/v1/token_plan/remains",
          families: ["general"],
          includeWeekly: false,
          textTokensPerPct: 50000,
          timeoutS: 20,
        },
      },
    ],
    // v0.3：模型由 provider 配置持有（options.dsh.defaultModel），全局能力目录不再使用。
    models: [],
    runners: {
      default: "dsh",
      dsh: {
        enabled: true,
        command: "dsh",
        profile: "lcs",
        patchDir: "~/.lcs/patches",
        timeoutS: 3600,
        maxParallel: 1,
      },
    },
    mcp: { serverName: "lcs" },
  };
}

/**
 * 配置迁移：v1（shell+dsh 双 runner、并发 4、全局 models 目录）→ v2（dsh-only、串行、模型归 provider）。
 * 迁移是幂等的：已经是 v2 的配置原样返回。
 */
export function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const version = Number(raw.version ?? 1);
  if (version >= 2) return raw;
  const out = structuredClone(raw) as Record<string, unknown>;

  const engine = (out.engine ?? {}) as Record<string, unknown>;
  if (typeof engine.workDir !== "string" || !engine.workDir) engine.workDir = "~/.lcs/work";
  if (typeof engine.sessionRetentionDays !== "number") engine.sessionRetentionDays = 7;
  engine.maxParallel = 1; // v0.3 串行
  out.engine = engine;

  const runners = (out.runners ?? {}) as Record<string, unknown>;
  const oldDsh = (runners.dsh ?? {}) as Record<string, unknown>;
  out.runners = {
    default: "dsh",
    dsh: {
      enabled: oldDsh.enabled !== false,
      command:
        typeof oldDsh.command === "string" && oldDsh.command ? oldDsh.command : "dsh",
      // v0.3 一律用 LCS 自建 profile（旧的 headless profile 里没有路由声明）
      profile: "lcs",
      patchDir: "~/.lcs/patches",
      timeoutS: 3600,
      maxParallel: 1,
    },
  };

  out.models = []; // 全局能力目录废弃：模型由 provider 配置持有

  const providers = Array.isArray(out.providers) ? (out.providers as ProviderConfig[]) : [];
  for (const provider of providers) {
    const options = (provider.options ?? {}) as Record<string, unknown>;
    if (!options.dsh) {
      const preset = findVendorByKind(provider.kind);
      if (preset) options.dsh = { ...preset.dsh };
    }
    provider.options = options;
  }
  out.providers = providers;
  out.version = 2;
  return out;
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LCS_CONFIG;
  if (explicit) return resolvePath(explicit, process.cwd());
  const local = path.resolve(process.cwd(), "lcs.config.json");
  if (fs.existsSync(local)) return local;
  return path.join(os.homedir(), ".lcs", "config.json");
}

export function loadConfig(explicitPath?: string): LoadedConfig {
  const configPath = explicitPath
    ? resolvePath(explicitPath, process.cwd())
    : defaultConfigPath();
  const exists = fs.existsSync(configPath);
  const baseDir = path.dirname(configPath);
  const raw = exists ? readJsonFile<Record<string, unknown>>(configPath, {}) : {};
  const migrated = migrateConfig(raw);
  const merged = deepMerge(defaultConfig() as unknown as Record<string, unknown>, migrated);
  const config = finalizeConfig(merged as unknown as Config, configPath, baseDir);
  validateConfig(config);
  return { config, path: configPath, baseDir, exists };
}

/** 把路径类字段统一成绝对路径（保存时也写绝对路径，避免歧义）。 */
export function finalizeConfig(config: Config, configPath: string, baseDir?: string): Config {
  const dir = baseDir ?? path.dirname(configPath);
  const engine = config.engine;
  engine.stateFile = resolvePath(engine.stateFile, dir);
  engine.artifactsDir = resolvePath(engine.artifactsDir, dir);
  engine.workDir = resolvePath(engine.workDir, dir);
  const patchDir = config.runners.dsh.patchDir;
  if (typeof patchDir === "string") config.runners.dsh.patchDir = resolvePath(patchDir, dir);
  for (const provider of config.providers) {
    const file = provider.options.apiKeyFile;
    if (typeof file === "string" && file) {
      provider.options.apiKeyFile = resolvePath(file, dir);
    }
    const stateFile = provider.options.stateFile;
    if (typeof stateFile === "string" && stateFile) {
      provider.options.stateFile = resolvePath(stateFile, dir);
    }
  }
  applyEnvOverrides(config);
  return config;
}

function applyEnvOverrides(config: Config): void {
  const env = process.env;
  if (env.LCS_STATE) config.engine.stateFile = resolvePath(env.LCS_STATE, process.cwd());
  if (env.LCS_ARTIFACTS) {
    config.engine.artifactsDir = resolvePath(env.LCS_ARTIFACTS, process.cwd());
  }
  if (env.LCS_PORT) config.engine.web.port = Number(env.LCS_PORT);
  if (env.LCS_TICK_SECONDS) config.engine.tickSeconds = Number(env.LCS_TICK_SECONDS);
  if (env.LCS_WEB_HOST) config.engine.web.host = env.LCS_WEB_HOST;
  if (env.LCS_NO_WEB === "1") config.engine.web.enabled = false;
}

export function saveConfig(config: Config, configPath: string): void {
  atomicWriteFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
}

/** 给 Web / MCP 的脱敏视图：apiKey 有值则替换成 ***。 */
export function redactConfig(config: Config): Config {
  const clone = structuredClone(config);
  for (const provider of clone.providers) {
    const key = provider.options.apiKey;
    if (typeof key === "string" && key.length > 0) provider.options.apiKey = "***";
  }
  return clone;
}

/**
 * Web 保存配置时合并密钥：`***` 或空串表示保留旧值。
 */
export function mergeSecrets(incoming: Config, current: Config): Config {
  const byName = new Map(current.providers.map((p) => [p.name, p]));
  for (const provider of incoming.providers) {
    const old = byName.get(provider.name);
    const nextKey = provider.options.apiKey;
    if (nextKey === "***" || nextKey === undefined || nextKey === "") {
      if (old && typeof old.options.apiKey === "string") {
        provider.options.apiKey = old.options.apiKey;
      } else {
        delete provider.options.apiKey;
      }
    }
  }
  return incoming;
}

export function validateConfig(config: Config): void {
  const fail = (msg: string): never => {
    throw new Error(`配置错误: ${msg}`);
  };
  if (config.version !== 2) fail("version 必须是 2");
  if (!(config.engine.tickSeconds >= 1)) fail("engine.tickSeconds 必须 ≥ 1");
  if (!config.engine.workDir) fail("engine.workDir 不能为空");
  if (!(config.engine.sessionRetentionDays >= 0)) fail("engine.sessionRetentionDays 必须 ≥ 0");
  if (!config.engine.stateFile) fail("engine.stateFile 不能为空");
  if (!config.engine.artifactsDir) fail("engine.artifactsDir 不能为空");
  if (!(config.engine.maxParallel >= 1)) fail("engine.maxParallel 必须 ≥ 1");
  if (config.engine.web.port < 0 || config.engine.web.port > 65535) {
    fail("engine.web.port 非法");
  }
  const policy = config.policy;
  if (!(policy.burnLeadMinutes >= 0)) fail("policy.burnLeadMinutes 必须 ≥ 0");
  if (!(policy.minReservePct >= 0 && policy.minReservePct <= 100)) {
    fail("policy.minReservePct 必须在 0..100");
  }
  if (!(policy.safetyFactor >= 1)) fail("policy.safetyFactor 必须 ≥ 1");
  if (!(policy.defaultEstPct > 0)) fail("policy.defaultEstPct 必须 > 0");
  if (!(policy.maxConcurrentPerBucket >= 1)) fail("policy.maxConcurrentPerBucket 必须 ≥ 1");
  if (!(policy.maxAttempts >= 1)) fail("policy.maxAttempts 必须 ≥ 1");
  if (!(policy.windowGraceSeconds >= 0)) fail("policy.windowGraceSeconds 必须 ≥ 0");
  for (const day of policy.usage.workdays) {
    if (day < 1 || day > 7) fail("policy.usage.workdays 取值 1..7");
  }
  parseHHMM(policy.usage.workStart);
  parseHHMM(policy.usage.workEnd);
  for (const peak of policy.peakWindows) {
    parseHHMM(peak.start);
    parseHHMM(peak.end);
  }
  const providerNames = new Set<string>();
  for (const provider of config.providers) {
    if (!provider.name) fail("provider.name 不能为空");
    if (providerNames.has(provider.name)) fail(`provider 重名: ${provider.name}`);
    providerNames.add(provider.name);
    if (!["minimax", "payg", "mock"].includes(provider.kind)) {
      fail(`未知 provider.kind: ${provider.kind}`);
    }
  }
  for (const model of config.models) {
    if (!model.provider || !model.model) fail("models 条目缺少 provider/model");
    if (!providerNames.has(model.provider) && config.providers.length > 0) {
      fail(`models 引用了不存在的 provider: ${model.provider}`);
    }
  }
  if (config.runners.default !== "dsh") {
    fail(`runners.default 必须是 dsh（v0.3 只保留 dsh 执行器）`);
  }
  const dsh = config.runners.dsh;
  if (!dsh.command) fail("runners.dsh.command 不能为空");
  if (!dsh.profile) fail("runners.dsh.profile 不能为空");
  if (!dsh.patchDir) fail("runners.dsh.patchDir 不能为空");
  if (!(dsh.timeoutS > 0)) fail("runners.dsh.timeoutS 必须 > 0");
  if (!(dsh.maxParallel >= 1)) fail("runners.dsh.maxParallel 必须 ≥ 1");
  for (const provider of config.providers) {
    const dshOptions = provider.options.dsh as Record<string, unknown> | undefined;
    if (!dshOptions) continue;
    for (const field of ["route", "api", "baseURL", "apiKeyEnv"]) {
      if (typeof dshOptions[field] !== "string" || !dshOptions[field]) {
        fail(`provider ${provider.name} 的 dsh.${field} 不能为空`);
      }
    }
    const models = dshOptions.models;
    if (!Array.isArray(models) || models.length === 0) {
      fail(`provider ${provider.name} 的 dsh.models 不能为空`);
    }
    const modelIds = models as string[];
    const defaultModel = dshOptions.defaultModel;
    if (typeof defaultModel !== "string" || !modelIds.includes(defaultModel)) {
      fail(`provider ${provider.name} 的 dsh.defaultModel 必须在 dsh.models 内`);
    }
  }
}

const INIT_README = [
  "lcs 配置文件。敏感信息建议放 apiKeyEnv 环境变量或 apiKeyFile 指向的文件。",
  "改完保存后引擎会热加载（Web 端 PUT /api/config 或重启进程）。",
  "providers.kind 支持 minimax / payg / mock；mock 用于本地演示与测试。",
];

export function exampleConfig(): Config {
  const config = defaultConfig();
  (config as unknown as Record<string, unknown>)._readme = INIT_README;
  return config;
}
