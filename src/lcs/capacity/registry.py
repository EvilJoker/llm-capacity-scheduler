"""adapter 注册表：kind → 构造函数。加 provider 只改这里 + 新增一个模块。"""

from __future__ import annotations

from typing import Any

from ..config import ProviderConfig
from .base import Adapter, unknown_bucket
from .minimax import MinimaxAdapter
from .payg import PaygAdapter

ADAPTERS: dict[str, Any] = {
    "minimax": MinimaxAdapter,
    "payg": PaygAdapter,
}


def build_adapter(provider: ProviderConfig) -> Adapter:
    try:
        factory = ADAPTERS[provider.kind]
    except KeyError as exc:
        raise ValueError(
            f"未知 adapter kind: {provider.kind!r}（已支持: {sorted(ADAPTERS)}）"
        ) from exc
    return factory(name=provider.name, options=provider.options)


def build_adapters(providers: list[ProviderConfig]) -> list[Adapter]:
    return [build_adapter(p) for p in providers if p.enabled]


__all__ = ["ADAPTERS", "Adapter", "build_adapter", "build_adapters", "unknown_bucket"]
