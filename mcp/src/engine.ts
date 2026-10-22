/**
 * 引擎：tick + reconcile 主循环。
 *
 * 每个 tick：
 *   ① observe   读全部 provider 容量快照，采样落库
 *   ② reap      收口已结束的 run；窗口已结束的 run 抢占为 interrupted
 *   ③ reconcile 清理孤儿任务（running 但没有在飞 run）
 *   ④ expire    deadline 已过 → expired
 *   ⑤ dispatch  排序 → 能力匹配 → 容量准入 → 生成 Assignment → spawn
 *   ⑥ publish   快照给 Web / MCP
 */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { buildAdapters, type Adapter } from "./capacity/index.js";
import { resolveModel, type ResolvedModel } from "./catalog.js";
import {
  BurnBeforeExpiryPolicy,
  taskScore,
  type PeakSchedule,
} from "./policy.js";
import type { GcLogEntry, Store } from "./store.js";
import {
  bucketKey,
  bucketShortKey,
  describeBucket,
  isPaid,
  isPerishable,
  QUEUE_STATES,
  type Assignment,
  type Bucket,
  type BucketSnapshot,
  type DecisionLog,
  type ReapLog,
  type Run,
  type RunResult,
  type RunnerName,
  type SpawnLog,
  type Task,
  type TaskState,
  type TickReport,
} from "./types.js";
import { log, logError, nowMs, uid } from "./util.js";
import { buildRunners, collectRunnerRoutes, type RunnerMap } from "./runner/index.js";
import { gcExpired, type GcResult } from "./gc.js";
import { readCheckpoint } from "./runner/exec.js";

const MAX_DECISIONS = 500;
const MAX_TICKS = 50;
const MAX_SAMPLES = 5000;
/** 每 N 个 tick 做一次会话/产物 GC（共享 ~/.dsh 下的保留策略） */
const GC_EVERY_TICKS = 30;

export interface EngineOptions {
  config: Config;
  baseDir: string;
  store: Store;
  adapters?: Adapter[];
  runners?: RunnerMap;
  clock?: () => number;
}

export interface SchedulerState {
  started: boolean;
  paused: boolean;
  tickSeconds: number;
  tickCount: number;
  lastTickAt: number | null;
  nextTickAt: number | null;
}

export class Engine {
  config: Config;
  readonly store: Store;
  policy: BurnBeforeExpiryPolicy;
  private adapters: Adapter[];
  private runners: RunnerMap;
  /** provider → dsh 路由（只有带 dsh 段的 provider 才能被执行） */
  private runnerRoutes: Record<string, { route: string; apiKeyEnv: string; defaultModel: string; models: string[] }>;
  private clock: () => number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private baseDir: string;

  paused = false;
  started = false;
  lastTickAt: number | null = null;
  nextTickAt: number | null = null;
  lastBuckets: Bucket[] = [];
  recentDecisions: DecisionLog[] = [];
  recentTicks: TickReport[] = [];

  constructor(options: EngineOptions) {
    this.config = options.config;
    this.baseDir = options.baseDir;
    this.store = options.store;
    this.clock = options.clock ?? nowMs;
    this.policy = new BurnBeforeExpiryPolicy(this.config.policy);
    this.adapters = options.adapters ?? buildAdapters(this.config.providers, { store: this.store });
    this.runners = options.runners ?? buildRunners(this.config, this.baseDir);
    this.runnerRoutes = collectRunnerRoutes(this.config);
  }

  now(): number {
    return this.clock();
  }

  /** 配置热加载：重建 policy / adapters / runners，并调整 tick 间隔。 */
  reload(config: Config, baseDir = this.baseDir): void {
    this.config = config;
    this.baseDir = baseDir;
    this.policy = new BurnBeforeExpiryPolicy(config.policy);
    this.adapters = buildAdapters(config.providers, { store: this.store });
    this.runners = buildRunners(config, baseDir);
    this.runnerRoutes = collectRunnerRoutes(config);
    if (this.started) {
      this.stop();
      this.start();
    }
  }

  // ---------------------------------------------------------------- 调度循环

  start(): void {
    if (this.timer) return;
    this.started = true;
    this.scheduleNext(0);
    log(
      `scheduler started (tick=${this.config.engine.tickSeconds}s, policy=${this.config.policy.name})`,
    );
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.started = false;
    this.nextTickAt = null;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  schedulerState(): SchedulerState {
    return {
      started: this.started,
      paused: this.paused,
      tickSeconds: this.config.engine.tickSeconds,
      tickCount: this.store.tickCount,
      lastTickAt: this.lastTickAt,
      nextTickAt: this.nextTickAt,
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.nextTickAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      void this.onTimer();
    }, delayMs);
    this.timer.unref?.();
  }

  private async onTimer(): Promise<void> {
    try {
      if (!this.paused) await this.tick();
    } catch (error) {
      logError("tick 失败", error);
    } finally {
      this.scheduleNext(this.config.engine.tickSeconds * 1000);
    }
  }

  // ---------------------------------------------------------------- 观测

  async observeNow(now = this.now()): Promise<Bucket[]> {
    const buckets: Bucket[] = [];
    for (const adapter of this.adapters) {
      try {
        buckets.push(...(await adapter.observe(now)));
      } catch (error) {
        logError(`adapter ${adapter.name} observe 失败`, error);
      }
    }
    this.lastBuckets = buckets;
    if (buckets.length > 0) {
      this.store.recordSamples(buckets, now, MAX_SAMPLES);
    }
    return buckets;
  }

  // ---------------------------------------------------------------- 主 tick

  async tick(nowOverride?: number): Promise<TickReport> {
    const now = nowOverride ?? this.now();
    const startedAt = Date.now();
    const tickId = this.store.nextTickId();
    const report: TickReport = {
      tickId,
      now,
      durationMs: 0,
      buckets: [],
      spawned: [],
      reaped: [],
      interrupted: [],
      requeued: 0,
      expired: 0,
      decisions: [],
      errors: [],
    };
    if (this.ticking) {
      report.errors.push("上一轮 tick 尚未结束，跳过");
      return report;
    }
    this.ticking = true;
    try {
      let buckets: Bucket[] = [];
      try {
        buckets = await this.observeNow(now);
      } catch (error) {
        report.errors.push(`observe: ${String(error)}`);
      }
      report.buckets = buckets.map((b) =>
        describeBucket(b, now, this.policy.reserveFn.reservePct(b, now)),
      );

      try {
        await this.reap(now, buckets, report);
      } catch (error) {
        report.errors.push(`reap: ${String(error)}`);
        logError("reap 失败", error);
      }

      try {
        report.requeued += this.reconcileOrphans(now);
      } catch (error) {
        report.errors.push(`reconcile: ${String(error)}`);
      }

      try {
        report.expired = this.store.expireTasks(now);
      } catch (error) {
        report.errors.push(`expire: ${String(error)}`);
      }

      try {
        await this.dispatch(now, buckets, report);
      } catch (error) {
        report.errors.push(`dispatch: ${String(error)}`);
        logError("dispatch 失败", error);
      }

      // 保留策略：定期清理「自己登记过的」过期 dsh 会话 / 产物（隔离家目录内）
      if (report.tickId % GC_EVERY_TICKS === 0) {
        try {
          this.runGc({});
        } catch (error) {
          report.errors.push(`gc: ${String(error)}`);
        }
      }

      report.durationMs = Date.now() - startedAt;
      this.lastTickAt = now;
      this.lastBuckets = buckets;
      this.recentDecisions = [...report.decisions, ...this.recentDecisions].slice(0, MAX_DECISIONS);
      this.recentTicks = [report, ...this.recentTicks].slice(0, MAX_TICKS);
      this.store.setLastTick(report);
      this.store.setDecisions(this.recentDecisions);
      this.store.persist();
      return report;
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- 收口

  private async reap(now: number, buckets: Bucket[], report: TickReport): Promise<void> {
    const bucketMap = new Map(buckets.map((b) => [bucketKey(b), b]));
    for (const run of this.store.runningRuns()) {
      const task = this.store.getTask(run.taskId);
      if (!task) {
        this.store.updateRun(run.id, {
          status: "failed",
          endedAt: now,
          error: "task 不存在",
        });
        continue;
      }

      // 窗口边界抢占：避免「消耗算到新窗口、租约记在旧桶」
      if (
        this.config.policy.windowPreempt &&
        run.windowEndMs !== null &&
        now >= run.windowEndMs
      ) {
        await this.interruptRun(task, run, now, bucketMap, report);
        continue;
      }

      const runner = this.runnerFor(run);
      let result: RunResult | null = null;
      try {
        result = await runner.poll(task, run, now);
      } catch (error) {
        report.errors.push(`poll ${run.id}: ${String(error)}`);
      }
      if (!result) continue;
      report.reaped.push(this.finalizeRun(task, run, result, now, bucketMap, report));
    }
  }

  private async interruptRun(
    task: Task,
    run: Run,
    now: number,
    bucketMap: Map<string, Bucket>,
    report: TickReport,
  ): Promise<void> {
    const runner = this.runnerFor(run);
    try {
      await runner.kill(task, run);
    } catch {
      /* 已经退出 */
    }
    const checkpoint = readCheckpoint(run.runDir) ?? task.checkpoint;
    const result: RunResult = {
      status: "interrupted",
      endedAt: now,
      exitCode: null,
      verified: false,
      artifacts: [],
      error: "窗口结束被抢占",
      checkpoint,
    };
    const entry = this.finalizeRun(task, run, result, now, bucketMap, report);
    report.interrupted.push(entry);
  }

  private finalizeRun(
    task: Task,
    run: Run,
    result: RunResult,
    now: number,
    bucketMap: Map<string, Bucket>,
    report: TickReport,
  ): ReapLog {
    const delta = this.quotaDelta(run, bucketMap.get(run.bucketKey), now);
    this.store.updateRun(run.id, {
      status: result.status,
      endedAt: result.endedAt,
      exitCode: result.exitCode ?? null,
      verified: result.verified,
      artifacts: result.artifacts,
      usage: result.usage ?? {},
      sessionId: result.sessionId ?? run.sessionId ?? null,
      error: result.error,
      quotaDelta: delta,
    });
    if (delta !== null && delta > 0) {
      this.store.calibrationUpdate(task.taskClass, run.provider, run.bucketKey, delta);
    }
    const taskState = this.applyTaskResult(task, run, result, now);
    return {
      runId: run.id,
      taskId: task.id,
      status: result.status,
      exitCode: result.exitCode ?? null,
      verified: result.verified,
      artifacts: result.artifacts,
      quotaDelta: delta,
      taskState,
    };
  }

  private applyTaskResult(
    task: Task,
    run: Run,
    result: RunResult,
    now: number,
  ): TaskState {
    const attempts = task.attempts + 1;
    const checkpoint = result.checkpoint ?? task.checkpoint;
    const from: TaskState[] = ["running", "admitted"];

    if (result.status === "succeeded" && result.verified) {
      this.store.transition(task.id, from, "succeeded", {
        attempts,
        checkpoint,
        finishedAt: now,
        error: undefined,
      });
      return "succeeded";
    }

    const retryable = result.status !== "cancelled";
    if (retryable && attempts < this.config.policy.maxAttempts) {
      const boost = Math.min(2, task.priorityBoost + (checkpoint ? 0.5 : 0.2));
      this.store.transition(task.id, from, "queued", {
        attempts,
        checkpoint,
        priorityBoost: boost,
        nextEligibleAtMs: now + this.config.policy.retryBackoffSeconds * 1000,
        error: result.error,
      });
      return "queued";
    }
    this.store.transition(task.id, from, "failed", {
      attempts,
      checkpoint,
      finishedAt: now,
      error: result.error ?? `run ${run.id} ${result.status}`,
    });
    return "failed";
  }

  private quotaDelta(run: Run, bucket: Bucket | undefined, now: number): number | null {
    if (!bucket || bucket.remaining === null) return null;
    const prev = this.store.lastSampleBefore(run.bucketKey, run.startedAt);
    if (!prev || prev.remaining === null) return null;
    const concurrent = this.store
      .runsBetween(run.bucketKey, prev.ts, now)
      .filter((r) => r.id !== run.id);
    if (concurrent.length > 0) return null; // 并发批次无法归因，宁可不校准
    return Math.max(0, prev.remaining - bucket.remaining);
  }

  private reconcileOrphans(now: number): number {
    let requeued = 0;
    for (const state of ["admitted", "running"] as TaskState[]) {
      for (const task of this.store.tasksInStates([state])) {
        const runs = this.store.runsForTask(task.id);
        if (runs.some((r) => r.status === "running")) continue;
        const attempts = task.attempts + 1;
        if (attempts < this.config.policy.maxAttempts) {
          if (
            this.store.transition(task.id, [state], "queued", {
              attempts,
              nextEligibleAtMs: now + this.config.policy.retryBackoffSeconds * 1000,
              error: "orphan: 无在飞 run",
            })
          ) {
            requeued += 1;
          }
        } else {
          this.store.transition(task.id, [state], "failed", {
            attempts,
            error: "orphan: 重试次数用尽",
          });
        }
      }
    }
    return requeued;
  }

  // ---------------------------------------------------------------- 派发

  private async dispatch(now: number, buckets: Bucket[], report: TickReport): Promise<void> {
    // v0.3：串行执行 —— 同一时刻只允许一个任务在跑
    const maxParallel = 1;
    const running = this.store.runningRuns();
    if (running.length >= maxParallel) return;

    const committed = this.store.committedByBucket();
    const runningCount = this.store.runningCountByBucket();
    let totalRunning = running.length;

    const tasks = this.store.queuedTasks();
    for (const task of tasks) {
      if (task.state === "submitted") {
        this.store.transition(task.id, ["submitted"], "queued");
      }
    }
    tasks.sort(
      (a, b) =>
        taskScore(b, now, this.config.policy) - taskScore(a, now, this.config.policy),
    );

    for (const task of tasks) {
      if (totalRunning >= maxParallel) break;
      if (report.decisions.length >= MAX_DECISIONS) break;
      if (task.nextEligibleAtMs !== null && task.nextEligibleAtMs > now) continue;
      if (task.deadlineMs !== null && task.deadlineMs <= now) {
        this.store.transition(task.id, ["submitted", "queued", "deferred"], "expired", {
          error: "deadline 已过",
        });
        continue;
      }

      const candidates = this.candidates(task, buckets, now);
      if (candidates.length === 0) {
        this.logDecision(report, {
          taskId: task.id,
          bucket: "-",
          provider: "-",
          windowEndMs: null,
          remaining: null,
          primary: true,
          admit: false,
          reason: "no_bucket",
          est: 0,
          reserve: 0,
          excess: 0,
          slots: 0,
        });
        if (task.state === "queued") {
          this.store.transition(task.id, ["queued"], "deferred");
        }
        continue;
      }

      let chosen:
        | { bucket: Bucket; model: ResolvedModel; est: number; runner: RunnerName; reason: string }
        | undefined;

      for (const candidate of candidates) {
        const model = resolveModel(task, candidate, this.config.providers);
        if (!model) {
          this.logDecision(report, {
            taskId: task.id,
            bucket: bucketShortKey(candidate),
            provider: candidate.provider,
            windowEndMs: candidate.window.endMs,
            remaining: candidate.remaining,
            primary: true,
            admit: false,
            reason: "no_model",
            est: 0,
            reserve: 0,
            excess: 0,
            slots: 0,
          });
          continue;
        }
        const calibration = this.calibrationFor(task, candidate);
        const decision = this.policy.decide({
          bucket: candidate,
          task,
          now,
          committed: committed[bucketKey(candidate)] ?? 0,
          runningCount: runningCount[bucketKey(candidate)] ?? 0,
          selfBusy: this.selfBusy(candidate, now),
          calibration,
        });
        this.logDecision(report, {
          taskId: task.id,
          bucket: bucketShortKey(candidate),
          provider: candidate.provider,
          model: model.model,
          windowEndMs: candidate.window.endMs,
          remaining: candidate.remaining,
          primary: true,
          ...decision,
        });
        if (decision.admit) {
          const runner = this.selectRunner(task, candidate.provider);
          if (!runner) {
            this.logDecision(report, {
              taskId: task.id,
              bucket: bucketShortKey(candidate),
              provider: candidate.provider,
              windowEndMs: candidate.window.endMs,
              remaining: candidate.remaining,
              primary: true,
              admit: false,
              reason: "no_runner",
              est: decision.est,
              reserve: decision.reserve,
              excess: decision.excess,
              slots: decision.slots,
            });
            continue;
          }
          chosen = { bucket: candidate, model, est: decision.est, runner, reason: decision.reason };
          break;
        }
      }

      if (!chosen) {
        if (task.state === "queued") {
          this.store.transition(task.id, ["queued"], "deferred");
        }
        continue;
      }

      const spawned = await this.spawn(task, chosen, now, report);
      if (!spawned) continue;
      committed[bucketKey(chosen.bucket)] =
        (committed[bucketKey(chosen.bucket)] ?? 0) + chosen.est;
      runningCount[bucketKey(chosen.bucket)] =
        (runningCount[bucketKey(chosen.bucket)] ?? 0) + 1;
      totalRunning += 1;
    }
  }

  private candidates(task: Task, buckets: Bucket[], now: number): Bucket[] {
    const req = task.requirements;
    return buckets
      .filter((b) => {
        if (b.window.unlimited || b.window.lifecycle === "unlimited") return false;
        if (b.window.endMs !== null && b.window.endMs <= now) return false;
        if (req.providers && req.providers.length > 0 && !req.providers.includes(b.provider)) {
          return false;
        }
        if (req.modelFamily && b.modelFamily !== req.modelFamily) return false;
        return true;
      })
      .sort((a, b) => {
        const ea = a.window.endMs ?? Number.POSITIVE_INFINITY;
        const eb = b.window.endMs ?? Number.POSITIVE_INFINITY;
        if (ea !== eb) return ea - eb;
        return b.remaining === null ? 1 : a.remaining === null ? -1 : b.remaining - a.remaining;
      });
  }

  private selectRunner(task: Task, provider?: string): RunnerName | undefined {
    const name = this.config.runners.default;
    if (!this.runners[name]) return undefined;
    if (provider && !this.runnerRoutes[provider]) return undefined; // 该 provider 没有 dsh 路由
    if (name === "dsh") {
      const hasPrompt = Boolean(task.spec.prompt ?? task.spec.cmd?.length);
      return hasPrompt ? name : undefined;
    }
    return undefined;
  }

  private async spawn(
    task: Task,
    chosen: { bucket: Bucket; model: ResolvedModel; est: number; runner: RunnerName; reason: string },
    now: number,
    report: TickReport,
  ): Promise<boolean> {
    if (!this.store.transition(task.id, ["submitted", "queued", "deferred"], "admitted")) {
      return false;
    }
    if (!this.store.transition(task.id, ["admitted"], "running")) {
      return false;
    }
    const runId = uid("run");
    const assignmentId = uid("asg");
    const runDir = path.join(this.config.engine.artifactsDir, task.id, runId);
    // 每 task 固定工作目录（dsh session 按 cwd 绑定）
    const workDir = task.workDir ?? path.join(this.config.engine.workDir, task.id);
    if (!task.workDir) this.store.updateTask(task.id, { workDir });
    fs.mkdirSync(workDir, { recursive: true });
    const route: Record<string, string> = {
      LCS_PROVIDER: chosen.bucket.provider,
      LCS_MODEL: chosen.model.model,
      LCS_FAMILY: chosen.model.family,
      LCS_ASSIGNMENT_ID: assignmentId,
      LCS_TASK_ID: task.id,
      LCS_RUN_ID: runId,
    };
    const dshRoute = this.runnerRoutes[chosen.bucket.provider]?.route;
    if (dshRoute) route.LCS_DSH_ROUTE = dshRoute;
    const assignment: Assignment = {
      id: assignmentId,
      taskId: task.id,
      provider: chosen.bucket.provider,
      model: chosen.model.model,
      dshRoute,
      runner: chosen.runner,
      est: chosen.est,
      route,
      createdAt: now,
    };
    const run: Run = {
      id: runId,
      taskId: task.id,
      assignmentId,
      provider: chosen.bucket.provider,
      model: chosen.model.model,
      runner: chosen.runner,
      sessionId: task.checkpoint?.sessionId ?? null,
      dshProfile: this.config.runners.dsh.profile,
      bucketKey: bucketKey(chosen.bucket),
      est: chosen.est,
      pid: null,
      startedAt: now,
      endedAt: null,
      status: "running",
      exitCode: null,
      verified: null,
      artifacts: [],
      usage: {},
      quotaDelta: null,
      runDir,
      logPath: path.join(runDir, "stdout.log"),
      windowEndMs: chosen.bucket.window.endMs,
    };
    const runner = this.runners[chosen.runner];
    if (!runner) {
      this.store.transition(task.id, ["running"], "failed", { error: "runner 不存在" });
      return false;
    }
    try {
      run.pid = await runner.spawn({ task, assignment, run });
    } catch (error) {
      this.store.transition(task.id, ["running"], "failed", {
        error: `spawn 失败: ${String(error)}`,
      });
      report.errors.push(`spawn ${task.id}: ${String(error)}`);
      return false;
    }
    this.store.addRun(run);
    const spawnLog: SpawnLog = {
      taskId: task.id,
      runId,
      assignmentId,
      provider: chosen.bucket.provider,
      model: chosen.model.model,
      runner: chosen.runner,
      est: chosen.est,
    };
    report.spawned.push(spawnLog);
    log(
      `spawn ${task.id} → ${chosen.bucket.provider}/${chosen.model.model} runner=${chosen.runner} est=${chosen.est.toFixed(2)}`,
    );
    return true;
  }

  private runnerFor(run: Run) {
    const runner = this.runners[run.runner] ?? this.runners.dsh;
    if (!runner) throw new Error(`runner 不可用: ${run.runner}`);
    return runner;
  }

  private calibrationFor(task: Task, bucket: Bucket): number | undefined {
    const calib = this.store.calibrationGet(task.taskClass, bucket.provider, bucketKey(bucket));
    if (!calib) return undefined;
    if (calib.n < this.config.policy.calibrationMinSamples) return undefined;
    return calib.ewma;
  }

  private selfBusy(bucket: Bucket, now: number): boolean {
    const lookbackMs = this.config.policy.activityLookbackMinutes * 60000;
    if (lookbackMs <= 0 || this.config.policy.activityDropThresholdPct <= 0) return false;
    const key = bucketKey(bucket);
    const samples = this.store
      .recentSamples(key, now - lookbackMs)
      .filter((s) => s.remaining !== null);
    if (samples.length < 2) return false;
    if (this.store.runningRuns().some((r) => r.bucketKey === key)) return false;
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (first.remaining === null || last.remaining === null) return false;
    const attributed = this.store
      .runsBetween(key, first.ts, now)
      .filter((r) => r.status === "succeeded")
      .reduce((sum, r) => sum + r.est, 0);
    const drop = first.remaining - last.remaining;
    return drop - attributed >= this.config.policy.activityDropThresholdPct;
  }

  private logDecision(
    report: TickReport,
    decision: Omit<DecisionLog, "tickId" | "now" | "primary"> & { primary?: boolean },
  ): void {
    report.decisions.push({
      tickId: report.tickId,
      now: report.now,
      primary: true,
      ...decision,
    });
  }

  // ---------------------------------------------------------------- 快照

  /**
   * 跑一轮清理（或只预览）。
   *
   * 只处理 LCS 自己登记过的会话与产物，路径限定在 `engine.dshHome` 内。
   * 每次动作写一条审计（`store.gcLog`），Web「清理审计」与 `lcs-mcp gc` 共用。
   */
  runGc(options: { dryRun?: boolean; maxPerCall?: number } = {}): GcResult {
    const now = this.now();
    const result = gcExpired(this.config, this.store, now, options);
    for (const detail of result.details) {
      this.store.appendGcLog({
        ts: now,
        dryRun: result.dryRun,
        taskId: detail.taskId,
        sessionId: detail.sessionId,
        removedSessions: detail.sessionRemoved ? 1 : 0,
        removedProjections: detail.projectionRemoved ? 1 : 0,
        removedArtifacts: detail.artifactsRemoved ? 1 : 0,
      });
    }
    if (result.removedSessions > 0 || result.removedArtifacts > 0) {
      log(
        `gc: ${result.dryRun ? "[预览] 将" : ""}清理会话 ${result.removedSessions} 个、` +
          `投影 ${result.removedProjections} 个、产物 ${result.removedArtifacts} 份` +
          `（隔离家目录内；陌生会话 ${result.foreignSessions} 个不动）`,
      );
    }
    this.store.persist();
    return result;
  }

  /** 最近清理审计（最新在前）。 */
  recentGc(limit = 20): GcLogEntry[] {
    return this.store.gcLog.slice(0, limit);
  }

  snapshot(): Record<string, unknown> {
    const now = this.now();
    const buckets: BucketSnapshot[] = this.lastBuckets.map((b) =>
      describeBucket(b, now, this.policy.reserveFn.reservePct(b, now)),
    );
    const queue = this.store
      .queuedTasks()
      .sort((a, b) => taskScore(b, now, this.config.policy) - taskScore(a, now, this.config.policy));
    const running = this.store.runningRuns();
    return {
      now,
      scheduler: this.schedulerState(),
      gc: {
        // 清理只发生在 LCS 专用家目录内；这里把「删了什么」摊开给用户审
        dshHome: this.config.engine.dshHome,
        sessionRetentionDays: this.config.engine.sessionRetentionDays,
        recent: this.recentGc(10),
      },
      policy: {
        name: this.config.policy.name,
        burnLeadMinutes: this.config.policy.burnLeadMinutes,
        minReservePct: this.config.policy.minReservePct,
        workHoursOpportunistic: this.config.policy.workHoursOpportunistic,
        usage: this.config.policy.usage,
        maxAttempts: this.config.policy.maxAttempts,
        maxParallel: this.config.engine.maxParallel,
        maxConcurrentPerBucket: this.config.policy.maxConcurrentPerBucket,
      },
      providers: this.config.providers.map((p) => ({
        name: p.name,
        kind: p.kind,
        enabled: p.enabled,
      })),
      runners: {
        default: this.config.runners.default,
        available: Object.keys(this.runners),
      },
      buckets,
      bucketsStaleSeconds:
        this.lastTickAt === null ? null : Math.round((now - this.lastTickAt) / 1000),
      taskCounts: this.store.taskCounts(),
      queue: queue.slice(0, 100).map((t) => this.taskSummary(t, now)),
      running: running.map((r) => this.runSummary(r)),
      recentRuns: this.store.recentRuns(30).map((r) => this.runSummary(r)),
      recentDecisions: this.recentDecisions.slice(0, 100),
      lastTick: this.store.lastTick
        ? {
            tickId: this.store.lastTick.tickId,
            now: this.store.lastTick.now,
            durationMs: this.store.lastTick.durationMs,
            spawned: this.store.lastTick.spawned.length,
            reaped: this.store.lastTick.reaped.length,
            interrupted: this.store.lastTick.interrupted.length,
            requeued: this.store.lastTick.requeued,
            expired: this.store.lastTick.expired,
            errors: this.store.lastTick.errors,
          }
        : null,
    };
  }

  taskSummary(task: Task, now: number): Record<string, unknown> {
    return {
      id: task.id,
      taskClass: task.taskClass,
      state: task.state,
      value: task.value,
      attempts: task.attempts,
      score: Math.round(taskScore(task, now, this.config.policy) * 100) / 100,
      deadlineMs: task.deadlineMs,
      nextEligibleAtMs: task.nextEligibleAtMs,
      hasCheckpoint: Boolean(task.checkpoint),
      priorityBoost: task.priorityBoost,
      runner: task.spec.runner ?? this.config.runners.default,
      cmd: task.spec.cmd ?? null,
      prompt: task.spec.prompt ?? null,
      resources: task.resources,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      error: task.error ?? null,
    };
  }

  runSummary(run: Run): Record<string, unknown> {
    return {
      id: run.id,
      taskId: run.taskId,
      provider: run.provider,
      model: run.model,
      runner: run.runner,
      status: run.status,
      est: run.est,
      pid: run.pid,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exitCode: run.exitCode,
      verified: run.verified,
      artifacts: run.artifacts,
      sessionId: run.sessionId ?? null,
      usage: run.usage ?? {},
      quotaDelta: run.quotaDelta,
      windowEndMs: run.windowEndMs,
      error: run.error ?? null,
      runDir: run.runDir,
    };
  }
}

export function describeTaskState(state: TaskState): string {
  const labels: Record<TaskState, string> = {
    submitted: "已提交",
    queued: "排队中",
    deferred: "等待时机",
    admitted: "已准入",
    running: "执行中",
    succeeded: "成功",
    failed: "失败",
    cancelled: "已取消",
    expired: "已过期",
  };
  return labels[state];
}

export { isPaid, isPerishable, QUEUE_STATES };
export type { PeakSchedule };
