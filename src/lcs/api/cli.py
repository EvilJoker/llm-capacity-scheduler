"""CLI：agent 视角的 submit / poll / status / tick / run。

v0.1 只做本机 CLI（DESIGN §9 决策 #2）：任务即本地 shell，开放 HTTP 等于 RCE，
等 v0.2 再上 MCP/HTTP + 沙箱 + 审批。
"""

from __future__ import annotations

import argparse
import json
import shlex
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

from ..config import EXAMPLE_CONFIG, find_config_path, load_config
from ..engine import Engine
from ..models import Requirements, Task, TaskSpec, utcnow
from ..taskstore import TaskStore, new_idempotency_key


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.strip().replace("/", "-")
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return datetime.fromisoformat(text)


def _build_engine(args: argparse.Namespace) -> Engine:
    cfg = load_config(args.config)
    return Engine(cfg)


def _store(args: argparse.Namespace) -> TaskStore:
    return TaskStore(load_config(args.config).engine.db_path)


def _print(data: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))
        return
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, (dict, list)):
                print(f"{key}:")
                print(json.dumps(value, ensure_ascii=False, indent=2, default=str))
            else:
                print(f"{key}: {value}")
    else:
        print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------


def cmd_init_config(args: argparse.Namespace) -> int:
    target = Path(args.path or "config.toml")
    if target.exists() and not args.force:
        print(f"已存在: {target}（--force 覆盖）", file=sys.stderr)
        return 1
    target.write_text(EXAMPLE_CONFIG, encoding="utf-8")
    print(f"已写入 {target}")
    return 0


def cmd_submit(args: argparse.Namespace) -> int:
    store = _store(args)
    cfg = load_config(args.config)

    spec_dict: dict[str, Any] = {}
    if args.spec:
        spec_dict = json.loads(Path(args.spec).read_text(encoding="utf-8"))

    cmd = spec_dict.get("cmd")
    if args.cmd:
        cmd = shlex.split(args.cmd)
    if not cmd:
        print("必须提供 --cmd 或 --spec（含 cmd）", file=sys.stderr)
        return 2

    verify_cmd = spec_dict.get("verify_cmd")
    if args.verify:
        verify_cmd = shlex.split(args.verify)
    expect_artifacts = list(spec_dict.get("expect_artifacts") or [])
    expect_artifacts.extend(args.expect_artifact or [])

    env = dict(spec_dict.get("env") or {})
    for item in args.env or []:
        if "=" not in item:
            print(f"--env 需要 K=V 形式: {item}", file=sys.stderr)
            return 2
        k, v = item.split("=", 1)
        env[k] = v

    spec = TaskSpec(
        cmd=list(cmd),
        cwd=args.cwd or spec_dict.get("cwd"),
        env=env,
        timeout_s=int(args.timeout or spec_dict.get("timeout_s") or 1800),
        verify_cmd=list(verify_cmd) if verify_cmd else None,
        expect_artifacts=expect_artifacts,
    )

    resources: dict[str, float] = dict(spec_dict.get("resources") or {})
    if args.est_pct is not None:
        resources["est_pct"] = args.est_pct
    if args.tokens is not None:
        resources["text_tokens"] = float(args.tokens)

    requirements = Requirements.from_dict(spec_dict.get("requirements") or {})
    if args.provider:
        requirements.providers = list(args.provider)
    if args.family:
        requirements.model_family = args.family

    task = Task(
        id=Task.new_id(),
        idempotency_key=args.idempotency_key or new_idempotency_key("cli"),
        spec=spec,
        requirements=requirements,
        resources=resources,
        value=float(args.value if args.value is not None else spec_dict.get("value", 50.0)),
        deadline=_parse_dt(args.deadline) or _parse_dt(spec_dict.get("deadline")),
        task_class=args.task_class or spec_dict.get("task_class") or "default",
    )
    saved, created = store.submit(task)
    _print(
        {
            "task_id": saved.id,
            "state": saved.state,
            "created": created,
            "idempotency_key": saved.idempotency_key,
            "db": str(cfg.engine.db_path),
        },
        args.json,
    )
    return 0


def cmd_poll(args: argparse.Namespace) -> int:
    store = _store(args)
    if args.ids:
        ids = [i for chunk in args.ids for i in chunk.split(",") if i]
        tasks = [t for t in (store.get_task(i) for i in ids) if t]
    elif args.all:
        states = args.state or [
            "submitted",
            "queued",
            "deferred",
            "admitted",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "expired",
        ]
        tasks = store.tasks_in_states(states, limit=args.limit)
    else:
        print("需要 --ids 或 --all", file=sys.stderr)
        return 2

    payload = []
    for task in tasks:
        runs = store.runs_for_task(task.id)
        artifacts = sorted({a for run in runs for a in run.artifacts})
        payload.append(
            {
                "task_id": task.id,
                "state": task.state,
                "value": task.value,
                "task_class": task.task_class,
                "deadline": task.deadline.isoformat() if task.deadline else None,
                "attempts": task.attempts,
                "runs": [r.to_dict() for r in runs],
                "artifacts": artifacts,
            }
        )
    _print(payload if args.json else {"tasks": payload}, args.json)
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    engine = _build_engine(args)
    data = engine.status()
    if args.json:
        _print(data, True)
        return 0

    now = datetime.fromisoformat(data["now"])
    print(f"now: {now.isoformat(timespec='seconds')}  policy: {data['policy']}")
    print("\n容量桶:")
    if not data["buckets"]:
        print("  (无 provider 配置)")
    for bucket in data["buckets"]:
        window = ""
        if bucket["window_start"] and bucket["window_end"]:
            window = f" {bucket['window_start'][11:16]}–{bucket['window_end'][11:16]}"
        mte = bucket["minutes_to_end"]
        left = f" 剩{mte / 60:.1f}h" if mte is not None else ""
        remaining = "unlimited" if bucket["unlimited"] else f"{bucket['remaining']}%"
        print(
            f"  {bucket['short_key']:<32} {bucket['lifecycle']:<10} "
            f"{remaining:>8} {window}{left}  src={bucket['source']}"
        )
    print(f"\n任务状态: {data['task_counts'] or '{}'}")
    print(f"在飞 run: {len(data['running'])}")
    for run in data["running"]:
        print(
            f"  {run['id']} task={run['task_id']} bucket={run['bucket_key'].split('/')[0]} "
            f"est={run['est']:.2f} pid={run['pid']} since={run['started_at'][11:19]}"
        )
    if data["committed"]:
        print(f"在飞占位: {data['committed']}")
    return 0


def cmd_observe(args: argparse.Namespace) -> int:
    engine = _build_engine(args)
    now = utcnow()
    buckets = engine.observe(now)
    data = [b.describe(now) for b in buckets]
    if args.json:
        _print(data, True)
        return 0
    if not data:
        print("(无 provider 配置：config.toml 里 [[providers]] 为空)")
        return 0
    for bucket in data:
        print(json.dumps(bucket, ensure_ascii=False))
    return 0


def cmd_tick(args: argparse.Namespace) -> int:
    engine = _build_engine(args)
    report = engine.tick()
    _print(report.to_dict() if args.json else _human_tick(report.to_dict()), args.json)
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    engine = _build_engine(args)
    cfg = engine.config
    print(
        f"[lcs] 常驻调度启动 tick={cfg.engine.tick_seconds}s "
        f"db={cfg.engine.db_path} policy={cfg.policy.name}"
    )
    engine.run_forever(max_ticks=args.max_ticks)
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    store = _store(args)
    ok = store.cancel_task(args.task_id)
    _print({"task_id": args.task_id, "cancelled": ok}, args.json)
    return 0 if ok else 1


def _human_tick(report: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "now": report["now"],
        "buckets": [
            {
                "bucket": b["short_key"],
                "remaining": b["remaining"],
                "unlimited": b["unlimited"],
                "minutes_to_end": b["minutes_to_end"],
            }
            for b in report["buckets"]
        ],
        "spawned": report["spawned"],
        "reaped": report["reaped"],
        "expired": report["expired"],
        "requeued": report["requeued"],
        "decisions": report["decisions"][:20],
        "errors": report["errors"],
    }
    return summary


# ---------------------------------------------------------------------------
# argparse
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--config", help="config.toml 路径（默认 ./config.toml 或 $LCS_CONFIG）"
    )
    common.add_argument("--json", action="store_true", help="JSON 输出")

    parser = argparse.ArgumentParser(
        prog="lcs",
        description="容量感知的异步任务调度器（LLM capacity scheduler）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("init-config", parents=[common], help="生成示例 config.toml")
    p.add_argument("--path")
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_init_config)

    p = sub.add_parser("submit", parents=[common], help="提交任务")
    p.add_argument("--spec", help="任务 JSON（含 cmd/requirements/resources/value/deadline）")
    p.add_argument("--cmd", help="命令（shell 字符串，会 shlex 拆分）")
    p.add_argument("--cwd", help="执行目录（默认 engine 工作目录）")
    p.add_argument("--env", action="append", help="环境变量 K=V（可重复）")
    p.add_argument("--value", type=float, help="业务价值 0..100")
    p.add_argument("--est-pct", type=float, help="预估消耗（百分点）")
    p.add_argument("--tokens", type=float, help="预估 text token 消耗（按 provider 换算成 %）")
    p.add_argument("--deadline", help="deadline（ISO，如 2026-10-22T09:00）")
    p.add_argument("--provider", action="append", help="限定 provider（可重复）")
    p.add_argument("--family", help="限定 model_family，如 general")
    p.add_argument("--task-class", help="任务类（用于校准，默认 default）")
    p.add_argument("--idempotency-key", help="幂等键（重试 submit 不会重复跑）")
    p.add_argument("--expect-artifact", action="append", help="声明产物（相对产物目录，可重复）")
    p.add_argument("--verify", help="verifier 命令（exit 0 才算 succeeded）")
    p.add_argument("--timeout", type=int, help="执行超时（秒）")
    p.set_defaults(func=cmd_submit)

    p = sub.add_parser("poll", parents=[common], help="批量轮询任务状态与产物")
    p.add_argument("--ids", nargs="+", help="task id（可逗号分隔）")
    p.add_argument("--all", action="store_true", help="列出所有任务")
    p.add_argument("--state", action="append", help="按状态过滤（可重复）")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(func=cmd_poll)

    p = sub.add_parser("status", parents=[common], help="容量桶 + 队列 + 在飞概览")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("observe", parents=[common], help="只读一次容量快照")
    p.set_defaults(func=cmd_observe)

    p = sub.add_parser("tick", parents=[common], help="执行一次 tick")
    p.set_defaults(func=cmd_tick)

    p = sub.add_parser("run", parents=[common], help="常驻 tick 循环")
    p.add_argument("--max-ticks", type=int, help="最多跑多少 tick（调试用）")
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("cancel", parents=[common], help="取消任务")
    p.add_argument("task_id")
    p.set_defaults(func=cmd_cancel)

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001
        if getattr(args, "json", False):
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        else:
            print(f"错误: {exc}", file=sys.stderr)
        return 1


__all__ = ["main", "build_parser", "find_config_path"]
