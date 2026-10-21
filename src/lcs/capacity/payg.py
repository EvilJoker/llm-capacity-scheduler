"""PAYG / Credits 余额适配器：`depleting` 生命周期（与 MiniMax 性质相反）。

刻意选一个**性质相反**的实现来证伪抽象是否够通用：
- 只减不归满 → 不存在"窗口关闭即作废"，reserve 不是用量而是**价格**；
- 单位是金额而不是百分比；
- 烧 = 花钱 → 策略反转，只有「任务价值 > 成本」才允许执行。

余额来源：`state_file`（JSON: `{"balance": 12.34, "currency": "USD"}`），
或配置里写死的 `balance`。读不到 → source="unknown" → 策略不烧。
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any

from ..models import Bucket, Window
from .base import unknown_bucket


class PaygAdapter:
    name = "payg"

    def __init__(self, name: str = "payg", options: dict[str, Any] | None = None):
        self.name = name
        opts = options or {}
        self.state_file = opts.get("state_file")
        self.balance = opts.get("balance")
        self.currency = opts.get("currency", "USD")
        self.unit_price_per_1k_tokens = float(
            opts.get("unit_price_per_1k_tokens", 0.0) or 0.0
        )
        self.model_family = opts.get("model_family", "credits")

    def observe(self, now: datetime) -> list[Bucket]:
        balance = self._read_balance()
        if balance is None:
            return [
                unknown_bucket(
                    self.name, self.model_family, "money", unit="money", error="balance unknown"
                )
            ]
        return [
            Bucket(
                provider=self.name,
                model_family=self.model_family,
                resource_kind="money",
                unit="money",
                window=Window(lifecycle="depleting"),
                remaining=float(balance),
                source="api",
                raw={
                    "currency": self.currency,
                    "unit_price_per_1k_tokens": self.unit_price_per_1k_tokens,
                },
            )
        ]

    def _read_balance(self) -> float | None:
        if self.state_file:
            path = Path(os.path.expanduser(str(self.state_file)))
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                balance = data.get("balance")
                if balance is not None:
                    self.currency = data.get("currency", self.currency)
                    return float(balance)
            except (OSError, ValueError, TypeError):
                return None
        if self.balance is not None:
            try:
                return float(self.balance)
            except (TypeError, ValueError):
                return None
        return None
