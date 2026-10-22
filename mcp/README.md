# llm-capacity-scheduler-mcp

> **容量感知的异步任务调度器 —— MCP Server + Web 控制台。**
> 把会过期的 LLM 配额，变成有价值的产出。

订阅制 LLM 的容量有几种截然不同的性质：5h 窗口用不完就作废、周限额可能无限、
付费余额烧了要花钱、还有 rate limit / 峰时降速。人盯着仪表盘手动跑任务迟早会漏；
这个服务把「**什么时候、用谁、用多强**」变成自动决策，agent 只负责 `submit` 和 `poll`。

- **一个 npm 进程**：MCP stdio + 调度器 + Web 控制台。
- **agent 接入**：在 MCP 客户端（DSH / Claude Desktop 等）配一条 stdio server 即可。
- **人用**：浏览器打开 `http://127.0.0.1:7788` 改配置、看容量、提交任务、追产物。
- **零原生依赖**：状态是单文件 JSON（原子写），`npm i` 不需要编译工具链。

---

## 安装

```bash
npm install -g llm-capacity-scheduler-mcp
# 或 npx
npx llm-capacity-scheduler-mcp --help
```

要求 Node.js ≥ 20。

## 快速开始

```bash
lcs-mcp init                          # 生成 ~/.lcs/config.json（已存在则不覆盖）
lcs-mcp serve                         # 常驻：调度器 + Web 控制台（http://127.0.0.1:7788）
```

起服务后，不用手改配置也能接 provider：**配置 → Provider → 「＋ 添加 LLM」**，选厂商
（当前支持 MiniMax）、填 API Key、保存。保存后会立刻向 provider 拉一次容量，切到「容量」页即可
看到新桶；同一厂商可以加多个 Key（自动命名 `minimax` / `minimax-2`）。

只想临时用（不常驻）也可以直接 `lcs-mcp`：它同时起调度器 + Web + MCP stdio。

### 接入 MCP 客户端

```jsonc
// DSH / Claude Desktop 的 MCP 配置
{
  "mcpServers": {
    "lcs": {
      "command": "lcs-mcp",
      "args": ["--config", "/home/you/.lcs/config.json"]
    }
  }
}
```

> 如果已经用 `lcs-mcp serve` 起了常驻守护进程，MCP 进程会自动检测到它并**以 HTTP 代理模式接入**
> （同一份状态、同一个 Web 控制台），不会出现两个实例抢写状态。

### 让 agent 用

```text
lcs_submit_task  { cmd: ["python3","jobs/summarize.py"], value: 70, tokens: 120000,
                   deadline: "2026-10-22T09:00", expect_artifacts: ["summary.md"] }

→ { task_id: "task_...", state: "deferred",
    note: "任务已入队；state=deferred 表示引擎会在合适时机执行" }

lcs_poll_tasks   { ids: ["task_..."] }
→ { state: "succeeded", runs: [{ artifacts: ["summary.md"], verified: true }] }
```

**提交 ≠ 执行**：`deferred` 是正常状态。引擎会在「工作时段尾段」或「空闲时段」
按 reserve 自动开烧，烧到保留线就停。

---

## 它怎么工作

```
Task ──(Queue 派生视图)──▶ Controller ──(Assignment)──▶ Runner ──▶ Run
  ▲                          │                                      │
  │                          ├─ ModelCatalog（能力匹配）              │
  │                          ├─ CapacityBuckets（容量 + reserve）     │
  │                          └─ Policy（准入 / 强度 / 优先级）        │
  └────────── checkpoint / step ◀──────── Artifact + Verifier ◀───────┘
```

**v0.3 执行模型**：执行器只有 dsh headless，任务串行（一次一个）；每个 task 一个 dsh session +
固定工作目录；模型由 provider 配置决定（`options.dsh.defaultModel`），换模型只换后端大模型。

每个 tick（默认 60s）：

1. **observe** 读所有 provider 容量（MiniMax 5h 窗口 / PAYG 余额 / 自定义 adapter）；
2. **reap** 收口已结束的 run：验收产物、算本次消耗、更新 EWMA 校准；
3. **preempt** 窗口已结束仍在跑的 run → 抢占为 `interrupted`（避免跨窗口串账）；
4. **reconcile / expire** 清理孤儿任务与过期任务；
5. **dispatch** 排序 → 能力匹配 → 容量准入 → 生成 Assignment（provider/model/runner/est/route）→ spawn。

核心策略是 **reserve(t) = 从 t 到窗口结束，预期自己还要用掉的容量**：

| 场景 | reserve | 行为 |
|---|---|---|
| 工作时段中段 | 高（≈ 预期自用） | 不烧，把额度留给你 |
| 工作时段末尾 30min | → 5% 下限 | 全速烧 |
| 深夜 / 周末 | ≈ 5% 下限 | 一刷新就烧 |
| 窗口横跨上班时刻 | 含上班后自用 | 不会烧掉第二天要用的量 |
| 付费余额（PAYG） | 0（阈值是价格） | 任务价值 > 成本才跑 |

详细设计见仓库 `docs/MCP-DESIGN.md`。

## Web 控制台

| 页签 | 内容 |
|---|---|
| 概览 | 容量桶卡片（余量/窗口倒计时/reserve 线）、队列/在飞、最近决策原因、手动 tick / 暂停 |
| 任务 | 提交表单（shell / dsh headless）、任务表、执行记录、产物在线查看、取消 |
| 容量 | 桶明细 + 观测记录（每轮调度自动落一条，页面自动刷新），解释「现在为什么不烧」；「刷新容量」手动向 provider 拉一次 |
| 任务 | 执行器固定 dsh；产物 `final.md` 来自 dsh 的 `final` 事件；run 详情含 sessionId 与 usage tokens |
| 配置 | 表单 + 原始 JSON 双模式，保存即热加载；Provider 用选项卡管理，「＋ 添加 LLM」按厂商预设接入（当前支持 MiniMax）、「删除」移除该 Key；API Key 脱敏 |

```bash
lcs-mcp serve --port 7788          # 配置和命令都支持 --config / --port
lcs-mcp serve --no-web             # 只跑调度器
```

## MCP 工具

| 工具 | 作用 |
|---|---|
| `lcs_submit_task` | 提交任务（幂等键），返回 task_id 与当前状态（可能 `deferred`） |
| `lcs_poll_tasks` | 批量轮询状态 / 执行记录 / 产物 / 错误 |
| `lcs_cancel_task` | 取消尚未开始的任务 |
| `lcs_status` | 容量桶 + 队列 + 在飞 + 最近决策原因 |
| `lcs_observe` | 立即读一次容量（不消耗配额） |
| `lcs_tick` | 手动触发一次 tick（调试/演示） |
| `lcs_get_config` | 读取配置（API Key 脱敏） |

## 配置

默认 `~/.lcs/config.json`（可用 `--config` / `LCS_CONFIG` 覆盖）。最小可用配置：

```jsonc
{
  "version": 1,
  "engine": { "tickSeconds": 60, "stateFile": "~/.lcs/state.json",
              "artifactsDir": "~/.lcs/artifacts", "maxParallel": 4,
              "web": { "enabled": true, "host": "127.0.0.1", "port": 7788 } },
  "policy": {
    "burnLeadMinutes": 30, "minReservePct": 5, "safetyFactor": 1.5,
    "defaultEstPct": 3, "maxConcurrentPerBucket": 2, "maxAttempts": 2,
    "usage": { "workdays": [1,2,3,4,5], "workStart": "09:00", "workEnd": "19:30",
               "workRatePctPerHour": 8, "offhoursRatePctPerHour": 0.5 }
  },
  "providers": [
    { "name": "minimax", "kind": "minimax", "enabled": true,
      "options": { "apiKeyEnv": "MINIMAX_API_KEY", "apiKeyFile": "~/.mmx/config.json",
                   "families": ["general"], "textTokensPerPct": 50000 } }
  ],
  "runners": { "default": "shell",
               "shell": { "enabled": true },
               "dsh": { "enabled": true, "command": "dsh", "profile": "headless" } }
}
```

- **provider.kind**：`minimax`（fixed_grid 5h + 周 unlimited）/ `payg`（depleting 余额）/
  `mock`（本地演示与测试）。
- **runner**：`shell`（本机命令，产物落 `artifacts/<taskId>/<runId>/`）/
  `dsh`（`dsh --profile headless --json "<task>"`，checkpoint = `--session-id`，可续跑）。
- **route 注入**：任务进程会拿到 `LCS_PROVIDER` / `LCS_MODEL` / `LCS_ASSIGNMENT_ID`，
  保证「控制器以为的桶」和「真实消耗的桶」一致。

## 命令行

```
lcs-mcp [--config <path>]         MCP stdio + 调度器 + Web
lcs-mcp serve                     常驻：调度器 + Web
lcs-mcp init                      生成默认配置
      --port <n>                  覆盖 Web 端口
      --no-web / --no-mcp / --no-scheduler
      --force                     忽略单实例锁
```

## 开发

```bash
npm install
npm run build
npm test                          # node:test，49 个用例（含端到端烧窗口 / Web API / MCP 闭环 / 迁移 / GC）
npm run dev -- serve              # tsx 直跑
```

## 安全边界

任务 spec 就是本机命令，服务默认只绑定 `127.0.0.1`，MCP 走 stdio；
配置中的 API Key 落盘 `0600`，读取接口一律脱敏。开放远程访问前请自行加鉴权与沙箱。
