/** 基于「子进程 + 退出码文件」的 runner 基类；shell / dsh 共用生命周期。 */

import type { Assignment, Run, RunResult, RunnerName, Task } from "../types.js";
import type { Runner } from "./base.js";
import {
  buildRunResult,
  isPidAlive,
  killProcessGroup,
  readExitCode,
  spawnWithExitFile,
} from "./exec.js";

export interface SpawnRunnerOptions {
  baseDir: string;
  artifactsDir: string;
  defaultTimeoutS: number;
}

export interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export abstract class SpawnRunner implements Runner {
  abstract readonly name: RunnerName;

  constructor(protected readonly options: SpawnRunnerOptions) {}

  protected abstract buildCommand(
    task: Task,
    assignment: Assignment,
    run: Run,
  ): CommandSpec;

  /** 执行结束后的钩子（dsh 用它解析 session id 写 checkpoint） */
  protected async afterComplete(_task: Task, _run: Run): Promise<void> {}

  async spawn(params: { task: Task; assignment: Assignment; run: Run }): Promise<number> {
    const { task, assignment, run } = params;
    const spec = this.buildCommand(task, assignment, run);
    const timeoutS = task.spec.timeoutS ?? this.options.defaultTimeoutS;
    return spawnWithExitFile({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      run,
      timeoutS,
    });
  }

  async poll(task: Task, run: Run, now: number): Promise<RunResult | null> {
    const exit = readExitCode(run.runDir);
    const timeoutS = task.spec.timeoutS ?? this.options.defaultTimeoutS;
    const cwd = run.runDir;

    if (!exit) {
      if (isPidAlive(run.pid)) {
        if (now - run.startedAt > timeoutS * 1000) {
          await this.kill(task, run);
          const result = buildRunResult({
            status: "timeout",
            endedAt: now,
            exitCode: null,
            task,
            run,
            cwd,
            timeoutS,
          });
          return { ...result, verified: false, error: `超过 timeoutS=${timeoutS}` };
        }
        return null;
      }
      const result = buildRunResult({
        status: "failed",
        endedAt: now,
        exitCode: -1,
        task,
        run,
        cwd,
        timeoutS,
      });
      return { ...result, error: "进程在写出退出码前结束（可能被 kill / OOM）" };
    }

    await this.afterComplete(task, run);
    const status = exit.code === 0 ? "succeeded" : "failed";
    return buildRunResult({
      status,
      endedAt: exit.endedAt,
      exitCode: exit.code,
      task,
      run,
      cwd,
      timeoutS,
    });
  }

  async kill(_task: Task, run: Run): Promise<void> {
    await killProcessGroup(run.pid);
  }
}
