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

## 目录规划

```
llm-capacity-scheduler/
├── README.md              # 本文件：定位、概念、里程碑
├── TASK.md                # 执行状态与决策记录（gitignore，仅供 agent 接续）
├── docs/
│   ├── DESIGN.md          # 详细设计：容量模型 / reserve / 架构 / 数据模型 / API
│   └── PRIOR-ART.md       # 现有项目对照，避免重复造轮子
└── src/                   # （v0.1 待建）
    ├── capacity/          # provider adapters
    ├── policy/            # reserve 函数 + 准入控制
    ├── taskstore/         # SQLite 状态机
    ├── runner/            # 执行器
    └── api/               # CLI / HTTP / MCP
```

## 起点

```bash
cd ~/github/llm-capacity-scheduler
cat docs/DESIGN.md    # 先读设计
cat TASK.md           # 再看当前进度与下一步
```

> 状态：**设计完成，代码未开工**。下一步见 `TASK.md`。
