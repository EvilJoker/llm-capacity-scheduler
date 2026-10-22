/**
 * 守护进程地址解析（dsh 插件侧用）。
 *
 * 插件是**纯客户端**：不抢锁、不起调度器、不监听端口，只把工具调用转发给
 * 独立常驻的 LCS 守护进程（`lcs-mcp serve`，7×24）。
 *
 * 地址优先级：
 *   1. `LCS_URL` 环境变量（显式指定，最优先）
 *   2. `~/.lcs/config.json` 的 `engine.web.host/port`（守护进程自己写的配置）
 *   3. 默认 `http://127.0.0.1:7788`
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultConfigPath } from "../config.js";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7788";

export interface DaemonUrlOptions {
  env?: NodeJS.ProcessEnv;
  /** 读配置文件的实现（测试可注入）。 */
  readFile?: (file: string) => string;
}

/** 解析守护进程 base URL（不带尾斜杠）。 */
export function resolveDaemonUrl(options: DaemonUrlOptions = {}): string {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const explicit = env.LCS_URL?.trim();
  if (explicit) return stripTrailingSlash(explicit);

  const configPath = defaultConfigPath(env);
  try {
    const raw = JSON.parse(readFile(configPath)) as {
      engine?: { web?: { host?: string; port?: number } };
    };
    const web = raw.engine?.web ?? {};
    const host = !web.host || web.host === "0.0.0.0" ? "127.0.0.1" : web.host;
    const port = web.port ?? 7788;
    return `http://${host}:${port}`;
  } catch {
    return DEFAULT_DAEMON_URL;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
