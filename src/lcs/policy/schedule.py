"""时间语义：工作时间表 + 自用率积分 + 高峰窗口判定。

reserve(t) 的唯一输入是「从 t 到窗口结束，预期自己还要用掉多少」。
所有用户直觉规则（工作时段留量 / 尾段烧光 / 深夜立刻烧）都从这里涌现。
"""

from __future__ import annotations

from datetime import datetime, time, timedelta

from ..config import PeakWindow, PolicyConfig, UsageProfile


class UsageModel:
    """把「用户什么时候自己在用、用多快」抽象成一条分段时间速率曲线。"""

    def __init__(self, profile: UsageProfile):
        self.profile = profile

    def is_work_time(self, dt: datetime) -> bool:
        p = self.profile
        if dt.isoweekday() not in p.workdays:
            return False
        t = dt.time()
        return p.work_start <= t < p.work_end

    def rate_pct_per_hour(self, dt: datetime) -> float:
        """dt 这一刻的自用速率（百分点/小时）。"""
        if self.is_work_time(dt):
            return self.profile.work_rate_pct_per_hour
        return self.profile.offhours_rate_pct_per_hour

    def expected_self_usage_pct(self, start: datetime, end: datetime) -> float:
        """从 start 到 end 的预期自用量（百分点）。

        按 work_start / work_end / 午夜切段后解析积分，最多 7 天，避免逐分钟循环。
        """
        if end <= start:
            return 0.0
        total = 0.0
        cursor = start
        guard = 0
        while cursor < end:
            guard += 1
            if guard > 24 * 14:
                break
            next_boundary = self._next_boundary(cursor, end)
            hours = (next_boundary - cursor).total_seconds() / 3600.0
            total += hours * self.rate_pct_per_hour(cursor)
            cursor = next_boundary
        return total

    def _next_boundary(self, cursor: datetime, end: datetime) -> datetime:
        """返回下一次速率可能变化的时刻（工作日/周末、上班/下班、午夜）。"""
        p = self.profile
        candidates: list[datetime] = [end]

        # 下一个整点午夜
        midnight = datetime.combine(cursor.date() + timedelta(days=1), time(0, 0))
        candidates.append(midnight)
        # 今天 / 明天的上班、下班时刻
        for day_offset in (0, 1):
            day = cursor.date() + timedelta(days=day_offset)
            for boundary in (p.work_start, p.work_end):
                cand = datetime.combine(day, boundary)
                if cand > cursor:
                    candidates.append(cand)
        return min(c for c in candidates if c > cursor)


class PeakSchedule:
    """高峰限流时段：降档，不是禁止。"""

    def __init__(self, windows: list[PeakWindow]):
        self.windows = list(windows)

    def match(self, dt: datetime) -> PeakWindow | None:
        for w in self.windows:
            if dt.isoweekday() not in w.days:
                continue
            if w.start <= dt.time() < w.end:
                return w
        return None

    def is_peak(self, dt: datetime) -> bool:
        return self.match(dt) is not None

    def slots_factor(self, dt: datetime) -> float:
        w = self.match(dt)
        return w.slots_factor if w else 1.0

    def reserve_multiplier(self, dt: datetime) -> float:
        w = self.match(dt)
        return w.reserve_multiplier if w else 1.0


def clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, value))


__all__ = ["UsageModel", "PeakSchedule", "clamp", "PolicyConfig"]
