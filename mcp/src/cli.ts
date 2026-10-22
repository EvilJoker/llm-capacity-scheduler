#!/usr/bin/env node
/** CLI 入口：init / mcp（默认，stdio MCP + 调度器 + Web）/ serve（无 MCP 的常驻守护）。 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  defaultConfigPath,
  exampleConfig,
  finalizeConfig,
  loadConfig,
  mergeSecrets,
  saveConfig,
  validateConfig,
  type Config,
} from "./config.js";
import { Engine } from "./engine.js";
import { HttpBackend, LocalBackend } from "./backend.js";
import { createMcpServer, serveMcpStdio, VERSION } from "./mcp.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { ensureDshProfile } from "./dsh-profile.js";
import { addProvider, removeProvider, type AddProviderInput } from "./provider-presets.js";
import { Store } from "./store.js";
import { deepMerge, log, logError } from "./util.js";
import { startWebServer, type RunningWebServer, type WebDeps } from "./web/server.js";

interface CliOptions {
  command: "mcp" | "serve" | "init" | "doctor";
  config?: string;
  web: boolean;
  mcp: boolean;
  scheduler: boolean;
  force: boolean;
}

function parseCli(argv: string[]): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      "no-web": { type: "boolean" },
      "no-mcp": { type: "boolean" },
      "no-scheduler": { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      port: { type: "string" },
    },
  });
  if (values.help) {
    printHelp();
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }
  const command = (positionals[0] ?? "mcp") as CliOptions["command"];
  if (!["mcp", "serve", "init", "doctor"].includes(command)) {
    console.error(`未知命令: ${command}`);
    printHelp();
    process.exit(2);
  }
  if (values.port) process.env.LCS_PORT = values.port;
  const isOneShot = command === "init" || command === "doctor";
  return {
    command,
    config: values.config,
    web: !values["no-web"] && !isOneShot,
    mcp: !values["no-mcp"] && command === "mcp",
    scheduler: !values["no-scheduler"] && !isOneShot,
    force: Boolean(values.force),
  };
}

function printHelp(): void {
  console.log(`lcs-mcp ${VERSION} — 容量感知异步任务调度器（MCP Server + Web 控制台）

用法:
  lcs-mcp [--config <path>]            启动：MCP stdio + 调度器 + Web（agent 接入用）
  lcs-mcp serve [--config <path>]      常驻守护：调度器 + Web（不接 MCP 客户端）
  lcs-mcp init [--config <path>]       生成默认配置文件
  lcs-mcp doctor [--config <path>]     安装自检：还差什么（dsh/配置/凭据/守护进程/插件接线）

选项:
  -c, --config <path>   配置文件路径（默认 ~/.lcs/config.json，或 $LCS_CONFIG）
      --port <n>        覆盖 Web 端口（默认 7788）
      --no-web          不启动 Web 控制台
      --no-mcp          不启动 MCP stdio
      --no-scheduler    不启动自动 tick（只保留手动 tick）
      --force           忽略单实例锁
  -h, --help            显示帮助
  -v, --version         显示版本

环境变量:
  LCS_CONFIG, LCS_STATE, LCS_ARTIFACTS, LCS_PORT, LCS_TICK_SECONDS, LCS_NO_WEB
`);
}

function webUrl(config: Config): string {
  const host = config.engine.web.host === "0.0.0.0" ? "127.0.0.1" : config.engine.web.host;
  return `http://${host}:${config.engine.web.port}`;
}

interface LockInfo {
  pid: number;
  startedAt: number;
  configFile: string;
}

function lockHolder(stateFile: string): LockInfo | null {
  const lockFile = `${stateFile}.lock`;
  try {
    const info = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockInfo;
    if (info.pid && isAlive(info.pid)) return info;
  } catch {
    /* 没有锁或坏锁 */
  }
  return null;
}

function acquireLock(stateFile: string, force: boolean): () => void {
  const lockFile = `${stateFile}.lock`;
  if (!force) {
    const holder = lockHolder(stateFile);
    if (holder) {
      throw new Error(
        `已有实例在运行 (pid=${holder.pid})，state=${stateFile}。加 --force 可强制启动。`,
      );
    }
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const info: LockInfo = { pid: process.pid, startedAt: Date.now(), configFile: "" };
  fs.writeFileSync(lockFile, JSON.stringify(info), { encoding: "utf8", mode: 0o600 });
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockFile, "utf8")) as LockInfo;
      if (current.pid === process.pid) fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  const configPath = options.config
    ? path.resolve(options.config)
    : defaultConfigPath();

  if (options.command === "doctor") {
    const checks = await runDoctor({ configPath });
    const report = formatDoctor(checks);
    process.stdout.write(`${report.text}\n`);
    if (report.failed) process.exitCode = 1;
    return;
  }

  if (options.command === "init") {
    if (fs.existsSync(configPath) && !options.force) {
      console.error(`配置已存在: ${configPath}（--force 覆盖）`);
      process.exitCode = 1;
      return;
    }
    saveConfig(exampleConfig(), configPath);
    log(`已生成 ${configPath}`);
    log("下一步：填好 provider 的 API Key（或 apiKeyFile / 环境变量），然后运行 `lcs-mcp serve`");
    return;
  }

  let loaded = loadConfig(configPath);
  if (!loaded.exists) {
    saveConfig(loaded.config, loaded.path);
    log(`未找到配置，已生成默认配置: ${loaded.path}`);
  }
  let config: Config = loaded.config;
  const baseDir = loaded.baseDir;

  // 迁移落盘：配置文件是 v1 时，启动即升级为 v2（否则每次都要迁移一遍）
  try {
    const raw = JSON.parse(fs.readFileSync(loaded.path, "utf8")) as Record<string, unknown>;
    if (Number(raw.version ?? 1) < 2) {
      saveConfig(config, loaded.path);
      log(`配置已迁移到 v2（dsh-only / 串行）：${loaded.path}`);
    }
  } catch {
    /* 读不到就跳过（下次保存时自然会写新格式） */
  }

  // 已有守护进程在跑：MCP 模式自动降级为 HTTP 代理（Web 常开 + agent 接入共存）
  const holder = lockHolder(config.engine.stateFile);
  if (holder && options.mcp && !options.force) {
    const url = webUrl(config);
    try {
      const health = (await (await fetch(`${url}/api/health`)).json()) as { ok?: boolean };
      if (!health.ok) throw new Error("health not ok");
      log(`检测到守护进程 pid=${holder.pid}，MCP 以代理模式接入 ${url}`);
      const server = createMcpServer({
        backend: new HttpBackend(url),
        serverName: config.mcp.serverName,
      });
      await serveMcpStdio(server);
      log("MCP stdio ready (proxy)");
      await new Promise<void>(() => {
        process.stdin.on("end", () => process.exit(0));
        process.stdin.on("close", () => process.exit(0));
      });
      return;
    } catch (error) {
      logError(`守护进程在运行但 Web API 不可用（${url}）：${String(error)}`);
      process.exitCode = 1;
      return;
    }
  }
  if (holder && !options.force) {
    logError(`已有实例在运行 (pid=${holder.pid})，state=${config.engine.stateFile}。加 --force 可强制启动。`);
    process.exitCode = 1;
    return;
  }

  // 自举 dsh profile：LCS 自建 ~/.dsh/profiles/<profile>，静态声明各 provider 的路由
  try {
    const profile = ensureDshProfile(config, config.runners.dsh.profile);
    log(`dsh profile: ${profile.dir}${profile.changed ? "（已更新路由声明）" : ""}`);
  } catch (error) {
    logError("dsh profile 自举失败（执行任务会失败）", error);
  }

  const releaseLock = acquireLock(config.engine.stateFile, options.force);
  const store = Store.open(config.engine.stateFile);
  const engine = new Engine({ config, baseDir, store });

  let web: RunningWebServer | null = null;
  const shutdown = async (signal: string): Promise<void> => {
    log(`收到 ${signal}，正在退出…`);
    engine.stop();
    if (web) await web.close();
    releaseLock();
    store.persist();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const applyConfig = async (incoming: Config): Promise<Config> => {
    const merged = deepMerge(config, mergeSecrets(incoming, config)) as Config;
    const next = finalizeConfig(merged, loaded.path, baseDir);
    validateConfig(next);
    saveConfig(next, loaded.path);
    config = next;
    engine.reload(next, baseDir);
    try {
      ensureDshProfile(config, config.runners.dsh.profile);
    } catch (error) {
      logError("dsh profile 更新失败", error);
    }
    log("配置已保存并热加载");
    return next;
  };

  // Web「添加 LLM」：按厂商预设追加 provider + model，保存后热加载并立刻观测一次，
  // 这样切换「容量」页时新桶已经在 lastBuckets 里，无需等下一个 tick。
  const addProviderFromWeb: WebDeps["addProvider"] = async (input: AddProviderInput) => {
    const { config: next, provider } = addProvider(config, input);
    const finalized = finalizeConfig(next, loaded.path, baseDir);
    validateConfig(finalized);
    saveConfig(finalized, loaded.path);
    config = finalized;
    engine.reload(finalized, baseDir);
    try {
      ensureDshProfile(finalized, finalized.runners.dsh.profile);
    } catch (error) {
      logError("dsh profile 更新失败", error);
    }
    const buckets = await engine.observeNow();
    const mine = buckets.filter((bucket) => bucket.provider === provider.name);
    log(`已添加 provider ${provider.name}（已观测 ${mine.length} 个桶）`);
    return {
      config,
      provider: provider.name,
      buckets: mine.map((bucket) => ({
        provider: bucket.provider,
        modelFamily: bucket.modelFamily,
        resourceKind: bucket.resourceKind,
        remaining: bucket.remaining,
        unit: bucket.unit,
        source: bucket.source,
        lifecycle: bucket.window.lifecycle,
      })),
    };
  };

  // Web「删除 LLM」：移除 provider 及其 models 条目，保存后热加载并重新观测，
  // 让容量页立刻不再显示该 provider 的桶。
  const deleteProviderFromWeb: WebDeps["deleteProvider"] = async (name: string) => {
    const running = engine.store.runningRuns().filter((run) => run.provider === name);
    if (running.length > 0) {
      throw new Error(`该 provider 还有 ${running.length} 个在飞任务，请先等待结束或取消后再删除`);
    }
    const { config: next, provider } = removeProvider(config, name);
    const finalized = finalizeConfig(next, loaded.path, baseDir);
    validateConfig(finalized);
    saveConfig(finalized, loaded.path);
    config = finalized;
    engine.reload(finalized, baseDir);
    await engine.observeNow();
    log(`已删除 provider ${provider.name}`);
    return { config, provider: provider.name };
  };

  if (options.scheduler) engine.start();

  if (options.web && config.engine.web.enabled) {
    try {
      web = await startWebServer({
        engine,
        getConfig: () => config,
        applyConfig,
        addProvider: addProviderFromWeb,
        deleteProvider: deleteProviderFromWeb,
        version: VERSION,
      });
    } catch (error) {
      logError("Web 启动失败（MCP/调度器继续运行）", error);
    }
  }

  if (options.mcp) {
    const server = createMcpServer({
      backend: new LocalBackend(engine, () => config),
      serverName: config.mcp.serverName,
    });
    await serveMcpStdio(server);
    log("MCP stdio ready");
    process.stdin.on("end", () => void shutdown("stdin end"));
    process.stdin.on("close", () => void shutdown("stdin close"));
  } else {
    log(`运行中：scheduler=${options.scheduler ? "on" : "off"} web=${web ? web.url : "off"}（Ctrl-C 退出）`);
    // 保持进程存活（不能 unref：没有 Web/MCP 时 event loop 不能提前退出）
    setInterval(() => {}, 1 << 30);
  }
}

export { VERSION };
