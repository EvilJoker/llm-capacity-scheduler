# llm-capacity-scheduler

> **面向 LLM 后端的「容量感知异步任务调度器」——把会过期的配额，变成有价值的产出。**

引擎持续监控**多个第三方 LLM 的容量窗口**（配额 / 限流 / 余额），结合**用户策略**决定
「**什么时候、用谁、用多强**」去执行队列里的任务；调用方（通常是 agent）只负责
`submit` 和 `poll`，不关心调度细节。

![Web 控制台](docs/images/web-overview.png)

## 交付物

| 目录 | 形态 | 说明 |
|---|---|---|
| **`mcp/`** | **npm 包（产品）** | MCP Server + 自带 Web 控制台。一个 Node 进程同时提供 MCP stdio、调度器与浏览器界面。 |
| `src/lcs/` | Python 参考实现（v0.1） | 最初的引擎原型 + `lcs` CLI，用于对照设计、跑单元测试；新功能以 `mcp/` 为准。 |
| `docs/` | 设计文档 | `MCP-DESIGN.md`（v0.2 定稿模型）、`DESIGN.md`（v0.1 设计）、`PRIOR-ART.md`（调研）。 |

## 快速开始（npm / MCP）

```bash
npm install -g llm-capacity-scheduler-mcp   # Node.js >= 20
lcs-mcp init                                # 生成 ~/.lcs/config.json
# 填好 provider 的 API Key（或 MINIMAX_API_KEY / ~/.mmx/config.json）
lcs-mcp serve                               # 调度器 + Web：http://127.0.0.1:7788
```

agent 侧在 MCP 客户端里加一条 stdio server：

```jsonc
{
  "mcpServers": {
    "lcs": { "command": "lcs-mcp", "args": ["--config", "/home/you/.lcs/config.json"] }
  }
}
```

> 已有常驻 `lcs-mcp serve` 时，MCP 进程会自动检测并以 **HTTP 代理模式**接入同一个实例，
> 不会出现两个进程抢写状态文件。

agent 使用方式：

```text
lcs_submit_task  { cmd: ["python3","jobs/summarize.py"], value: 70, tokens: 120000,
                   expect_artifacts: ["summary.md"] }
→ state: "deferred"      # 提交 ≠ 执行：引擎会在合适的配额窗口自动开烧

lcs_poll_tasks   { ids: ["task_..."] }
→ state: "succeeded", runs[0].artifacts = ["summary.md"], verified: true
```

MCP 工具：`lcs_submit_task` / `lcs_poll_tasks` / `lcs_cancel_task` / `lcs_status` /
`lcs_observe` / `lcs_tick` / `lcs_get_config`。详细用法见 [`mcp/README.md`](mcp/README.md)。

## 要解决的问题

订阅制 LLM 的容量有几种**截然不同**的性质：

| 性质 | 后果 |
|---|---|
| 配额分**固定窗口**（如 MiniMax 5h：10-15 / 15-20） | 窗口内用不完就**作废**，官方明确不滚存 |
| 部分维度**周/月无限** | 真正稀缺的只有窗口内那一份 |
| 部分**只在工作时间需要** | 白天要留给自己写代码，深夜空闲才可自由消耗 |
| 另一些是**付费余额**（Credits / PAYG） | 烧它就是花钱，策略必须反转 |
| 还叠加 **rate limit / 并发槽位 / 高峰限流** | 这些**不作废**，不该当"配额"去优化时机 |

## 模型（v0.2 定稿）

```
Task ──(Queue 派生视图)──▶ Controller ──(Assignment)──▶ Runner ──▶ Run
  ▲                          │                                      │
  │                          ├─ ModelCatalog（能力匹配）              │
  │                          ├─ CapacityBuckets（容量 + reserve）     │
  │                          └─ Policy（准入 / 强度 / 优先级）        │
  └────────── checkpoint / step ◀──────── Artifact + Verifier ◀───────┘
```

六个实体：**Task**（要干的活）、**Run**（一次执行尝试）、**Assignment**（provider × model ×
runner × est × route）、**Queue**（任务状态的派生视图，不是独立队列）、**Capacity**
（provider 容量桶）、**Runner**（shell / dsh headless / 未来 HTTP）。

核心策略：**reserve(t) = 从 t 到窗口结束，预期自己还要用掉的容量**。

| 场景 | reserve | 行为 |
|---|---|---|
| 工作时段中段 | 高（≈ 预期自用） | 不烧 |
| 工作时段末尾 30min | → 下限（默认 5%） | 开烧，烧到下限停 |
| 深夜 / 周末 | ≈ 下限 | 一刷新就烧 |
| 窗口横跨上班时刻 | 含上班后自用 | 不会烧掉第二天要用的量 |
| 付费余额（PAYG） | 0（阈值是价格） | 价值 > 成本才跑 |

关键语义：**提交 ≠ 执行**（`deferred` 合法）、在飞 **lease 占位**防并发超支、
`unknown` 观测**绝不盲烧**、窗口装不下不开跑、跨窗口 run 被抢占并重排、
失败/中断带 **checkpoint**（dsh 用 `--session-id`）续跑。

完整设计见 [`docs/MCP-DESIGN.md`](docs/MCP-DESIGN.md)。

## Python 参考引擎（v0.1）

```bash
python3 -m pip install -e .
lcs init-config
lcs observe                 # 只读容量（不消耗配额）
lcs submit --cmd "python3 job.py" --value 70 --tokens 120000
lcs tick                    # 单次 tick（准入 + 派发 + 收口）
lcs run                     # 常驻 tick 循环
lcs poll --all
```

v0.1 已实现：MiniMax（fixed_grid + 周 unlimited）与 PAYG（depleting）两个性质相反的 adapter、
reserve 时间函数、SQLite 状态机 + 幂等 + EWMA 校准、shell runner + verifier、CLI。
44 个 Python 测试覆盖策略与端到端烧窗口。

## 目录

```
llm-capacity-scheduler/
├── mcp/                         # 产品：npm 包（MCP Server + Web 控制台 + 调度器）
│   ├── src/{engine,policy,store,backend,mcp,cli}.ts
│   ├── src/capacity/{minimax,payg,mock}.ts
│   ├── src/runner/{shell,dsh}.ts
│   ├── src/web/{server.ts,public/}
│   └── src/test/                # 38 个 node:test 用例
├── src/lcs/                     # v0.1 Python 参考引擎 + CLI
├── tests/                       # v0.1 Python 测试（44 个）
├── docs/
│   ├── MCP-DESIGN.md            # v0.2 定稿：6 实体模型 / 队列语义 / MCP+Web 架构
│   ├── DESIGN.md                # v0.1 设计：容量模型 / reserve / 数据模型
│   └── PRIOR-ART.md             # 现有项目对照
├── TASK.md                      # 执行状态与决策记录（gitignore）
└── README.md
```

## 开发与测试

```bash
# npm 产品
cd mcp && npm install && npm run build && npm test

# Python 参考实现
python3 -m pytest -q
```

## 安全边界

任务 spec 就是本机命令、引擎持有 provider API key，因此：

- Web 默认只绑定 `127.0.0.1`，MCP 走 stdio；
- API Key 落盘 `0600`，读取接口一律脱敏；
- 开放 HTTP/MCP 给远程使用前，必须先加鉴权 + 沙箱 + 审批（v0.3 计划）。

## 里程碑

| 版本 | 内容 | 状态 |
|---|---|---|
| v0.1 | Python 引擎：容量模型 / reserve / SQLite / shell runner / CLI | ✅ |
| **v0.2** | **npm MCP Server + Web 控制台 + Assignment/ModelCatalog + dsh runner + 窗口抢占/续跑** | ✅ |
| v0.3 | npm 发布、dsh headless 实机联调、消耗校准 canary、沙箱与审批、第三个 provider（证伪抽象） | 计划 |
