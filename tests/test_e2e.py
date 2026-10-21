"""端到端验收（DESIGN §8）：

MiniMax 5h 固定窗口在 `end_time − 30min` 自动开烧 → 烧到 reserve 停 → 产物落 artifacts。

用可控时钟 + 脚本化 adapter 跑真实 shell runner，不联网、不消耗真实配额。
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta

from lcs.config import Config, EngineConfig, PolicyConfig, UsageProfile
from lcs.engine import Engine
from lcs.models import Task, TaskSpec
from lcs.runner import ShellRunner
from lcs.taskstore import TaskStore

from conftest import FakeClock, ScriptedAdapter

BURN_CMD = [
    "python3",
    "-c",
    "import pathlib; pathlib.Path('out.txt').write_text('burned'); print('ok')",
]


def build_engine(tmp_path, *, clock, adapter, initial_remaining=80.0, burn_per_run=6.0,
                 start=None, end=None):
    cfg = Config(
        engine=EngineConfig(
            tick_seconds=1,
            db_path=tmp_path / "state.db",
            artifacts_dir=tmp_path / "artifacts",
            log_dir=tmp_path / "logs",
        ),
        policy=PolicyConfig(
            burn_lead_minutes=30,
            min_reserve_pct=5.0,
            safety_factor=2.0,
            default_est_pct=3.0,
            max_concurrent_per_bucket=2,
            max_parallel_total=4,
            work_hours_opportunistic=False,
            activity_lookback_minutes=10,
            activity_drop_threshold_pct=1.0,
            usage_profile=UsageProfile(),
        ),
        providers=[],
        base_dir=tmp_path,
    )
    store = TaskStore(cfg.engine.db_path)
    adapter = adapter(store=store)
    engine = Engine(
        cfg,
        store=store,
        adapters=[adapter],
        runner=ShellRunner(cfg.engine.artifacts_dir, base_dir=tmp_path),
        clock=clock,
    )
    return engine, store, adapter


def submit_burn_tasks(store, n, *, value=50.0, deadline=None, cmd=None, expect=("out.txt",)):
    tasks = []
    for _ in range(n):
        task = Task(
            id=Task.new_id(),
            idempotency_key=f"e2e-{Task.new_id()}",
            spec=TaskSpec(
                cmd=list(cmd or BURN_CMD),
                timeout_s=30,
                expect_artifacts=list(expect),
            ),
            resources={},
            value=value,
            deadline=deadline,
        )
        saved, _ = store.submit(task)
        tasks.append(saved)
    return tasks


def drain(engine, clock, *, rounds=200, step_seconds=5):
    """推进时钟直到没有在飞 run、也没有新的 spawn。

    真实子进程需要一点真实时间才能写出退出码，所以每轮 sleep 一下。
    """
    for _ in range(rounds):
        before = len(store_running(engine))
        report = engine.tick()
        clock.advance(seconds=step_seconds)
        if not report.spawned and before == 0:
            return report
        time.sleep(0.02)
    raise AssertionError("drain 未能收敛")


def store_running(engine):
    return engine.store.running_runs()


def wait_terminal(engine, clock, task_id, *, rounds=200, sleep=0.02):
    for _ in range(rounds):
        engine.tick()
        clock.advance(seconds=5)
        state = engine.store.get_task(task_id).state
        if state in ("succeeded", "failed", "cancelled", "expired"):
            return state
        time.sleep(sleep)
    raise AssertionError(f"task {task_id} 未在限定轮次内结束")


def test_full_burn_cycle(tmp_path):
    window_start = datetime(2026, 10, 21, 10, 0)
    window_end = datetime(2026, 10, 21, 15, 0)
    clock = FakeClock(datetime(2026, 10, 21, 14, 0))
    engine, store, adapter = build_engine(
        tmp_path,
        clock=clock,
        adapter=lambda store: ScriptedAdapter(
            start=window_start, end=window_end, store=store,
            initial_remaining=80.0, burn_per_run=6.0,
        ),
    )
    tasks = submit_burn_tasks(store, 20)
    minute_before_lead = datetime(2026, 10, 21, 14, 0)

    # 1) 工作时段中段（14:00，距窗口结束 60min）：绝不烧
    report = engine.tick()
    assert report.spawned == []
    assert report.expired == 0
    assert all(store.get_task(t.id).state in ("deferred", "queued") for t in tasks)
    wait_reasons = {d["reason"] for d in report.decisions}
    assert "work_hours_wait" in wait_reasons
    assert minute_before_lead <= report.now

    # 2) 进入尾段（14:35，距结束 25min ≤ burn_lead 30min）：自动开烧
    clock.set(datetime(2026, 10, 21, 14, 35))
    report = engine.tick()
    assert len(report.spawned) == 2, report.spawned
    led = datetime(2026, 10, 21, 14, 35)
    assert led >= window_end - timedelta(minutes=30)

    # 3) 烧到 reserve 停
    drain(engine, clock)

    succeeded = [t for t in tasks if (store.get_task(t.id).state == "succeeded")]
    remaining = 80.0 - 6.0 * len(succeeded)
    assert 8 <= len(succeeded) <= 13, f"succeeded={len(succeeded)}, remaining={remaining}"
    assert remaining >= 5.0, "绝不能烧穿 min_reserve"
    assert remaining <= 30.0, "应该烧到 reserve 附近停下"

    # 4) 再 tick 也不应继续烧（reserve 守住）
    before = len(succeeded)
    for _ in range(5):
        engine.tick()
        clock.advance(seconds=30)
    succeeded_after = [
        t for t in tasks if store.get_task(t.id).state == "succeeded"
    ]
    assert len(succeeded_after) == before or remaining <= 8.0

    # 5) 产物落 artifacts，且 verification 通过
    ok_task = succeeded[0]
    runs = [r for r in store.runs_for_task(ok_task.id) if r.status == "succeeded"]
    assert runs, "succeeded 任务必须有 succeeded run"
    run = runs[0]
    assert run.verified is True
    assert "out.txt" in run.artifacts
    assert (tmp_path / "artifacts" / ok_task.id / run.id / "out.txt").exists()
    assert run.quota_delta is None or run.quota_delta >= 0


def test_offhours_burns_immediately(tmp_path):
    clock = FakeClock(datetime(2026, 10, 21, 20, 5))
    engine, store, _ = build_engine(
        tmp_path,
        clock=clock,
        adapter=lambda store: ScriptedAdapter(
            start=datetime(2026, 10, 21, 20, 0),
            end=datetime(2026, 10, 22, 1, 0),
            store=store,
            initial_remaining=90.0,
            burn_per_run=6.0,
        ),
    )
    tasks = submit_burn_tasks(store, 1)
    report = engine.tick()
    assert len(report.spawned) == 1, report.decisions
    assert report.decisions[0]["reason"] in ("admit", "slots")

    state = wait_terminal(engine, clock, tasks[0].id)
    assert state == "succeeded"


def test_unknown_observation_never_burns(tmp_path):
    clock = FakeClock(datetime(2026, 10, 21, 14, 45))
    engine, store, _ = build_engine(
        tmp_path,
        clock=clock,
        adapter=lambda store: ScriptedAdapter(
            start=datetime(2026, 10, 21, 10, 0),
            end=datetime(2026, 10, 21, 15, 0),
            store=store,
            remaining_override=None,
        ),
    )
    # 覆盖 observe 让它始终返回 unknown
    adapter = engine.adapters[0]

    def unknown_observe(now):
        return []

    adapter.observe = unknown_observe  # type: ignore[method-assign]
    tasks = submit_burn_tasks(store, 1)
    report = engine.tick()
    assert report.spawned == []
    assert report.decisions[0]["reason"] == "no_bucket"
    assert store.get_task(tasks[0].id).state in ("queued", "deferred")


def test_failed_task_is_not_succeeded(tmp_path):
    clock = FakeClock(datetime(2026, 10, 21, 14, 45))
    engine, store, _ = build_engine(
        tmp_path,
        clock=clock,
        adapter=lambda store: ScriptedAdapter(
            start=datetime(2026, 10, 21, 10, 0),
            end=datetime(2026, 10, 21, 15, 0),
            store=store,
            initial_remaining=90.0,
        ),
    )
    tasks = submit_burn_tasks(store, 1, cmd=["python3", "-c", "raise SystemExit(3)"], expect=())
    report = engine.tick()
    assert len(report.spawned) == 1
    state = wait_terminal(engine, clock, tasks[0].id)
    assert state == "failed"


def test_expired_task_never_runs(tmp_path):
    clock = FakeClock(datetime(2026, 10, 21, 14, 45))
    engine, store, _ = build_engine(
        tmp_path,
        clock=clock,
        adapter=lambda store: ScriptedAdapter(
            start=datetime(2026, 10, 21, 10, 0),
            end=datetime(2026, 10, 21, 15, 0),
            store=store,
            initial_remaining=90.0,
        ),
    )
    tasks = submit_burn_tasks(store, 1, deadline=datetime(2026, 10, 21, 14, 0))
    report = engine.tick()
    assert report.spawned == []
    assert store.get_task(tasks[0].id).state == "expired"
