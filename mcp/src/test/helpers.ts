/** 测试辅助。 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultConfig, type Config } from "../config.js";
import { Engine } from "../engine.js";
import { Store } from "../store.js";
import type { Task } from "../types.js";
import { uid } from "../util.js";

export function tmpDir(prefix = "lcs-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export class FakeClock {
  constructor(public value: number) {}
  now = (): number => this.value;
  set(ms: number): void {
    this.value = ms;
  }
  advance(ms: number): number {
    this.value += ms;
    return this.value;
  }
}

/**
 * 假 dsh：模拟 `dsh --profile p --patch f --json [--session-id id] "<task>"`
 * - stdout 输出 NDJSON 事件流（session/status/text/final）
 * - 把调用现场写进 $LCS_ARTIFACT_DIR/invocation.json（测试据此断言参数与环境变量）
 * - 产物：out.txt / env.txt（任务文本含 NOARTIFACT 时不写 out.txt）；final.md 由 runner 从 final 事件落盘
 * - 任务文本含 FAIL → 输出 error 事件并 exit 1；含 SLOW → 睡 30 秒（超时/抢占用）
 */
const FAKE_DSH_SOURCE = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
let sessionArg = null;
let profile = null;
let patch = null;
const words = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--session-id") { sessionArg = argv[i + 1]; i += 1; }
  else if (a === "--profile") { profile = argv[i + 1]; i += 1; }
  else if (a === "--patch") { patch = argv[i + 1]; i += 1; }
  else if (a === "--json") { /* 事件流开关 */ }
  else words.push(a);
}
const task = words.join(" ");
const artifactDir = process.env.LCS_ARTIFACT_DIR || "";
const sessionId = sessionArg || "session-" + randomUUID();
const cwd = process.cwd();

if (artifactDir) {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, "invocation.json"),
    JSON.stringify(
      {
        argv,
        profile,
        patch,
        sessionArg,
        task,
        cwd,
        env: {
          LCS_PROVIDER: process.env.LCS_PROVIDER || null,
          LCS_MODEL: process.env.LCS_MODEL || null,
          LCS_FAMILY: process.env.LCS_FAMILY || null,
          LCS_DSH_ROUTE: process.env.LCS_DSH_ROUTE || null,
          LCS_ARTIFACT_DIR: process.env.LCS_ARTIFACT_DIR || null,
          LCS_MOCK_API_KEY: process.env.LCS_MOCK_API_KEY || null,
          DSH_PROFILE: process.env.DSH_PROFILE || null,
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(artifactDir, "env.txt"),
    [process.env.LCS_PROVIDER, process.env.LCS_MODEL, process.env.LCS_ASSIGNMENT_ID].join("/"),
  );
  if (!task.includes("NOARTIFACT")) fs.writeFileSync(path.join(artifactDir, "out.txt"), "burned");
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "session", sessionId, cwd });
emit({ type: "status", phase: "turn_start", turn: 1 });

if (task.includes("FAIL")) {
  emit({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { code: "AUTH", message: "fake auth error" } } });
  process.exit(1);
}

if (task.includes("SLOW")) await new Promise((r) => setTimeout(r, 30000));

emit({ type: "status", phase: "step_start", turn: 1, step: 1 });
emit({ type: "text", text: "ok" });
emit({ type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 50, totalTokens: 1050, cacheReadTokens: 0 } });
emit({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } });
emit({ type: "final", text: "ok" });
`;

export function writeFakeDsh(dir: string): string {
  const file = path.join(dir, "fake-dsh.mjs");
  fs.writeFileSync(file, FAKE_DSH_SOURCE, "utf8");
  fs.chmodSync(file, 0o755); // 直接 exec：需要可执行的 shebang 脚本
  return file;
}

/** mock provider 的 dsh 路由（测试用） */
export const MOCK_DSH = {
  route: "mock",
  api: "openai-completions",
  baseURL: "http://mock.invalid",
  apiKeyEnv: "LCS_MOCK_API_KEY",
  models: ["mock-model"],
  defaultModel: "mock-model",
};

export function makeConfig(overrides: {
  dir: string;
  tickSeconds?: number;
  providers?: Config["providers"];
  policy?: Partial<Config["policy"]>;
  maxParallel?: number;
  webPort?: number;
  fakeDsh?: string;
}): Config {
  const config = defaultConfig();
  config.engine.tickSeconds = overrides.tickSeconds ?? 60;
  config.engine.stateFile = path.join(overrides.dir, "state.json");
  config.engine.artifactsDir = path.join(overrides.dir, "artifacts");
  config.engine.workDir = path.join(overrides.dir, "work");
  config.engine.maxParallel = 1; // v0.3 串行
  config.engine.web.enabled = true;
  config.engine.web.port = overrides.webPort ?? 0;
  if (overrides.providers) config.providers = overrides.providers;
  else {
    config.providers = [
      {
        name: "mock",
        kind: "mock",
        enabled: true,
        options: {
          family: "general",
          start: "10:00",
          end: "15:00",
          initialRemaining: 80,
          burnPerRun: 6,
          apiKey: "mock-key",
          dsh: MOCK_DSH,
        },
      },
    ];
  }
  // 能力目录已废弃（模型归 provider 配置）
  config.models = [];
  Object.assign(config.policy, overrides.policy ?? {});
  config.runners.default = "dsh";
  config.runners.dsh.enabled = true;
  config.runners.dsh.command = overrides.fakeDsh ?? writeFakeDsh(overrides.dir);
  config.runners.dsh.profile = "lcs-test";
  config.runners.dsh.patchDir = path.join(overrides.dir, "patches");
  config.runners.dsh.timeoutS = 30;
  config.runners.dsh.maxParallel = 1;
  return config;
}

export function buildEngine(config: Config, clock: FakeClock, dir: string): Engine {
  const store = Store.open(config.engine.stateFile);
  return new Engine({ config, baseDir: dir, store, clock: clock.now });
}

export function makeTask(overrides: Partial<Task> & { cmd?: string[] } = {}): Task {
  const now = Date.now();
  return {
    id: uid("task"),
    idempotencyKey: uid("idem"),
    taskClass: "default",
    spec: {
      cmd: overrides.cmd ?? ["fake-task"],
      expectedDurationS: 1,
      timeoutS: 30,
      ...overrides.spec,
    },
    requirements: overrides.requirements ?? {},
    resources: overrides.resources ?? {},
    value: overrides.value ?? 50,
    deadlineMs: overrides.deadlineMs ?? null,
    state: overrides.state ?? "submitted",
    attempts: overrides.attempts ?? 0,
    priorityBoost: overrides.priorityBoost ?? 0,
    nextEligibleAtMs: overrides.nextEligibleAtMs ?? null,
    checkpoint: overrides.checkpoint,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    error: overrides.error,
  };
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 8000, intervalMs = 20 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitUntil 超时");
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 推进假时钟并 tick，直到任务进入终态（测试里没有自动调度循环，需要手动推进）。 */
export async function waitForTask(
  engine: Engine,
  clock: FakeClock,
  taskId: string,
  terminal = ["succeeded", "failed", "cancelled", "expired"],
  timeoutMs = 8000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = engine.store.getTask(taskId)?.state;
    if (state && terminal.includes(state)) return state;
    await engine.tick();
    clock.advance(5000);
    await sleep(20);
  }
  throw new Error(
    `task ${taskId} 未在限定时间进入终态，当前=${engine.store.getTask(taskId)?.state}`,
  );
}

export async function drain(engine: Engine, clock: FakeClock, stepMs = 5000, rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    const before = engine.store.runningRuns().length;
    const report = await engine.tick();
    clock.advance(stepMs);
    if (before === 0 && report.spawned.length === 0) return;
    await sleep(20);
  }
  throw new Error("drain 未能收敛");
}
