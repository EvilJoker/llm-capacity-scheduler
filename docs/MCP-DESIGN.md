# 方案：调度模型与 MCP 产品形态（v0.2）

> 本文是 v0.2 的**定稿设计**：把 v0.1 的「引擎概念」对齐成可实现的 6 实体模型，
> 并定产品形态 —— **一个 npm 部署的 MCP Server，自带 Web 控制台**。
> 实现见 `mcp/`。v0.1 的 Python 引擎（`src/lcs/`、`lcs` CLI）保留为参考实现。

---

## 1. 产品形态

```
┌───────────────────────────── 一个 Node 进程 ─────────────────────────────┐
│                                                                          │
│  MCP Server (stdio)          Scheduler (tick 60s)        Web 控制台       │
│  ├─ lcs_submit_task   ◀──┐   ├─ observe 容量                (127.0.0.1:7788)│
│  ├─ lcs_poll_tasks       │   ├─ reap / preempt              ├─ 概览       │
│  ├─ lcs_cancel_task      │   ├─ reconcile / expire          ├─ 任务       │
│  ├─ lcs_status           │   └─ dispatch (Assignment)       ├─ 容量       │
│  ├─ lcs_observe          │            │                     └─ 配置（可写） │
│  └─ lcs_get_config       │            ▼                                  │
│                          │      Runner (shell / dsh headless)            │
│                          └────── 共享 Store（JSON 单文件 + 原子写）         │
└──────────────────────────────────────────────────────────────────────────┘
```

- **部署**：`npm i -g llm-capacity-scheduler-mcp` → `lcs-mcp`（或 `npx`）。
- **agent 接入**：MCP 配一条 stdio server（命令 `lcs-mcp --config ~/.lcs/config.json`）。
- **人用**：浏览器开 `http://127.0.0.1:7788`，配置文件 + 前端表单两种方式都能改。
- **模式**：
  - `lcs-mcp`（默认）：MCP stdio + 调度器 + Web，一起跑；
  - `lcs-mcp serve`：只跑调度器 + Web（常驻守护，不接 MCP 客户端）；
  - `lcs-mcp init`：生成默认配置后退出。

---

## 2. 六个核心实体

```
Task ──(Queue 派生视图)──▶ Controller ──(Assignment)──▶ Runner ──▶ Run
  ▲                          │                                      │
  │                          ├─ ModelCatalog（能力匹配）              │
  │                          ├─ CapacityBuckets（容量 + reserve）     │
  │                          └─ Policy（准入 / 强度 / 优先级）        │
  └────────── checkpoint / step ◀──────── Artifact + Verifier ◀───────┘
```

| 实体 | 职责 | 不是什么 |
|---|---|---|
| **Task** | 要干的活：不可变 spec + 需求 + 价值 + deadline | 不是一次执行 |
| **Run / Attempt** | 一次执行尝试：租约、pid、产物、消耗归因、checkpoint | 不是任务本身 |
| **Assignment** | 控制器的派发单：`(task, provider, model, runner, est, route)` | 不是“随便挑个 LLM” |
| **Queue** | 任务状态的**派生视图**（queued/deferred），不是独立内存队列 | 不是另一个真相源 |
| **Capacity** | provider 的容量桶（余量 / 窗口 / 生命周期 / 约束） | 不是模型能力表 |
| **Runner** | 执行方式：shell / dsh headless / http | 不是 provider |

> 关键决策：**Queue 不做独立数据结构**。任务状态就是唯一真相，
> 排序/优先级/可执行时间都是状态上的字段或派生函数。这样崩溃重启、并发写、双端（MCP+Web）都不会不一致。

---

## 3. Controller：tick + reconcile

每个 tick（默认 60s，可配）固定七步：

```python
tick(now):
  ① observe     adapter.observe() → Set<Bucket>，采样落库
  ② reap        poll 每个 running run → 结束判定 / 验收 / quota_delta / 校准
  ③ preempt     窗口已结束但仍在跑的 run → kill + interrupted + 结算
  ④ reconcile   状态 running 但无在飞 run（崩溃残留）→ 重排 / 失败
  ⑤ expire      deadline 已过 → expired
  ⑥ dispatch    排序 → 能力匹配 → 容量准入 → 生成 Assignment → lease → spawn
  ⑦ publish     状态快照给 Web / MCP（内存 ring buffer，不额外持久化）
```

为什么不是事件驱动：崩溃可重入、全量对账无 drift、好测试。k8s 控制循环同款。

---

## 4. 队列语义（重点修正）

**不做“没完成就放回队头”**，改为：**有界提权 + 下次可执行时间 + 尝试上限 + checkpoint**。

### 4.1 排序分数（每次 dispatch 动态计算）

```
score = value_density × deadline_urgency × checkpoint_bonus

value_density      = value / est_usage
deadline_urgency   = 有 deadline ? 1 + 2×(1 − 剩余时间比例) : 1
checkpoint_bonus   = 有 checkpoint ? 1.5 : 1.0
```

`value_density` 优先，保证「高价值/低消耗」先跑；接近 deadline 的任务被提权；
带 checkpoint 的任务有极限提权（继续跑比从头跑省额度）。

### 4.2 未完成 / 中断的语义

| 情况 | 处理 |
|---|---|
| 执行超时 | `run=timeout` → 任务 `queued`，`attempts+1`，`nextEligibleAt=now+backoff` |
| 窗口结束被抢占 | `run=interrupted`，先结算 `quotaDelta`，再 `queued` + 提权 + checkpoint |
| 执行器崩溃（无退出码） | `run=failed`，`attempts+1`，可重排 |
| 失败达到 `maxAttempts` | 任务 `failed`，错误透出给 poll |
| 有 checkpoint | 重跑时注入（dsh：`--session-id`；shell：`LCS_CHECKPOINT_FILE`） |

**禁止**：同一窗口里对同一任务立刻重试（会重复烧额度、饿死别人）。
`nextEligibleAt = now + max(60s, backoff)` 兜底，新窗口的 reserve 时间门再做一次闸。

### 4.3 窗口边界正确性（v0.1 的隐藏 bug，v0.2 修掉）

- **装得下才开跑**：`expectedDurationS + grace ≤ 距窗口结束秒数` 才准入，否则 `reason=window_too_short`；
- **边界前收口**：`window.end − ε` 仍在跑 → 抢占（interrupted），避免“消耗算到新窗口、租约记在旧桶”的串账；
- 长任务要么 step 化，要么靠 checkpoint 续跑。

---

## 5. Assignment 与路由注入（v0.1 缺失的一环）

```
Provider（谁的额度）  ×  Runner（怎么跑）  = 两个正交轴
  MiniMax / Claude      shell / dsh headless / http
```

控制器必须把「选中的 provider/model」**传给执行器**，否则计量是假的：

```jsonc
{
  "assignmentId": "asg_...",
  "taskId": "task_...",
  "provider": "minimax",
  "model": "MiniMax-M2.2",
  "runner": "dsh-headless",
  "est": 4.5,
  "route": {
    "LCS_PROVIDER": "minimax",
    "LCS_MODEL": "MiniMax-M2.2",
    "LCS_ASSIGNMENT_ID": "asg_..."
  }
}
```

- shell runner：`route` 注入为环境变量；
- dsh runner：`route` 注入环境变量 + 可选 `--profile` 映射（`runners.dsh.profiles: {minimax: "headless"}`）；
- 任务里用 `$LCS_PROVIDER` / `$LCS_MODEL` 选择实际调用的后端，保证「控制器以为的」和「真实消耗的」是同一个桶。

---

## 6. Model Catalog：把“可用 LLM”拆成两个问题

| 维度 | 问题 | 数据 |
|---|---|---|
| **能力匹配** | 能不能干这活 | `models[]`：provider / model / family / context / modalities / qualityTier / price |
| **容量可用** | 现在该不该烧 | `providers[]` 的容量桶 + reserve |

`dispatch` 先按能力筛候选 `(provider, model)`，再对容量桶做准入。没有 catalog 条目时
退化为 `provider.defaultModel || family`，保证零配置也能跑。

---

## 7. Runner 契约

```ts
interface Runner {
  name: string;
  spawn(task: Task, assignment: Assignment, run: Run): Promise<number>; // → pid
  poll(task: Task, run: Run, now: Date): Promise<RunResult | null>;      // null = 仍在跑
  kill(task: Task, run: Run, signal?): Promise<void>;
}
```

- **退出状态写文件**（`.exit_code`），不依赖父进程 `waitpid` → 引擎重启仍可判定；
- 产物目录 `artifacts/<taskId>/<runId>/`，任务默认在此执行；
- 验收 = 声明产物存在 + `verifyCmd` exit 0；**没验证不许 succeeded**；
- **dsh headless runner**：`dsh --profile headless --json "<task>"`；
  checkpoint = `--session-id`（下一次续跑），从 jsonl 事件里抓 session id。

---

## 8. MCP 工具面

| 工具 | 作用 |
|---|---|
| `lcs_submit_task` | 提交任务（幂等键），返回 task_id + 当前状态（可能 `deferred`） |
| `lcs_poll_tasks` | 批量轮询：状态、run、产物、错误 |
| `lcs_cancel_task` | 取消 |
| `lcs_status` | 容量桶 + 队列计数 + 在飞 + 最近决策原因 |
| `lcs_observe` | 只读一次容量快照 |
| `lcs_tick` | 手动触发一次 tick（调试/演示） |
| `lcs_get_config` | 读配置（密钥脱敏） |

> `提交 ≠ 执行` 必须写进工具描述：`deferred` 是合法且预期状态。

---

## 9. Web 控制台

单页应用（原生 HTML/JS/CSS，无前端构建），4 个页签：

| 页签 | 内容 |
|---|---|
| **概览** | 容量桶卡片（余量、窗口倒计时、reserve 线）、队列/在飞计数、最近决策原因、调度器开关与手动 tick |
| **任务** | 提交表单（cmd/prompt、价值、token、deadline、产物、verifier）+ 任务表（状态徽章、产物链接、取消） |
| **容量** | 采样历史表 + 各桶时间线，解释“现在为什么不烧” |
| **配置** | 表单（provider/policy/engine/runner）+ 原始 JSON 高级编辑；保存即写配置并热加载；密钥脱敏 |

REST（同端口）：

```
GET  /api/health
GET  /api/config                 # 脱敏
PUT  /api/config                 # 合并保存 + 热加载；"***" 表示保留旧密钥
GET  /api/status                 # buckets + counts + running + recent decisions
GET  /api/tasks?state=&limit=
POST /api/tasks                  # 提交
GET  /api/tasks/:id
POST /api/tasks/:id/cancel
POST /api/tick                   # 手动 tick
POST /api/scheduler/pause|resume
GET  /api/samples?bucket=&limit=
```

---

## 10. 持久化与单实例

- **JSON 单文件**（`~/.lcs/state.json`）：tasks / runs / samples / calibration。
  原子写（tmp + rename），单写者；单用户规模（万级任务以内）足够。
  选它而不是 SQLite：npm 零原生依赖，`npm i` 不会因为编译工具链失败。
- **采样**只保留最近 N 条（默认 5000），按桶裁剪。
- **单实例锁**：`state.lock` 记录 pid；启动时发现同 state 的活进程 → 拒绝启动（`--force` 覆盖）。
- 启动时 recover：`running` 但没有活的执行器 → interrupted/failed → 重排。

---

## 11. 安全边界

- 默认只绑定 `127.0.0.1`；Web 无鉴权但仅本机；
- MCP 走 stdio，不监听端口；
- **任务 = 本机命令**：Web/MCP 的提交入口默认只允许本机来源；
- 配置里的 API key 落盘 `0600`，GET 一律脱敏；日志不打印密钥；
- 执行器不持有 shell 之外的权限，v0.3 再上容器/沙箱与审批。

---

## 12. v0.2 验收标准

1. `npm i -g .` 后 `lcs-mcp init` 生成配置，`lcs-mcp serve` 起 Web 控制台；
2. 浏览器能改配置、看到 MiniMax 真实容量、提交/轮询/取消任务；
3. MCP 客户端（DSH）能 `lcs_submit_task` → `lcs_poll_tasks` 拿到产物；
4. 用 mock provider + 可控时钟的测试复现：工作时段不烧 → 尾段开烧 → 烧到 reserve 停；
5. 窗口边界：`window_too_short` 拒绝 + 跨窗口 run 被 interrupted 并重排（带 checkpoint 时提权）；
6. `npm run build && npm test` 全绿；Python v0.1 的 44 个测试不受影响。
