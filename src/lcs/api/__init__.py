"""对外接口层：v0.1 只有 CLI，v0.2 加 HTTP / MCP。"""

from .cli import build_parser, main

__all__ = ["build_parser", "main"]
