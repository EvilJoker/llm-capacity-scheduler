"""最小 runner：本地 shell 命令。

崩溃可重入的关键设计：**退出码写文件**，而不是依赖父进程 waitpid。
这样即使引擎重启（run 不再是子进程），也能通过 `.exit_code` 文件判定结束。

产物目录布局：
    artifacts/<task_id>/<run_id>/
        stdout.log
        stderr.log
        .exit_code
        <任务自己产出的文件>
"""

from __future__ import annotations

import os
import signal
import subprocess
from datetime import datetime
from pathlib import Path

from ..models import Run, Task
from .base import RunResult

INTERNAL_FILES = {".exit_code", "stdout.log", "stderr.log"}

_WRAPPER = '"$@"\necho $? > "$LCS_EXIT_FILE"\n'


class ShellRunner:
    name = "shell"

    def __init__(self, artifacts_dir: str | Path, base_dir: str | Path | None = None):
        self.artifacts_dir = Path(artifacts_dir)
        self.base_dir = Path(base_dir) if base_dir else Path.cwd()

    # -- 生命周期 -----------------------------------------------------------

    def spawn(self, task: Task, run: Run) -> int:
        spec = task.spec
        if not spec.cmd:
            raise ValueError(f"task {task.id} 没有 cmd，shell runner 无法执行")

        run_dir = self._run_dir(task, run)
        run_dir.mkdir(parents=True, exist_ok=True)
        run.run_dir = str(run_dir)
        run.log_path = str(run_dir / "stdout.log")

        # 默认在产物目录里执行：任务写出的相对路径文件天然成为产物。
        # 需要仓库上下文的命令用 spec.cwd 显式指定。
        cwd = Path(spec.cwd) if spec.cwd else run_dir
        if not cwd.is_absolute():
            cwd = self.base_dir / cwd

        env = os.environ.copy()
        env.update({k: str(v) for k, v in spec.env.items()})
        env["LCS_TASK_ID"] = task.id
        env["LCS_RUN_ID"] = run.id
        env["LCS_ARTIFACT_DIR"] = str(run_dir)
        env["LCS_EXIT_FILE"] = str(run_dir / ".exit_code")

        wrapper = ["/bin/sh", "-c", _WRAPPER, "lcs-run", *spec.cmd]
        with open(run_dir / "stdout.log", "wb") as out, open(
            run_dir / "stderr.log", "wb"
        ) as err:
            proc = subprocess.Popen(  # noqa: S603 - 任务 spec 即本地命令，边界见 TASK.md 已知坑 #6
                wrapper,
                cwd=str(cwd),
                env=env,
                stdout=out,
                stderr=err,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        return int(proc.pid)

    def poll(self, task: Task, run: Run, now: datetime) -> RunResult | None:
        run_dir = Path(run.run_dir) if run.run_dir else None
        if run_dir is None:
            return RunResult(
                status="failed", ended_at=now, error="run_dir 缺失（不是本 runner 创建的 run）"
            )

        exit_file = run_dir / ".exit_code"
        if exit_file.exists():
            exit_code = self._read_exit_code(exit_file)
            ended_at = datetime.fromtimestamp(exit_file.stat().st_mtime)
            verified, verify_error = self._verify(task, run_dir)
            status = "succeeded" if exit_code == 0 and verified else "failed"
            return RunResult(
                status=status,
                ended_at=ended_at,
                exit_code=exit_code,
                verified=verified,
                artifacts=self._artifacts(run_dir),
                usage={"exit_code": exit_code},
                error=verify_error,
            )

        # 还没结束：检查进程是否还活着 + 超时
        if run.pid is not None and self._pid_alive(run.pid):
            timeout_s = int(task.spec.timeout_s or 0)
            if timeout_s > 0 and (now - run.started_at).total_seconds() > timeout_s:
                self.kill(task, run)
                return RunResult(
                    status="timeout",
                    ended_at=now,
                    error=f"超过 timeout_s={timeout_s}",
                    artifacts=self._artifacts(run_dir),
                )
            return None

        # 进程没了但没有退出码文件 → 异常死亡
        return RunResult(
            status="failed",
            ended_at=now,
            exit_code=-1,
            verified=False,
            artifacts=self._artifacts(run_dir),
            error="进程在写出退出码前结束（可能是 OOM / 被 kill）",
        )

    def kill(self, task: Task, run: Run) -> None:
        if run.pid is None:
            return
        try:
            os.killpg(os.getpgid(run.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                os.kill(run.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass

    # -- 内部 ---------------------------------------------------------------

    def _run_dir(self, task: Task, run: Run) -> Path:
        return self.artifacts_dir / task.id / run.id

    @staticmethod
    def _read_exit_code(path: Path) -> int:
        try:
            return int(path.read_text(encoding="utf-8").strip() or "-1")
        except (OSError, ValueError):
            return -1

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True

    def _verify(self, task: Task, run_dir: Path) -> tuple[bool, str | None]:
        """验收 = 声明产物存在 + verifier 命令 exit 0。"""
        for rel in task.spec.expect_artifacts:
            if not (run_dir / rel).exists():
                return False, f"缺少声明产物: {rel}"
        if task.spec.verify_cmd:
            try:
                proc = subprocess.run(  # noqa: S603
                    task.spec.verify_cmd,
                    cwd=str(run_dir),
                    capture_output=True,
                    text=True,
                    timeout=max(60, int(task.spec.timeout_s or 0)),
                )
            except subprocess.TimeoutExpired:
                return False, "verifier 超时"
            except OSError as exc:
                return False, f"verifier 无法启动: {exc}"
            if proc.returncode != 0:
                return False, f"verifier 失败 exit={proc.returncode}: {proc.stderr.strip()[:300]}"
        return True, None

    def _artifacts(self, run_dir: Path) -> list[str]:
        found: list[str] = []
        for path in sorted(run_dir.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(run_dir).as_posix()
            if rel in INTERNAL_FILES:
                continue
            found.append(rel)
        return found


__all__ = ["ShellRunner", "INTERNAL_FILES"]
