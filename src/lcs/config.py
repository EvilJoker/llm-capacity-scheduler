"""配置加载：TOML（stdlib tomllib，零第三方依赖）。

优先级：显式 path > 环境变量 LCS_CONFIG > ./config.toml > 内置默认值。
环境变量可覆盖关键路径（LCS_DB / LCS_ARTIFACTS），方便测试与多实例隔离。
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, replace
from datetime import time
from pathlib import Path
from typing import Any


def _parse_time(v: str | time | None, default: time) -> time:
    if v is None:
        return default
    if isinstance(v, time):
        return v
    hh, mm = v.split(":")
    return time(int(hh), int(mm))


def _parse_path(v: str | None, base: Path) -> Path | None:
    if not v:
        return None
    p = Path(os.path.expanduser(v))
    if not p.is_absolute():
        p = base / p
    return p


@dataclass
class UsageProfile:
    """自用率时间表：reserve(t) = 从 t 到窗口结束的预期自用量。

    这是 reserve 的唯一输入。规则（工作时段留量 / 尾段烧光 / 深夜立刻烧）
    全部由它 + reserve 函数涌现，而不是硬编码。
    """

    workdays: tuple[int, ...] = (1, 2, 3, 4, 5)  # ISO weekday: 1=Mon
    work_start: time = time(9, 0)
    work_end: time = time(19, 30)
    work_rate_pct_per_hour: float = 8.0
    offhours_rate_pct_per_hour: float = 0.5


@dataclass
class PeakWindow:
    """高峰限流时段：降低强度，但不禁止（不可易逝的约束）。"""

    days: tuple[int, ...] = (1, 2, 3, 4, 5)
    start: time = time(15, 0)
    end: time = time(17, 30)
    slots_factor: float = 0.5
    reserve_multiplier: float = 1.0


@dataclass
class PolicyConfig:
    name: str = "burn_before_expiry"
    # 尾段：窗口结束前 burn_lead_minutes 内视为「必须开烧」
    burn_lead_minutes: float = 30.0
    # reserve 下限：无论估算多低，至少保留这么多（保护基本任务）
    min_reserve_pct: float = 5.0
    # 预估安全系数：est = ewma/中位数 × safety_factor
    safety_factor: float = 1.5
    # 没有历史校准时的默认单任务消耗（百分点）
    default_est_pct: float = 3.0
    # 校准生效所需最小样本数
    calibration_min_samples: int = 3
    # 单桶并发上限
    max_concurrent_per_bucket: int = 2
    # 全局并发上限
    max_parallel_total: int = 4
    # 工作时段是否允许「非尾段」提前烧。False = 严格只在 burn_lead 内烧（保守）
    work_hours_opportunistic: bool = False
    # 自用活跃检测：回看窗口内余量下降超过阈值 → 认为用户正在用，让路
    activity_lookback_minutes: float = 10.0
    activity_drop_threshold_pct: float = 1.0
    # PAYG：1 点业务价值 = 多少货币；cost*该系数 <= value 才允许付费执行
    value_points_per_currency: float = 100.0
    # 任务价值低于此值不调度
    min_value: float = 0.0
    usage_profile: UsageProfile = field(default_factory=UsageProfile)
    peak_windows: list[PeakWindow] = field(default_factory=list)

    def is_peak(self, now) -> bool:
        for w in self.peak_windows:
            if now.isoweekday() not in w.days:
                continue
            if w.start <= now.time() < w.end:
                return True
        return False


@dataclass
class EngineConfig:
    tick_seconds: float = 60.0
    db_path: Path = Path("state.db")
    artifacts_dir: Path = Path("artifacts")
    log_dir: Path = Path("logs")
    # 单个 run 的兜底超时（秒），任务 spec 未指定时使用
    default_timeout_s: int = 1800


@dataclass
class ProviderConfig:
    name: str
    kind: str  # minimax | payg
    enabled: bool = True
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class Config:
    engine: EngineConfig = field(default_factory=EngineConfig)
    policy: PolicyConfig = field(default_factory=PolicyConfig)
    providers: list[ProviderConfig] = field(default_factory=list)
    base_dir: Path = field(default_factory=Path.cwd)

    def enabled_providers(self) -> list[ProviderConfig]:
        return [p for p in self.providers if p.enabled]


DEFAULT_CONFIG_PATHS = (
    Path("config.toml"),
    Path("lcs.toml"),
)


def find_config_path(explicit: str | Path | None = None) -> Path | None:
    if explicit:
        return Path(os.path.expanduser(str(explicit)))
    env = os.environ.get("LCS_CONFIG")
    if env:
        return Path(os.path.expanduser(env))
    for candidate in DEFAULT_CONFIG_PATHS:
        if candidate.exists():
            return candidate
    return None


def load_config(path: str | Path | None = None, *, allow_missing: bool = True) -> Config:
    """加载配置。找不到文件时返回内置默认值（providers 为空）。"""
    resolved = find_config_path(path)
    if resolved is None:
        return _apply_env_overrides(Config())
    if not resolved.exists():
        if allow_missing:
            return _apply_env_overrides(Config())
        raise FileNotFoundError(f"config not found: {resolved}")

    raw = tomllib.loads(resolved.read_text(encoding="utf-8"))
    base = resolved.resolve().parent
    cfg = _from_raw(raw, base)
    return _apply_env_overrides(cfg)


def _from_raw(raw: dict[str, Any], base: Path) -> Config:
    eng_raw = raw.get("engine", {}) or {}
    engine = EngineConfig(
        tick_seconds=float(eng_raw.get("tick_seconds", 60)),
        db_path=_parse_path(eng_raw.get("db"), base) or base / "state.db",
        artifacts_dir=_parse_path(eng_raw.get("artifacts_dir"), base) or base / "artifacts",
        log_dir=_parse_path(eng_raw.get("log_dir"), base) or base / "logs",
        default_timeout_s=int(eng_raw.get("default_timeout_s", 1800)),
    )

    pol_raw = raw.get("policy", {}) or {}
    up_raw = pol_raw.get("usage_profile", {}) or {}
    usage = UsageProfile(
        workdays=tuple(int(d) for d in up_raw.get("workdays", [1, 2, 3, 4, 5])),
        work_start=_parse_time(up_raw.get("work_start"), time(9, 0)),
        work_end=_parse_time(up_raw.get("work_end"), time(19, 30)),
        work_rate_pct_per_hour=float(up_raw.get("work_rate_pct_per_hour", 8.0)),
        offhours_rate_pct_per_hour=float(up_raw.get("offhours_rate_pct_per_hour", 0.5)),
    )
    peaks = []
    for w in pol_raw.get("peak_windows", []) or []:
        peaks.append(
            PeakWindow(
                days=tuple(int(d) for d in w.get("days", [1, 2, 3, 4, 5])),
                start=_parse_time(w.get("start"), time(15, 0)),
                end=_parse_time(w.get("end"), time(17, 30)),
                slots_factor=float(w.get("slots_factor", 0.5)),
                reserve_multiplier=float(w.get("reserve_multiplier", 1.0)),
            )
        )
    policy = PolicyConfig(
        name=pol_raw.get("name", "burn_before_expiry"),
        burn_lead_minutes=float(pol_raw.get("burn_lead_minutes", 30)),
        min_reserve_pct=float(pol_raw.get("min_reserve_pct", 5)),
        safety_factor=float(pol_raw.get("safety_factor", 1.5)),
        default_est_pct=float(pol_raw.get("default_est_pct", 3.0)),
        calibration_min_samples=int(pol_raw.get("calibration_min_samples", 3)),
        max_concurrent_per_bucket=int(pol_raw.get("max_concurrent_per_bucket", 2)),
        max_parallel_total=int(pol_raw.get("max_parallel_total", 4)),
        work_hours_opportunistic=bool(pol_raw.get("work_hours_opportunistic", False)),
        activity_lookback_minutes=float(pol_raw.get("activity_lookback_minutes", 10)),
        activity_drop_threshold_pct=float(
            pol_raw.get("activity_drop_threshold_pct", 1.0)
        ),
        value_points_per_currency=float(
            pol_raw.get("value_points_per_currency", 100.0)
        ),
        min_value=float(pol_raw.get("min_value", 0.0)),
        usage_profile=usage,
        peak_windows=peaks,
    )

    providers: list[ProviderConfig] = []
    for p in raw.get("providers", []) or []:
        if not p.get("name") or not p.get("kind"):
            raise ValueError("provider 配置必须包含 name 与 kind")
        providers.append(
            ProviderConfig(
                name=p["name"],
                kind=p["kind"],
                enabled=bool(p.get("enabled", True)),
                options=dict(p.get("options") or {}),
            )
        )

    return Config(engine=engine, policy=policy, providers=providers, base_dir=base)


def _apply_env_overrides(cfg: Config) -> Config:
    db = os.environ.get("LCS_DB")
    art = os.environ.get("LCS_ARTIFACTS")
    engine = cfg.engine
    if db:
        engine = replace(engine, db_path=Path(os.path.expanduser(db)))
    if art:
        engine = replace(engine, artifacts_dir=Path(os.path.expanduser(art)))
    if engine is not cfg.engine:
        cfg = replace(cfg, engine=engine)
    return cfg


# ---------------------------------------------------------------------------
# 示例配置（`lcs init-config` 输出）
# ---------------------------------------------------------------------------

EXAMPLE_CONFIG = """\
# lcs 配置示例。复制为 config.toml 后按需修改。
# 本文件包含真实 provider 的接入方式；API key 建议放环境变量或 ~/.mmx/config.json。

[engine]
tick_seconds = 60
db = "state.db"
artifacts_dir = "artifacts"
log_dir = "logs"
default_timeout_s = 1800

[policy]
name = "burn_before_expiry"
burn_lead_minutes = 30          # 窗口结束前 30 分钟内必须开烧
min_reserve_pct = 5.0           # 无论如何保留 5%（基本任务保护）
safety_factor = 1.5             # 预估消耗的安全系数
default_est_pct = 3.0           # 冷启动单任务默认消耗（百分点）
calibration_min_samples = 3
max_concurrent_per_bucket = 2
max_parallel_total = 4
work_hours_opportunistic = false  # 工作时段：严格只在尾段烧
activity_lookback_minutes = 10
activity_drop_threshold_pct = 1.0
value_points_per_currency = 100  # 付费型：100 点价值 = 1 单位货币

[policy.usage_profile]
# 自用率时间表：工作日 9:00-19:30 是用户自己在用，余量要留给他们
workdays = [1, 2, 3, 4, 5]
work_start = "09:00"
work_end = "19:30"
work_rate_pct_per_hour = 8.0
offhours_rate_pct_per_hour = 0.5

[[policy.peak_windows]]
# MiniMax 工作日 15:00-17:30 是高峰动态限流：降档，不是禁止
days = [1, 2, 3, 4, 5]
start = "15:00"
end = "17:30"
slots_factor = 0.5

[[providers]]
name = "minimax"
kind = "minimax"
enabled = true

[providers.options]
# key 读取顺序：环境变量 → api_key_file 里的 "api_key" 字段
api_key_env = "MINIMAX_API_KEY"
api_key_file = "~/.mmx/config.json"
endpoint = "https://api.minimaxi.com/v1/token_plan/remains"
families = ["general"]           # 只调度 text 桶；video 桶按需加
text_tokens_per_pct = 50000      # 1% 配额 ≈ 多少 text token（用于 est 换算）
timeout_s = 20

[[providers]]
name = "openrouter_credits"
kind = "payg"
enabled = false

[providers.options]
state_file = "~/.lcs/payg.json"  # {"balance": 12.34, "currency": "USD"}
unit = "money"
unit_price_per_1k_tokens = 0.002
"""
