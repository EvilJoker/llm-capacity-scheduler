/**
 * 领域模型：Task / Run / Assignment / Bucket / Decision。
 *
 * 设计定稿见 docs/MCP-DESIGN.md。所有时间在运行时与持久化中统一用 epoch ms。
 */

export type Lifecycle =
  | "fixed_grid"
  | "rolling_on_first_use"
  | "calendar"
  | "depleting"
  | "unlimited";

export type Unit = "pct" | "count" | "tokens" | "money";

export type TaskState =
  | "submitted"
  | "queued"
  | "deferred"
  | "admitted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export const ACTIVE_STATES: TaskState[] = [
  "submitted",
  "queued",
  "deferred",
  "admitted",
  "running",
];
export const TERMINAL_STATES: TaskState[] = [
  "succeeded",
  "failed",
  "cancelled",
  "expired",
];
export const QUEUE_STATES: TaskState[] = ["submitted", "queued", "deferred"];

export type RunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "interrupted"
  | "cancelled";

export type RunnerName = "dsh";

export interface CapacityWindow {
  lifecycle: Lifecycle;
  /** epoch ms；null = 不可知 */
  startMs: number | null;
  endMs: number | null;
  unlimited: boolean;
}

export interface Constraint {
  kind: "concurrency" | "rate_limit" | "throttle" | "budget";
  value?: number;
  start?: string;
  end?: string;
  note?: string;
}

export interface Bucket {
  provider: string;
  modelFamily: string;
  resourceKind: string;
  unit: Unit;
  window: CapacityWindow;
  /** 剩余量；null = 不可信 */
  remaining: number | null;
  source: "api" | "manual" | "mock" | "unknown";
  constraints: Constraint[];
  raw: Record<string, unknown>;
}

export interface TaskCheckpoint {
  /** dsh headless 的 session id，用于续跑 */
  sessionId?: string;
  /** shell 任务自己写回的进度数据 */
  data?: Record<string, unknown>;
  updatedAt: number;
}

export interface TaskSpec {
  /** 执行器；缺省用 config.runners.default */
  runner?: RunnerName;
  /** shell runner 的命令 */
  cmd?: string[];
  /** dsh runner 的任务文本 */
  prompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  /** 单次执行硬超时（秒） */
  timeoutS?: number;
  /** 预估单次执行时长（秒），用于「窗口装得下才开跑」 */
  expectedDurationS?: number;
  /** verifier 命令：exit 0 才算 succeeded */
  verifyCmd?: string[];
  /** 声明的产物（相对产物目录） */
  expectArtifacts?: string[];
}

export interface TaskRequirements {
  /** 允许的 provider 名；空 = 任意 */
  providers?: string[];
  modelFamily?: string;
  minContext?: number;
  modalities?: string[];
  qualityTier?: "cheap" | "standard" | "best";
}

export interface Task {
  id: string;
  /** 每 task 固定的工作目录（dsh session 接管要求 cwd 一致） */
  workDir?: string;
  idempotencyKey: string;
  taskClass: string;
  spec: TaskSpec;
  requirements: TaskRequirements;
  resources: Record<string, number>;
  value: number;
  deadlineMs: number | null;
  state: TaskState;
  attempts: number;
  priorityBoost: number;
  nextEligibleAtMs: number | null;
  checkpoint?: TaskCheckpoint;
  createdAt: number;
  updatedAt: number;
  /** 进入终态的时间，供会话/产物保留策略使用 */
  finishedAt?: number;
  error?: string;
}

export interface Assignment {
  id: string;
  taskId: string;
  provider: string;
  model: string;
  /** dsh 路由名（= agent-default-model.provider） */
  dshRoute?: string;
  runner: RunnerName;
  est: number;
  route: Record<string, string>;
  createdAt: number;
}

export interface Run {
  id: string;
  taskId: string;
  assignmentId: string;
  provider: string;
  model: string;
  runner: RunnerName;
  /** 本次运行使用的 dsh session（首跑结束后回填） */
  sessionId?: string | null;
  /** dsh profile 名 */
  dshProfile?: string;
  bucketKey: string;
  est: number;
  pid: number | null;
  startedAt: number;
  endedAt: number | null;
  status: RunStatus;
  exitCode: number | null;
  verified: boolean | null;
  artifacts: string[];
  usage: Record<string, unknown>;
  quotaDelta: number | null;
  runDir: string;
  logPath: string;
  windowEndMs: number | null;
  error?: string;
}

export interface RunResult {
  status: Exclude<RunStatus, "running">;
  endedAt: number;
  exitCode?: number | null;
  verified: boolean;
  artifacts: string[];
  usage?: Record<string, unknown>;
  error?: string;
  checkpoint?: TaskCheckpoint;
  /** dsh session id（续跑用） */
  sessionId?: string;
}

export interface Sample {
  bucketKey: string;
  provider: string;
  modelFamily: string;
  resourceKind: string;
  ts: number;
  remaining: number | null;
  unit: Unit;
  windowStartMs: number | null;
  windowEndMs: number | null;
  source: string;
}

export interface Decision {
  admit: boolean;
  reason: string;
  est: number;
  reserve: number;
  excess: number;
  slots: number;
}

export interface DecisionLog {
  tickId: number;
  now: number;
  taskId: string;
  bucket: string;
  provider: string;
  model?: string;
  windowEndMs: number | null;
  remaining: number | null;
  /** 被拒绝的 task 只记录第一条候选桶的原因，避免日志爆炸 */
  primary?: boolean;
  admit: boolean;
  reason: string;
  est: number;
  reserve: number;
  excess: number;
  slots: number;
}

export interface SpawnLog {
  taskId: string;
  runId: string;
  assignmentId: string;
  provider: string;
  model: string;
  runner: RunnerName;
  est: number;
}

export interface ReapLog {
  runId: string;
  taskId: string;
  status: RunStatus;
  exitCode: number | null;
  verified: boolean | null;
  artifacts: string[];
  quotaDelta: number | null;
  taskState: TaskState;
}

export interface TickReport {
  tickId: number;
  now: number;
  durationMs: number;
  buckets: BucketSnapshot[];
  spawned: SpawnLog[];
  reaped: ReapLog[];
  interrupted: ReapLog[];
  requeued: number;
  expired: number;
  decisions: DecisionLog[];
  errors: string[];
}

export interface BucketSnapshot {
  key: string;
  shortKey: string;
  provider: string;
  modelFamily: string;
  resourceKind: string;
  unit: Unit;
  lifecycle: Lifecycle;
  unlimited: boolean;
  remaining: number | null;
  source: string;
  windowStartMs: number | null;
  windowEndMs: number | null;
  minutesToEnd: number | null;
  perishable: boolean;
  paid: boolean;
  reservePct: number;
}

export function windowKey(w: CapacityWindow): string {
  const fmt = (ms: number | null) => (ms === null ? "-" : String(ms));
  return `${w.lifecycle}:${fmt(w.startMs)}:${fmt(w.endMs)}:${w.unlimited ? "U" : "-"}`;
}

export function bucketKey(b: {
  provider: string;
  modelFamily: string;
  resourceKind: string;
  window: CapacityWindow;
}): string {
  return `${b.provider}/${b.modelFamily}/${b.resourceKind}/${windowKey(b.window)}`;
}

export function bucketShortKey(b: {
  provider: string;
  modelFamily: string;
  resourceKind: string;
}): string {
  return `${b.provider}/${b.modelFamily}/${b.resourceKind}`;
}

export function isPerishable(b: Bucket): boolean {
  return (
    !b.window.unlimited &&
    (b.window.lifecycle === "fixed_grid" ||
      b.window.lifecycle === "rolling_on_first_use" ||
      b.window.lifecycle === "calendar")
  );
}

export function isPaid(b: Bucket): boolean {
  return b.window.lifecycle === "depleting" || b.unit === "money";
}

export function describeBucket(b: Bucket, now: number, reservePct: number): BucketSnapshot {
  const minutesToEnd =
    b.window.endMs === null ? null : (b.window.endMs - now) / 60000;
  return {
    key: bucketKey(b),
    shortKey: bucketShortKey(b),
    provider: b.provider,
    modelFamily: b.modelFamily,
    resourceKind: b.resourceKind,
    unit: b.unit,
    lifecycle: b.window.lifecycle,
    unlimited: b.window.unlimited,
    remaining: b.remaining,
    source: b.source,
    windowStartMs: b.window.startMs,
    windowEndMs: b.window.endMs,
    minutesToEnd: minutesToEnd === null ? null : Math.round(minutesToEnd * 10) / 10,
    perishable: isPerishable(b),
    paid: isPaid(b),
    reservePct: Math.round(reservePct * 100) / 100,
  };
}
