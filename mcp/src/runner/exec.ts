/** 执行器公共能力：带退出码文件的 spawn、进程存活、验收、产物收集、checkpoint。 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Run, RunResult, Task, TaskCheckpoint } from "../types.js";
import { ensureDirSync } from "../util.js";

export const INTERNAL_FILES = new Set([".exit_code", "stdout.log", "stderr.log"]);
export const CHECKPOINT_FILE = "checkpoint.json";

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  timeoutS: number;
}

/**
 * 启动子进程，并在退出时把退出码写进 `.exit_code`。
 *
 * 不依赖父进程 waitpid：引擎重启后仍可通过退出码文件 + pid 存活判定 run 是否结束。
 */
export function spawnWithExitFile(options: SpawnOptions): number {
  ensureDirSync(options.run.runDir);
  const exitFile = path.join(options.run.runDir, ".exit_code");
  const stdoutPath = path.join(options.run.runDir, "stdout.log");
  const stderrPath = path.join(options.run.runDir, "stderr.log");
  const outFd = fs.openSync(stdoutPath, "w");
  const errFd = fs.openSync(stderrPath, "w");
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    LCS_EXIT_FILE: exitFile,
    LCS_ARTIFACT_DIR: options.run.runDir,
    LCS_TASK_ID: options.run.taskId,
    LCS_RUN_ID: options.run.id,
    LCS_CHECKPOINT_FILE: path.join(options.run.runDir, CHECKPOINT_FILE),
  };
  try {
    const child = spawn("/bin/sh", ["-c", '"$@"\necho $? > "$LCS_EXIT_FILE"', "lcs-run", options.command, ...options.args], {
      cwd: options.cwd,
      env,
      detached: true,
      stdio: ["ignore", outFd, errFd],
    });
    child.unref();
    if (!child.pid) throw new Error("子进程启动失败（无 pid）");
    return child.pid;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
}

export function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killProcessGroup(pid: number | null): Promise<void> {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 已经退出 */
    }
  }
}

export function readExitCode(runDir: string): { code: number; endedAt: number } | null {
  const file = path.join(runDir, ".exit_code");
  try {
    const stat = fs.statSync(file);
    const text = fs.readFileSync(file, "utf8").trim();
    const code = Number.parseInt(text || "-1", 10);
    return { code: Number.isFinite(code) ? code : -1, endedAt: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function readCheckpoint(runDir: string): TaskCheckpoint | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runDir, CHECKPOINT_FILE), "utf8")) as
      | Record<string, unknown>
      | null;
    if (!raw || typeof raw !== "object") return null;
    const sessionId =
      typeof raw.sessionId === "string"
        ? raw.sessionId
        : typeof raw.session_id === "string"
          ? raw.session_id
          : undefined;
    const data =
      raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : undefined;
    return { sessionId, data, updatedAt: Date.now() };
  } catch {
    return null;
  }
}

export function runVerifier(task: Task, cwd: string, timeoutS: number): { ok: boolean; error?: string } {
  const cmd = task.spec.verifyCmd;
  if (!cmd || cmd.length === 0) return { ok: true };
  const { status, stderr } = spawnSyncSafe(cmd[0], cmd.slice(1), cwd, timeoutS * 1000);
  if (status !== 0) {
    return { ok: false, error: `verifier 失败 exit=${status}: ${(stderr ?? "").slice(0, 300)}` };
  }
  return { ok: true };
}

function spawnSyncSafe(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): { status: number; stdout: string; stderr: string } {
  // 用同步 spawn 保持 poll 的简单性；verifier 通常很快
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: Math.max(60_000, timeoutMs),
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** 产物收集：runDir 内文件 + 声明产物（必要时从 cwd 复制进 runDir）。 */
export function collectArtifacts(
  task: Task,
  run: Run,
  cwd: string,
): { artifacts: string[]; missing: string[] } {
  const found = new Set<string>();
  for (const file of listFiles(run.runDir)) {
    const rel = path.relative(run.runDir, file).split(path.sep).join("/");
    if (INTERNAL_FILES.has(rel)) continue;
    found.add(rel);
  }
  const missing: string[] = [];
  for (const declared of task.spec.expectArtifacts ?? []) {
    const inRunDir = path.join(run.runDir, declared);
    if (fs.existsSync(inRunDir) && fs.statSync(inRunDir).isFile()) {
      found.add(declared.split(path.sep).join("/"));
      continue;
    }
    const inCwd = path.isAbsolute(declared) ? declared : path.join(cwd, declared);
    if (fs.existsSync(inCwd) && fs.statSync(inCwd).isFile()) {
      const target = path.join(run.runDir, path.basename(declared));
      try {
        fs.copyFileSync(inCwd, target);
        found.add(path.basename(declared));
      } catch {
        missing.push(declared);
      }
    } else {
      missing.push(declared);
    }
  }
  return { artifacts: [...found].sort(), missing };
}

function listFiles(dir: string, base = dir): string[] {
  let out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFiles(full, base));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function buildRunResult(params: {
  status: RunResult["status"];
  endedAt: number;
  exitCode: number | null;
  task: Task;
  run: Run;
  cwd: string;
  timeoutS: number;
}): RunResult {
  const { artifacts, missing } = collectArtifacts(params.task, params.run, params.cwd);
  let verified = params.status === "succeeded" || params.exitCode === 0;
  let error: string | undefined;
  if (params.exitCode !== 0) {
    verified = false;
    error = `exit=${params.exitCode}`;
  }
  if (missing.length > 0) {
    verified = false;
    error = `缺少声明产物: ${missing.join(", ")}`;
  } else if (params.exitCode === 0) {
    const check = runVerifier(params.task, params.run.runDir, params.timeoutS);
    if (!check.ok) {
      verified = false;
      error = check.error;
    }
  }
  const checkpoint = readCheckpoint(params.run.runDir) ?? undefined;
  return {
    status: params.status,
    endedAt: params.endedAt,
    exitCode: params.exitCode,
    verified,
    artifacts,
    usage: { exitCode: params.exitCode },
    error,
    checkpoint,
  };
}
