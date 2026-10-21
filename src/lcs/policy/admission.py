"""策略：准入控制（本引擎的内核）。

`burn_before_expiry` = 易逝容量的阈值策略：
- 只在「窗口尾段」或「非工作时段」开烧；
- 烧到 `reserve(t)` 就停；
- 付费型（depleting）反转：任务价值 > 成本才跑。

所有拒绝都带 `reason`，便于 CLI / 日志解释「为什么现在不跑」。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..config import PolicyConfig
from ..models import Bucket, Task
from .reserve import PeakSchedule, ReserveFunction, UsageModel
from .schedule import clamp


@dataclass(frozen=True)
class Decision:
    admit: bool
    reason: str
    est: float = 0.0
    reserve: float = 0.0
    excess: float = 0.0
    slots: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "admit": self.admit,
            "reason": self.reason,
            "est": round(self.est, 3),
            "reserve": round(self.reserve, 3),
            "excess": round(self.excess, 3),
            "slots": self.slots,
        }


class BurnBeforeExpiry:
    name = "burn_before_expiry"

    def __init__(
        self,
        policy: PolicyConfig,
        reserve_fn: ReserveFunction | None = None,
        peaks: PeakSchedule | None = None,
    ):
        self.policy = policy
        self.usage = UsageModel(policy.usage_profile)
        self.peaks = peaks or PeakSchedule(policy.peak_windows)
        self.reserve_fn = reserve_fn or ReserveFunction(policy, self.usage, self.peaks)

    # -- 预估 ---------------------------------------------------------------

    def estimate_usage(self, task: Task, bucket: Bucket, calibration: float | None) -> float:
        """预估一次执行会消耗多少桶单位（含安全系数）。"""
        resources = task.resources
        base: float | None = None

        if "est_pct" in resources:
            base = float(resources["est_pct"])
        elif f"{bucket.resource_kind}_pct" in resources:
            base = float(resources[f"{bucket.resource_kind}_pct"])
        elif "text_tokens" in resources:
            per_pct = bucket.raw.get("text_tokens_per_pct") or 50000
            try:
                per_pct = float(per_pct)
            except (TypeError, ValueError):
                per_pct = 50000.0
            if per_pct > 0:
                base = float(resources["text_tokens"]) / per_pct

        if base is None:
            base = calibration if calibration is not None else self.policy.default_est_pct
        return max(0.0, base) * self.policy.safety_factor

    def estimate_cost(self, task: Task, bucket: Bucket) -> float:
        """付费型任务成本（货币单位）。优先用任务显式 est_cost。"""
        if "est_cost" in task.resources:
            return float(task.resources["est_cost"])
        tokens = float(task.resources.get("text_tokens") or 0)
        price = float(bucket.raw.get("unit_price_per_1k_tokens") or 0.0)
        return tokens / 1000.0 * price

    # -- 强度 ---------------------------------------------------------------

    def slots(self, bucket: Bucket, now: datetime) -> int:
        """此刻允许的并发槽位（强度映射，DESIGN §4.2）。"""
        if bucket.paid:
            return max(0, self.policy.max_concurrent_per_bucket)
        pct = bucket.remaining if bucket.remaining is not None else 0.0
        if pct > 70:
            slots = 3
        elif pct > 40:
            slots = 2
        elif pct > 15:
            slots = 1
        else:
            slots = 0
        factor = self.peaks.slots_factor(now)
        if factor < 1.0 and slots > 0:
            slots = max(1, int(slots * factor))
        cap = self.policy.max_concurrent_per_bucket
        for c in bucket.constraints:
            if c.kind == "concurrency" and c.value:
                cap = min(cap, int(c.value))
        return max(0, min(slots, cap))

    # -- 时间门 -------------------------------------------------------------

    def schedule_allows(self, bucket: Bucket, now: datetime) -> tuple[bool, str]:
        """是否允许「现在开烧」。

        三条用户直觉：
        - 窗口结束前 `burn_lead_minutes` 内 → 必须开烧；
        - 非工作时间（深夜/周末）→ 一刷新就烧；
        - 工作时段中段 → 不烧（把额度留给用户自己）。
        """
        if self.reserve_fn.is_within_burn_lead(bucket, now):
            return True, "burn_lead"
        if not self.usage.is_work_time(now):
            return True, "idle_time"
        if self.policy.work_hours_opportunistic:
            return True, "opportunistic"
        return False, "work_hours_wait"

    # -- 准入 ---------------------------------------------------------------

    def decide(
        self,
        *,
        bucket: Bucket,
        task: Task,
        now: datetime,
        committed: float,
        running_count: int,
        self_busy: bool = False,
        calibration: float | None = None,
    ) -> Decision:
        if bucket.window.unlimited or bucket.window.lifecycle == "unlimited":
            return Decision(False, "unlimited")
        if not bucket.known:
            return Decision(False, "unknown")
        if task.value < self.policy.min_value:
            return Decision(False, "value")
        if self_busy:
            return Decision(False, "self_busy")

        if bucket.paid:
            return self._decide_paid(
                bucket=bucket,
                task=task,
                now=now,
                committed=committed,
                running_count=running_count,
                calibration=calibration,
            )

        if not bucket.perishable:
            return Decision(False, "not_schedulable")
        if bucket.window.end is None:
            return Decision(False, "no_window_end")

        reserve = self.reserve_fn.reserve_pct(bucket, now)
        remaining = float(bucket.remaining or 0.0)
        excess = remaining - committed - reserve
        est = self.estimate_usage(task, bucket, calibration)

        ok, why = self.schedule_allows(bucket, now)
        if not ok:
            return Decision(
                False, why, est=est, reserve=reserve, excess=excess,
                slots=self.slots(bucket, now),
            )

        if excess < est:
            return Decision(
                False, "reserve", est=est, reserve=reserve, excess=excess,
                slots=self.slots(bucket, now),
            )

        slots = self.slots(bucket, now)
        if running_count >= slots:
            return Decision(
                False, "slots", est=est, reserve=reserve, excess=excess, slots=slots
            )

        return Decision(
            True, "admit", est=est, reserve=reserve, excess=excess, slots=slots
        )

    def _decide_paid(
        self,
        *,
        bucket: Bucket,
        task: Task,
        now: datetime,
        committed: float,
        running_count: int,
        calibration: float | None,
    ) -> Decision:
        cost = self.estimate_cost(task, bucket)
        balance = float(bucket.remaining or 0.0)
        excess = balance - committed - cost
        slots = self.slots(bucket, now)

        if cost <= 0:
            return Decision(False, "no_cost_estimate", est=cost, excess=excess, slots=slots)
        # 烧钱策略反转：只有价值 > 机会成本（价格）才允许
        threshold = cost * self.policy.value_points_per_currency
        if task.value < threshold:
            return Decision(
                False, "not_worth_cost", est=cost, excess=excess, slots=slots
            )
        if excess < 0:
            return Decision(False, "balance", est=cost, excess=excess, slots=slots)
        if running_count >= slots:
            return Decision(False, "slots", est=cost, excess=excess, slots=slots)
        return Decision(True, "admit", est=cost, excess=excess, slots=slots)


__all__ = ["BurnBeforeExpiry", "Decision", "clamp"]
