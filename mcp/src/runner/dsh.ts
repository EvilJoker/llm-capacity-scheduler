/**
 * dsh headless runner：把任务交给 `dsh --profile headless --json "<task>"`。
 *
 * checkpoint = dsh 的 `--session-id`：中断/失败后下次重跑可以续上同一个 session，
 * 这是「没完成就放回队列」最省额度的实现方式。
 *
 * 路由注入：Assignment 里的 provider/model 通过环境变量传下去；
 * 若配置了 `runners.dsh.profiles`，则把 provider 映射成对应的 dsh profile。
 */

import fs from "node:fs";
import path from "node:path";

import type { DshRunnerConfig } from "../config.js";
import type { Assignment, Run, Task } from "../types.js";
import { resolvePath } from "../util.js";
import { CHECKPOINT_FILE } from "./exec.js";
import type { SpawnRunnerOptions } from "./spawn-runner.js";
import { SpawnRunner } from "./spawn-runner.js";

export interface DshRunnerOptions extends SpawnRunnerOptions {
  dsh: DshRunnerConfig;
}

export class DshRunner extends SpawnRunner {
  readonly name = "dsh" as const;

  constructor(private readonly dshOptions: DshRunnerOptions) {
    super(dshOptions);
  }

  private get dsh(): DshRunnerConfig {
    return this.dshOptions.dsh;
  }

  protected buildCommand(task: Task, assignment: Assignment, run: Run) {
    const prompt = (task.spec.prompt ?? task.spec.cmd?.join(" ") ?? "").trim();
    if (!prompt) throw new Error("dsh runner 需要 task.spec.prompt（或 cmd 作为任务文本）");
    const profile = this.dsh.profiles[assignment.provider] ?? this.dsh.profile;
    const args: string[] = ["--profile", profile, "--json"];
    if (task.checkpoint?.sessionId) {
      args.push("--session-id", task.checkpoint.sessionId);
      args.push(`${prompt}\n\n继续把上次未完成的部分做完。`);
    } else {
      args.push(prompt);
    }
    const cwd = task.spec.cwd ? resolvePath(task.spec.cwd, this.options.baseDir) : this.options.baseDir;
    return {
      command: this.dsh.command,
      args,
      cwd,
      env: {
        ...process.env,
        ...task.spec.env,
        ...assignment.route,
        DSH_PROFILE: profile,
        LCS_ARTIFACT_DIR: run.runDir,
      },
    };
  }

  protected override async afterComplete(task: Task, run: Run): Promise<void> {
    if (task.checkpoint?.sessionId) return;
    const sessionId = extractSessionId(path.join(run.runDir, "stdout.log"));
    if (!sessionId) return;
    const file = path.join(run.runDir, CHECKPOINT_FILE);
    if (fs.existsSync(file)) return;
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ sessionId, updatedAt: Date.now() }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      /* checkpoint 写不进去不影响主流程 */
    }
  }
}

/** 从 dsh --json 的事件流里抓 session id（形如 session-<uuid>）。 */
export function extractSessionId(stdoutFile: string): string | undefined {
  let text: string;
  try {
    const stat = fs.statSync(stdoutFile);
    const fd = fs.openSync(stdoutFile, "r");
    const length = Math.min(stat.size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    fs.closeSync(fd);
    text = buffer.toString("utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const id = findSessionId(parsed);
      if (id) return id;
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return undefined;
}

function findSessionId(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null) return undefined;
  if (typeof value === "string") {
    return /^session[-_][\w-]{6,}$/.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (/session_?id$/i.test(key) && typeof child === "string" && child.length > 6) {
        return child;
      }
      const found = findSessionId(child, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}
