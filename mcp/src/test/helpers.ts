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

export function makeConfig(overrides: {
  dir: string;
  tickSeconds?: number;
  providers?: Config["providers"];
  policy?: Partial<Config["policy"]>;
  maxParallel?: number;
  webPort?: number;
}): Config {
  const config = defaultConfig();
  config.engine.tickSeconds = overrides.tickSeconds ?? 60;
  config.engine.stateFile = path.join(overrides.dir, "state.json");
  config.engine.artifactsDir = path.join(overrides.dir, "artifacts");
  config.engine.maxParallel = overrides.maxParallel ?? 4;
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
        },
      },
    ];
  }
  // 只保留与当前 providers 匹配的 model catalog，否则配置校验会失败
  config.models = config.models.filter((m) =>
    config.providers.some((p) => p.name === m.provider),
  );
  Object.assign(config.policy, overrides.policy ?? {});
  config.runners.default = "shell";
  config.runners.shell.enabled = true;
  config.runners.dsh.enabled = false;
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
      cmd: overrides.cmd ?? ["node", "-e", "1"],
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

/** 推进假时钟并 tick，直到没有在飞 run、也没有新的 spawn。 */
/** 反复 tick 直到任务进入终态（测试里没有自动调度循环，需要手动推进）。 */
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
