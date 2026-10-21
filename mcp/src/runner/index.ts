/** 执行器层：shell / dsh headless。换执行方式不影响 provider 与 policy。 */

import type { Config } from "../config.js";
import type { RunnerName } from "../types.js";
import type { Runner } from "./base.js";
import { DshRunner } from "./dsh.js";
import { ShellRunner } from "./shell.js";

export type { Runner } from "./base.js";
export { DshRunner, extractSessionId } from "./dsh.js";
export { ShellRunner } from "./shell.js";

export type RunnerMap = Partial<Record<RunnerName, Runner>>;

export function buildRunners(config: Config, baseDir: string): RunnerMap {
  const base = {
    baseDir,
    artifactsDir: config.engine.artifactsDir,
    defaultTimeoutS: 1800,
  };
  const runners: RunnerMap = {};
  if (config.runners.shell.enabled) runners.shell = new ShellRunner(base);
  if (config.runners.dsh.enabled) {
    runners.dsh = new DshRunner({ ...base, dsh: config.runners.dsh });
  }
  return runners;
}
