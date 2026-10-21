/** runner 契约：执行器只负责「跑起来 / 收结果」，不关心容量与策略。 */

import type { Assignment, Run, RunResult, RunnerName, Task } from "../types.js";

export interface SpawnParams {
  task: Task;
  assignment: Assignment;
  run: Run;
}

export interface Runner {
  readonly name: RunnerName;
  spawn(params: SpawnParams): Promise<number>;
  poll(task: Task, run: Run, now: number): Promise<RunResult | null>;
  kill(task: Task, run: Run): Promise<void>;
}
