"""准入控制：工作时段不烧 / 尾段烧 / 烧到 reserve 停 / 付费反转 / unknown 不烧。"""

from __future__ import annotations

from datetime import datetime

from lcs.config import PeakWindow, PolicyConfig, UsageProfile
from lcs.models import Bucket, Task, TaskSpec, Window
from lcs.policy import BurnBeforeExpiry

WED = 21


def dt(h: int, m: int = 0) -> datetime:
    return datetime(2026, 10, WED, h, m)


def bucket(start=dt(10), end=dt(15), *, remaining=80.0, lifecycle="fixed_grid",
           unlimited=False, unit="pct", source="api", raw=None) -> Bucket:
    return Bucket(
        provider="fake",
        model_family="general",
        resource_kind="text_tokens",
        unit=unit,  # type: ignore[arg-type]
        window=Window(lifecycle=lifecycle, start=start, end=end, unlimited=unlimited),  # type: ignore[arg-type]
        remaining=remaining,
        source=source,
        raw=raw or {},
    )


def task(resources=None, value=50.0) -> Task:
    return Task(
        id="task_x",
        idempotency_key="k",
        spec=TaskSpec(cmd=["true"]),
        resources=resources or {},
        value=value,
    )


def policy(**kwargs) -> PolicyConfig:
    base = dict(
        burn_lead_minutes=30,
        min_reserve_pct=5.0,
        safety_factor=2.0,
        default_est_pct=3.0,
        max_concurrent_per_bucket=2,
        work_hours_opportunistic=False,
        usage_profile=UsageProfile(),
    )
    base.update(kwargs)
    return PolicyConfig(**base)


def decide(pol: BurnBeforeExpiry, b: Bucket, t: Task, now: datetime, **kwargs):
    return pol.decide(
        bucket=b,
        task=t,
        now=now,
        committed=kwargs.pop("committed", 0.0),
        running_count=kwargs.pop("running_count", 0),
        **kwargs,
    )


def test_work_hours_wait_mid_window():
    pol = BurnBeforeExpiry(policy())
    decision = decide(pol, bucket(), task(), dt(12, 0))
    assert not decision.admit
    assert decision.reason == "work_hours_wait"


def test_burns_in_tail_window():
    pol = BurnBeforeExpiry(policy())
    decision = decide(pol, bucket(remaining=20.0), task(), dt(14, 45))
    assert decision.admit, decision
    assert decision.reason == "admit"
    assert decision.reserve == 5.0
    assert decision.est == 6.0  # 3.0 × 2.0


def test_stops_at_reserve():
    pol = BurnBeforeExpiry(policy())
    # 余量 8：8 - 0 - 5 = 3 < est 6 → 停
    decision = decide(pol, bucket(remaining=8.0), task(), dt(14, 45))
    assert not decision.admit
    assert decision.reason == "reserve"


def test_offhours_burns_immediately():
    pol = BurnBeforeExpiry(policy())
    b = bucket(start=dt(20), end=datetime(2026, 10, 22, 1, 0), remaining=90.0)
    decision = decide(pol, b, task(), dt(20, 5))
    assert decision.admit
    assert decision.reason == "admit"


def test_unlimited_bucket_never_admitted():
    pol = BurnBeforeExpiry(policy())
    b = bucket(lifecycle="unlimited", unlimited=True, remaining=None)
    decision = decide(pol, b, task(), dt(20, 0))
    assert not decision.admit
    assert decision.reason == "unlimited"


def test_unknown_observation_never_burns():
    pol = BurnBeforeExpiry(policy())
    b = bucket(remaining=None, source="unknown")
    decision = decide(pol, b, task(), dt(14, 45))
    assert not decision.admit
    assert decision.reason == "unknown"


def test_self_busy_yields():
    pol = BurnBeforeExpiry(policy())
    decision = decide(pol, bucket(remaining=20.0), task(), dt(14, 45), self_busy=True)
    assert not decision.admit
    assert decision.reason == "self_busy"


def test_committed_leases_prevent_overburn():
    pol = BurnBeforeExpiry(policy())
    # 余量 20，在飞占位 8，reserve 5 → excess 7 ≥ est 6 → 还能开一个
    assert decide(pol, bucket(remaining=20.0), task(), dt(14, 45), committed=8.0).admit
    # 但在飞占位 10 → excess 5 < 6 → 停
    assert not decide(pol, bucket(remaining=20.0), task(), dt(14, 45), committed=10.0).admit


def test_slot_cap_by_intensity():
    pol = BurnBeforeExpiry(policy())
    # 余量 20 → 强度 1
    decision = decide(pol, bucket(remaining=20.0), task(), dt(14, 45), running_count=1)
    assert decision.slots == 1
    assert not decision.admit
    assert decision.reason == "slots"


def test_peak_window_halves_slots():
    pol = policy(peak_windows=[PeakWindow(start=datetime(2026, 10, 21, 15, 0).time(),
                                          end=datetime(2026, 10, 21, 17, 30).time(),
                                          slots_factor=0.5)])
    strat = BurnBeforeExpiry(pol)
    b = bucket(start=dt(15), end=dt(20), remaining=90.0)
    assert strat.slots(b, dt(16, 0)) == 1  # 3 × 0.5 → 1
    assert strat.slots(b, dt(18, 0)) == 2  # 3 不降档但被 max_concurrent=2 截断


def test_estimate_from_tokens():
    pol = BurnBeforeExpiry(policy())
    b = bucket(raw={"text_tokens_per_pct": 50000})
    t = task({"text_tokens": 100000})
    assert pol.estimate_usage(t, b, None) == 4.0  # 2% × 2.0


def test_estimate_uses_calibration_when_no_explicit():
    pol = BurnBeforeExpiry(policy())
    assert pol.estimate_usage(task(), bucket(), calibration=10.0) == 20.0


# -- 付费型（depleting）：策略反转 -------------------------------------------


def paid_bucket(balance=5.0, price=0.002, tokens=50000) -> Bucket:
    b = bucket(lifecycle="depleting", unit="money", remaining=balance)
    b.raw = {"unit_price_per_1k_tokens": price}
    return b


def test_paid_admits_only_if_value_exceeds_cost():
    pol = BurnBeforeExpiry(policy(value_points_per_currency=100.0))
    t = task({"text_tokens": 50000}, value=50.0)  # cost=0.1 → 阈值 10
    assert decide(pol, paid_bucket(), t, dt(12, 0)).admit

    cheap_value = task({"text_tokens": 50000}, value=5.0)  # 5 < 10
    decision = decide(pol, paid_bucket(), cheap_value, dt(12, 0))
    assert not decision.admit
    assert decision.reason == "not_worth_cost"


def test_paid_insufficient_balance():
    pol = BurnBeforeExpiry(policy())
    t = task({"text_tokens": 50000}, value=50.0)
    decision = decide(pol, paid_bucket(balance=0.05), t, dt(12, 0))
    assert not decision.admit
    assert decision.reason == "balance"


def test_paid_without_price_estimate():
    pol = BurnBeforeExpiry(policy())
    b = paid_bucket(price=0.0)
    decision = decide(pol, b, task({}, value=50.0), dt(12, 0))
    assert not decision.admit
    assert decision.reason == "no_cost_estimate"
