"""测试公共夹具：可控时钟 + 脚本化容量适配器。"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from lcs.config import Config, EngineConfig, PolicyConfig, UsageProfile
from lcs.models import Bucket, Task, TaskSpec, Window


class FakeClock:
    def __init__(self, now: datetime):
        self._now = now

    def __call__(self) -> datetime:
        return self._now

    def now(self) -> datetime:
        return self._now

    def set(self, dt: datetime) -> None:
        self._now = dt

    def advance(self, **kwargs: float) -> datetime:
        self._now = self._now + timedelta(**kwargs)
        return self._now


class ScriptedAdapter:
    """按「已完成 run 数」递减余量的假 provider，用于端到端验收。

    burn_per_run：每完成一次执行，余量下降多少个百分点。
    """

    name = "fake"

    def __init__(
        self,
        *,
        start: datetime,
        end: datetime,
        initial_remaining: float = 80.0,
        burn_per_run: float = 6.0,
        store=None,
        lifecycle: str = "fixed_grid",
        family: str = "general",
        resource_kind: str = "text_tokens",
        unit: str = "pct",
        remaining_override: float | None = None,
    ):
        self.start = start
        self.end = end
        self.initial_remaining = initial_remaining
        self.burn_per_run = burn_per_run
        self.store = store
        self.lifecycle = lifecycle
        self.family = family
        self.resource_kind = resource_kind
        self.unit = unit
        self.remaining_override = remaining_override
        self.observe_calls = 0

    def _bucket(self) -> Bucket:
        return Bucket(
            provider=self.name,
            model_family=self.family,
            resource_kind=self.resource_kind,
            unit=self.unit,  # type: ignore[arg-type]
            window=Window(
                lifecycle=self.lifecycle,  # type: ignore[arg-type]
                start=self.start,
                end=self.end,
            ),
            remaining=self.initial_remaining,
            source="api",
        )

    def observe(self, now: datetime) -> list[Bucket]:
        self.observe_calls += 1
        bucket = self._bucket()
        if self.remaining_override is not None:
            bucket.remaining = self.remaining_override
            return [bucket]
        completed = self.store.completed_runs_count(bucket.key) if self.store else 0
        bucket.remaining = max(0.0, self.initial_remaining - completed * self.burn_per_run)
        return [bucket]


@pytest.fixture
def tmp_config(tmp_path):
    return Config(
        engine=EngineConfig(
            tick_seconds=1,
            db_path=tmp_path / "state.db",
            artifacts_dir=tmp_path / "artifacts",
            log_dir=tmp_path / "logs",
        ),
        policy=PolicyConfig(
            burn_lead_minutes=30,
            min_reserve_pct=5.0,
            safety_factor=2.0,
            default_est_pct=3.0,
            max_concurrent_per_bucket=2,
            max_parallel_total=4,
            work_hours_opportunistic=False,
            activity_lookback_minutes=10,
            activity_drop_threshold_pct=1.0,
            usage_profile=UsageProfile(),
        ),
        providers=[],
        base_dir=tmp_path,
    )


def make_task(cmd: list[str], **kwargs) -> Task:
    return Task(
        id=Task.new_id(),
        idempotency_key=f"test-{Task.new_id()}",
        spec=TaskSpec(cmd=cmd, timeout_s=30),
        resources=kwargs.pop("resources", {}),
        value=kwargs.pop("value", 50.0),
        task_class=kwargs.pop("task_class", "default"),
        **kwargs,
    )
