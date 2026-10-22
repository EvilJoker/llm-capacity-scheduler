# LCS v0.3 执行器方案：dsh-only · 单 runner · 串行执行

> 状态：**M1–M4 已实现，M5 部分完成，M6 真机验证通过**（2026-10-21）
> 前置：`docs/MCP-DESIGN.md`（v0.2 领域模型）· 实测记录见本文「附录 A」

---

## 0. 一句话

执行器收敛为**唯一的 dsh runner**，全局**串行**（一次只跑一个任务）；每个 task 绑定**一个 dsh session + 一个固定工作目录**；「切换模型」= 只换 dsh 后端的大模型，不影响 task/session 绑定；provider 的 Key 由调度器**按调用注入环境变量**，保证「烧的账号 = 记账的账号」；dsh 会话写在**LCS 专用的隔离 `DSH_HOME`**（`~/.lcs/dsh-home`），与用户的 `~/.dsh` 物理隔离，由 LCS 侧只清理**自己登记过**的会话。

---

## 1. 范围与非目标

**本方案要做**

1. 执行器从「shell + dsh 两种固定实现」收敛为「dsh 一种」；
2. 调度从「最多 N 个并发」改为「**严格串行**」；
3. provider 卡片新增 **dsh 路由段**（route/api/baseURL/apiKeyEnv/models）；
4. `models` 能力目录恢复语义：**模型 id 必须与 dsh 路由的 models 对齐**；
5. dsh runner 重写：patch 生成、Key 注入、session 续跑、事件流解析、usage 计量；
6. 会话与产物的**保留策略（GC）**。

**非目标（本轮不做）**

- 多 provider 并行 / 多 runner 并行；
- dsh 的沙箱与审批（仍属 v0.3 后续安全项，见 §11）；
- 非 LLM 本地脚本任务（`shell` runner 暂不支持调度，由 agent 自行执行）；
- dsh 侧工具集的裁剪（沿用默认工具集）。

---

## 2. 决策清单

| # | 决策 | 理由 |
|---|---|---|
| D1 | 执行器**只有 dsh** | 执行器的价值 = 消耗额度 + 跑 LLM 任务；shell 属于「非 LLM 本地任务」，与本产品定位不符 |
| D2 | **全局串行**：同一时刻最多 1 个任务在跑 | 单 dsh 进程、额度可控、session 简单、避免同账号并发撞限流；代价是吞吐（见 §3.2） |
| D3 | ~~共享 `DSH_HOME=~/.dsh`~~ → **改为独立 `DSH_HOME=~/.lcs/dsh-home`**（2026-10-22 事故后反转） | 共享家目录时，LCS 的「孤儿会话」清理会扫到**用户自己的 dsh web 会话**并删除（真实数据丢失）。隔离后会话物理分开；AGENTS.md / skills 以符号链接只读共享，保持任务上下文一致 |
| D4 | **路由静态、模型动态** | 路由（api/baseURL/apiKeyEnv/models）写在 profile 的 patch 层；每次运行只用 `--patch` 覆盖 `agent-default-model` |
| D5 | **Key 只走环境变量** | 配置文件 0600 存 Key（已如此），spawn 时注入子进程 env；patch 与命令行都不出现明文 Key |
| D6 | 每 task 一个 **dsh session** + 一个**固定工作目录** | dsh 接管 session 要求 cwd 一致；固定工作目录让同一 task 的多次运行可续跑 |
| D7 | 会话/产物**保留策略**：终态 + TTL 清理 | 避免 `~/.dsh/sessions` 无限堆积、避免 `session.list` 膨胀 |
| D8 | **usage（token）为第一手消耗证据**，`quotaDelta` 兜底 | `step_end.usage` 是真实用量，解决「并发批次无法归因」的死结 |
| D9 | 串行下 **slots 恒为 1**，reserve 语义不变 | 策略仍按 reserve/excess 决定「什么时候烧」，只是并发维度被压到 1 |
| D10 | 失败**分类处理**：认证/额度类不重试 | 401/额度耗尽重试只会白烧；普通失败按 attempts 上限重试，且**同 session 续跑** |
| D11 | 窗口抢占 → **同 session 重排**，不新建会话 | 续跑最省额度（`--session-id`），这也是 dsh 的原生语义 |
| D12 | 模型切换**只改后端模型**，不改 task/session 绑定 | 同 session 内换模型由 dsh 处理，并自动插入 `[model changed: …]` 提示 |
| D13 | **模型是 provider 级配置**：provider 配一个模型，任务就用它 | 去掉全局 `models[]` 目录与能力匹配选型；模型与「谁的额度」绑定，语义更直 |
| D14 | **厂商参数只读**（route/api/baseURL/apiKeyEnv/models 由预设写死） | 用户只填 Key 与选模型；填错端点/协议会直接让观测与执行失真 |

---

## 3. 执行器模型

### 3.1 单 runner + 串行的精确语义

```
engine.maxParallel = 1                      // 硬上限，配置里保留字段但只接受 1
policy.maxConcurrentPerBucket = 1           // 实际值恒为 1（单串行下无意义保留）
```

调度循环（每 tick）：

```
observe → reap（收口/抢占）→ expire → dispatch
dispatch: 若已有 run 在跑 → 本 tick 不再 spawn（决定记 reason=busy）
          否则按 score 选出队首任务 → 准入 → spawn（同时只有 1 个）
```

### 3.2 串行的收益与代价

| | 收益 | 代价 |
|---|---|---|
| 额度 | 在飞 committed 最多 1 个任务的 est，reserve 不被多任务蚕食 | 无法「多窗口并行烧额度」；错过窗口就得等下一个窗口 |
| 执行 | 单 dsh 进程、boot 一次（~7s） | 单任务失败/超时会阻塞队列（需靠 timeout 兜底） |
| session | 一个 task 一个 session，语义干净 | 无法跨任务共享上下文（本来也不该共享） |
| 可观测 | 决策原因单一，日志好读 | 队列积压时吞吐低 |

> **取舍结论**：本产品的主要价值是「把会过期的额度烧掉」，而不是「最大化并发」。串行让「烧的账号、跑的模型、记的账」三者始终一致，计量可信度远高于吞吐。

### 3.3 串行对策略层的影响

- `slots()`：仍按 remaining 分档（>70→3 / >40→2 / >15→1），但被 `maxConcurrentPerBucket=1` 压到 **1**；
- `committed`：Σ 在飞 run 的 est，串行下 ≤ 1 项；
- `excess = remaining - committed - reserve`：语义不变；
- 队列排序更重要：`taskScore`（价值密度 × 紧迫度 × checkpoint 加权）决定「谁先跑」。

---

## 4. dsh 调用契约（实测确认）

### 4.1 命令模板

```bash
# 首次运行（新建 session）
dsh --profile lcs --patch <run.patch.yml> --json "<task 文本>"

# 续跑（同一 task 的后续尝试 / 被抢占后重排）
dsh --profile lcs --patch <run.patch.yml> --json --session-id <sessionId> "<继续提示>"
```

- `--profile lcs`：LCS 自建 profile（`~/.dsh/profiles/lcs/`），不动用户的 `headless`/`web`；
- `--patch`：每次运行的**临时覆盖层**，只覆盖 `agent-default-model`（provider+model）；
- `--json`：stdout 输出 NDJSON 事件流；stderr 只有 `dsh:` 诊断行；
- `--session-id`：**只能接管已存在的 session**，未知 id 直接失败（不会静默开新会话）。

### 4.2 事件流与产物

```json
{"type":"session","sessionId":"session-<uuid>","cwd":"<workDir>"}
{"type":"status","phase":"turn_start","turn":1}
{"type":"status","phase":"step_start","turn":1,"step":1}
{"type":"text","text":"…"}
{"type":"status","phase":"step_end","turn":1,"step":1,
 "usage":{"inputTokens":8144,"outputTokens":3,"totalTokens":8147,"cacheReadTokens":0}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"最终答案"}
```

- **最终答案** = `final.text` → 落 `stdout.log`，可选另存 `final.md` 作为产物；
- **用量** = `step_end.usage` → 写进 `Run.usage`（计量与校准的第一手证据）；
- **错误** = `turn_end.reason.error{code,message}`（`AUTH` / `MISSING_CREDENTIAL` / 429 …）+ 退出码 1；
- **产物目录**：`LCS_ARTIFACT_DIR` 指向 `~/.lcs/artifacts/<taskId>/<runId>/`，agent 写出的文件即产物。

### 4.3 session 绑定规则（坑位清单）

| 规则 | 后果 | LCS 的做法 |
|---|---|---|
| 接管要求 **cwd 一致** | cwd 变了就接管失败 | 每 task 固定 `~/.lcs/work/<taskId>/`，多次运行都用它 |
| session 按 cwd 分目录 | 会话分散在各工作区分组 | 同上，天然隔离 |
| 未知 `--session-id` 直接失败 | 误用会白跑一次 | sessionId 只从 `task.checkpoint.sessionId` 取 |
| 拒绝接管 subagent / fork 会话 | 只能用普通会话 | dsh headless 建的即普通会话 |
| headless 退出时可能报 `flush on a closed handle` | 冷会话投影不完整（仅影响 web 显示） | 不影响 LCS 自己的 sessionId/usage 解析（都来自 stdout 事件流） |

### 4.4 模型切换机制

dsh headless **没有 `--model` 参数**，模型来自 profile 的两个 row：

| row | 作用 | 谁写 |
|---|---|---|
| `llm-pi-ai` | 定义路由：`api` / `baseURL` / `apiKeyEnv` / `models[]` | **LCS 写进 profile 的 `cordis.patch.yml`（静态）** |
| `agent-default-model` | 新建 agent 的默认 `{provider, model}` | **LCS 每次运行用 `--patch` 覆盖（动态）** |

patch 格式（YAML 数组，`- id: <row>` + `config:` **整段替换**，`!!js` 可用）：

```yaml
# ~/.lcs/patches/run-minimax-<model-slug>.yml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: minimax          # = 路由名
    model: MiniMax-M3.1-Flash[1m]
```

> 注意：patch 整段替换 `config`。所以**路由必须写在 profile 层**（静态），运行期 patch 只改 `agent-default-model`，否则会把别的路由覆盖掉。

### 4.5 凭据注入（计量可信的关键）

dsh 凭据查找优先级：**启动环境 > `~/.dsh/.credentials.yaml` > 项目 `.env` > harness-home `.env`**。

- LCS spawn 时把**本次选中的 provider 的 Key** 注入为环境变量，变量名取自 provider 的 `options.dsh.apiKeyEnv`（如 `LCS_MINIMAX_API_KEY`）；
- dsh 路由的 `apiKeyEnv` 指向同一个变量名；
- 于是 **dsh 烧的账号 == LCS 记账的账号**；
- 用独立变量名（而非 `MINIMAX_API_KEY`）可避免与用户自己 dsh 配置里的同名变量串味；
- patch 文件与命令行**都不出现明文 Key**。

> 实测：把该 env 换成假值 → 立刻 `401 authentication_error`（证明环境变量确实优先于凭据文件）。

---

## 5. 配置模型（schema v2）

```jsonc
{
  "version": 2,
  "engine": {
    "tickSeconds": 60,
    "stateFile": "~/.lcs/state.json",
    "artifactsDir": "~/.lcs/artifacts",
    "workDir": "~/.lcs/work",            // 新增：每 task 固定工作目录的根
    "maxParallel": 1,                     // 语义收紧为串行
    "sessionRetentionDays": 7,            // 新增：dsh 会话保留天数
    "web": { "enabled": true, "host": "127.0.0.1", "port": 7788 }
  },
  "policy": { /* 不变 */ },
  "providers": [
    {
      "name": "minimax",
      "kind": "minimax",
      "enabled": true,
      "options": {
        "apiKey": "", "apiKeyEnv": "MINIMAX_API_KEY", "apiKeyFile": "~/.mmx/config.json",
        "endpoint": "https://api.minimaxi.com/v1/token_plan/remains",
        "families": ["general"], "textTokensPerPct": 50000,
        "dsh": {                                   // 新增：dsh 路由段（厂商预设写死，只读）
          "route": "minimax",                      // dsh 里的路由名（= agent-default-model.provider）
          "api": "anthropic-messages",
          "baseURL": "https://api.minimaxi.com/anthropic",
          "apiKeyEnv": "LCS_MINIMAX_API_KEY",      // 注入用的环境变量名
          "models": ["MiniMax-M3.1-Flash[1m]"],    // 该路由可用的模型 id（预设给定）
          "defaultModel": "MiniMax-M3.1-Flash[1m]" // 用户在添加 LLM 时选定，可改
        }
      }
    }
  ],
  // v0.3 不再有全局 models[] 能力目录：模型由 provider 配置（D13）
  "runners": {
    "default": "dsh",
    "dsh": {
      "enabled": true,
      "command": "dsh",
      "profile": "lcs",                            // LCS 自建 profile
      "patchDir": "~/.lcs/patches",                // 运行期 patch 缓存
      "timeoutS": 3600,                            // 默认超时（task.spec.timeoutS 可覆盖）
      "maxParallel": 1                             // 恒为 1
    }
  }
}
```

**迁移（v1 → v2）**

| v1 | v2 |
|---|---|
| `runners.shell` | 丢弃（shell 不再参与调度） |
| `runners.dsh.{command,profile,profiles}` | `runners.dsh.{command,profile}`；`profiles` 映射废弃（路由改为 provider 自带） |
| `engine.maxParallel=4` | 强制为 1（并提示「已切换为串行」） |
| `providers[].options`（无 dsh 段） | 按厂商预设补全 `options.dsh` 默认值 |
| `models[]` 全局能力目录 | **废弃**（模型改由 provider 配置持有） |
| `providers[].options` 无 dsh 段 | 按厂商预设补全 `options.dsh`（含 models 与 defaultModel） |

---

## 6. 状态模型变更

| 实体 | 新增字段 | 说明 |
|---|---|---|
| `Task` | `workDir` | `~/.lcs/work/<taskId>`，提交时创建 |
| `Task` | `dshSessionId` | 首次运行后从事件流抓取；等价于 `checkpoint.sessionId`（统一到后者） |
| `Task` | `finishedAt` | 终态时间，供 GC 判定 |
| `Run` | `sessionId` | 本次运行使用的 dsh session（首次为空） |
| `Run` | `usage` | `{inputTokens, outputTokens, cacheReadTokens, totalTokens}`（来自 `step_end.usage`） |
| `Run` | `dshProfile` / `model` | 实际使用的 profile 与模型 id |
| `Store` | `sessions` 索引 | `{sessionId → {taskId, cwd, createdAt}}`，供 GC 定位 |

> 兼容：老状态文件 `version: 1` 打开时按默认值补齐（沿用既有 `normalizeTask` 模式）。

---

## 7. 时序：从提交到收口

```
① submit(task)
   ├─ 分配 taskId、创建 workDir ~/.lcs/work/<taskId>
   └─ state=queued

② tick → dispatch（串行：若已有 run 在跑则跳过）
   ├─ observe：各 provider 容量 → 桶
   ├─ 候选桶：未过期 + 非 unlimited + 任务要求匹配
   ├─ 选模型：取该 provider 配置的模型（`options.dsh.defaultModel`，必须在 `options.dsh.models` 内）
   ├─ 准入：reserve/excess/slots（slots=1）→ admit
   └─ spawn:
        ├─ 生成 patch：agent-default-model{provider: route, model: modelId}
        ├─ env 注入：LCS_<PROVIDER>_API_KEY=<key>、LCS_ARTIFACT_DIR=…
        ├─ 命令：dsh --profile lcs --patch <patch> --json [--session-id <sid>] "<task>"
        └─ run.runner=dsh, run.sessionId=(首跑未知，稍后从事件流补)

③ 收口（reap）：读 stdout 事件流
   ├─ session 事件 → 写 task.checkpoint.sessionId + run.sessionId
   ├─ step_end.usage → run.usage（计量）
   ├─ final 事件 → final.md（可选产物）
   ├─ 退出码 0 → verifier 校验产物 → succeeded / failed(verification_failed)
   └─ 退出码 1 → 按错误码分类（D10）

④ 失败重试：attempts < maxAttempts → 回 queued（同 session 续跑）+ 退避
⑤ 窗口抢占：now ≥ windowEnd → kill → interrupted → 回 queued（同 session 续跑）
```

---

## 8. 计量与校准

| 量 | 来源 | 用途 |
|---|---|---|
| `remaining` | provider API（观测） | 容量事实 |
| `reserve(t)` | 策略（自用速率积分） | 保留线 |
| `est` | 任务声明 / 换算 / **usage 校准** / 默认值 | 单任务消耗预估 |
| `usage.tokens` | **dsh `step_end.usage`（实测）** | 真实消耗 → 折算 pct（`tokens / textTokensPerPct`）→ 更新 EWMA 校准 |
| `quotaDelta` | 两次采样余量差 | 兜底（dsh 不可用时） |

**校准链**：`usage 折算 pct → calibrationUpdate(taskClass, provider, bucketKey, pct)` → EWMA(α=0.3) → `n ≥ calibrationMinSamples` 后用于 `est`。

> 这样就摆脱了「并发批次无法归因」——串行 + usage 双保险，归因几乎总是可得的。

---

## 9. 会话与产物的保留策略（GC）

**清理对象**

1. `~/.dsh/sessions/<slug>/session-<id>/`（dsh 会话目录）
2. `~/.dsh/storages/session_projcache/sessions/session-<id>.json`（投影缓存）

**定位方式**：不复刻 dsh 的 slug 规则，直接按 sessionId glob `~/.dsh/sessions/*/session-<id>`。

**触发**：每次 tick 顺带做一次轻量 GC（上限：每 tick 最多删 N=10 个，避免单 tick 抖动）。

**规则**

| 会话 | 处理 |
|---|---|
| task 仍在进行（非终态） | **绝不删** |
| task 终态且 `now - finishedAt < sessionRetentionDays` | 保留（便于回看/续跑） |
| task 终态且超过 TTL | 删会话目录 + 投影缓存，清 `task.checkpoint.sessionId` |
| 未知归属（不在 tasks 里）且超过 TTL | 删（按会话目录 mtime 判定） |

**产物**：`~/.lcs/artifacts/<taskId>/<runId>/` 同样按 TTL 清理（独立于会话，保留期可更长，默认 30 天）。

**不做的事**：不碰 `~/.dsh/storages/workspace.json`（headless 会话本就不在里面）。

---

## 10. 失败与重试语义

| 情况 | 退出码 | `turn_end.reason` | 处理 |
|---|---|---|---|
| 正常完成 | 0 | `completed` | 验产物 → `succeeded` |
| 认证失败 | 1 | `error{AUTH}` / `MISSING_CREDENTIAL` | **不重试** → `failed`（错误码入 `task.error`） |
| 额度/限流 | 1 | `error{429…}` | **不重试**（等下一个窗口再排） |
| 模型不可用 | 1 | `error{…}` | 不重试（换模型/改配置） |
| 一般失败 | 1 | `error{…}` | 重试（attempts < maxAttempts），**同 session 续跑** |
| 超时 | kill | — | `failed(timeout)`，可重试 |
| 窗口结束抢占 | kill | — | `interrupted` → 回队列，**同 session 续跑** |
| 产物缺失 / verifier 失败 | 0 | `completed` | `failed(verification_failed)`，可重试 |

**重试退避**：`nextEligibleAtMs = now + retryBackoffSeconds`（默认 60s），并给 `priorityBoost` 有界提权（≤2）。

---

## 11. 安全边界

| 面 | 现状 | 本方案 |
|---|---|---|
| Key | 配置文件 0600、GET 脱敏 | 不变；新增「只走 env 注入」 |
| patch 文件 | — | 只含路由与模型名，**无 Key**；权限 0600 |
| 任务执行 | 本机命令 | dsh 默认带 bash/file/web 工具 → **任务即本机代码执行**；沙箱 + 审批仍待办（v0.3 后续） |
| 工作目录 | 产物目录 | 固定 `~/.lcs/work/<taskId>`，避免写到任意路径 |
| 监听 | 127.0.0.1 | 不变 |

> **待办（v0.3 收尾）**：dsh 侧启用 bash 沙箱（`dsh-bash-sandbox` / `dsh-sandbox-policy` 已在依赖里），并把「新增 provider / 改路由」纳入审批流。

---

## 12. UI 变更（配置页）

| 区域 | 变更 |
|---|---|
| **执行器** | 单张卡片「dsh」（不可多实例）：命令、profile、patch 目录、默认超时；顶部提示「当前为串行执行，一次一个任务」 |
| **Provider 卡片** | 「dsh 路由」段**只读**展示厂商参数（route/api/baseURL/models）+ **可改**的「模型」下拉（选项来自厂商预设） |
| ~~模型目录~~ | **取消**（模型归 provider 配置，添加 LLM 时选一次即可） |
| **引擎** | workDir、sessionRetentionDays、`maxParallel` 固定显示为 1（不可改） |
| **任务详情** | 展示 dsh sessionId、模型、usage tokens、final 文本 |

---

## 13. 代码改动清单

| 文件 | 改动 |
|---|---|
| `mcp/src/config.ts` | schema v2：`engine.workDir` / `sessionRetentionDays`；`runners` 收敛为 dsh；`providers[].options.dsh`；`migrateV1ToV2()` |
| `mcp/src/types.ts` | `RunnerName` → `"dsh"`；`Task.workDir/finishedAt`；`Run.sessionId/usage/dshProfile`；`Assignment.dshRoute` |
| `mcp/src/runner/dsh.ts` | **重写**：patch 生成、env 注入、session 续跑、事件流解析（session/final/usage/error）、cwd=workDir、超时 |
| `mcp/src/runner/events.ts`（新） | NDJSON 解析器（宽松：未知事件忽略；按类型容错） |
| `mcp/src/runner/index.ts` | 只构建 dsh runner |
| `mcp/src/runner/shell.ts` | v0.3 保留文件但不再注册（便于回退） |
| `mcp/src/dsh-profile.ts`（新） | 生成/校验 `~/.dsh/profiles/lcs/`（package.json / cordis.yml / cordis.patch.yml / pnpm-workspace.yaml）；生成运行期 patch；bootstrap 检查 |
| `mcp/src/engine.ts` | 串行化（maxParallel=1）；`selectRunner` 简化为 dsh；spawn 前生成 patch/注入 env；reap 解析 usage/session；抢占走同 session 重排 |
| `mcp/src/store.ts` | `sessions` 索引；`usage` 字段；GC 查询（终态 + TTL） |
| `mcp/src/gc.ts`（新） | 会话/产物清理（glob 定位 session 目录 + 投影缓存） |
| `mcp/src/web/server.ts` + `public/` | 执行器卡片、provider 路由字段、模型目录（+ `/api/dsh/import-models`）、任务详情展示 |
| `mcp/src/mcp.ts` | `lcs_status` 增 `sessions/usage` 字段 |
| `mcp/src/test/*` | 见 §14 |

---

## 14. 测试计划

| 类别 | 用例 |
|---|---|
| 假 dsh | 写一个 stub 脚本模拟 NDJSON 事件（session/final/usage/error/turn_end），验证：事件解析、`--session-id` 透传、env 注入、patch 生成内容、cwd=workDir、退出码映射 |
| 策略 | 串行下 slots=1；excess/reserve 不变；usage 校准写回 EWMA |
| 引擎 | 第二个任务在第一个结束前不 spawn；抢占 → interrupted → 同 session 重排；失败分类（401 不重试 / 一般失败重试） |
| 状态 | v1 → v2 迁移；新字段默认值；session 索引维护 |
| GC | 终态超 TTL → 会话目录与投影缓存被删；非终态不删；未知会话按 mtime 删 |
| Web | provider 路由字段读写；模型目录导入；执行器卡片只读串行语义 |
| 端到端 | 真机：真实 MiniMax Key 跑一个任务 → 校验 sessionId/usage/产物/校准写回 |

---

## 15. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | 配置 v2 + 迁移 + 类型 | 老配置能自动升级；单测覆盖 |
| M2 | dsh runner 重写 + 假 dsh | 事件/续跑/env/patch 全部单测通过 |
| M3 | 引擎串行 + session/usage 接入 | 串行不重叠；usage 入 state |
| M4 | GC | TTL 清理生效，不误删在飞会话 |
| M5 | Web UI | 执行器卡片、路由字段、模型目录 |
| M6 | 真机联调 | 真实 Key 跑通「提交 → 烧额度 → 出结果 → 校准 → 续跑」 |

---

## 16. 已知风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh 启动开销 ~7s | 串行下吞吐低 | 默认超时与退避；必要时 v0.4 再评估并发 |
| headless 退出时 `flush on a closed handle` | 冷会话投影不完整（仅影响 web 显示） | 不影响 LCS 解析（数据来自 stdout） |
| dsh 事件格式随版本变化 | 解析失效 | 宽松解析 + 未知事件忽略 + 记录原始流 |
| 会话目录堆积 | 磁盘与 `session.list` 膨胀 | GC（§9） |
| dsh 工具集含 bash/file | 任务可执行本机命令 | 沙箱 + 审批（待办） |
| 标题生成额外消耗一次模型调用 | 额度浪费 | patch 中把 `session-title-llm` 固定到便宜模型，或禁用 |
| 用户误改 `~/.dsh/profiles/lcs` | LCS 起不来 | bootstrap 自检 + 明确报错 |

---

## 17. 已确认的决策（2026-10-21，用户拍板）

1. **厂商参数用预设默认值，用户不可修改**（D14）：`route/api/baseURL/apiKeyEnv/models` 由厂商预设写死，UI 只读展示；
2. **provider 增加模型配置，用配置的模型**（D13）：添加 LLM 时选模型（选项来自厂商预设），provider 卡片里可改；全局 `models[]` 目录取消；
3. **shell runner 在 v0.3 彻底不再参与调度**（D1），代码文件保留以便回退。

---

## 17.1 实现进度（2026-10-21）

| 阶段 | 状态 | 证据 |
|---|---|---|
| M1 配置 v2 + 迁移 | ✅ | `migrateConfig()`；老配置启动即升级并落盘（实机日志：`配置已迁移到 v2`） |
| M2 dsh runner 重写 | ✅ | 事件解析 / patch 生成 / Key 注入 / session 续跑；假 dsh 单测 |
| M3 引擎串行 + session/usage | ✅ | `maxParallel=1`；run 记录 `sessionId` + `usage` |
| M4 GC | ✅ | 终态超 TTL → 删会话/投影/产物；非终态不删（单测） |
| M5 Web UI | ◐ | 执行器卡片（dsh-only/串行提示）、provider 只读路由 + 模型下拉、任务表单 dsh-only；截图待更新 |
| M6 真机联调 | ✅ | 见下 |

**M6 实测（真实 MiniMax Key，独立临时实例）**

```
task state: succeeded
run: model=MiniMax-M3.1-Flash[1m]
     session=session-44ecde30-3ec2-4ac0-bc2e-722799503236
     usage={inputTokens:10618, outputTokens:2, totalTokens:10831, cacheReadTokens:211}
     artifacts=[checkpoint.json, final.md], verified=true
final.md 内容: OK
```

**实现期发现并修掉的两个真问题**

1. **dsh 不会自己写产物文件**：答案只在 `final` 事件里。→ runner 在 `afterComplete` 把 `final.text` 落成 `final.md`（`FINAL_ARTIFACT`），任务用 `expect_artifacts: ["final.md"]` 即可。
2. **产物收集发生在收口时**：写入必须早于 `buildRunResult`，所以放在 `afterComplete` 里而不是 `poll` 返回后。

---

## 附录 A：实测记录（2026-10-21）

| 实验 | 结果 |
|---|---|
| `--patch` 覆盖 `agent-default-model` 换模型 | ✅ MiniMax 正常出结果 |
| 同 session 续跑（`--session-id`） | ✅ 历史保留，约 7s |
| 同 session 中换模型 | ✅ dsh 自动插入 `[model changed: …]` 提示 |
| 事件流含 `session` / `step_end.usage` / `final` / `turn_end` | ✅ 契约确认 |
| env 注入覆盖凭据文件 | ✅ 假 Key → `401 authentication_error` |
| 独立 `DSH_HOME` | ✅ 会话隔离到独立目录（本次未采用） |
| 独立 `DSH_HOME=~/.lcs/dsh-home` + 自建 profile `lcs` | ✅ 正常运行，会话落隔离 store；用户 `~/.dsh/sessions` 计数执行前后不变 |
| dsh web 侧边栏可见性 | headless 会话**不在** workspace 注册表 → 界面不可见；`session.list` API 可见 |

---

## 18. 事故记录：GC 越界删除用户会话（2026-10-22）

**现象**：用户 dsh web 的历史会话大面积消失（44 个），DSH 自身从不删会话目录。

**根因**：`mcp/src/gc.ts` 第 2 段「孤儿会话」分支——扫整个共享 `~/.dsh/sessions/**`，
把「不属于任何 LCS task 且目录 mtime 超过保留期（7 天）」的 `session-*` 目录删掉，
连带删投影缓存。在共享 `~/.dsh` 的前提下，这等于**替用户决定哪些会话该留**。
触发频率：每 30 个 tick（约 30 分钟）一轮，每轮最多 10 个。

**修复（两条，缺一不可）**：
1. **GC 只删自己登记过的会话**：`sessionId` 只能来自 store 里 `task.checkpoint.sessionId`，
   且 `engine.sessionRetentionDays` 只作用于**终态** task；彻底删掉「按 mtime 扫目录」的分支。
2. **家目录物理隔离**：新增 `engine.dshHome`（默认 `~/.lcs/dsh-home`），
   - dsh 子进程通过 `DSH_HOME` 注入；
   - 执行器 profile 建在 `<dshHome>/profiles/lcs`；
   - GC 的所有路径都限定在 `<dshHome>` 内；
   - **配置校验直接拒绝 `dshHome === ~/.dsh`**（启动即失败，不等 GC 周期）；
   - AGENTS.md / skills 以符号链接只读共享到隔离家目录。

**回归防线**：
- 测试 `GC：不属于 LCS 的会话一律不删（2026-10-22 事故回归测试）`
- 测试 `GC：只碰 engine.dshHome，绝不碰用户家目录`
- 测试 `配置：engine.dshHome 指向 ~/.dsh 时直接拒绝启动`

**验证**：隔离家目录跑真实 dsh 任务 → 用户 `~/.dsh/sessions` 计数 67→67 不变，
新会话落在 `~/.lcs/dsh-home/sessions/`；子进程 `invocation.json` 记录 `dshHome` 正确。
