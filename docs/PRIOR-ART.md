# 现有项目对照（调研于 2026-10）

> 目的：确认空白位置，避免重复造轮子，并决定复用哪一层。

## 1. 相邻四层都不做这件事

| 层 | 代表 | 它解决什么 | 它**不**管什么 |
|---|---|---|---|
| **LLM 网关** | [LiteLLM](https://github.com/BerriAI/litellm) (~57K★)、[OpenRouter](https://openrouter.ai)、Portkey | 统一 API、140+ provider、故障转移、缓存、预算/限流作为**路由输入** | ❌ 同步代理，**不延迟执行**；❌ 没有"易逝窗口"概念；其 `RouterBudgetLimiting` 只是"超预算就把 deployment 从候选里过滤掉"；❌ budget 是累计花费，不是"5h 窗口还剩多少" |
| **持久化执行** | [Temporal](https://github.com/temporalio/temporal) (23.8K★)、[Hatchet](https://github.com/hatchet-dev/hatchet)、[Inngest](https://www.inngest.com)、[Trigger.dev](https://github.com/triggerdotdev/trigger.dev)、Celery | 任务不丢、重试、checkpoint、human-in-loop、结果存储、可视面板 | ❌ **完全不感知配额**。Hatchet 宣传 "rate limiting against LLM provider quotas"，但那是**令牌桶节流**，不是窗口库存，不会因为"这 5h 额度要作废了"而提前跑 |
| **配额监控** | [durandom/token-burn](https://github.com/durandom/token-burn)、`minimax-status`、`Musage`、`dsh-minimax-usage`、`mmx-quota-tool`、`pi-minimax-usage` | 看剩余量、燃烧率、耗尽预测、进度条 | ❌ 只读不调度 |
| **单供应商燃烧器** | [shadmau/quota-burn](https://github.com/shadmau/quota-burn)、[secreter/idleloop](https://github.com/secreter/idleloop) | 一家供应商的"窗口关闭前把 backlog 烧掉"（Claude / Codex） | ❌ 策略硬编码、只支持 1~2 家、无通用容量模型、无对外任务系统 |
| **DSH/OpenClaw 定时任务** | [dsh-cron](https://dshmp.com/en/plugins/goodandready-dsh-cron)、[dsh-cron-tasks](https://ai-develop.top/blog/1790794927550)、[dsh-scheduled](https://ai-develop.top/blog/1790158532913)、`dsh-plugin-automations`（有 off-peak 模式）、`openclaw cron` | 按 cron 起 agent 任务、有 UI/历史 | ❌ 纯时间驱动，**不读配额**、不按剩余量调强度、不在 `end_time−30min` 精确开烧 |

**结论：网关 × 持久化执行 × 配额监控 三者的交集是空的。** 缺的正是
**「在易逝容量上做准入控制，并把结果变成异步产物」**这一层。

## 2. 最接近的参考实现（可抄架构，不可直接用）

### shadmau/quota-burn ⭐ 最值得借鉴
- 定位：窗口关闭前自动跑低优先级 backlog 任务。
- 可借鉴：`config.toml` 策略参数（`reset_threshold_minutes` / `idle_threshold_minutes` /
  `max_tasks_per_run`）、任务用 markdown 元数据声明（`task/provider/cwd/type/model/prompt`）、
  `once/recurring/loop` 三种类型、`state.json`、`artifacts/`、单文件无依赖、cron 驱动 tick。
- 不可借鉴的原因：只支持 Claude/Codex；策略是常量阈值而非 reserve 函数；没有对外任务 API。
- **它的 `idle` 检测思路值得直接采用**：用两次探针间的配额漂移判断"用户是否活跃"。

### secreter/idleloop
- 中文项目，一句话定位与需求完全重合："让 AI 在你睡觉时自动消耗即将重置的订阅余量"。
- 可借鉴：每个任务独立 git 分支 + 验证 + shift log，早上 review；直接调 OAuth usage 端点
  （而非解析本地 JSONL）——**"provider 是唯一真相"的正确做法**。
- 现状：Phase 1 起步，只支持 Claude。

### thevibeworks/claude-quota-scheduler / mamuncseru/claude-keepwarm
- 目标**相反**：让 5h 窗口对齐工作时间 / 让窗口背靠背 tiling。
- 价值：提供"窗口相位"的调度思路。但 keepwarm 针对的是 Claude 的 `rolling_on_first_use`，
  **对 MiniMax 的 `fixed_grid` 不适用**——正好是容量模型里两种不同生命周期的现实例证。

## 3. 复用建议

```
LiteLLM（模型调用 / 故障转移 / 报价库）        ← 不重写
        ↑
本引擎（容量模型 + 准入策略 + 任务系统）        ← 差异化在这
        ↑
Runner（shell / dsh headless / claude-code）  ← 不重写
```

LiteLLM 已覆盖 140+ provider 的调用与模型能力元数据，**唯一它不提供的是配额窗口观测**——
那是本引擎自己要写的 adapter（各家 usage 端点多为非公开接口，需逆向 + 降级）。

## 4. 参考资料

- MiniMax 配额端点：`GET https://api.minimaxi.com/v1/token_plan/remains`
  （Subscription Key `sk-cp-` 前缀；pay-as-you-go key 401；`*_remaining_percent` 是**剩余**语义；
  时间戳为**毫秒**；HTTP 200 但错误码在 `base_resp.status_code`）
- MiniMax 5h 为**固定档**（社区实测 10-15 / 15-20），但官方 FAQ 写"从首次使用开始" →
  **两说冲突，一律以 API 返回的 `start_time`/`end_time` 为准**
- 官方明确：**未用完额度不滚存**；周限额对早期老用户为 ∞
- 高峰限流：工作日 15:00–17:30 动态限流；并发参考 Plus 3–4 / Max 4–5 / Ultra 6–7 agents
- 本机已验证：`mmx quota` 可用（`mmx-cli`，region=cn），无需登录态
