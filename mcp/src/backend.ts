/** MCP 工具后端：本地引擎直连，或代理到已运行守护进程（serve 模式）的 HTTP API。 */

import { redactConfig, type Config } from "./config.js";
import type { Engine } from "./engine.js";
import { buildTaskFromInput, type TaskInput } from "./task-input.js";
import type { Task } from "./types.js";
import { bucketKey, describeBucket } from "./types.js";

export interface SubmitResult {
  task_id: string;
  state: string;
  created: boolean;
  idempotency_key: string;
  note?: string;
}

export interface PollInput {
  ids?: string[];
  states?: string[];
  limit?: number;
}

export interface ToolBackend {
  submitTask(input: TaskInput): Promise<SubmitResult>;
  pollTasks(input: PollInput): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  status(): Promise<unknown>;
  observe(): Promise<unknown>;
  tick(): Promise<unknown>;
  getConfig(): Promise<unknown>;
}

export class LocalBackend implements ToolBackend {
  constructor(
    private readonly engine: Engine,
    private readonly configProvider: () => Config,
  ) {}

  async submitTask(input: TaskInput): Promise<SubmitResult> {
    const task = buildTaskFromInput(input);
    const { task: saved, created } = this.engine.store.submit(task);
    return {
      task_id: saved.id,
      state: saved.state,
      created,
      idempotency_key: saved.idempotencyKey,
      note: "任务已入队；state=deferred 表示引擎会在合适时机执行，请用 lcs_poll_tasks 取结果。",
    };
  }

  async pollTasks(input: PollInput): Promise<unknown> {
    const tasks = input.ids?.length
      ? input.ids
          .map((id) => this.engine.store.getTask(id))
          .filter((t): t is Task => Boolean(t))
      : this.engine.store.listTasks({
          states: input.states as Task["state"][] | undefined,
          limit: input.limit ?? 20,
          includeTerminal: true,
        });
    return tasks.map((task) => this.taskPayload(task));
  }

  private taskPayload(task: Task): unknown {
    const runs = this.engine.store.runsForTask(task.id);
    return {
      task_id: task.id,
      state: task.state,
      task_class: task.taskClass,
      value: task.value,
      attempts: task.attempts,
      deadline_ms: task.deadlineMs,
      has_checkpoint: Boolean(task.checkpoint),
      error: task.error ?? null,
      runs: runs.map((run) => ({
        run_id: run.id,
        status: run.status,
        provider: run.provider,
        model: run.model,
        runner: run.runner,
        started_at: run.startedAt,
        ended_at: run.endedAt,
        exit_code: run.exitCode,
        verified: run.verified,
        artifacts: run.artifacts,
        quota_delta: run.quotaDelta,
        error: run.error ?? null,
      })),
    };
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return { task_id: taskId, cancelled: this.engine.store.cancelTask(taskId) };
  }

  async status(): Promise<unknown> {
    return this.engine.snapshot();
  }

  async observe(): Promise<unknown> {
    const now = this.engine.now();
    const buckets = await this.engine.observeNow(now);
    return buckets.map((bucket) => ({
      ...describeBucket(bucket, now, this.engine.policy.reserveFn.reservePct(bucket, now)),
      key: bucketKey(bucket),
    }));
  }

  async tick(): Promise<unknown> {
    const report = await this.engine.tick();
    return {
      tick_id: report.tickId,
      now: report.now,
      spawned: report.spawned,
      reaped: report.reaped,
      interrupted: report.interrupted,
      requeued: report.requeued,
      expired: report.expired,
      decisions: report.decisions.slice(0, 30),
      errors: report.errors,
    };
  }

  async getConfig(): Promise<unknown> {
    return redactConfig(this.configProvider());
  }
}

export class HttpBackend implements ToolBackend {
  constructor(readonly baseUrl: string) {}

  private async request(pathname: string, init?: RequestInit): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${pathname}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    const text = await resp.text();
    const data = text ? JSON.parse(text) : null;
    if (!resp.ok) {
      throw new Error(
        `守护进程 API 失败 ${resp.status}: ${data && data.error ? data.error : text.slice(0, 200)}`,
      );
    }
    return data;
  }

  async submitTask(input: TaskInput): Promise<SubmitResult> {
    const data = (await this.request("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input),
    })) as { task_id: string; state: string; created: boolean };
    return {
      ...data,
      idempotency_key: input.idempotency_key ?? "",
      note: "任务已入队；state=deferred 表示引擎会在合适时机执行，请用 lcs_poll_tasks 取结果。",
    };
  }

  async pollTasks(input: PollInput): Promise<unknown> {
    if (input.ids?.length) {
      const out: unknown[] = [];
      for (const id of input.ids) {
        try {
          out.push(await this.request(`/api/tasks/${encodeURIComponent(id)}`));
        } catch {
          /* 不存在的 id 跳过 */
        }
      }
      return out;
    }
    const limit = input.limit ?? 20;
    const state = input.states?.length ? `state=${encodeURIComponent(input.states.join(","))}&` : "";
    return this.request(`/api/tasks?${state}limit=${limit}`);
  }

  async cancelTask(taskId: string): Promise<unknown> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" });
  }

  async status(): Promise<unknown> {
    return this.request("/api/status");
  }

  async observe(): Promise<unknown> {
    return this.request("/api/observe", { method: "POST" });
  }

  async tick(): Promise<unknown> {
    return this.request("/api/tick", { method: "POST" });
  }

  async getConfig(): Promise<unknown> {
    return this.request("/api/config");
  }
}
