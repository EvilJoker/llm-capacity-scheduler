/**
 * dsh headless runner：LCS 唯一的执行器。
 *
 * 调用契约（实测，dsh 0.2.0-rc.2）：
 *   dsh --profile <profile> --patch <run.patch.yml> --json [--session-id <id>] "<task>"
 *
 * - stdout 是 NDJSON 事件流；stderr 是 `dsh:` 诊断行；
 * - `--session-id` 只能接管已存在的 session（未知 id 直接失败）；
 * - 接管要求 cwd 一致 → 每个 task 使用固定工作目录（task.workDir）；
 * - patch 只覆盖 agent-default-model（provider + model），路由定义在 profile 层；
 * - Key 由调度器按 provider 注入环境变量（apiKeyEnv），保证烧的账号 = 记账的账号。
 */

import fs from "node:fs";
import path from "node:path";

import type { DshRunnerConfig } from "../config.js";
import { ensureRunPatch } from "../dsh-profile.js";
import type { Assignment, Run, Task } from "../types.js";
import { resolvePath } from "../util.js";
import { CHECKPOINT_FILE } from "./exec.js";
import { parseDshEvents } from "./events.js";
import type { SpawnRunnerOptions } from "./spawn-runner.js";
import { SpawnRunner } from "./spawn-runner.js";

export interface DshRouteLike {
  route: string;
  apiKeyEnv: string;
  defaultModel: string;
  models: string[];
}

/** dsh 的答案默认落盘为该文件（任务可用 expect_artifacts 声明它）。 */
export const FINAL_ARTIFACT = "final.md";

export interface DshRunnerOptions extends SpawnRunnerOptions {
  dsh: DshRunnerConfig;
  /** 执行器专用 DSH_HOME：会话落在这里，与用户自己的 ~/.dsh 隔离 */
  dshHome: string;
  /** provider 名 → dsh 路由 */
  routes: Record<string, DshRouteLike>;
  /** provider 名 → 该 provider 的 Key（明文，仅注入子进程 env 用） */
  keys: Record<string, string | null>;
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

    const route = this.dshOptions.routes[assignment.provider];
    if (!route) throw new Error(`provider ${assignment.provider} 没有 dsh 路由配置`);
    const model = assignment.model || route.defaultModel;
    if (route.models.length > 0 && !route.models.includes(model)) {
      throw new Error(
        `模型 ${model} 不在 provider ${assignment.provider} 的可用模型内（${route.models.join("、")}）`,
      );
    }

    const patchFile = ensureRunPatch(this.dsh.patchDir, route.route, model);
    const sessionId = task.checkpoint?.sessionId;

    const args: string[] = ["--profile", this.dsh.profile, "--patch", patchFile, "--json"];
    if (sessionId) args.push("--session-id", sessionId);
    args.push(prompt);

    // 每 task 固定工作目录：dsh 接管 session 要求 cwd 一致
    const cwd = task.workDir
      ? resolvePath(task.workDir, this.options.baseDir)
      : task.spec.cwd
        ? resolvePath(task.spec.cwd, this.options.baseDir)
        : this.options.baseDir;
    fs.mkdirSync(cwd, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...task.spec.env,
      ...assignment.route,
      DSH_PROFILE: this.dsh.profile,
      // 会话隔离：子 dsh 用 LCS 专用家目录，绝不写进用户的 ~/.dsh
      DSH_HOME: this.dshOptions.dshHome,
      LCS_ARTIFACT_DIR: run.runDir,
    };
    // Key 注入：只走环境变量，命令行与 patch 都不出现明文
    const key = this.dshOptions.keys[assignment.provider];
    if (key && route.apiKeyEnv) env[route.apiKeyEnv] = key;

    return { command: this.dsh.command, args, cwd, env };
  }

  protected override async afterComplete(task: Task, run: Run): Promise<void> {
    const summary = parseDshEvents(readStdout(run.runDir));
    // dsh 把答案打在 stdout，不会自己写文件 → 落成 final.md 作为默认产物
    if (summary.finalText !== undefined) {
      const finalFile = path.join(run.runDir, FINAL_ARTIFACT);
      if (!fs.existsSync(finalFile)) {
        try {
          fs.writeFileSync(finalFile, summary.finalText, { encoding: "utf8" });
        } catch {
          /* 写不进去不影响主流程（产物校验会失败） */
        }
      }
    }
    if (task.checkpoint?.sessionId) return;
    if (!summary.sessionId) return;
    const file = path.join(run.runDir, CHECKPOINT_FILE);
    if (fs.existsSync(file)) return;
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ sessionId: summary.sessionId, updatedAt: Date.now() }, null, 2),
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      /* checkpoint 写不进去不影响主流程 */
    }
  }

  /** 事件流里的 session/usage/final 交给引擎收口时记账。 */
  override async poll(task: Task, run: Run, now: number) {
    const result = await super.poll(task, run, now);
    if (!result) return null;
    const summary = parseDshEvents(readStdout(run.runDir));
    const usage = summary.usage ? { ...summary.usage } : undefined;
    const error = summary.error
      ? `${summary.error.code ?? "dsh-error"}: ${summary.error.message ?? ""}`.trim()
      : result.error;
    return {
      ...result,
      usage,
      error,
      sessionId: summary.sessionId,
      checkpoint: summary.sessionId
        ? { sessionId: summary.sessionId, updatedAt: Date.now() }
        : result.checkpoint,
    };
  }
}

function readStdout(runDir: string): string {
  try {
    return fs.readFileSync(path.join(runDir, "stdout.log"), "utf8");
  } catch {
    return "";
  }
}
