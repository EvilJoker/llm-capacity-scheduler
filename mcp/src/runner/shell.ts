/** shell runner：任务 = 本机命令，产物默认落在 artifacts/<taskId>/<runId>/。 */

import type { Assignment, Run, Task } from "../types.js";
import type { SpawnRunnerOptions } from "./spawn-runner.js";
import { SpawnRunner } from "./spawn-runner.js";
import { resolvePath } from "../util.js";

export class ShellRunner extends SpawnRunner {
  readonly name = "shell" as const;

  constructor(options: SpawnRunnerOptions) {
    super(options);
  }

  protected buildCommand(task: Task, assignment: Assignment, run: Run) {
    const spec = task.spec;
    if (!spec.cmd || spec.cmd.length === 0) {
      throw new Error("shell runner 需要 task.spec.cmd");
    }
    const cwd = spec.cwd ? resolvePath(spec.cwd, this.options.baseDir) : run.runDir;
    return {
      command: spec.cmd[0],
      args: spec.cmd.slice(1),
      cwd,
      env: {
        ...process.env,
        ...spec.env,
        ...assignment.route,
      },
    };
  }
}
