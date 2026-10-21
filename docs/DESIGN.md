# 设计文档：通用容量感知调度引擎（v0.1）

> 目标读者：后续接手的 agent / 未来的自己。看完这一份应当能直接写代码。
>
> **v0.2 起模型有更新**（六实体 / Queue 语义 / Assignment / 窗口抢占 / MCP+Web 形态），
> 以 [`docs/MCP-DESIGN.md`](MCP-DESIGN.md) 为准；本文保留为 v0.1 的实现依据。

---

## 1. 问题定义

> **引擎 = 一个「可调度容量库存管理 + 异步任务队列」**

| 项 | 内容 |
|---|---|
| 输入 | `N 个 provider 的容量快照`（多维、易逝、部分不可观测）× `用户策略` × `任务积压队列` |
| 输出 | `派发决策`（用谁 / 用多强 / 是否现在跑）+ `持久化运行记录与产物` |
| 消费者 | agent —— 只 `submit` 和 `poll`，不关心何时 / 用哪家 / 烧多少 |
| 内核 | **多维易逝容量上的准入控制 + 派发**（bin packing over perishable capacity） |

### 核心循环（reconcile 式，**不是**事件驱动）

```python
tick every 60s:
    caps     = observe_all_providers()      # Set<Bucket> 容量快照
    activity = detect_self_usage()          # 我自己正在用吗（让路）
    while admit(caps, activity, backlog):   # 准入控制 = 核心
        task  = pick_by_value_density(backlog)
        lease = reserve_capacity(task.est)  # 在飞占位，防并发超支
        spawn(runner, task, lease)
    reap_finished()                         # 收口：usage / quota_delta / 校准
```

**为什么用 tick + reconcile 而不是事件驱动**：崩溃后天然可重入、每次全量对账不会 drift、
好测试。k8s 控制循环同款思想。

---

## 2. 容量模型：三维 + Bucket

### 2.1 通用性来自哪里

**不要按"规则"建模**（`if provider == minimax then ...`）。加到第 4 家就会爆炸。
任何计费方案都可以分解为三个**正交维度**：

### 维度 1：生命周期语义（谁让它过期？）

| 类型 | 语义 | 实例 | 对策略的含义 |
|---|---|---|---|
| `fixed_grid` | 绝对时间栅格，到点归满 | MiniMax 5h（实测 10-15） | 窗口关闭即作废，**必须提前烧** |
| `rolling_on_first_use` | 首次使用才开始计时 | Claude 5h | 不存在"刷新前"，只有"让窗口背靠背" |
| `calendar` | 周/月，按日期归满 | 各家周限额 | 粒度粗，接近过期才值得激进 |
| `depleting` | 只减不归满 | Credits、PAYG 余额 | **烧 = 花钱**，策略反转 |
| `unlimited` | 无限 | MiniMax 周限额（老用户） | **必须显式建模，不能塞进 100%** |

> ⚠️ **坑**：MiniMax 周限额返回 `remaining_percent: 100` + `current_weekly_status: 3`。
> 若当成"还剩 100% 额度"，reserve 逻辑会以为还有大把空间，直接烧穿 5h 窗口。
> `unlimited` 是独立字段，**不参与准入计算**。

### 维度 2：约束维度（什么在限流？）

| 约束 | 易逝？ | 连续恢复？ | 需要建模的动作 |
|---|---|---|---|
| **配额窗口** quota | ✅ 会作废 | ❌ 到点跳变 | 挑时机烧 |
| **速率限制** rate limit | ❌ | ✅ 令牌桶 | 排队，**不需要挑时机** |
| **并发槽位** concurrency | ❌ | ✅ | 限并发数 |
| **高峰限流** throttle | ❌ | — | 避开时段（MiniMax 工作日 15:00–17:30） |
| **金额预算** budget | ❌ | ✅ 充值 | 价值 > 价格才跑 |
| **资源桶** bucket | 各自不同 | — | 见 2.2 |

**"可调度性"只存在于第 1 行和第 6 行。** 把 rate limit 当配额优化时机是纯浪费。

### 维度 3：付费性质（超用要付什么？）

| 类型 | 超用代价 | 未用代价 | 目标函数 |
|---|---|---|---|
| `free_perishable` | 硬阻塞 | **纯浪费** | 最大化利用率 |
| `paid` | 真金白银 | 无 | 最小化成本，价值 > 价格才跑 |
| `mixed` | 先订阅后 Credits | 浪费订阅部分 | 分层：订阅优先，Credits 仅紧急 |

### 2.2 Bucket：容量不是标量

MiniMax `model_remains` 已暴露这一点：`general` 是 5h token 桶，`video` 是**日窗口 + 按次计数**
的完全不同的桶，image / speech 又各自独立。

```python
@dataclass
class Bucket:
    provider: str
    model_family: str          # "general" / "video" / "image" / ...
    resource_kind: str         # "text_tokens" / "clips" / "images"
    window: Window
    remaining: float | None    # 百分比或绝对数；None = unknown
    unit: str                  # "pct" | "count" | "tokens" | "money"
    constraints: list[Constraint]

@dataclass
class Window:
    lifecycle: str             # fixed_grid | rolling_on_first_use | calendar | depleting | unlimited
    start: datetime | None
    end: datetime | None       # ← 唯一权威的"刷新时刻"，绝不写死 cron
    unlimited: bool
    carry_over: bool
```

> **关键**：`end` 必须每次都从 provider 读。MiniMax 的 5h 与 24h 不整除，窗口边界每天会漂，
> 写死 `*/5 14-15 * * *` 的 cron 一定会错。

### 2.3 任务侧：资源需求向量

```yaml
task:
  resources: { text_input_tokens: 120000, text_output_tokens: 8000 }
  # 视频任务则是: { video_clips: 1 }
  requirements:
    min_context: 200000
    modalities: [text]
    quality_tier: standard     # cheap | standard | best
    structured_output: true
  value: 70                    # 业务价值 0..100
  deadline: 2026-10-22T09:00
  max_cost: 0                  # 付费型容量的价格上限
```

引擎把需求向量匹配到桶上 → **多维装箱**。这是整个框架的学术内核。

---

## 3. 策略核心：reserve 是时间的函数，不是常数

### 3.1 公式

```
reserve(t) = 从 t 到 window.end 这段时间，预期自己还要用掉的容量
准入：remaining(t) − committed_inflight − est(new_task) > reserve(t)
```

**这就是易逝品收益管理里的阈值 / 出价（bid-price）策略**：阈值 = 未来需求的机会成本。

### 3.2 用户直觉规则如何自动涌现

| 场景 | reserve(t) | 行为 | 对应的原始直觉 |
|---|---|---|---|
| 工作时段中间 | 高（≈ 历史自用量） | 不烧 | 工作时段不烧 |
| 工作时段末尾 30min | → 0（马上作废） | 全烧 | "刷新前半小时烧掉" |
| 深夜空闲窗口 | ≈ 0（人睡了） | 一刷新就烧 | "非工作时间立刻开工" |
| **窗口横跨上班时刻** | 按到上班时刻的预期用量 | 保留到上班 | ✅ 自动修正"一刷新就烧会烧掉上班额度" |
| PAYG 余额 | = 该任务值多少钱 | 价值 > 价格才跑 | 自动扩展到付费型 |

> 原始三条规则互相打架（尤其 05:00 开烧会烧穿 09:00 要用的量），换成一个函数后自洽。

### 3.3 reserve 的三个性质

1. **时间函数**，不是配置常量。
2. `unlimited` 维度不参与公式（没有机会成本）。
3. `depleting` 维度的 reserve 是**价格**而非用量。

---

## 4. 准入控制与在飞占位

### 4.1 为什么必须 lease

配额是**纯滞后**观测：任务跑完才下降。若只看 `remaining` 就并发派发，一定超支。
所以每个派发先占位：

```python
committed_inflight = sum(lease.est for lease in running_leases)
est = ewma_actual(task_class) * SAFETY_FACTOR(1.3 ~ 2.0)
admit = remaining - committed_inflight > reserve(t) + est
```

### 4.2 强度映射

```python
def intensity(remaining, time_left, activity):
    if activity.busy:              return 0        # 让路
    if in_peak_window(now):        slots //= 2     # 高峰降档
    if remaining > 70:             slots = 3
    elif remaining > 40:           slots = 2
    elif remaining > 15:           slots = 1
    else:                          return 0
    return min(slots, provider.concurrency_cap)
```

### 4.3 控制论视角（真正的工程难点）

| 问题 | 表现 |
|---|---|
| 传感器量化 | 配额只给整数 %，单任务消耗可能 < 1%，**测不出来** |
| 纯滞后 | 任务 10–30 分钟，决策基于 30 分钟前观测 |
| 不可预知 | 同 prompt 消耗可差 3 倍（上下文、思考量、重试） |
| 增益未知 | 不同 provider 的"1%"代表多少 token 不同，无量纲统一 |

对策：
1. **硬护栏**：`remaining − committed > reserve + est`
2. **保守前馈 + 慢积分校正**：`est = 历史中位数 × 安全系数`，跑完用实测 delta 做 EWMA
3. **冷启动 canary**：新 provider / 新任务类型先小任务探针，测增益再放大
4. **不对称原则**：over-burn 会伤到自己的正常工作；under-burn 只是浪费免费额度。**永远偏保守。**

---

## 5. 任务系统契约（agent 视角）

### 5.1 状态机

```
submitted → queued → admitted → running → succeeded
                 ↘ deferred ↗         ↘ failed
                 ↘ expired（超过 deadline）
                          ↘ cancelled
```

`admitted` 与 `running` **必须分开**：`提交 ≠ 执行`。这是本引擎与普通队列最本质的区别，
必须写进对外契约。

### 5.2 API

```
POST /tasks                 提交 → task_id（可立即返回，状态可能 deferred）
GET  /tasks?ids=a,b,c       批量轮询状态 + 结果引用
GET  /tasks/{id}/events     进度 / 流
POST /tasks/{id}/cancel
POST /tasks/{id}/feedback   验收结果 → 回灌 value / calibration
```

### 5.3 必须钉死的语义

| 语义 | 为什么 |
|---|---|
| **幂等键** `idempotency_key` | agent 会重试 submit，不能重复跑 |
| **提交 ≠ 执行**（deferred 合法） | 整个产品的核心价值 |
| **deadline / TTL** | 否则 backlog 无限膨胀，永远在跑过期任务 |
| **结果与产物分离** | 结果引用 artifacts（路径/对象存储），不塞 JSON |
| **succeeded 必须有验证** | = 产物存在 + 校验通过（exit code / schema / 测试），否则下游在垃圾上盖楼 |

---

## 6. 架构与扩展点

```
┌ Capacity (适配器，扩展点 A) ──────────────────────┐
│ Adapter.observe() → Set<Bucket>                   │
│ source: api | manual | unknown                    │
└───────────────┬───────────────────────────────────┘
                ▼
┌ Policy (准入控制) ─────────────────────────────────┐
│ reserve_fn(bucket, now, activity, history) → %    │
│ admit(bucket, task) → bool                        │
│ intensity(...) → slots / effort                   │
│ schedule_filter: 高峰避让 / 自我活跃让路           │
└───────────────┬───────────────────────────────────┘
                ▼
┌ TaskStore (SQLite) ───────────────────────────────┐
│ tasks / runs / leases / capacity_samples / calib   │
└───────────────┬───────────────────────────────────┘
                ▼
┌ Runner (执行器，扩展点 B) ────────────────────────┐
│ run(task, lease) → {status, artifacts, usage}     │
│ 实现：shell | dsh headless | claude-code | HTTP    │
└───────────────────────────────────────────────────┘
```

**两个正交扩展点**：`Adapter` 换 provider 不影响 runner；`Runner` 换执行方式不影响 provider。

### 6.1 数据模型（SQLite）

```sql
providers(id, kind, config_json, enabled)
capacity_samples(id, provider, model_family, resource_kind,
                 ts, remaining, unit, window_start, window_end, source)
tasks(id, idempotency_key UNIQUE, spec_json, requirements_json,
      resources_json, value, deadline, state, attempts,
      created_at, updated_at)
runs(id, task_id, provider, model, lease_est,
     started_at, ended_at, usage_json, quota_delta,
     status, artifacts_json, verified)
leases(run_id, bucket_key, est, created_at)
calibration(task_class, provider, ewma_actual, n_samples)
```

### 6.2 Provider adapter 契约

```python
class Adapter(Protocol):
    def observe(self) -> list[Bucket]: ...
    # 失败时必须返回 source="unknown" 而不是抛异常；
    # 策略对 unknown 的默认是「不烧」（安全默认）
```

---

## 7. 反模式清单

| ❌ 反模式 | 为什么致命 | ✅ 正确做法 |
|---|---|---|
| 先设计策略 DSL | 只有 1 个真实用例，DSL 一定长歪 | 先用 4 个固定策略 + 参数：`burn_before_expiry` / `fill_idle_window` / `cheapest_capable` / `quality_first`，等第二个需求出现再抽象 |
| 造通用优化器（ILP） | 单用户几十任务，贪心就够 | 贪心 + value_density 排序，留 `Assignment` 接口 |
| 常驻 daemon + 事件状态机 | 崩溃后难对账 | **tick + reconcile** |
| 本地账本当权威 | drift 后所有决策都错 | **provider 是唯一真相**，本地账本只做归因/校准 |
| `unlimited` 当 100% | 误判余量 | 独立字段，不参与准入 |
| 让 agent 提交任意任务并执行 | **这是 RCE 服务**，且持有全部 API key | 任务 spec 校验 + bwrap/容器沙箱 + 资源上限 + 破坏性操作审批 |
| 把 token 消耗当 KPI | 会为"烧得多"跑垃圾任务 | KPI = **有价值产出的数量 / 浪费额度回收率** |

---

## 8. MVP 边界（v0.1）

**做**：
- SQLite 单文件 + 60s tick
- 2 个性质截然不同的 adapter：`minimax_fixed_grid`（易逝）+ `payg_balance`（付费）—— 用两家逼出抽象
- 1 个策略：`burn_before_expiry`，reserve 为时间函数
- 1 个 runner：shell
- CLI：`submit` / `poll` / `status`

**不做**：UI、MCP、多租户、DSL、优化器、agent loop

**验收**：MiniMax 5h 窗口在 `end_time − 30min` 自动开烧，烧到 reserve 停，产出落 artifacts。

> **通用性成立的标准只有一条**：加第三家 provider 时改的是 `adapters/*.py`，不是 `policy/*.py`。

---

## 9. 待定决策（开工前需拍板）

| # | 问题 | 备选 | 倾向 |
|---|---|---|---|
| 1 | 执行边界：引擎自己跑 agent loop，还是只调度 + 调外部 runner？ | 内置 / 外挂 | **外挂**：引擎越小越通用，agent loop 交给各家 harness |
| 2 | 提交方：只本机 agent（MCP/CLI），还是开放 HTTP？ | 本地 / 开放 | 先本地，决定安全模型 |
| 3 | 单机单用户 vs 多用户多机？ | SQLite / Postgres | **单机 SQLite 到底** |
| 4 | 是否支持非 LLM 任务（纯 shell/HTTP/Docker）？ | 是 / 否 | **是**：runner 抽象天生支持，且让任务系统立刻有价值 |
| 5 | 产物与验收：本地路径 vs 对象存储？谁判定成功？ | — | 本地 paths + verifier 命令 |
