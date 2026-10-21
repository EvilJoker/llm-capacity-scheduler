"""MiniMax adapter：字段语义（剩余百分比 / 毫秒时间戳 / unlimited）+ 失败降级。

不联网：monkeypatch `fetch`。
"""

from __future__ import annotations

from datetime import datetime

from lcs.capacity import MinimaxAdapter
from lcs.capacity.minimax import STATUS_UNLIMITED

NOW = datetime(2026, 10, 21, 11, 15)

PAYLOAD = {
    "model_remains": [
        {
            "start_time": 1792548000000,  # 2026-10-21 10:00
            "end_time": 1792566000000,    # 2026-10-21 15:00
            "remains_time": 13500000,
            "model_name": "general",
            "current_interval_status": 1,
            "current_interval_remaining_percent": 74,
            "current_weekly_status": 3,
            "current_weekly_remaining_percent": 100,
            "weekly_start_time": 1792339200000,
            "weekly_end_time": 1792944000000,
        },
        {
            "start_time": 1792512000000,  # 2026-10-21 00:00
            "end_time": 1792598400000,    # 2026-10-22 00:00
            "model_name": "video",
            "current_interval_status": 3,
            "current_interval_remaining_percent": 100,
            "current_weekly_status": 3,
            "current_weekly_remaining_percent": 100,
        },
    ],
    "base_resp": {"status_code": 0, "status_msg": "success"},
}


def test_observe_general_bucket():
    adapter = MinimaxAdapter(options={"families": ["general"]})
    adapter.fetch = lambda: PAYLOAD  # type: ignore[method-assign]
    buckets = adapter.observe(NOW)
    assert len(buckets) == 1
    b = buckets[0]
    assert b.model_family == "general"
    assert b.resource_kind == "text_tokens"
    assert b.remaining == 74.0
    assert b.window.lifecycle == "fixed_grid"
    assert b.window.end == datetime(2026, 10, 21, 15, 0)
    assert b.perishable and not b.paid
    assert b.known


def test_video_interval_status_3_is_unlimited():
    adapter = MinimaxAdapter(options={"families": ["video"]})
    adapter.fetch = lambda: PAYLOAD  # type: ignore[method-assign]
    (b,) = adapter.observe(NOW)
    assert b.window.lifecycle == "unlimited"
    assert b.window.unlimited
    assert b.remaining is None
    assert not b.perishable


def test_weekly_bucket_optional():
    adapter = MinimaxAdapter(options={"families": ["general"], "include_weekly": True})
    adapter.fetch = lambda: PAYLOAD  # type: ignore[method-assign]
    buckets = {b.resource_kind: b for b in adapter.observe(NOW)}
    weekly = buckets["text_tokens_weekly"]
    assert weekly.window.unlimited
    assert weekly.remaining is None


def test_missing_family_returns_unknown():
    adapter = MinimaxAdapter(options={"families": ["image"]})
    adapter.fetch = lambda: PAYLOAD  # type: ignore[method-assign]
    (b,) = adapter.observe(NOW)
    assert b.source == "unknown"
    assert b.remaining is None
    assert not b.known


def test_fetch_failure_degrades_to_unknown():
    adapter = MinimaxAdapter(options={"families": ["general"]})

    def boom():
        raise RuntimeError("network down")

    adapter.fetch = boom  # type: ignore[method-assign]
    (b,) = adapter.observe(NOW)
    assert b.source == "unknown"
    assert b.remaining is None
    assert "network down" in b.raw["error"]


def test_api_error_status_degrades_to_unknown():
    adapter = MinimaxAdapter(options={"families": ["general"], "api_key_env": "NOPE"})
    adapter._api_key = "dummy"

    def boom():
        raise RuntimeError("MiniMax API error 1004: invalid key")

    adapter.fetch = boom  # type: ignore[method-assign]
    (b,) = adapter.observe(NOW)
    assert b.source == "unknown"


def test_status_unlimited_constant():
    assert STATUS_UNLIMITED == 3
