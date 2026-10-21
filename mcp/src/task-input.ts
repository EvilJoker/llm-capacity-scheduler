/** 任务输入解析：MCP 工具与 Web API 共用同一套字段，保证两个入口行为一致。 */

import type { RunnerName, Task, TaskRequirements, TaskSpec } from "./types.js";
import { uid } from "./util.js";

export interface TaskInput {
  cmd?: string[];
  prompt?: string;
  runner?: RunnerName;
  cwd?: string;
  env?: Record<string, string>;
  timeout_s?: number;
  expected_duration_s?: number;
  verify_cmd?: string[];
  expect_artifacts?: string[];
  value?: number;
  est_pct?: number;
  tokens?: number;
  est_cost?: number;
  deadline?: string;
  task_class?: string;
  idempotency_key?: string;
  providers?: string[];
  model_family?: string;
  min_context?: number;
  modalities?: string[];
  quality_tier?: "cheap" | "standard" | "best";
}

function parseDeadline(input?: string): number | null {
  if (!input) return null;
  const normalized = input.trim().replace(" ", "T");
  const ms = Date.parse(normalized);
  if (!Number.isFinite(ms)) throw new Error(`无法解析 deadline: ${input}`);
  return ms;
}

export function buildTaskFromInput(input: {
  cmd?: string[];
  prompt?: string;
  runner?: RunnerName;
  cwd?: string;
  env?: Record<string, string>;
  timeout_s?: number;
  expected_duration_s?: number;
  verify_cmd?: string[];
  expect_artifacts?: string[];
  value?: number;
  est_pct?: number;
  tokens?: number;
  est_cost?: number;
  deadline?: string;
  task_class?: string;
  idempotency_key?: string;
  providers?: string[];
  model_family?: string;
  min_context?: number;
  modalities?: string[];
  quality_tier?: "cheap" | "standard" | "best";
}): Task {
  if (!input.cmd?.length && !input.prompt) {
    throw new Error("必须提供 cmd（shell 任务）或 prompt（LLM/dsh 任务）");
  }
  const spec: TaskSpec = {
    runner: input.runner,
    cmd: input.cmd,
    prompt: input.prompt,
    cwd: input.cwd,
    env: input.env,
    timeoutS: input.timeout_s,
    expectedDurationS: input.expected_duration_s,
    verifyCmd: input.verify_cmd,
    expectArtifacts: input.expect_artifacts,
  };
  const requirements: TaskRequirements = {};
  if (input.providers?.length) requirements.providers = input.providers;
  if (input.model_family) requirements.modelFamily = input.model_family;
  if (input.min_context) requirements.minContext = input.min_context;
  if (input.modalities?.length) requirements.modalities = input.modalities;
  if (input.quality_tier) requirements.qualityTier = input.quality_tier;

  const resources: Record<string, number> = {};
  if (input.est_pct !== undefined) resources.estPct = input.est_pct;
  if (input.tokens !== undefined) resources.text_tokens = input.tokens;
  if (input.est_cost !== undefined) resources.estCost = input.est_cost;

  return {
    id: uid("task"),
    idempotencyKey: input.idempotency_key ?? uid("auto"),
    taskClass: input.task_class ?? "default",
    spec,
    requirements,
    resources,
    value: input.value ?? 50,
    deadlineMs: parseDeadline(input.deadline),
    state: "submitted",
    attempts: 0,
    priorityBoost: 0,
    nextEligibleAtMs: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

