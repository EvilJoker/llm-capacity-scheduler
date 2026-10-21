# llm-capacity-scheduler

> **面向 LLM 后端的「容量感知异步任务调度器」——把会过期的配额，变成有价值的产出。**

## 一句话定位

引擎持续监控**多个第三方 LLM 的容量窗口**（配额 / 限流 / 并发 / 余额），结合**用户策略**决定
「**什么时候、用谁、用多强的强度**」去执行队列里的任务；调用方（通常是 agent）只负责
`submit` 和 `poll`，不关心调度细节。

```
                ┌──────────────────────────────────────────┐
   agent ──────▶│  submit(task)  →  task_id                │
                │                                          │
                │  ┌──────────┐   ┌──────────┐   ┌───────┐ │
                │  │ Capacity │──▶│  Policy  │──▶│Runner │ │
                │  │ adapter  │   │ 准入控制  │   │ 执行  │ │
                │  └──────────┘   └──────────┘   └───────┘ │
                │        ▲              │             │    │
                │        │        ┌─────▼─────┐  ┌────▼──┐ │
                │   多 provider   │ TaskStore │  │ 产物   │ │
                │   配额快照       │ 状态机     │  │artifact│ │
                └──────────────────────────────────────────┘
   agent ◀──────  poll(task_ids) → status + artifacts
```

## 要解决的问题

订阅制 LLM（MiniMax Token Plan、Claude Code、Codex …）的容量有几种**截然不同**的性质：

| 性质 | 后果 |
|---|---|
| 配额分**固定窗口**（如 MiniMax 5h：10-15 / 15-20） | 窗口内用不完就**作废**，官方明确不滚存 |
| 部分维度**周/月无限** | 真正稀缺的只有窗口内那一份 |
| 部分**只在工作时间需要** | 白天要留给自己写代码，深夜空闲才可自由消耗 |
| 另一些是**付费余额**（Credits / PAYG） | 烧它就是花钱，策略必须反转 |
| 还叠加 **rate limit / 并发槽位 / 高峰限流** | 这些**不作废**，不该当"配额"去优化时机 |

把人眼盯着仪表盘 + 手动跑任务的流程，变成一个**自动在空闲时段把易逝容量转化为产出**的引擎。
MiniMax 只是**第一个具体实现**（provider adapter），不是框架本身。

## 不做什么

- ❌ **不是 LLM 网关**：模型调用/故障转移/多供应商协议转换交给 LiteLLM 之类的网关。
- ❌ **不是 durable workflow 引擎**：多步流程编排交给 Temporal/Hatchet/Inngest。
- ❌ **不是监控面板**：看板是附属产物，不是目的。
- ❌ **不追求通用优化器**：单用户规模，贪心 + 价值密度排序足够。

它恰好卡在网关（负责"怎么调"）与持久化执行引擎（负责"不丢"）之间的**空白层**：
**负责"该不该现在调、调多少、用哪家"**。

## 四个核心概念

1. **Capacity（容量）** — 不是"剩余百分比"，而是 `Set<Bucket>`。
   每个 Bucket = `(provider, model_family, resource_kind, window)`，
   window 有五种生命周期：`fixed_grid` / `rolling_on_first_use` / `calendar` / `depleting` / `unlimited`。
2. **Policy（策略）** — 核心是**把 reserve 建成时间的函数**，而不是一个常数：
   `reserve(t) = 从 t 到窗口过期，预期自己还要用掉的容量`（= 机会成本 / 期权价值）。
   用户的所有直觉规则（工作时段留 10%、下班前一刷新就烧、刷新前 30 分钟烧光）都由此**自动涌现**。
3. **Task（任务）** — 声明的是**资源需求向量**（不只"token 强度"）+ 价值 + deadline，而不是"一段 prompt"。
4. **Runner（执行器）** — 可插拔：`shell` / `dsh headless` / `claude-code` / `mmx` / `HTTP`。
   引擎不拥有 agent loop；引擎只决定"派发什么、派给谁"。

## 里程碑

| 版本 | 内容 | 验收标准 |
|---|---|---|
| **v0.1** | SQLite + tick 循环 + 2 个性质截然不同的 adapter（`minimax_fixed_grid` / `payg_balance`）+ 1 个策略（`burn_before_expiry`，reserve 为时间函数）+ shell runner + CLI `submit/poll` | **端到端跑通**：MiniMax 5h 窗口在 `end_time - 30min` 自动开烧，烧到 reserve 停，产出落 artifacts |
| **v0.2** | MCP / HTTP 工具化（agent 可直接调）、消耗校准 + canary、verifier | agent 能通过工具 submit 并取回结果 |
| **v0.3** | 第三个 adapter（`rolling_on_first_use`，Claude）**用于证伪抽象**；intensity 档位；只读面板 | 加第三家 provider 时只改 adapter，**不改 policy** |

## 目录

```
llm-capacity-scheduler/
├── README.md                    # 本文件：定位、概念、里程碑、用法
├── TASK.md                      # 执行状态与决策记录（gitignore，仅供 agent 接续）
├── config.toml                  # 本地配置（gitignore；`lcs init-config` 生成）
├── docs/
│   ├── DESIGN.md                # 详细设计：容量模型 / reserve / 架构 / 数据模型 / API
│   └── PRIOR-ART.md             # 现有项目对照，避免重复造轮子
├── src/lcs/
│   ├── models.py                # Bucket / Window / Task / Run / TaskSpec
│   ├── config.py                # TOML 配置（stdlib tomllib，零依赖）
│   ├── capacity/                # 扩展点 A：provider 容量观测
│   │   ├── base.py              #   Adapter 契约（失败 → source=unknown）
│   │   ├── minimax.py           #   fixed_grid + weekly unlimited
│   │   ├── payg.py              #   depleting 余额（性质相反的第二个实现）
│   │   └── registry.py          #   kind → adapter
│   ├── policy/                  # 准入控制（内核）
│   │   ├── schedule.py          #   工作时间表 / 自用率积分 / 高峰窗口
│   │   ├── reserve.py           #   reserve(t) = 未来预期自用量
│   │   └── admission.py         #   burn_before_expiry + 强度映射
│   ├── taskstore/store.py       # SQLite：状态机 / 幂等键 / 采样 / EWMA 校准
│   ├── runner/                  # 扩展点 B：执行器
│   │   ├── base.py              #   Runner 契约
│   │   └── shell.py             #   shell 执行 + 产物目录 + verifier
│   ├── engine.py                # tick + reconcile 主循环
│   └── api/cli.py               # submit / poll / status / observe / tick / run
└── tests/                       # pytest：reserve / admission / store / adapter / e2e
```

## 快速开始

```bash
cd ~/github/llm-capacity-scheduler
python3 -m pip install -e .        # 零运行时依赖；需要 Python 3.11+
lcs init-config                    # 生成 config.toml（含 MiniMax 接入示例）

lcs observe                        # 只读一次容量快照（不消耗配额）
lcs submit --cmd "python3 job.py" --value 70 --tokens 120000 \
           --deadline 2026-10-22T09:00 --expect-artifact out.json
lcs tick                           # 执行一次 tick（准入 + 派发 + 收口）
lcs poll --all                     # 轮询状态与产物
lcs run                            # 常驻：每 60s 一个 tick
```

常驻调度示例（把任务交给引擎，agent 只 poll）：

```bash
# 1) 提交任务（幂等键保证重试不会跑两次）
lcs submit --spec job.json --json
# 2) 隔一会儿取结果
lcs poll --ids <task_id> --json
# 3) 看为什么现在不跑（决策原因直接暴露）
lcs tick --json | jq '.decisions'
```

## v0.1 状态

**端到端已打通**：MiniMax 5h 固定窗口在 `end_time − 30min` 自动开烧 → 烧到 reserve 停 →
产物落 `artifacts/<task_id>/<run_id>/` → verifier 通过才算 `succeeded`。

| 能力 | 状态 |
|---|---|
| 2 个性质相反的 adapter（`minimax` fixed_grid / `payg` depleting） | ✅ |
| reserve 时间函数（工作时段留量 / 尾段烧光 / 深夜立刻烧） | ✅ |
| 准入控制 + 在飞 lease 占位 + 强度/高峰降档 + 自用活跃让路 | ✅ |
| SQLite 状态机 + 幂等键 + deadline 过期 + 孤儿 reconcile | ✅ |
| shell runner + 产物收集 + verifier + 超时 kill | ✅ |
| CLI `submit/poll/status/observe/tick/run/cancel` | ✅ |
| 测试（44 个，含端到端烧窗口验收，不消耗真实配额） | ✅ |
| HTTP / MCP / 沙箱审批 / canary 校准 | v0.2 |

```bash
python3 -m pytest -q     # 全部通过
```

> 安全边界（v0.1）：**任务 spec = 本机 shell 命令**，引擎持有 provider API key，
> 因此对外接口只做本机 CLI。开放 HTTP/MCP 前必须先上沙箱 + 审批（见 TASK.md 已知坑 #6）。

> 状态：**v0.1 可用**。接续与待办见 `TASK.md`。
