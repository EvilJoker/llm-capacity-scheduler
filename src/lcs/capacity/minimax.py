"""MiniMax 容量适配器：`fixed_grid` 生命周期 + 周限额 `unlimited`。

实测（2026-10-21）：
- `GET https://api.minimaxi.com/v1/token_plan/remains`
- `model_remains[]` 每个 model_name 一个桶：general 是 5h 固定栅格（如 10:00–15:00），
  video 是日窗口（00:00–24:00）。
- `*_remaining_percent` 是**剩余**语义（0..100 整数）。
- 毫秒时间戳；`remains_time` 是剩余毫秒。
- `current_interval_status == 3` / `current_weekly_status == 3` 表示 **unlimited**，
  绝不能当成 "还剩 100%"。
- `base_resp.status_code != 0` 是真实错误码。

观测失败 → 返回 source="unknown" 的桶，策略不烧。
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from ..models import Bucket, Window
from .base import Adapter, unknown_bucket

DEFAULT_ENDPOINT = "https://api.minimaxi.com/v1/token_plan/remains"
# 状态码 3 = unlimited / 无限制（周限额对老用户即为 3）
STATUS_UNLIMITED = 3

RESOURCE_KIND = {
    "general": "text_tokens",
    "video": "video_clips",
}


class MinimaxAdapter:
    name = "minimax"

    def __init__(self, name: str = "minimax", options: dict[str, Any] | None = None):
        self.name = name
        opts = options or {}
        self.endpoint = opts.get("endpoint", DEFAULT_ENDPOINT)
        self.families = list(opts.get("families") or ["general"])
        self.include_weekly = bool(opts.get("include_weekly", False))
        self.api_key_env = opts.get("api_key_env", "MINIMAX_API_KEY")
        self.api_key_file = opts.get("api_key_file", "~/.mmx/config.json")
        self.timeout_s = float(opts.get("timeout_s", 20))
        self.text_tokens_per_pct = float(opts.get("text_tokens_per_pct", 50000) or 50000)
        self._api_key: str | None = None

    # -- 凭据 ---------------------------------------------------------------

    def _resolve_api_key(self) -> str | None:
        if self._api_key:
            return self._api_key
        env = os.environ.get(self.api_key_env)
        if env:
            self._api_key = env.strip()
            return self._api_key
        if self.api_key_file:
            path = Path(os.path.expanduser(self.api_key_file))
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                key = data.get("api_key") or data.get("token")
                if key:
                    self._api_key = str(key).strip()
                    return self._api_key
            except (OSError, ValueError, AttributeError):
                pass
        return None

    # -- 观测 ---------------------------------------------------------------

    def fetch(self) -> dict[str, Any]:
        key = self._resolve_api_key()
        if not key:
            raise RuntimeError("MiniMax API key 未配置（MINIMAX_API_KEY 或 api_key_file）")
        req = urllib.request.Request(
            self.endpoint,
            headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            body = resp.read().decode("utf-8")
        data = json.loads(body)
        base = data.get("base_resp") or {}
        if base.get("status_code", 0) != 0:
            raise RuntimeError(
                f"MiniMax API error {base.get('status_code')}: {base.get('status_msg')}"
            )
        return data

    def observe(self, now: datetime) -> list[Bucket]:
        try:
            data = self.fetch()
        except Exception as exc:  # noqa: BLE001 - 契约要求不抛异常
            return [
                unknown_bucket(self.name, family, RESOURCE_KIND.get(family, family), error=str(exc))
                for family in self.families
            ]

        buckets: list[Bucket] = []
        seen: set[str] = set()
        for item in data.get("model_remains") or []:
            family = str(item.get("model_name") or "")
            if not family:
                continue
            if self.families and family not in self.families:
                continue
            seen.add(family)
            buckets.extend(self._interval_buckets(family, item))
            if self.include_weekly:
                weekly = self._weekly_bucket(family, item)
                if weekly is not None:
                    buckets.append(weekly)

        # provider 返回里缺了配置的 family → 视为 unknown，不烧
        for family in self.families:
            if family not in seen:
                buckets.append(
                    unknown_bucket(
                        self.name,
                        family,
                        RESOURCE_KIND.get(family, family),
                        error="family not present in provider response",
                    )
                )
        return buckets

    def _interval_buckets(self, family: str, item: dict[str, Any]) -> list[Bucket]:
        resource_kind = RESOURCE_KIND.get(family, family)
        start = _ms_to_dt(item.get("start_time"))
        end = _ms_to_dt(item.get("end_time"))
        remaining = item.get("current_interval_remaining_percent")
        status = item.get("current_interval_status")

        if status == STATUS_UNLIMITED:
            # 显式 unlimited 桶：不参与准入，绝不参与 reserve 计算
            return [
                Bucket(
                    provider=self.name,
                    model_family=family,
                    resource_kind=resource_kind,
                    unit="pct",
                    window=Window(
                        lifecycle="unlimited", start=start, end=end, unlimited=True
                    ),
                    remaining=None,
                    source="api",
                    raw=dict(item),
                )
            ]

        return [
            Bucket(
                provider=self.name,
                model_family=family,
                resource_kind=resource_kind,
                unit="pct",
                window=Window(lifecycle="fixed_grid", start=start, end=end),
                remaining=float(remaining) if remaining is not None else None,
                source="api" if remaining is not None else "unknown",
                raw=dict(item),
            )
        ]

    def _weekly_bucket(self, family: str, item: dict[str, Any]) -> Bucket | None:
        status = item.get("current_weekly_status")
        start = _ms_to_dt(item.get("weekly_start_time"))
        end = _ms_to_dt(item.get("weekly_end_time"))
        unlimited = status == STATUS_UNLIMITED
        remaining_pct = item.get("current_weekly_remaining_percent")
        if unlimited:
            remaining: float | None = None
        elif remaining_pct is None:
            return None
        else:
            remaining = float(remaining_pct)
        return Bucket(
            provider=self.name,
            model_family=family,
            resource_kind=f"{RESOURCE_KIND.get(family, family)}_weekly",
            unit="pct",
            window=Window(
                lifecycle="unlimited" if unlimited else "calendar",
                start=start,
                end=end,
                unlimited=unlimited,
            ),
            remaining=remaining,
            source="api",
            raw=dict(item),
        )


def _ms_to_dt(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromtimestamp(int(value) / 1000.0)
    except (TypeError, ValueError, OSError):
        return None
