/**
 * `lcs-mcp doctor`：安装/初始化自检。
 *
 * 回答一个问题：**「我装完了吗？还差什么？」**
 * 按依赖顺序逐项检查：dsh 执行器 → 配置 → 凭据 → 执行器 profile → 守护进程 → dsh 插件接线。
 *
 * 每项给 ok / warn / fail + 一条可执行的修复建议。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { defaultConfigPath, loadConfig, type Config } from "./config.js";
import { collectDshRoutes, dshOptionsOf } from "./dsh-profile.js";
import { resolveProviderKey } from "./provider-key.js";

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
}

export interface DoctorOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  /** 注入实现，便于测试。 */
  run?: (cmd: string, args: string[]) => string;
  fetchHealth?: (url: string) => Promise<boolean>;
  readFile?: (file: string) => string;
  exists?: (file: string) => boolean;
}

const PLUGIN_PACKAGE = "llm-capacity-scheduler-mcp";

function defaultRunner(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export async function runDoctor(options: DoctorOptions = {}): Promise<CheckResult[]> {
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const run = options.run ?? defaultRunner;
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));
  const checks: CheckResult[] = [];

  // ── 1. dsh 执行器 ────────────────────────────────────────────────
  const dshCmd = env.LCS_DSH_COMMAND?.trim() || "dsh";
  try {
    const version = run(dshCmd, ["--version"]).trim();
    checks.push({
      name: "dsh 执行器",
      level: "ok",
      detail: `${dshCmd} ${version}`,
    });
  } catch {
    checks.push({
      name: "dsh 执行器",
      level: "fail",
      detail: `找不到可执行的 ${dshCmd}`,
      hint: "安装 dsh（npm i -g @deepseek-ai/dsh），或用 LCS_DSH_COMMAND 指定路径。",
    });
  }

  // ── 2. 配置 ─────────────────────────────────────────────────────
  const configPath = options.configPath ?? defaultConfigPath(env);
  let config: Config | null = null;
  if (!exists(configPath)) {
    checks.push({
      name: "配置文件",
      level: "fail",
      detail: `不存在：${configPath}`,
      hint: "运行 `lcs-mcp init` 生成默认配置。",
    });
  } else {
    try {
      const loaded = loadConfig(configPath);
      config = loaded.config;
      const version = (JSON.parse(readFile(configPath)) as { version?: number }).version ?? 1;
      checks.push({
        name: "配置文件",
        level: version >= 2 ? "ok" : "warn",
        detail: `${configPath}（v${version}）`,
        hint: version >= 2 ? undefined : "配置还是 v1，下次启动会自动迁移到 v2。",
      });
    } catch (error) {
      checks.push({
        name: "配置文件",
        level: "fail",
        detail: `解析失败：${String(error)}`,
      });
    }
  }

  // ── 3. 凭据 ─────────────────────────────────────────────────────
  if (config) {
    const usable = config.providers.filter((p) => {
      if (!p.enabled) return false;
      return resolveProviderKey(p.options, env) !== null;
    });
    const enabled = config.providers.filter((p) => p.enabled);
    checks.push({
      name: "厂商凭据",
      level: usable.length > 0 ? "ok" : enabled.length > 0 ? "fail" : "warn",
      detail:
        enabled.length === 0
          ? "还没有启用任何厂商"
          : `${usable.length}/${enabled.length} 个厂商的 API Key 可用`,
      hint:
        enabled.length === 0
          ? "在 Web 控制台（http://127.0.0.1:7788）点「添加 LLM」，或手写 ~/.lcs/config.json。"
          : usable.length === 0
            ? "所有厂商都取不到 Key：检查 apiKey / apiKeyFile / 对应的 apiKeyEnv 环境变量。"
            : undefined,
    });
  }

  // ── 4. 执行器 profile（dsh 侧路由声明）────────────────────────────
  if (config) {
    const profile = config.runners.dsh.profile;
    const dshHome = config.engine.dshHome || path.join(home, ".dsh");
    const profileDir = path.join(dshHome, "profiles", profile);
    const routes = collectDshRoutes(config);
    let patch = "";
    try {
      patch = readFile(path.join(profileDir, "cordis.patch.yml"));
    } catch {
      patch = "";
    }
    const hasRoutes = routes.length > 0 && /providers:/.test(patch);
    checks.push({
      name: `执行器 profile（${profile}）`,
      level: hasRoutes ? "ok" : routes.length === 0 ? "warn" : "fail",
      detail: hasRoutes
        ? `${profileDir}（${routes.length} 条路由）`
        : `路由声明缺失：${profileDir}`,
      hint: hasRoutes
        ? undefined
        : routes.length === 0
          ? "没有带 dsh 路由的厂商：先在 Web 控制台添加厂商并选好模型。"
          : "启动一次 `lcs-mcp serve` 会自动补写执行器 profile 的路由声明。",
    });
  }

  // ── 4b. 执行器家目录隔离（2026-10-22 事故后新增）────────────────────
  if (config) {
    const sharedHome = path.join(home, ".dsh");
    const isolated = path.resolve(config.engine.dshHome) !== path.resolve(sharedHome);
    const sessionsDir = path.join(config.engine.dshHome, "sessions");
    checks.push({
      name: "执行器家目录隔离",
      level: isolated ? "ok" : "fail",
      detail: isolated
        ? `${config.engine.dshHome}（会话只落在这里）`
        : `${config.engine.dshHome} —— 与用户 dsh 家目录相同！`,
      hint: isolated
        ? undefined
        : "LCS 的 dshHome 不能是 ~/.dsh：共享家目录会让清理逻辑扫到用户自己的会话" +
          "（2026-10-22 真实事故）。改成独立目录，例如 ~/.lcs/dsh-home。",
    });
    checks.push({
      name: "执行器会话目录",
      level: "ok",
      detail: sessionsDir,
      hint: "LCS 产生的 dsh 会话只写这个目录；用户 ~/.dsh/sessions 不会被 GC 触碰。",
    });
  }

  // ── 5. 守护进程（7×24 常驻服务）──────────────────────────────────
  const daemonUrl = config
    ? `http://${config.engine.web.host === "0.0.0.0" ? "127.0.0.1" : config.engine.web.host}:${config.engine.web.port}`
    : "http://127.0.0.1:7788";
  const health = options.fetchHealth ?? defaultHealth;
  const alive = await health(daemonUrl);
  checks.push({
    name: "守护进程",
    level: alive ? "ok" : "warn",
    detail: alive ? `运行中：${daemonUrl}` : `没在跑：${daemonUrl}`,
    hint: alive
      ? undefined
      : "调度器要常驻才干活：`systemctl --user start lcs`（或直接 `lcs-mcp serve`）。",
  });

  // ── 6. dsh 插件接线 ─────────────────────────────────────────────
  const dshHome = env.DSH_HOME?.trim() || path.join(home, ".dsh");
  const profilesDir = path.join(dshHome, "profiles");
  const installed: string[] = [];
  try {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(profilesDir, entry.name, "package.json");
      try {
        const manifest = JSON.parse(readFile(manifestPath)) as {
          dependencies?: Record<string, string>;
          dsh?: { profile?: { bundles?: string[] } };
        };
        const bundles = manifest.dsh?.profile?.bundles ?? [];
        const dep = manifest.dependencies?.[PLUGIN_PACKAGE];
        if (dep || bundles.includes(PLUGIN_PACKAGE)) installed.push(entry.name);
      } catch {
        /* profile 没有 package.json，跳过 */
      }
    }
  } catch {
    /* 没有 profiles 目录 */
  }
  checks.push({
    name: "dsh 插件接线",
    level: installed.length > 0 ? "ok" : "warn",
    detail:
      installed.length > 0
        ? `已安装到 profile：${installed.join(", ")}`
        : "没有 profile 装 LCS 插件",
    hint:
      installed.length > 0
        ? undefined
        : `想让 dsh 里的 agent 直接用 lcs_* 工具：dsh plugin --profile web add ${PLUGIN_PACKAGE}`,
  });

  // ── 7. MCP 备选接线 ─────────────────────────────────────────────
  checks.push({
    name: "MCP 接线（备选）",
    level: "ok",
    detail: "dsh 里也可以不装插件，改用一条 MCP 配置：",
    hint:
      `- insert:\n` +
      `    - id: mcp-lcs\n` +
      `      name: '@deepseek-ai/dsh-mcp-client'\n` +
      `      config:\n` +
      `        serverName: lcs\n` +
      `        transport: stdio\n` +
      `        command: lcs-mcp\n` +
      `        args: []`,
  });

  return checks;
}

async function defaultHealth(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(`${url}/api/health`, { signal: controller.signal });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok !== false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 打印自检结果，返回是否存在 fail。 */
export function formatDoctor(checks: CheckResult[]): { text: string; failed: boolean } {
  const icon: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`${icon[check.level]} ${check.name}：${check.detail}`);
    if (check.hint) {
      for (const line of check.hint.split("\n")) lines.push(`    ${line}`);
    }
  }
  const failed = checks.some((c) => c.level === "fail");
  lines.push("");
  lines.push(failed ? "自检未通过：先修掉上面标 ✗ 的项。" : "自检通过。");
  return { text: lines.join("\n"), failed };
}
