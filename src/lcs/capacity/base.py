"""容量适配器契约（扩展点 A）。

核心约定：**失败不抛异常**，而是返回 `source="unknown"` 的桶。
策略对 unknown 的默认动作是「不烧」——安全默认，绝不盲烧。
"""

from __future__ import annotations

from datetime import datetime
from typing import Protocol, runtime_checkable

from ..models import Bucket, Window


@runtime_checkable
class Adapter(Protocol):
    """provider 容量观测器。换 provider 只改这一层，不动 policy。"""

    name: str

    def observe(self, now: datetime) -> list[Bucket]:
        ...


def unknown_bucket(
    provider: str,
    model_family: str,
    resource_kind: str,
    unit: str = "pct",
    error: str | None = None,
) -> Bucket:
    """构造一个「观测失败」的桶：余量 None + source=unknown → 策略不烧。"""
    return Bucket(
        provider=provider,
        model_family=model_family,
        resource_kind=resource_kind,
        unit=unit,  # type: ignore[arg-type]
        window=Window(lifecycle="fixed_grid"),
        remaining=None,
        source="unknown",
        raw={"error": error} if error else {},
    )
