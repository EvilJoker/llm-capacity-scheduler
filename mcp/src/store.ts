/**
 * 单文件 JSON 状态存储（原子写、单写者）。
 *
 * 为什么不 SQLite：npm 安装不能依赖原生模块编译；单用户规模下 JSON 足够，
 * 且 tasks/runs/samples 全在一个文件里，备份/迁移就是一个文件。
 */

import fs from "node:fs";
import path from "node:path";

import type {
  Bucket,
  DecisionLog,
  Run,
  Sample,
  Task,
  TaskState,
  TickReport,
} from "./types.js";
import { QUEUE_STATES, TERMINAL_STATES, bucketKey } from "./types.js";
import { atomicWriteFileSync, ensureDirSync, readJsonFile, uid } from "./util.js";

/** 一次 GC 动作的审计记录（删了哪个 task 的哪个会话；dryRun 表示只是预览）。 */
export interface GcLogEntry {
  ts: number;
  dryRun: boolean;
  taskId: string;
  sessionId: string | null;
  removedSessions: number;
  removedProjections: number;
  removedArtifacts: number;
}

const MAX_GC_LOG = 200;

export interface StoreData {
  version: 1;
  tickCount: number;
  tasks: Record<string, Task>;
  runs: Record<string, Run>;
  samples: Sample[];
  calibration: Record<string, { ewma: number; n: number }>;
  lastTick?: TickReport;
  decisions?: DecisionLog[];
  /** 最近的清理审计（最新在前）。 */
  gcLog?: GcLogEntry[];
}

const EMPTY: StoreData = {
  version: 1,
  tickCount: 0,
  tasks: {},
  runs: {},
  samples: [],
  calibration: {},
};

export interface TaskFilter {
  states?: TaskState[];
  limit?: number;
  includeTerminal?: boolean;
}

export class Store {
  readonly file: string;
  private data: StoreData;

  private constructor(file: string, data: StoreData) {
    this.file = file;
    this.data = data;
  }

  static open(file: string): Store {
    ensureDirSync(path.dirname(file));
    const raw = readJsonFile<Partial<StoreData> | null>(file, null);
    const data: StoreData = {
      ...EMPTY,
      ...(raw ?? {}),
      version: 1,
      tasks: raw?.tasks ?? {},
      runs: raw?.runs ?? {},
      samples: raw?.samples ?? [],
      calibration: raw?.calibration ?? {},
      tickCount: raw?.tickCount ?? 0,
    };
    for (const task of Object.values(data.tasks)) normalizeTask(task);
    return new Store(file, data);
  }

  // ---------------------------------------------------------------- 持久化

  persist(): void {
    atomicWriteFileSync(this.file, `${JSON.stringify(this.data)}\n`, 0o600);
  }

  get tickCount(): number {
    return this.data.tickCount;
  }

  nextTickId(): number {
    this.data.tickCount += 1;
    return this.data.tickCount;
  }

  setLastTick(report: TickReport): void {
    this.data.lastTick = report;
  }

  get lastTick(): TickReport | undefined {
    return this.data.lastTick;
  }

  setDecisions(decisions: DecisionLog[]): void {
    this.data.decisions = decisions;
  }

  get decisions(): DecisionLog[] {
    return this.data.decisions ?? [];
  }

  /** 追加一条清理审计（最新在前，最多 MAX_GC_LOG 条）。 */
  appendGcLog(entry: GcLogEntry): void {
    const log = this.data.gcLog ?? [];
    log.unshift(entry);
    this.data.gcLog = log.slice(0, MAX_GC_LOG);
  }

  get gcLog(): GcLogEntry[] {
    return this.data.gcLog ?? [];
  }

  // ------------------------------------------------------------------ tasks

  submit(task: Task): { task: Task; created: boolean } {
    const existing = this.findByIdempotencyKey(task.idempotencyKey);
    if (existing) return { task: existing, created: false };
    this.data.tasks[task.id] = task;
    this.persist();
    return { task, created: true };
  }

  getTask(taskId: string): Task | undefined {
    return this.data.tasks[taskId];
  }

  findByIdempotencyKey(key: string): Task | undefined {
    return Object.values(this.data.tasks).find((t) => t.idempotencyKey === key);
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    let tasks = Object.values(this.data.tasks);
    if (filter.states?.length) {
      const set = new Set(filter.states);
      tasks = tasks.filter((t) => set.has(t.state));
    } else if (!filter.includeTerminal) {
      tasks = tasks.filter((t) => !TERMINAL_STATES.includes(t.state));
    }
    tasks.sort((a, b) => b.createdAt - a.createdAt);
    if (filter.limit) tasks = tasks.slice(0, filter.limit);
    return tasks;
  }

  tasksInStates(states: TaskState[]): Task[] {
    const set = new Set(states);
    return Object.values(this.data.tasks)
      .filter((t) => set.has(t.state))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  queuedTasks(): Task[] {
    return this.tasksInStates(QUEUE_STATES);
  }

  transition(
    taskId: string,
    from: TaskState[],
    to: TaskState,
    patch: Partial<Task> = {},
  ): boolean {
    const task = this.data.tasks[taskId];
    if (!task) return false;
    if (!from.includes(task.state)) return false;
    Object.assign(task, patch, { state: to, updatedAt: Date.now() });
    this.persist();
    return true;
  }

  updateTask(taskId: string, patch: Partial<Task>): void {
    const task = this.data.tasks[taskId];
    if (!task) return;
    Object.assign(task, patch, { updatedAt: Date.now() });
    this.persist();
  }

  cancelTask(taskId: string): boolean {
    return this.transition(
      taskId,
      ["submitted", "queued", "deferred", "admitted"],
      "cancelled",
    );
  }

  expireTasks(now: number): number {
    let count = 0;
    for (const task of Object.values(this.data.tasks)) {
      if (!QUEUE_STATES.includes(task.state)) continue;
      if (task.deadlineMs !== null && task.deadlineMs <= now) {
        task.state = "expired";
        task.updatedAt = now;
        count += 1;
      }
    }
    if (count > 0) this.persist();
    return count;
  }

  taskCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const task of Object.values(this.data.tasks)) {
      counts[task.state] = (counts[task.state] ?? 0) + 1;
    }
    return counts;
  }

  // ------------------------------------------------------------------- runs

  addRun(run: Run): void {
    this.data.runs[run.id] = run;
    this.persist();
  }

  updateRun(runId: string, patch: Partial<Run>): void {
    const run = this.data.runs[runId];
    if (!run) return;
    Object.assign(run, patch);
    this.persist();
  }

  getRun(runId: string): Run | undefined {
    return this.data.runs[runId];
  }

  runningRuns(): Run[] {
    return Object.values(this.data.runs)
      .filter((r) => r.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  runsForTask(taskId: string): Run[] {
    return Object.values(this.data.runs)
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  recentRuns(limit = 50): Run[] {
    return Object.values(this.data.runs)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  completedRunsCount(bucketKeyFilter?: string): number {
    return Object.values(this.data.runs).filter(
      (r) =>
        r.status === "succeeded" &&
        (bucketKeyFilter === undefined || r.bucketKey === bucketKeyFilter),
    ).length;
  }

  runsBetween(bucketKeyFilter: string, startMs: number, endMs: number): Run[] {
    return Object.values(this.data.runs).filter(
      (r) =>
        r.bucketKey === bucketKeyFilter &&
        r.startedAt >= startMs &&
        r.startedAt <= endMs,
    );
  }

  committedByBucket(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const run of Object.values(this.data.runs)) {
      if (run.status !== "running") continue;
      out[run.bucketKey] = (out[run.bucketKey] ?? 0) + run.est;
    }
    return out;
  }

  runningCountByBucket(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const run of Object.values(this.data.runs)) {
      if (run.status !== "running") continue;
      out[run.bucketKey] = (out[run.bucketKey] ?? 0) + 1;
    }
    return out;
  }

  // ---------------------------------------------------------------- samples

  recordSamples(buckets: Bucket[], now: number, maxSamples: number): void {
    for (const b of buckets) {
      this.data.samples.push({
        bucketKey: bucketKey(b),
        provider: b.provider,
        modelFamily: b.modelFamily,
        resourceKind: b.resourceKind,
        ts: now,
        remaining: b.remaining,
        unit: b.unit,
        windowStartMs: b.window.startMs,
        windowEndMs: b.window.endMs,
        source: b.source,
      });
    }
    if (this.data.samples.length > maxSamples) {
      this.data.samples = this.data.samples.slice(-maxSamples);
    }
    this.persist();
  }

  recentSamples(bucketKeyFilter: string, sinceMs: number): Sample[] {
    return this.data.samples.filter(
      (s) => s.bucketKey === bucketKeyFilter && s.ts >= sinceMs,
    );
  }

  lastSampleBefore(bucketKeyFilter: string, ts: number): Sample | undefined {
    let best: Sample | undefined;
    for (const sample of this.data.samples) {
      if (sample.bucketKey !== bucketKeyFilter || sample.ts >= ts) continue;
      if (!best || sample.ts > best.ts) best = sample;
    }
    return best;
  }

  allSamples(limit = 200): Sample[] {
    return this.data.samples.slice(-limit);
  }

  // ------------------------------------------------------------ calibration

  private calibKey(taskClass: string, provider: string, bucket: string): string {
    return `${taskClass}|${provider}|${bucket}`;
  }

  calibrationGet(
    taskClass: string,
    provider: string,
    bucket: string,
  ): { ewma: number; n: number } | undefined {
    return this.data.calibration[this.calibKey(taskClass, provider, bucket)];
  }

  calibrationUpdate(
    taskClass: string,
    provider: string,
    bucket: string,
    actual: number,
    alpha = 0.3,
  ): { ewma: number; n: number } {
    const key = this.calibKey(taskClass, provider, bucket);
    const old = this.data.calibration[key];
    const next = old
      ? { ewma: (1 - alpha) * old.ewma + alpha * actual, n: old.n + 1 }
      : { ewma: actual, n: 1 };
    this.data.calibration[key] = next;
    this.persist();
    return next;
  }
}

export function normalizeTask(task: Task): Task {
  task.spec ??= {};
  task.requirements ??= {};
  task.resources ??= {};
  task.attempts ??= 0;
  task.priorityBoost ??= 0;
  task.nextEligibleAtMs ??= null;
  task.deadlineMs ??= null;
  task.value ??= 50;
  task.taskClass ??= "default";
  task.createdAt ??= Date.now();
  task.updatedAt ??= task.createdAt;
  if (task.spec.expectedDurationS === undefined) task.spec.expectedDurationS = 300;
  if (task.spec.timeoutS === undefined) task.spec.timeoutS = 1800;
  return task;
}

export { uid, fs };
