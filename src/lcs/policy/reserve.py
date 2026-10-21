"""reserve(t)：从 t 到窗口过期，预期自己还要用掉的容量（机会成本 / 期权价值）。

准入条件（DESIGN §3.1）：
    remaining(t) - committed_inflight - est(new_task) > reserve(t)

三个性质：
1. 是时间函数，不是配置常量；
2. `unlimited` 维度不参与公式（没有机会成本）；
3. `depleting`（付费）维度的阈值是**价格**而非用量，走 admission 的付费分支。
"""

from __future__ import annotations

from datetime import datetime

from ..config import PolicyConfig
from ..models import Bucket
from .schedule import PeakSchedule, UsageModel, clamp


class ReserveFunction:
    def __init__(
        self,
        policy: PolicyConfig,
        usage: UsageModel | None = None,
        peaks: PeakSchedule | None = None,
    ):
        self.policy = policy
        self.usage = usage or UsageModel(policy.usage_profile)
        self.peaks = peaks or PeakSchedule(policy.peak_windows)

    def reserve_pct(self, bucket: Bucket, now: datetime) -> float:
        """返回该桶此刻应保留的余量（百分点 / 与 bucket.unit 同单位）。

        - unlimited：0（没有机会成本，但也不会被调度）
        - 付费（depleting）：0（阈值是价格，由 admission 单独处理）
        - 窗口无 end（不可知）：100（观测不可信，坚决不烧）
        - 其他：max(预期自用量, min_reserve_pct)，上限 100
        """
        window = bucket.window
        if window.unlimited or window.lifecycle == "unlimited":
            return 0.0
        if bucket.paid:
            return 0.0
        if window.end is None:
            # 无法知道何时作废 → 保守：完全不烧
            return 100.0

        expected = self.usage.expected_self_usage_pct(now, window.end)
        expected *= self.peaks.reserve_multiplier(now)
        return clamp(max(expected, self.policy.min_reserve_pct))

    def is_within_burn_lead(self, bucket: Bucket, now: datetime) -> bool:
        left = bucket.window.minutes_to_end(now)
        if left is None:
            return False
        return left <= self.policy.burn_lead_minutes


__all__ = ["ReserveFunction", "UsageModel", "PeakSchedule", "clamp"]
