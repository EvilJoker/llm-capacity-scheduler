"""SQLite 任务存储：状态机 + 幂等键 + 容量采样 + 校准。

设计要点（DESIGN §6.1）：
- task 与 run 分离：`提交 ≠ 执行`，`admitted` 与 `running` 也分开；
- 幂等键 UNIQUE：agent 重试 submit 不会重复跑；
- 本地账本**不是**权威：provider 才是；本地只做归因与校准；
- tick + reconcile：每次全量对账，崩溃可重入。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from ..models import (
    ACTIVE_STATES,
    TERMINAL_STATES,
    Bucket,
    Requirements,
    Run,
    Task,
    TaskSpec,
)

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS tasks (
    id                TEXT PRIMARY KEY,
    idempotency_key   TEXT NOT NULL UNIQUE,
    task_class        TEXT NOT NULL DEFAULT 'default',
    spec_json         TEXT NOT NULL,
    requirements_json TEXT NOT NULL,
    resources_json    TEXT NOT NULL,
    value             REAL NOT NULL,
    deadline          TEXT,
    state             TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);

CREATE TABLE IF NOT EXISTS runs (
    id           TEXT PRIMARY KEY,
    task_id      TEXT NOT NULL,
    provider     TEXT NOT NULL,
    model        TEXT NOT NULL DEFAULT '',
    bucket_key   TEXT NOT NULL,
    est          REAL NOT NULL,
    pid          INTEGER,
    started_at   TEXT NOT NULL,
    ended_at     TEXT,
    status       TEXT NOT NULL,
    exit_code    INTEGER,
    verified     INTEGER,
    artifacts_json TEXT,
    usage_json   TEXT,
    quota_delta  REAL,
    log_path     TEXT,
    run_dir      TEXT,
    error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_bucket ON runs(bucket_key);

CREATE TABLE IF NOT EXISTS capacity_samples (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_key    TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model_family  TEXT NOT NULL,
    resource_kind TEXT NOT NULL,
    ts            TEXT NOT NULL,
    remaining     REAL,
    unit          TEXT NOT NULL,
    window_start  TEXT,
    window_end    TEXT,
    source        TEXT NOT NULL,
    raw_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_bucket_ts ON capacity_samples(bucket_key, ts);

CREATE TABLE IF NOT EXISTS calibration (
    task_class  TEXT NOT NULL,
    provider    TEXT NOT NULL,
    bucket_key  TEXT NOT NULL,
    ewma_actual REAL NOT NULL,
    n_samples   INTEGER NOT NULL,
    PRIMARY KEY (task_class, provider, bucket_key)
);
"""


def _dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


class TaskStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        if str(self.db_path) != ":memory:":
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(self.db_path))
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # -- task ---------------------------------------------------------------

    def submit(self, task: Task) -> tuple[Task, bool]:
        """写入任务。幂等键冲突时返回已存在任务。返回 (task, created)。"""
        try:
            self.conn.execute(
                """INSERT INTO tasks
                   (id, idempotency_key, task_class, spec_json, requirements_json,
                    resources_json, value, deadline, state, attempts, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task.id,
                    task.idempotency_key,
                    task.task_class,
                    json.dumps(task.spec.to_dict(), ensure_ascii=False),
                    json.dumps(task.requirements.to_dict(), ensure_ascii=False),
                    json.dumps(task.resources, ensure_ascii=False),
                    float(task.value),
                    _iso(task.deadline),
                    task.state,
                    task.attempts,
                    _iso(task.created_at),
                    _iso(task.updated_at),
                ),
            )
            self.conn.commit()
            return task, True
        except sqlite3.IntegrityError:
            existing = self.find_task_by_idempotency(task.idempotency_key)
            if existing is None:
                raise
            return existing, False

    def get_task(self, task_id: str) -> Task | None:
        row = self.conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        return self._row_to_task(row) if row else None

    def find_task_by_idempotency(self, key: str) -> Task | None:
        row = self.conn.execute(
            "SELECT * FROM tasks WHERE idempotency_key = ?", (key,)
        ).fetchone()
        return self._row_to_task(row) if row else None

    def tasks_in_states(self, states: Iterable[str], limit: int = 500) -> list[Task]:
        states = list(states)
        if not states:
            return []
        placeholders = ",".join("?" for _ in states)
        rows = self.conn.execute(
            f"SELECT * FROM tasks WHERE state IN ({placeholders}) "
            f"ORDER BY created_at ASC LIMIT ?",
            (*states, limit),
        ).fetchall()
        return [self._row_to_task(r) for r in rows]

    def transition(
        self, task_id: str, from_states: Iterable[str], to_state: str, **fields: Any
    ) -> bool:
        """原子状态迁移：只有当前状态在 from_states 里才成功。"""
        from_states = list(from_states)
        placeholders = ",".join("?" for _ in from_states)
        sets = ["state = ?", "updated_at = ?"]
        values: list[Any] = [to_state, _iso(datetime.now())]
        for key, value in fields.items():
            sets.append(f"{key} = ?")
            values.append(value)
        values.extend([task_id, *from_states])
        cur = self.conn.execute(
            f"UPDATE tasks SET {', '.join(sets)} "
            f"WHERE id = ? AND state IN ({placeholders})",
            values,
        )
        self.conn.commit()
        return cur.rowcount > 0

    def expire_tasks(self, now: datetime) -> int:
        cur = self.conn.execute(
            "UPDATE tasks SET state = 'expired', updated_at = ? "
            "WHERE state IN ('submitted','queued','deferred') AND deadline IS NOT NULL AND deadline <= ?",
            (_iso(now), _iso(now)),
        )
        self.conn.commit()
        return cur.rowcount

    def cancel_task(self, task_id: str) -> bool:
        return self.transition(
            task_id,
            ("submitted", "queued", "deferred", "admitted"),
            "cancelled",
        )

    def counts(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT state, COUNT(*) AS n FROM tasks GROUP BY state"
        ).fetchall()
        return {r["state"]: r["n"] for r in rows}

    # -- run ----------------------------------------------------------------

    def add_run(self, run: Run) -> None:
        self.conn.execute(
            """INSERT INTO runs
               (id, task_id, provider, model, bucket_key, est, pid, started_at,
                ended_at, status, exit_code, verified, artifacts_json, usage_json,
                quota_delta, log_path, run_dir, error)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                run.id,
                run.task_id,
                run.provider,
                run.model,
                run.bucket_key,
                float(run.est),
                run.pid,
                _iso(run.started_at),
                _iso(run.ended_at),
                run.status,
                run.exit_code,
                1 if run.verified else 0 if run.verified is not None else None,
                json.dumps(run.artifacts, ensure_ascii=False),
                json.dumps(run.usage, ensure_ascii=False),
                run.quota_delta,
                run.log_path,
                run.run_dir,
                run.error,
            ),
        )
        self.conn.commit()

    def update_run(self, run_id: str, **fields: Any) -> None:
        if not fields:
            return
        sets = []
        values: list[Any] = []
        for key, value in fields.items():
            if key in ("artifacts", "usage"):
                key, value = f"{key}_json", json.dumps(value, ensure_ascii=False)
            elif key == "verified":
                value = 1 if value else 0 if value is not None else None
            elif isinstance(value, datetime):
                value = _iso(value)
            sets.append(f"{key} = ?")
            values.append(value)
        values.append(run_id)
        self.conn.execute(f"UPDATE runs SET {', '.join(sets)} WHERE id = ?", values)
        self.conn.commit()

    def get_run(self, run_id: str) -> Run | None:
        row = self.conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
        return self._row_to_run(row) if row else None

    def running_runs(self) -> list[Run]:
        rows = self.conn.execute(
            "SELECT * FROM runs WHERE status = 'running' ORDER BY started_at ASC"
        ).fetchall()
        return [self._row_to_run(r) for r in rows]

    def runs_for_task(self, task_id: str) -> list[Run]:
        rows = self.conn.execute(
            "SELECT * FROM runs WHERE task_id = ? ORDER BY started_at ASC", (task_id,)
        ).fetchall()
        return [self._row_to_run(r) for r in rows]

    def committed_by_bucket(self) -> dict[str, float]:
        rows = self.conn.execute(
            "SELECT bucket_key, COALESCE(SUM(est), 0) AS total "
            "FROM runs WHERE status = 'running' GROUP BY bucket_key"
        ).fetchall()
        return {r["bucket_key"]: float(r["total"]) for r in rows}

    def running_count_by_bucket(self) -> dict[str, int]:
        rows = self.conn.execute(
            "SELECT bucket_key, COUNT(*) AS n FROM runs "
            "WHERE status = 'running' GROUP BY bucket_key"
        ).fetchall()
        return {r["bucket_key"]: int(r["n"]) for r in rows}

    def completed_runs_count(self, bucket_key: str | None = None) -> int:
        if bucket_key:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM runs WHERE status = 'succeeded' AND bucket_key = ?",
                (bucket_key,),
            ).fetchone()
        else:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM runs WHERE status = 'succeeded'"
            ).fetchone()
        return int(row["n"])

    def runs_between(self, bucket_key: str, start: datetime, end: datetime) -> list[Run]:
        rows = self.conn.execute(
            "SELECT * FROM runs WHERE bucket_key = ? AND started_at >= ? AND started_at <= ? "
            "ORDER BY started_at ASC",
            (bucket_key, _iso(start), _iso(end)),
        ).fetchall()
        return [self._row_to_run(r) for r in rows]

    # -- capacity samples ---------------------------------------------------

    def record_sample(self, bucket: Bucket, now: datetime) -> None:
        self.conn.execute(
            """INSERT INTO capacity_samples
               (bucket_key, provider, model_family, resource_kind, ts, remaining,
                unit, window_start, window_end, source, raw_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                bucket.key,
                bucket.provider,
                bucket.model_family,
                bucket.resource_kind,
                _iso(now),
                bucket.remaining,
                bucket.unit,
                _iso(bucket.window.start),
                _iso(bucket.window.end),
                bucket.source,
                json.dumps(bucket.raw, ensure_ascii=False),
            ),
        )
        self.conn.commit()

    def recent_samples(self, bucket_key: str, since: datetime) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT ts, remaining FROM capacity_samples "
            "WHERE bucket_key = ? AND ts >= ? ORDER BY ts ASC",
            (bucket_key, _iso(since)),
        ).fetchall()
        return [{"ts": _dt(r["ts"]), "remaining": r["remaining"]} for r in rows]

    def last_sample_before(self, bucket_key: str, ts: datetime) -> dict[str, Any] | None:
        row = self.conn.execute(
            "SELECT ts, remaining FROM capacity_samples "
            "WHERE bucket_key = ? AND ts < ? ORDER BY ts DESC LIMIT 1",
            (bucket_key, _iso(ts)),
        ).fetchone()
        if not row:
            return None
        return {"ts": _dt(row["ts"]), "remaining": row["remaining"]}

    def prune_samples(self, older_than: datetime) -> int:
        cur = self.conn.execute(
            "DELETE FROM capacity_samples WHERE ts < ?", (_iso(older_than),)
        )
        self.conn.commit()
        return cur.rowcount

    # -- calibration --------------------------------------------------------

    def calibration_get(
        self, task_class: str, provider: str, bucket_key: str
    ) -> tuple[float | None, int]:
        row = self.conn.execute(
            "SELECT ewma_actual, n_samples FROM calibration "
            "WHERE task_class = ? AND provider = ? AND bucket_key = ?",
            (task_class, provider, bucket_key),
        ).fetchone()
        if not row:
            return None, 0
        return float(row["ewma_actual"]), int(row["n_samples"])

    def calibration_update(
        self, task_class: str, provider: str, bucket_key: str, actual: float, alpha: float = 0.3
    ) -> tuple[float, int]:
        old, n = self.calibration_get(task_class, provider, bucket_key)
        if old is None:
            new, new_n = actual, 1
        else:
            new, new_n = (1 - alpha) * old + alpha * actual, n + 1
        self.conn.execute(
            "INSERT OR REPLACE INTO calibration "
            "(task_class, provider, bucket_key, ewma_actual, n_samples) VALUES (?,?,?,?,?)",
            (task_class, provider, bucket_key, new, new_n),
        )
        self.conn.commit()
        return new, new_n

    # -- rows ---------------------------------------------------------------

    def _row_to_task(self, row: sqlite3.Row) -> Task:
        return Task(
            id=row["id"],
            idempotency_key=row["idempotency_key"],
            spec=TaskSpec.from_dict(json.loads(row["spec_json"])),
            requirements=Requirements.from_dict(json.loads(row["requirements_json"])),
            resources=json.loads(row["resources_json"]),
            value=float(row["value"]),
            deadline=_dt(row["deadline"]),
            task_class=row["task_class"],
            state=row["state"],
            attempts=int(row["attempts"]),
            created_at=_dt(row["created_at"]) or datetime.now(),
            updated_at=_dt(row["updated_at"]) or datetime.now(),
        )

    def _row_to_run(self, row: sqlite3.Row) -> Run:
        return Run(
            id=row["id"],
            task_id=row["task_id"],
            provider=row["provider"],
            model=row["model"],
            bucket_key=row["bucket_key"],
            est=float(row["est"]),
            pid=row["pid"],
            started_at=_dt(row["started_at"]) or datetime.now(),
            ended_at=_dt(row["ended_at"]),
            status=row["status"],
            exit_code=row["exit_code"],
            verified=bool(row["verified"]) if row["verified"] is not None else None,
            artifacts=json.loads(row["artifacts_json"] or "[]"),
            usage=json.loads(row["usage_json"] or "{}"),
            quota_delta=row["quota_delta"],
            log_path=row["log_path"],
            run_dir=row["run_dir"],
            error=row["error"],
        )


# 便于测试/CLI 的辅助
def new_idempotency_key(prefix: str = "auto") -> str:
    return f"{prefix}-{uuid.uuid4().hex}"


__all__ = [
    "TaskStore",
    "ACTIVE_STATES",
    "TERMINAL_STATES",
    "new_idempotency_key",
    "timedelta",
]
