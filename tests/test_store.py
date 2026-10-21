"""SQLite taskstore：幂等、状态机、采样、校准。"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from lcs.models import Bucket, Requirements, Run, Task, TaskSpec, Window
from lcs.taskstore import TaskStore


@pytest.fixture
def store(tmp_path):
    s = TaskStore(tmp_path / "state.db")
    yield s
    s.close()


def make_task(key="k1", state="submitted", deadline=None) -> Task:
    return Task(
        id=Task.new_id(),
        idempotency_key=key,
        spec=TaskSpec(cmd=["echo", "hi"]),
        requirements=Requirements(),
        resources={"est_pct": 3.0},
        value=50.0,
        deadline=deadline,
        state=state,
    )


def test_submit_is_idempotent(store):
    t1, created1 = store.submit(make_task("same-key"))
    t2, created2 = store.submit(make_task("same-key"))
    assert created1 and not created2
    assert t2.id == t1.id
    assert len(store.tasks_in_states(["submitted"])) == 1


def test_transition_is_guarded(store):
    task, _ = store.submit(make_task())
    assert store.transition(task.id, ("submitted",), "queued")
    assert store.get_task(task.id).state == "queued"
    # 非法迁移：当前 state=queued 不在 from_states 里
    assert not store.transition(task.id, ("submitted",), "running")
    assert store.get_task(task.id).state == "queued"


def test_expire_by_deadline(store):
    now = datetime(2026, 10, 21, 12, 0)
    store.submit(make_task("late", deadline=now - timedelta(minutes=1)))
    store.submit(make_task("future", deadline=now + timedelta(hours=1)))
    assert store.expire_tasks(now) == 1
    assert store.get_task(store.find_task_by_idempotency("late").id).state == "expired"
    assert store.get_task(store.find_task_by_idempotency("future").id).state == "submitted"


def test_runs_and_committed(store):
    task, _ = store.submit(make_task())
    run = Run(
        id=Run.new_id(),
        task_id=task.id,
        provider="fake",
        model="general",
        bucket_key="fake/general/text_tokens/w",
        est=6.0,
        pid=1234,
        started_at=datetime(2026, 10, 21, 14, 35),
    )
    store.add_run(run)
    assert store.committed_by_bucket() == {"fake/general/text_tokens/w": 6.0}
    assert store.running_count_by_bucket() == {"fake/general/text_tokens/w": 1}

    store.update_run(run.id, status="succeeded", ended_at=datetime(2026, 10, 21, 14, 40))
    assert store.committed_by_bucket() == {}
    assert store.completed_runs_count("fake/general/text_tokens/w") == 1
    assert store.runs_for_task(task.id)[0].status == "succeeded"


def test_capacity_samples_strict_before(store):
    b = Bucket(
        provider="fake",
        model_family="general",
        resource_kind="text_tokens",
        unit="pct",
        window=Window(lifecycle="fixed_grid", start=None, end=None),
        remaining=80.0,
    )
    t1 = datetime(2026, 10, 21, 10, 0)
    t2 = datetime(2026, 10, 21, 10, 1)
    store.record_sample(b, t1)
    b.remaining = 70.0
    store.record_sample(b, t2)
    prev = store.last_sample_before(b.key, t2)
    assert prev is not None and prev["remaining"] == 80.0
    assert store.last_sample_before(b.key, t1) is None
    assert len(store.recent_samples(b.key, t1)) == 2


def test_calibration_ewma(store):
    val, n = store.calibration_update("cls", "fake", "bucket", 6.0)
    assert (val, n) == (6.0, 1)
    val, n = store.calibration_update("cls", "fake", "bucket", 4.0)
    assert val == pytest.approx(0.7 * 6.0 + 0.3 * 4.0)
    assert n == 2
    got, got_n = store.calibration_get("cls", "fake", "bucket")
    assert got == pytest.approx(val) and got_n == 2


def test_counts(store):
    store.submit(make_task("a"))
    store.submit(make_task("b"))
    assert store.counts() == {"submitted": 2}
