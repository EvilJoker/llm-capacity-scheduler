"""reserve(t) 是时间的函数：工作时段留量、尾段归零、深夜低、unlimited 不参与。"""

from __future__ import annotations

from datetime import datetime

from lcs.config import PolicyConfig, UsageProfile
from lcs.models import Bucket, Constraint, Window
from lcs.policy import ReserveFunction, UsageModel

WED = 2026, 10, 21  # 周三


def dt(h: int, m: int = 0, day: int = 21) -> datetime:
    return datetime(2026, 10, day, h, m)


def make_bucket(start: datetime, end: datetime, *, lifecycle="fixed_grid", unlimited=False, unit="pct", remaining=80.0):
    return Bucket(
        provider="fake",
        model_family="general",
        resource_kind="text_tokens",
        unit=unit,  # type: ignore[arg-type]
        window=Window(lifecycle=lifecycle, start=start, end=end, unlimited=unlimited),  # type: ignore[arg-type]
        remaining=remaining,
    )


def policy(**kwargs) -> PolicyConfig:
    base = dict(min_reserve_pct=5.0, burn_lead_minutes=30, safety_factor=1.5)
    base.update(kwargs)
    return PolicyConfig(**base)


def test_usage_model_work_rate():
    usage = UsageModel(UsageProfile())
    assert usage.is_work_time(dt(10, 0))
    assert usage.is_work_time(dt(19, 29))
    assert not usage.is_work_time(dt(19, 30))
    assert not usage.is_work_time(dt(8, 59))
    assert not usage.is_work_time(datetime(2026, 10, 24, 12, 0))  # 周六
    assert usage.rate_pct_per_hour(dt(12, 0)) == 8.0
    assert usage.rate_pct_per_hour(dt(23, 0)) == 0.5


def test_expected_self_usage_across_boundaries():
    usage = UsageModel(UsageProfile())
    # 06:00–11:00：3h 空闲(0.5) + 2h 工作(8) = 17.5
    total = usage.expected_self_usage_pct(dt(6), dt(11))
    assert abs(total - (3 * 0.5 + 2 * 8.0)) < 1e-6
    # 跨午夜
    total = usage.expected_self_usage_pct(dt(22), datetime(2026, 10, 22, 2, 0))
    assert abs(total - 4 * 0.5) < 1e-6


def test_reserve_is_high_mid_work_window():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(10), dt(15))
    # 10:00 时，预期自己还要用 5h × 8%/h = 40%
    assert abs(reserve.reserve_pct(bucket, dt(10)) - 40.0) < 1e-6


def test_reserve_drops_to_floor_near_expiry():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(10), dt(15))
    # 14:45 → 15 分钟 × 8%/h = 2% → 被 min_reserve 5% 托底
    assert abs(reserve.reserve_pct(bucket, dt(14, 45)) - 5.0) < 1e-6
    # 14:59 → 同样 5%
    assert abs(reserve.reserve_pct(bucket, dt(14, 59)) - 5.0) < 1e-6


def test_reserve_low_offhours():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(20), datetime(2026, 10, 22, 1, 0))
    # 20:00 深夜窗口：5h × 0.5%/h = 2.5% → 托底 5%
    assert abs(reserve.reserve_pct(bucket, dt(20)) - 5.0) < 1e-6


def test_reserve_work_window_spanning_morning():
    """06:00–11:00 窗口：reserve 把 09:00 上班后的自用算进去（自动修正「一刷新就烧」）。"""
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(6), dt(11))
    assert abs(reserve.reserve_pct(bucket, dt(6)) - 17.5) < 1e-6


def test_unlimited_not_counted():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(20), dt(23), lifecycle="unlimited", unlimited=True, remaining=None)
    assert reserve.reserve_pct(bucket, dt(20)) == 0.0


def test_unknown_window_end_blocks():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(10), dt(15))
    bucket.window = Window(lifecycle="fixed_grid", start=dt(10), end=None)
    assert reserve.reserve_pct(bucket, dt(10)) == 100.0


def test_paid_bucket_reserve_is_zero():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(10), dt(15), lifecycle="depleting", unit="money", remaining=10.0)
    assert reserve.reserve_pct(bucket, dt(10)) == 0.0


def test_burn_lead_detection():
    reserve = ReserveFunction(policy())
    bucket = make_bucket(dt(10), dt(15))
    assert not reserve.is_within_burn_lead(bucket, dt(14, 0))
    assert reserve.is_within_burn_lead(bucket, dt(14, 30))
    assert reserve.is_within_burn_lead(bucket, dt(14, 59))
