"""引擎：tick + reconcile 主循环（DESIGN §1 / §6）。

每个 tick：
    1. observe   —— 读全部 provider 的容量快照，落库
    2. reconcile —— 收口已结束的 run、清理孤儿任务、过期任务
    3. dispatch  —— 准入控制：价值密度排序 + reserve 阈值 + 强度槽位
    4. sleep

为什么不是事件驱动：崩溃后天然可重入、每次全量对账不会 drift、易测试。
"""

from __future__ import annotations

import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Callable

from .capacity import Adapter, build_adapters
from .config import Config
from .models import Bucket, Run, Task, utcnow
from .policy import BurnBeforeExpiry, Decision
from .runner import Runner, ShellRunner
from .taskstore import TaskStore


@dataclass
class TickReport:
    now: datetime
    buckets: list[Bucket] = field(default_factory=list)
    spawned: list[dict[str, Any]] = field(default_factory=list)
    reaped: list[dict[str, Any]] = field(default_factory=list)
    expired: int = 0
    requeued: int = 0
    decisions: list[dict[str, Any]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "now": self.now.isoformat(),
            "buckets": [b.describe(self.now) for b in self.buckets],
            "spawned": self.spawned,
            "reaped": self.reaped,
            "expired": self.expired,
            "requeued": self.requeued,
            "decisions": self.decisions,
            "errors": self.errors,
        }


class Engine:
    def __init__(
        self,
        config: Config,
        *,
        store: TaskStore | None = None,
        adapters: list[Adapter] | None = None,
        runner: Runner | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        self.config = config
        self.clock = clock or utcnow
        self.store = store or TaskStore(config.engine.db_path)
        self.adapters = adapters if adapters is not None else build_adapters(
            config.enabled_providers()
        )
        self.runner = runner or ShellRunner(
            config.engine.artifacts_dir, base_dir=config.base_dir
        )
        self.policy = BurnBeforeExpiry(config.policy)
        self._last_errors: list[str] = []

    # -- 观测 ---------------------------------------------------------------

    def observe(self, now: datetime) -> list[Bucket]:
        buckets: list[Bucket] = []
        for adapter in self.adapters:
            try:
                observed = adapter.observe(now)
            except Exception as exc:  # noqa: BLE001 - adapter 契约要求不抛，但防御一下
                observed = []
                self._last_errors.append(f"{adapter.name}: {exc}")
            for bucket in observed:
                try:
                    self.store.record_sample(bucket, now)
                except Exception as exc:  # noqa: BLE001
                    self._last_errors.append(f"record_sample: {exc}")
                buckets.append(bucket)
        return buckets

    # -- 主 tick ------------------------------------------------------------

    def tick(self, now: datetime | None = None) -> TickReport:
        now = now or self.clock()
        self._last_errors = []
        report = TickReport(now=now)

        try:
            report.buckets = self.observe(now)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"observe failed: {exc}\n{traceback.format_exc(limit=3)}")

        try:
            report.reaped = self.reap(now, report.buckets)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"reap failed: {exc}\n{traceback.format_exc(limit=3)}")

        try:
            report.requeued = self.reconcile_orphans()
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"reconcile failed: {exc}")

        try:
            report.expired = self.store.expire_tasks(now)
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"expire failed: {exc}")

        try:
            spawned, decisions = self.dispatch(now, report.buckets)
            report.spawned = spawned
            report.decisions = decisions
        except Exception as exc:  # noqa: BLE001
            report.errors.append(f"dispatch failed: {exc}\n{traceback.format_exc(limit=3)}")

        report.errors.extend(self._last_errors)
        return report

    def run_forever(self, *, max_ticks: int | None = None) -> None:
        """常驻循环。Ctrl-C 退出。"""
        ticks = 0
        try:
            while True:
                report = self.tick()
                ticks += 1
                if report.errors:
                    print(f"[lcs] tick errors: {report.errors}", flush=True)
                if report.spawned or report.reaped:
                    print(
                        f"[lcs] spawned={len(report.spawned)} reaped={len(report.reaped)} "
                        f"expired={report.expired} requeued={report.requeued}",
                        flush=True,
                    )
                if max_ticks is not None and ticks >= max_ticks:
                    return
                time.sleep(self.config.engine.tick_seconds)
        except KeyboardInterrupt:
            return

    # -- 收口 ---------------------------------------------------------------

    def reap(self, now: datetime, buckets: list[Bucket]) -> list[dict[str, Any]]:
        bucket_map = {b.key: b for b in buckets}
        results: list[dict[str, Any]] = []
        for run in self.store.running_runs():
            task = self.store.get_task(run.task_id)
            if task is None:
                self.store.update_run(
                    run.id, status="failed", ended_at=now, error="task 不存在"
                )
                continue
            try:
                result = self.runner.poll(task, run, now)
            except Exception as exc:  # noqa: BLE001
                result = None
                self._last_errors.append(f"poll {run.id}: {exc}")
            if result is None:
                continue

            quota_delta = self._quota_delta(run, bucket_map.get(run.bucket_key), now)
            self.store.update_run(
                run.id,
                status=result.status,
                ended_at=result.ended_at,
                exit_code=result.exit_code,
                verified=result.verified,
                artifacts=result.artifacts,
                usage=result.usage,
                error=result.error,
                quota_delta=quota_delta,
            )
            final_state = "succeeded" if result.status == "succeeded" else "failed"
            self.store.transition(
                task.id, ("running", "admitted"), final_state, error=result.error
            )
            if quota_delta is not None and quota_delta > 0:
                self.store.calibration_update(
                    task.task_class, run.provider, run.bucket_key, quota_delta
                )
            results.append(
                {
                    "run_id": run.id,
                    "task_id": task.id,
                    "status": result.status,
                    "exit_code": result.exit_code,
                    "verified": result.verified,
                    "artifacts": result.artifacts,
                    "quota_delta": quota_delta,
                }
            )
        return results

    def _quota_delta(
        self, run: Run, bucket: Bucket | None, now: datetime
    ) -> float | None:
        """本次执行消耗的配额（百分点）。与 run 开始前的最近样本对比。

        并发批次无法归因到单个 run（多个 run 共享同一段采样区间）→ 返回 None，
        宁可没有校准数据，也不要污染 EWMA。
        """
        if bucket is None or bucket.remaining is None:
            return None
        prev = self.store.last_sample_before(run.bucket_key, run.started_at)
        if not prev or prev.get("remaining") is None:
            return None
        concurrent = [
            r
            for r in self.store.runs_between(run.bucket_key, prev["ts"], now)
            if r.id != run.id
        ]
        if concurrent:
            return None
        return max(0.0, float(prev["remaining"]) - float(bucket.remaining))

    def reconcile_orphans(self) -> int:
        """状态是 running/admitted 但没有任何在飞 run 的任务：重排或判失败。"""
        max_attempts = 2
        requeued = 0
        for state in ("admitted", "running"):
            for task in self.store.tasks_in_states((state,)):
                runs = self.store.runs_for_task(task.id)
                if any(r.status == "running" for r in runs):
                    continue
                if task.attempts < max_attempts:
                    if self.store.transition(
                        task.id, (state,), "queued", attempts=task.attempts + 1
                    ):
                        requeued += 1
                else:
                    self.store.transition(
                        task.id, (state,), "failed", error="orphan: 无在飞 run，重试次数用尽"
                    )
        return requeued

    # -- 派发 ---------------------------------------------------------------

    def dispatch(
        self, now: datetime, buckets: list[Bucket]
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        spawned: list[dict[str, Any]] = []
        decisions: list[dict[str, Any]] = []

        running = self.store.running_runs()
        if len(running) >= self.config.policy.max_parallel_total:
            return spawned, decisions

        committed = self.store.committed_by_bucket()
        running_count = self.store.running_count_by_bucket()
        total_running = len(running)

        tasks = self.store.tasks_in_states(("submitted", "queued", "deferred"))
        # 归一化状态：submitted → queued
        for task in tasks:
            if task.state == "submitted":
                self.store.transition(task.id, ("submitted",), "queued")
                task.state = "queued"
        tasks.sort(key=lambda t: (-t.value_density, t.deadline or datetime.max))

        for task in tasks:
            if total_running >= self.config.policy.max_parallel_total:
                break
            if task.is_expired(now):
                self.store.transition(
                    task.id, ("queued", "deferred"), "expired", error="deadline 已过"
                )
                continue

            candidates = self._candidates(task, buckets)
            if not candidates:
                decisions.append(
                    {
                        "task_id": task.id,
                        "reason": "no_bucket",
                        "provider_requirements": task.requirements.providers,
                        "model_family": task.requirements.model_family,
                    }
                )
                continue

            chosen: tuple[Bucket, Decision] | None = None
            for bucket in candidates:
                calibration, samples = self.store.calibration_get(
                    task.task_class, bucket.provider, bucket.key
                )
                if samples < self.config.policy.calibration_min_samples:
                    calibration = None
                decision = self.policy.decide(
                    bucket=bucket,
                    task=task,
                    now=now,
                    committed=committed.get(bucket.key, 0.0),
                    running_count=running_count.get(bucket.key, 0),
                    self_busy=self._self_busy(bucket, now),
                    calibration=calibration,
                )
                decisions.append(
                    {
                        "task_id": task.id,
                        "bucket": bucket.short_key,
                        "window_end": bucket.window.end.isoformat()
                        if bucket.window.end
                        else None,
                        "remaining": bucket.remaining,
                        **decision.to_dict(),
                    }
                )
                if decision.admit:
                    chosen = (bucket, decision)
                    break

            if chosen is None:
                if task.state == "queued":
                    self.store.transition(task.id, ("queued",), "deferred")
                continue

            bucket, decision = chosen
            run = self._spawn(task, bucket, decision, now)
            if run is None:
                continue
            committed[bucket.key] = committed.get(bucket.key, 0.0) + decision.est
            running_count[bucket.key] = running_count.get(bucket.key, 0) + 1
            total_running += 1
            spawned.append(
                {
                    "task_id": task.id,
                    "run_id": run.id,
                    "bucket": bucket.short_key,
                    "est": round(decision.est, 2),
                }
            )
        return spawned, decisions

    def _spawn(
        self, task: Task, bucket: Bucket, decision: Decision, now: datetime
    ) -> Run | None:
        if not self.store.transition(task.id, ("submitted", "queued", "deferred"), "admitted"):
            return None
        if not self.store.transition(task.id, ("admitted",), "running"):
            return None

        run = Run(
            id=Run.new_id(),
            task_id=task.id,
            provider=bucket.provider,
            model=bucket.model_family,
            bucket_key=bucket.key,
            est=decision.est,
            pid=None,
            started_at=now,
        )
        try:
            run.pid = self.runner.spawn(task, run)
        except Exception as exc:  # noqa: BLE001
            self.store.transition(
                task.id, ("running",), "failed", error=f"spawn 失败: {exc}"
            )
            self._last_errors.append(f"spawn {task.id}: {exc}")
            return None
        self.store.add_run(run)
        return run

    def _candidates(self, task: Task, buckets: list[Bucket]) -> list[Bucket]:
        out: list[Bucket] = []
        req = task.requirements
        for bucket in buckets:
            if req.providers and bucket.provider not in req.providers:
                continue
            if req.model_family and bucket.model_family != req.model_family:
                continue
            out.append(bucket)
        # 越临近作废的桶越优先烧（易逝品先到期先处理）
        out.sort(key=lambda b: b.window.seconds_to_end(self.clock()) or float("inf"))
        return out

    def _self_busy(self, bucket: Bucket, now: datetime) -> bool:
        """自用活跃检测：回看窗口内余量下降（扣除引擎自己烧的）超过阈值 → 让路。"""
        lookback = self.config.policy.activity_lookback_minutes
        threshold = self.config.policy.activity_drop_threshold_pct
        if lookback <= 0 or threshold <= 0:
            return False
        since = now - timedelta(minutes=lookback)
        samples = self.store.recent_samples(bucket.key, since)
        if len(samples) < 2:
            return False
        first, last = samples[0], samples[-1]
        if first["remaining"] is None or last["remaining"] is None:
            return False
        running = [r for r in self.store.running_runs() if r.bucket_key == bucket.key]
        if running:
            return False
        # 引擎自己烧掉的额度不计入「用户在自用」：用 est 保守高估（宁可少判 busy）
        attributed = sum(
            r.est
            for r in self.store.runs_between(bucket.key, since, now)
            if r.status == "succeeded"
        )
        total_drop = float(first["remaining"]) - float(last["remaining"])
        self_drop = total_drop - attributed
        return self_drop >= threshold

    # -- 展示 ---------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        now = self.clock()
        buckets = self.observe(now)
        running = self.store.running_runs()
        return {
            "now": now.isoformat(),
            "policy": self.config.policy.name,
            "buckets": [b.describe(now) for b in buckets],
            "task_counts": self.store.counts(),
            "running": [r.to_dict() for r in running],
            "committed": self.store.committed_by_bucket(),
        }


__all__ = ["Engine", "TickReport"]
