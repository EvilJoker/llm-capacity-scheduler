"""领域模型：容量窗口 / 容量桶 / 任务 / 租约。

设计原则（见 docs/DESIGN.md §2）：
- 通用性来自**三维正交分解**，不按 provider 写 if/else。
- 容量不是标量，而是 `Set[Bucket]`。
- `unlimited` 必须显式建模，绝不能当 100%。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

# ---------------------------------------------------------------------------
# 字面量类型
# ---------------------------------------------------------------------------

Lifecycle = Literal[
    "fixed_grid",          # 绝对时间栅格，到点归满（MiniMax 5h）
    "rolling_on_first_use",# 首次使用才开始计时（Claude 5h）
    "calendar",            # 周/月按日期归满
    "depleting",           # 只减不归满（Credits / PAYG 余额）
    "unlimited",           # 无限（MiniMax 老用户周限额）
]

Unit = Literal["pct", "count", "tokens", "money"]

ConstraintKind = Literal["rate_limit", "concurrency", "throttle", "budget"]

# 任务状态机（DESIGN §5.1）
TASK_STATES = (
    "submitted",
    "queued",
    "deferred",
    "admitted",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
)
TERMINAL_STATES = frozenset({"succeeded", "failed", "cancelled", "expired"})
ACTIVE_STATES = frozenset({"submitted", "queued", "deferred", "admitted", "running"})

RUN_STATUSES = ("running", "succeeded", "failed", "timeout", "killed")


def utcnow() -> datetime:
    """统一的 naive 本地时间（引擎全程使用本地时区 naive datetime）。"""
    return datetime.now()


# ---------------------------------------------------------------------------
# 容量
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Window:
    """一个容量窗口。

    `end` 是**唯一权威的刷新时刻**：每次都必须从 provider 读，绝不写死 cron。
    """

    lifecycle: Lifecycle
    start: datetime | None = None
    end: datetime | None = None
    unlimited: bool = False
    carry_over: bool = False
    label: str = ""

    def seconds_to_end(self, now: datetime) -> float | None:
        if self.end is None:
            return None
        return (self.end - now).total_seconds()

    def minutes_to_end(self, now: datetime) -> float | None:
        left = self.seconds_to_end(now)
        return None if left is None else left / 60.0

    def fraction_left(self, now: datetime) -> float | None:
        """窗口时间进度（0..1）。仅用于展示/调试，不参与配额计算。"""
        if self.start is None or self.end is None:
            return None
        total = (self.end - self.start).total_seconds()
        if total <= 0:
            return 0.0
        return max(0.0, min(1.0, (self.end - now).total_seconds() / total))

    def is_expired(self, now: datetime) -> bool:
        return self.end is not None and now >= self.end

    def key(self) -> str:
        fmt = "%Y%m%dT%H%M%S"
        start = self.start.strftime(fmt) if self.start else "-"
        end = self.end.strftime(fmt) if self.end else "-"
        return f"{self.lifecycle}:{start}:{end}:{'U' if self.unlimited else '-'}"


@dataclass(frozen=True)
class Constraint:
    """非配额窗口的约束：rate limit / 并发槽位 / 高峰限流 / 金额预算。

    这些**不易逝**，不该当"配额"去优化时机；只用于限流与降档。
    """

    kind: ConstraintKind
    value: float | None = None
    start_time: str | None = None  # "15:00"
    end_time: str | None = None    # "17:30"
    note: str = ""


@dataclass
class Bucket:
    """容量桶 = (provider, model_family, resource_kind, window) 上的一份余量。"""

    provider: str
    model_family: str
    resource_kind: str
    unit: Unit
    window: Window
    remaining: float | None
    constraints: tuple[Constraint, ...] = ()
    source: str = "api"  # api | manual | static | unknown
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def key(self) -> str:
        return f"{self.provider}/{self.model_family}/{self.resource_kind}/{self.window.key()}"

    @property
    def short_key(self) -> str:
        return f"{self.provider}/{self.model_family}/{self.resource_kind}"

    @property
    def known(self) -> bool:
        """余量是否可信。None / source=unknown 一律视为不可信 → 不烧。"""
        return self.remaining is not None and self.source != "unknown"

    @property
    def perishable(self) -> bool:
        """易逝：窗口结束即作废，需要挑时机烧。"""
        return self.window.lifecycle in (
            "fixed_grid",
            "rolling_on_first_use",
            "calendar",
        ) and not self.window.unlimited

    @property
    def paid(self) -> bool:
        """付费型：烧 = 花钱，策略反转。"""
        return self.window.lifecycle == "depleting" or self.unit == "money"

    def describe(self, now: datetime | None = None) -> dict[str, Any]:
        now = now or utcnow()
        return {
            "key": self.key,
            "short_key": self.short_key,
            "provider": self.provider,
            "model_family": self.model_family,
            "resource_kind": self.resource_kind,
            "unit": self.unit,
            "lifecycle": self.window.lifecycle,
            "unlimited": self.window.unlimited,
            "remaining": self.remaining,
            "source": self.source,
            "window_start": self.window.start.isoformat() if self.window.start else None,
            "window_end": self.window.end.isoformat() if self.window.end else None,
            "minutes_to_end": round(self.window.minutes_to_end(now) or 0.0, 1)
            if self.window.end
            else None,
            "perishable": self.perishable,
            "paid": self.paid,
        }


# ---------------------------------------------------------------------------
# 任务
# ---------------------------------------------------------------------------


@dataclass
class TaskSpec:
    """执行契约：交给外挂 runner 的东西。引擎不内建 agent loop。"""

    cmd: list[str] = field(default_factory=list)
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    timeout_s: int = 1800
    verify_cmd: list[str] | None = None
    expect_artifacts: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "cmd": self.cmd,
            "cwd": self.cwd,
            "env": self.env,
            "timeout_s": self.timeout_s,
            "verify_cmd": self.verify_cmd,
            "expect_artifacts": self.expect_artifacts,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "TaskSpec":
        return cls(
            cmd=list(d.get("cmd") or []),
            cwd=d.get("cwd"),
            env=dict(d.get("env") or {}),
            timeout_s=int(d.get("timeout_s") or 1800),
            verify_cmd=list(d["verify_cmd"]) if d.get("verify_cmd") else None,
            expect_artifacts=list(d.get("expect_artifacts") or []),
        )


@dataclass
class Requirements:
    """任务对 provider 的硬性要求（能力匹配，而非容量）。"""

    providers: list[str] = field(default_factory=list)  # 空 = 任意
    model_family: str | None = None
    min_context: int | None = None
    modalities: list[str] = field(default_factory=lambda: ["text"])
    quality_tier: str = "standard"

    def to_dict(self) -> dict[str, Any]:
        return {
            "providers": self.providers,
            "model_family": self.model_family,
            "min_context": self.min_context,
            "modalities": self.modalities,
            "quality_tier": self.quality_tier,
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Requirements":
        return cls(
            providers=list(d.get("providers") or []),
            model_family=d.get("model_family"),
            min_context=d.get("min_context"),
            modalities=list(d.get("modalities") or ["text"]),
            quality_tier=d.get("quality_tier") or "standard",
        )


@dataclass
class Task:
    """一条待调度任务。声明的是资源需求向量 + 价值 + deadline。"""

    id: str
    idempotency_key: str
    spec: TaskSpec
    requirements: Requirements = field(default_factory=Requirements)
    resources: dict[str, float] = field(default_factory=dict)
    value: float = 50.0
    deadline: datetime | None = None
    task_class: str = "default"
    state: str = "submitted"
    attempts: int = 0
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    @staticmethod
    def new_id() -> str:
        return "task_" + uuid.uuid4().hex[:12]

    @property
    def value_density(self) -> float:
        """贪心排序用：价值 / 预估单位消耗。没有 est 时退化为 value。"""
        est = self.resources.get("est_pct") or self.resources.get("est_cost") or 1.0
        return self.value / max(float(est), 1e-9)

    def is_expired(self, now: datetime) -> bool:
        return self.deadline is not None and now >= self.deadline

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "idempotency_key": self.idempotency_key,
            "spec": self.spec.to_dict(),
            "requirements": self.requirements.to_dict(),
            "resources": self.resources,
            "value": self.value,
            "deadline": self.deadline.isoformat() if self.deadline else None,
            "task_class": self.task_class,
            "state": self.state,
            "attempts": self.attempts,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
        }


@dataclass
class Run:
    """一次具体执行（租约的载体）。"""

    id: str
    task_id: str
    provider: str
    model: str
    bucket_key: str
    est: float
    pid: int | None
    started_at: datetime
    ended_at: datetime | None = None
    status: str = "running"
    exit_code: int | None = None
    verified: bool | None = None
    artifacts: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    quota_delta: float | None = None
    log_path: str | None = None
    run_dir: str | None = None
    error: str | None = None

    @staticmethod
    def new_id() -> str:
        return "run_" + uuid.uuid4().hex[:12]

    @property
    def duration_s(self) -> float | None:
        if self.ended_at is None:
            return None
        return (self.ended_at - self.started_at).total_seconds()

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "task_id": self.task_id,
            "provider": self.provider,
            "model": self.model,
            "bucket_key": self.bucket_key,
            "est": self.est,
            "pid": self.pid,
            "started_at": self.started_at.isoformat(),
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
            "status": self.status,
            "exit_code": self.exit_code,
            "verified": self.verified,
            "artifacts": self.artifacts,
            "usage": self.usage,
            "quota_delta": self.quota_delta,
            "log_path": self.log_path,
            "run_dir": self.run_dir,
            "error": self.error,
        }
