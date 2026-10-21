"""执行器层：把任务真正跑起来。v0.1 只有 shell。"""

from .base import RunResult, Runner
from .shell import ShellRunner

__all__ = ["RunResult", "Runner", "ShellRunner"]
