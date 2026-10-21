"""执行器契约（扩展点 B）。

引擎不拥有 agent loop：runner 只负责「给我一条任务，我把它跑起来并告诉我结果」。
换执行方式（shell / dsh headless / claude-code / HTTP）不影响 provider 与 policy。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol, runtime_checkable

from ..models import Run, Task


@dataclass
class RunResult:
    """一次执行的最终结果。"""

    status: str  # succeeded | failed | timeout | killed
    ended_at: datetime
    exit_code: int | None = None
    verified: bool = False
    artifacts: list[str] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@runtime_checkable
class Runner(Protocol):
    name: str

    def spawn(self, task: Task, run: Run) -> int:
        """启动任务，返回 pid，并填充 run.run_dir / run.log_path。"""

    def poll(self, task: Task, run: Run, now: datetime) -> RunResult | None:
        """未结束返回 None；结束返回 RunResult。"""

    def kill(self, task: Task, run: Run) -> None:
        """取消正在跑的任务。"""


__all__ = ["Runner", "RunResult"]
