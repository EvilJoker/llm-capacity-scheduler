#!/usr/bin/env node
/** CLI 入口：init / mcp（默认，stdio MCP + 调度器 + Web）/ serve（无 MCP 的常驻守护）。 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

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
  command: Command;
  dryRun: boolean;
  config?: string;
  web: boolean;
  mcp: boolean;
  scheduler: boolean;
  force: boolean;
  follow: boolean;
  tail: number;
}

const COMMANDS = [
  "mcp",
  "serve",
  "init",
  "doctor",
  "gc",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
] as const;

type Command = (typeof COMMANDS)[number];

/** 一次性命令：不启动调度器 / Web / MCP。 */
const ONE_SHOT: ReadonlySet<Command> = new Set([
  "init",
  "doctor",
  "gc",
  "start",
  "stop",
  "restart",
  "status",
  "logs",
] as const);

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
      "dry-run": { type: "boolean" },
      follow: { type: "boolean", short: "f" },
      tail: { type: "string" },
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
  const command = (positionals[0] ?? "mcp") as Command;
  if (!COMMANDS.includes(command)) {
    console.error(`未知命令: ${command}`);
    printHelp();
    process.exit(2);
  }
  if (values.port) process.env.LCS_PORT = values.port;
  const isOneShot = ONE_SHOT.has(command);
  const tail = Number(values.tail ?? "100");
  return {
    command,
    dryRun: Boolean(values["dry-run"]),
    config: values.config,
    web: !values["no-web"] && !isOneShot,
    mcp: !values["no-mcp"] && command === "mcp",
    scheduler: !values["no-scheduler"] && !isOneShot,
    force: Boolean(values.force),
    follow: Boolean(values.follow),
    tail: Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 100,
  };
}

function printHelp(): void {
  console.log(`lcs-mcp ${VERSION} — 容量感知异步任务调度器（MCP Server + Web 控制台）

用法:
  lcs-mcp [--config <path>]            启动：MCP stdio + 调度器 + Web（agent 接入用）
  lcs-mcp serve [--config <path>]      前台常驻：调度器 + Web（服务管理器包这层）
  lcs-mcp start [--config <path>]      后台启动常驻服务（写 pid/日志，等健康检查通过才返回）
  lcs-mcp stop                         停止后台服务（SIGTERM，10s 不退再 SIGKILL）
  lcs-mcp restart                      = stop + start
  lcs-mcp status                       看是否在跑（在跑则打印 pid / 地址 / 调度器状态）
  lcs-mcp logs [-f] [--tail <n>]       看后台日志（默认最后 100 行，-f 跟随）
  lcs-mcp init [--config <path>]       生成默认配置文件（不预置厂商）
  lcs-mcp doctor [--config <path>]     安装自检：还差什么（dsh/配置/凭据/守护进程/插件接线）
  lcs-mcp gc [--dry-run]               清理审计：预览/执行一次 GC（只碰 LCS 自己的会话与产物）

选项:
  -c, --config <path>   配置文件路径（默认 ~/.lcs/config.json，或 $LCS_CONFIG）
      --port <n>        覆盖 Web 端口（默认 7788）
      --no-web          不启动 Web 控制台
      --no-mcp          不启动 MCP stdio
      --no-scheduler    不启动自动 tick（只保留手动 tick）
      --force           忽略单实例锁
      --tail <n>        logs：显示最后 n 行（默认 100）
  -f, --follow          logs：持续跟随输出
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
  /**
   * 本次运行实际使用的 Web 地址。
   * 必须是**运行时真相**：`--port` / `LCS_PORT` 只在启动进程的环境里生效，
   * 换个 shell 跑 `status` 读 config 会读到 7788 而误判「Web 没响应」。
   */
  webUrl?: string;
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

function acquireLock(stateFile: string, force: boolean, webUrl?: string): () => void {
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
  const info: LockInfo = { pid: process.pid, startedAt: Date.now(), configFile: "", webUrl };
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

// ---------------------------------------------------------------- 后台服务生命周期
//
// 产品形态是「7×24 常驻的调度服务」：用户装完只需要 `lcs-mcp start`，不该自己写 nohup。
// 这里不引入 systemd（各人机器上怎么托管由用户决定），只做三件事：
//   start  后台拉起 `serve`，日志落盘，等健康检查通过再返回（失败就把日志尾巴打出来）
//   stop   SIGTERM → 最多等 10s → SIGKILL
//   status 读单实例锁 + 探 /api/health，回答「在跑吗、pid 多少、调度器状态」

function logFileFor(stateFile: string): string {
  return path.join(path.dirname(stateFile), "logs", "lcs.log");
}

/** 单实例锁（`${stateFile}.lock`）是「谁在跑」的唯一真相源。 */
function lockFileFor(stateFile: string): string {
  return `${stateFile}.lock`;
}

/** 下次 `npm i -g` 换版本后，旧路径可能失效，所以按当前模块位置推导 bin。 */
function cliEntryPath(): string {
  return fileURLToPath(new URL("../bin/lcs-mcp.js", import.meta.url));
}

/** 日志超过 5MB 时滚动一份 .1（不做完整轮转：一天一个文件对排查已经够用）。 */
function rotateLog(logFile: string, maxBytes = 5 * 1024 * 1024): void {
  try {
    if (fs.statSync(logFile).size < maxBytes) return;
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* 文件不存在或没有权限：忽略 */
  }
}

function tailLines(file: string, n: number, maxBytes = 512 * 1024): string[] {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } finally {
    fs.closeSync(fd);
  }
}

async function probeHealth(url: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function loadForDaemon(configPath: string): { config: Config; configPath: string } | null {
  const loaded = loadConfig(configPath);
  if (!loaded.exists) {
    console.error(`配置不存在: ${loaded.path}`);
    console.error("先跑 `lcs-mcp init`，然后 `lcs-mcp start`。");
    process.exitCode = 1;
    return null;
  }
  return { config: loaded.config, configPath: loaded.path };
}

/** `lcs-mcp start`：后台拉起常驻服务，等健康检查通过再返回。 */
async function startDaemon(configPath: string, force: boolean): Promise<void> {
  const loaded = loadForDaemon(configPath);
  if (!loaded) return;
  const { config } = loaded;
  const stateFile = config.engine.stateFile;
  const holder = lockHolder(stateFile);
  const url = holder?.webUrl ?? webUrl(config);

  if (holder && !force) {
    const alive = await probeHealth(url);
    console.log(
      `已在运行：pid=${holder.pid} ${alive ? url : `${url}（Web 无响应，可能卡住了）`}`,
    );
    console.log("要重启用 `lcs-mcp restart`，停掉用 `lcs-mcp stop`。");
    return;
  }
  if (holder && force) {
    console.log(`--force：先停掉已在运行的 pid=${holder.pid}`);
    await stopDaemon(configPath, { quiet: true });
  }

  const logFile = logFileFor(stateFile);
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  rotateLog(logFile);
  const fd = fs.openSync(logFile, "a", 0o600);
  const args = [cliEntryPath(), "serve", "--config", loaded.configPath];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env },
    cwd: process.cwd(),
  });
  child.unref();
  fs.closeSync(fd);

  // 等健康检查（Web 关掉时只能看进程是否还活着 + 锁是否写好）
  const webEnabled = config.engine.web.enabled;
  const deadline = Date.now() + 15000;
  let ready = false;
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) break;
    if (webEnabled) {
      if (await probeHealth(url)) {
        ready = true;
        break;
      }
    } else if (lockHolder(stateFile)) {
      ready = true;
      break;
    }
    await sleep(200);
  }

  if (!ready) {
    console.error(`启动失败：${exited ? "进程已退出" : "15 秒内没就绪"}`);
    const tail = tailLines(logFile, 30);
    if (tail.length > 0) {
      console.error(`--- ${logFile} 最后 ${tail.length} 行 ---`);
      console.error(tail.join("\n"));
    }
    console.error("排查：`lcs-mcp doctor`，或用 `lcs-mcp serve` 前台启动看完整输出。");
    process.exitCode = 1;
    return;
  }

  const info = lockHolder(stateFile);
  console.log(`已启动：pid=${info?.pid ?? child.pid} ${webEnabled ? url : "(Web 已关闭)"}`);
  if (!webEnabled) console.log("提示：`engine.web.enabled=false`，没有 Web 控制台，只能用 MCP 接入。");
  console.log(`日志：${logFile}（\`lcs-mcp logs -f\` 跟随）`);
  console.log("停止：`lcs-mcp stop`；自检：`lcs-mcp doctor`。");
}

/** `lcs-mcp stop`：SIGTERM，最多等 10s，不退再 SIGKILL。 */
async function stopDaemon(
  configPath: string,
  options: { quiet?: boolean } = {},
): Promise<boolean> {
  const loaded = loadForDaemon(configPath);
  if (!loaded) return false;
  const stateFile = loaded.config.engine.stateFile;
  const holder = lockHolder(stateFile);
  if (!holder) {
    // 清掉过期锁，避免下次 start 误判
    fs.rmSync(lockFileFor(stateFile), { force: true });
    if (!options.quiet) console.log("没在运行。");
    return false;
  }
  try {
    process.kill(holder.pid, "SIGTERM");
  } catch (error) {
    if (!options.quiet) console.error(`发信号失败：${String(error)}`);
    return false;
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && isAlive(holder.pid)) await sleep(100);
  if (isAlive(holder.pid)) {
    if (!options.quiet) console.log("10 秒未退出，发送 SIGKILL。");
    try {
      process.kill(holder.pid, "SIGKILL");
    } catch {
      /* 已经没了 */
    }
    await sleep(300);
  }
  fs.rmSync(lockFileFor(stateFile), { force: true });
  if (!options.quiet) console.log(`已停止 pid=${holder.pid}。`);
  return true;
}

/** `lcs-mcp status`：在跑吗、pid、地址、调度器状态。 */
async function statusDaemon(configPath: string): Promise<void> {
  const loaded = loadForDaemon(configPath);
  if (!loaded) return;
  const { config } = loaded;
  const stateFile = config.engine.stateFile;
  const holder = lockHolder(stateFile);
  // 以锁定记录的实际地址为准（`--port` 覆盖不会写进配置文件）
  const url = holder?.webUrl ?? webUrl(config);
  if (!holder) {
    console.log(`没在运行（state=${stateFile}）`);
    console.log("启动：`lcs-mcp start`；后台日志：`lcs-mcp logs`。");
    process.exitCode = 1;
    return;
  }
  const alive = await probeHealth(url);
  const startedAt = new Date(holder.startedAt).toLocaleString("zh-CN", { hour12: false });
  console.log(`运行中：pid=${holder.pid} 启动于 ${startedAt}`);
  console.log(`  Web      ${alive ? url : `${url}（无响应）`}`);
  console.log(`  dshHome  ${config.engine.dshHome}`);
  console.log(`  日志     ${logFileFor(stateFile)}`);
  if (!alive) {
    console.log("Web 没响应，但进程还活着：看 `lcs-mcp logs` 确认是否卡住，必要时 `lcs-mcp stop`。");
    process.exitCode = 1;
    return;
  }
  try {
    const resp = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(3000) });
    const snap = (await resp.json()) as {
      scheduler?: { started?: boolean; paused?: boolean; tickCount?: number; tickSeconds?: number };
      tasks?: Record<string, number>;
      gc?: { refused?: string | null };
    };
    const sched = snap.scheduler ?? {};
    console.log(
      `  调度器   ${sched.started ? "运行中" : "未启动"}` +
        `${sched.paused ? "（已暂停）" : ""} · tick ${sched.tickCount ?? 0} 次 / 每 ${sched.tickSeconds ?? "?"}s`,
    );
    const tasks = snap.tasks ?? {};
    const busy = Object.entries(tasks)
      .filter(([, n]) => n > 0)
      .map(([state, n]) => `${state}=${n}`)
      .join(" ");
    console.log(`  任务     ${busy || "无"}`);
    if (snap.gc?.refused) console.log(`  ⚠ 清理已停用：${snap.gc.refused}`);
  } catch (error) {
    console.log(`  状态读取失败：${String(error)}`);
  }
}

/** `lcs-mcp logs`：看后台日志（-f 跟随，由 tail 负责）。 */
async function logsCommand(configPath: string, tail: number, follow: boolean): Promise<void> {
  const loaded = loadForDaemon(configPath);
  if (!loaded) return;
  const logFile = logFileFor(loaded.config.engine.stateFile);
  if (!fs.existsSync(logFile)) {
    console.log(`还没有日志文件：${logFile}`);
    console.log("服务至少启动过一次才会有日志（`lcs-mcp start`）。");
    return;
  }
  if (follow) {
    const child = spawn("tail", ["-n", String(tail), "-f", logFile], { stdio: "inherit" });
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    return;
  }
  const lines = tailLines(logFile, tail);
  process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

/**
 * `lcs-mcp gc [--dry-run]`：清理审计。
 *
 * - 守护进程在跑 → 转给它执行（避免两个进程同时写 state）；
 * - 没在跑 → 本地开着 store 直接跑一次（一次性，不启动调度器）。
 *
 * 无论哪种方式，GC 都只处理 LCS 自己登记过的会话与产物，路径限定在 engine.dshHome 内。
 */
async function runGcCommand(configPath: string, dryRun: boolean): Promise<void> {
  const loaded = loadConfig(configPath);
  if (!loaded.exists) {
    console.error(`配置不存在: ${loaded.path}（先跑 \`lcs-mcp init\`）`);
    process.exitCode = 1;
    return;
  }
  const config = finalizeConfig(loaded.config, loaded.path, loaded.baseDir);

  const holder = lockHolder(config.engine.stateFile);
  if (holder) {
    // 用锁里记录的实际地址：`--port` 覆盖不会写进配置文件
    const url = holder.webUrl ?? webUrl(config);
    try {
      const resp = await fetch(`${url}/api/gc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = (await resp.json()) as {
        dryRun: boolean;
        removedSessions: number;
        removedProjections: number;
        removedArtifacts: number;
        foreignSessions: number;
        refused?: string;
        details: Array<{ taskId: string; sessionId: string | null }>;
      };
      printGcResult(result, `守护进程 pid=${holder.pid} @ ${url}`);
      return;
    } catch (error) {
      console.error(`守护进程在跑但 GC 调用失败（${url}）：${String(error)}`);
      process.exitCode = 1;
      return;
    }
  }

  const store = Store.open(config.engine.stateFile);
  const engine = new Engine({ config, baseDir: loaded.baseDir, store });
  const result = engine.runGc({ dryRun });
  printGcResult(result, `本地（无守护进程）· dshHome=${config.engine.dshHome}`);
}

function printGcResult(
  result: {
    dryRun: boolean;
    removedSessions: number;
    removedProjections: number;
    removedArtifacts: number;
    foreignSessions: number;
    refused?: string;
    details: Array<{ taskId: string; sessionId: string | null }>;
  },
  where: string,
): void {
  if (result.refused) {
    console.error(`清理被安全校验拒绝 —— ${where}`);
    console.error(`  ${result.refused}`);
    console.error("  没有删除任何东西。修好 engine.dshHome 后重试。");
    process.exitCode = 1;
    return;
  }
  const head = result.dryRun ? "清理预览（未删除任何东西）" : "清理完成";
  console.log(`${head} —— ${where}`);
  if (result.details.length === 0) {
    console.log("  没有到期可清理的对象。");
  } else {
    for (const detail of result.details) {
      console.log(
        `  ${result.dryRun ? "[将删]" : "[已删]"} task=${detail.taskId}` +
          (detail.sessionId ? ` session=${detail.sessionId}` : ""),
      );
    }
  }
  console.log(
    `  会话 ${result.removedSessions} · 投影 ${result.removedProjections} · 产物 ${result.removedArtifacts}`,
  );
  console.log(
    `  隔离家目录内陌生会话 ${result.foreignSessions} 个：不在清理范围（只统计，不删）`,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseCli(argv);
  const configPath = options.config
    ? path.resolve(options.config)
    : defaultConfigPath();

  if (options.command === "gc") {
    await runGcCommand(configPath, options.dryRun);
    return;
  }

  if (options.command === "start") {
    await startDaemon(configPath, options.force);
    return;
  }
  if (options.command === "stop") {
    await stopDaemon(configPath);
    return;
  }
  if (options.command === "restart") {
    await stopDaemon(configPath, { quiet: true });
    await sleep(300);
    await startDaemon(configPath, true);
    return;
  }
  if (options.command === "status") {
    await statusDaemon(configPath);
    return;
  }
  if (options.command === "logs") {
    await logsCommand(configPath, options.tail, options.follow);
    return;
  }

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
    const config = exampleConfig();
    saveConfig(config, configPath);
    const url = webUrl(finalizeConfig(config, configPath, path.dirname(configPath)));
    log(`已生成 ${configPath}`);
    console.log(`
下一步（3 步就能跑起来）:
  1. 启动常驻服务   lcs-mcp start
  2. 打开控制台     ${url}
  3. 添加厂商       「添加 LLM」→ 选厂商 → 填 API Key → 保存，然后到「容量」页刷新
    （不预置厂商：没有 Key 的厂商在自检里只会变成一条失败项）

随时自检: lcs-mcp doctor      后台日志: lcs-mcp logs -f      停止: lcs-mcp stop
`);
    return;
  }

  let loaded = loadConfig(configPath);
  if (!loaded.exists) {
    // 首次直接 `serve`：同样生成「零厂商」的初始配置，与 `init` 保持一致
    saveConfig(exampleConfig(), loaded.path);
    log(`未找到配置，已生成初始配置: ${loaded.path}`);
    loaded = loadConfig(loaded.path);
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

  const releaseLock = acquireLock(config.engine.stateFile, options.force, webUrl(config));
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
