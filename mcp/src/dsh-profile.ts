/**
 * dsh profile / 运行期 patch 管理。
 *
 * - profile：LCS 自建 `~/.dsh/profiles/lcs`（bundles: dsh-base + dsh-headless），
 *   其 patch 层静态声明所有 provider 的路由（api/baseURL/apiKeyEnv/models，**不含 Key**）；
 * - 运行期 patch：每次调用只覆盖 `agent-default-model`（provider + model），
 *   按 (route, model) 缓存到 patchDir，避免重复写盘。
 *
 * 关键约束：dsh 的 patch 是**整段替换**目标 row 的 config，所以路由必须在 profile 层，
 * 运行期 patch 绝不能去覆盖 `llm-pi-ai`，否则会抹掉其它路由。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config, ProviderConfig } from "./config.js";
import { atomicWriteFileSync } from "./util.js";

export interface DshRouteConfig {
  route: string;
  api: string;
  baseURL: string;
  apiKeyEnv: string;
  models: string[];
  defaultModel: string;
  displayName?: string;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
}

export function dshOptionsOf(provider: ProviderConfig): DshRouteConfig | null {
  const raw = provider.options?.dsh as Partial<DshRouteConfig> | undefined;
  if (!raw || typeof raw.route !== "string" || !raw.route) return null;
  return {
    route: raw.route,
    api: raw.api ?? "openai-completions",
    baseURL: raw.baseURL ?? "",
    apiKeyEnv: raw.apiKeyEnv ?? "",
    models: Array.isArray(raw.models) ? raw.models : [],
    defaultModel: raw.defaultModel ?? "",
    displayName: raw.displayName,
    defaultContextWindow: raw.defaultContextWindow,
    defaultMaxTokens: raw.defaultMaxTokens,
  };
}

/** 所有带 dsh 路由的 provider（去重按 route）。 */
export function collectDshRoutes(config: Config): DshRouteConfig[] {
  const seen = new Set<string>();
  const routes: DshRouteConfig[] = [];
  for (const provider of config.providers) {
    if (!provider.enabled) continue;
    const dsh = dshOptionsOf(provider);
    if (!dsh || seen.has(dsh.route)) continue;
    seen.add(dsh.route);
    routes.push(dsh);
  }
  return routes;
}

/** 生成 dsh profile 的 patch 内容（静态路由层）。 */
export function renderProfilePatch(routes: DshRouteConfig[]): string {
  if (routes.length === 0) {
    return "# LCS 自动生成：当前没有带 dsh 路由的 provider。\n[]\n";
  }
  const lines: string[] = [
    "# LCS 自动生成（勿手改）：provider 的 dsh 路由声明；Key 不在这里，由调度器注入环境变量。",
    "- id: llm-pi-ai",
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    "  config:",
    "    providers:",
  ];
  for (const route of routes) {
    lines.push(`      ${route.route}:`);
    lines.push(`        displayName: ${yamlScalar(route.displayName ?? route.route)}`);
    lines.push(`        api: ${yamlScalar(route.api)}`);
    lines.push(`        baseURL: ${yamlScalar(route.baseURL)}`);
    lines.push(`        apiKeyEnv: ${yamlScalar(route.apiKeyEnv)}`);
    lines.push(`        defaultContextWindow: ${route.defaultContextWindow ?? 1048576}`);
    lines.push(`        defaultMaxTokens: ${route.defaultMaxTokens ?? 65536}`);
    lines.push("        models:");
    for (const model of route.models) {
      lines.push(`          - id: ${yamlScalar(model)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

/** 生成运行期 patch：只覆盖 agent-default-model。 */
export function renderRunPatch(route: string, model: string): string {
  return [
    "# LCS 自动生成（运行期）：只切换后端模型，不改路由定义。",
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    "  config:",
    `    provider: ${yamlScalar(route)}`,
    `    model: ${yamlScalar(model)}`,
    "",
  ].join("\n");
}

/** 确保 ~/.dsh/profiles/<profile> 存在且路由声明是最新的（幂等）。 */
export function ensureDshProfile(config: Config, profile: string): { dir: string; changed: boolean } {
  const home = process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
  const dir = path.join(home, "profiles", profile);
  fs.mkdirSync(dir, { recursive: true });

  const packageJson = {
    name: `dsh-profile-${profile}`,
    private: true,
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
  };
  const workspace = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
  const patch = renderProfilePatch(collectDshRoutes(config));

  let changed = false;
  const writeIfChanged = (file: string, content: string): void => {
    const target = path.join(dir, file);
    let current = "";
    try {
      current = fs.readFileSync(target, "utf8");
    } catch {
      current = "";
    }
    if (current === content) return;
    atomicWriteFileSync(target, content, 0o644);
    changed = true;
  };
  writeIfChanged("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  writeIfChanged("cordis.yml", "[]\n");
  writeIfChanged("pnpm-workspace.yaml", workspace);
  writeIfChanged("cordis.patch.yml", patch);
  return { dir, changed };
}

/** 运行期 patch 文件（按 route+model 缓存）。 */
export function ensureRunPatch(patchDir: string, route: string, model: string): string {
  fs.mkdirSync(patchDir, { recursive: true });
  const slug = `${route}--${model}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  const file = path.join(patchDir, `run-${slug}.yml`);
  const content = renderRunPatch(route, model);
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    current = "";
  }
  if (current !== content) atomicWriteFileSync(file, content, 0o600);
  return file;
}
