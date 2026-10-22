/**
 * dsh profile / 运行期 patch 管理。
 *
 * - profile：LCS 自建 `<engine.dshHome>/profiles/lcs`（bundles: dsh-base + dsh-headless），
 *   其 patch 层静态声明所有 provider 的路由（api/baseURL/apiKeyEnv/models，**不含 Key**）；
 * - 运行期 patch：每次调用只覆盖 `agent-default-model`（provider + model），
 *   按 (route, model) 缓存到 patchDir，避免重复写盘。
 *
 * 关键约束：
 * 1. dsh 的 patch 是**整段替换**目标 row 的 config，所以路由必须在 profile 层，
 *    运行期 patch 绝不能去覆盖 `llm-pi-ai`，否则会抹掉其它路由。
 * 2. **家目录必须隔离**：`engine.dshHome` 是 LCS 执行器专用 DSH_HOME（默认
 *    `~/.lcs/dsh-home`），与用户自己的 `~/.dsh` 物理分开。会话因此不会出现在
 *    dsh web 侧边栏，清理时也不会碰到用户的会话（2026-10-22 事故后定）。
 *    只读资产（AGENTS.md / skills）以符号链接方式共享过去，保持任务上下文一致。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Config, ProviderConfig } from "./config.js";
import { atomicWriteFileSync, resolvePath } from "./util.js";

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

/**
 * 把用户主家目录里的只读资产链接到隔离家目录。
 *
 * 只链接文本资产（AGENTS.md、skills/），**不链接 sessions / storages / profiles**——
 * 那正是必须隔离的部分。链接失败不影响主流程。
 */
function linkSharedAssets(isolatedHome: string): void {
  const sharedHome = path.join(os.homedir(), ".dsh");
  if (path.resolve(isolatedHome) === path.resolve(sharedHome)) return;
  for (const name of ["AGENTS.md", "skills"]) {
    const source = path.join(sharedHome, name);
    const target = path.join(isolatedHome, name);
    if (!fs.existsSync(source)) continue;
    try {
      if (fs.existsSync(target) || fs.lstatSync(target)) continue;
    } catch {
      /* 不存在，继续 */
    }
    try {
      fs.symlinkSync(source, target, name.endsWith(".md") ? "file" : "dir");
    } catch {
      /* 链接不了就算了：任务少一份全局说明而已 */
    }
  }
}

/** 确保 <dshHome>/profiles/<profile> 存在且路由声明是最新的（幂等）。 */
export function ensureDshProfile(config: Config, profile: string): { dir: string; changed: boolean } {
  const rawHome = config.engine.dshHome?.trim() || path.join(os.homedir(), ".lcs", "dsh-home");
  // 展开 ~：配置里可能写的是 `~/.lcs/dsh-home`，不能把字面量 `~` 当目录名用
  const home = resolvePath(rawHome, process.cwd());
  const dir = path.join(home, "profiles", profile);
  fs.mkdirSync(dir, { recursive: true });
  linkSharedAssets(home);

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
