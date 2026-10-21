/** 配置：默认值 / JSON 读写 / 路径解析 / 密钥脱敏 / 校验。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  maxParallel: number;
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

export interface ShellRunnerConfig {
  enabled: boolean;
}

export interface DshRunnerConfig {
  enabled: boolean;
  command: string;
  profile: string;
  /** provider → dsh profile 名，用于把选中的 provider 路由到真实执行后端 */
  profiles: Record<string, string>;
}

export interface RunnersConfig {
  default: RunnerName;
  shell: ShellRunnerConfig;
  dsh: DshRunnerConfig;
}

export interface McpConfig {
  serverName: string;
}

export interface Config {
  version: 1;
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
    version: 1,
    engine: {
      tickSeconds: 60,
      stateFile: "~/.lcs/state.json",
      artifactsDir: "~/.lcs/artifacts",
      maxParallel: 4,
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
    models: [
      {
        provider: "minimax",
        model: "MiniMax-M2.2",
        family: "general",
        context: 200000,
        modalities: ["text"],
        qualityTier: "best",
        unitPricePer1kTokens: 0,
      },
    ],
    runners: {
      default: "shell",
      shell: { enabled: true },
      dsh: { enabled: true, command: "dsh", profile: "headless", profiles: {} },
    },
    mcp: { serverName: "lcs" },
  };
}

export function defaultConfigPath(): string {
  const env = process.env.LCS_CONFIG;
  if (env) return resolvePath(env, process.cwd());
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
  const merged = deepMerge(defaultConfig() as unknown as Record<string, unknown>, raw);
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
  if (!(config.engine.tickSeconds >= 1)) fail("engine.tickSeconds 必须 ≥ 1");
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
  if (!["shell", "dsh"].includes(config.runners.default)) {
    fail(`未知 runners.default: ${config.runners.default}`);
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
