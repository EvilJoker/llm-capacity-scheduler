# Changelog

本项目的版本变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- **运维脚本 `scripts/install-service.sh`**：把常驻服务托管成 systemd **用户级**服务，
  开机自启、7×24。自动探测 `node` / `lcs-mcp` / 配置路径，`Restart=always` +
  `StartLimitIntervalSec=0`（崩溃无限拉回）、`KillMode=control-group`（停服务连 dsh 子进程一起收），
  支持 `--dry-run` / `--check` / `--uninstall`，幂等可重跑。

### 修复

- **文档：dsh 插件安装漏了 bundle 注册步骤**。`dsh plugin --profile <p> add` 只是 pnpm 透传，
  只在**新建** profile 时自动把包写进 `dsh.profile.bundles`；如果首次安装的 pnpm 阶段失败
  （典型：pnpm 11 的 `ERR_PNPM_IGNORED_BUILDS`），依赖已落盘而 bundle 行没写，重跑会得到
  "Already up to date" 空操作 → 最终状态是「装了但不加载」。README §1.1 / RELEASING §4
  补上手工注册步骤与 `--dump-config | grep lcs-client` 验证法。
- **`scripts/release.sh --verify-plugin` 增加 bundle 注册独立断言**：不再只靠 `--dump-config`
  的间接证据，profile `package.json` 里必须有 `llm-capacity-scheduler-mcp` 这一行，否则直接失败。

## [0.4.1] — 2026-10-23

首个对外发布版本。产品形态：**常驻调度服务 + dsh 执行器 + 薄客户端（MCP / dsh 插件）**。

### 新增

- **调度内核**：容量桶建模（`provider/modelFamily/resourceKind/windowKey`），生命周期
  `fixed_grid | rolling_on_first_use | calendar | depleting | unlimited`，单位支持 `pct/count/tokens/money`。
- **准入策略**：`reserve(t)`（从现在到窗口结束要留给自己的量）+ 五道闸
  `no_bucket / unknown / unlimited / window_too_short / no_window_end / self_busy / work_hours_wait`；
  `self_busy` 用于「同一账号被外部消耗」时主动放弃燃烧。
- **dsh 执行器**：任务串行、每 task 一个 dsh session + 固定工作目录；换模型 = 换 dsh 后端模型；
  dsh NDJSON 事件流解析（`session` / `step_end.usage` / `final` / `turn_end`），真实 token 用量计量。
- **会话隔离（事故后重建）**：执行器使用独立 `DSH_HOME=~/.lcs/dsh-home`，启动时硬校验家目录
  不是 `~/.dsh`（realpath + 包含关系，堵住符号链接与未展开 `~` 两种绕过）；GC 只删 store 里登记过的
  会话，未知会话只统计不删。
- **GC 可审计**：`--dry-run` 预览、`store.gcLog` 审计、Web「清理审计」卡片、GC 被安全校验拒绝时
  整轮跳过并给出原因。
- **守护进程生命周期**：`lcs-mcp start / stop / restart / status / logs`（后台拉起、pid 文件、
  日志落盘 `<state 目录>/logs/lcs.log`、等健康检查通过再返回）。
- **Web 控制台**：概览 / 任务 / 容量 / 配置四页；添加-删除厂商（选厂商 + 填 Key）；
  容量余量趋势（sparkline + reserve 虚线）；任务执行日志（dsh 事件流尾部）；产物下载。
- **dsh 插件**：`dsh plugin --profile <p> add llm-capacity-scheduler-mcp` 一条命令装上 7 个原生工具
  （`lcs_submit_task` / `lcs_poll_tasks` / …），插件是纯客户端，通过 HTTP 连常驻服务。
- **MCP Server**：stdio，工具与插件共用同一份 `tool-specs`；检测到常驻服务时自动降级为代理模式。
- **自检**：`lcs-mcp doctor` 检查 dsh 执行器 / 配置版本 / 厂商凭据 / 执行器 profile / 家目录隔离 /
  会话目录 / 守护进程 / 插件接线，并给出可直接执行的修复建议。

### 修复

- 修复共享 `~/.dsh` 时 GC 误删用户主会话的问题（2026-10-22 数据丢失事故）：删除「孤儿会话」分支，
  改为独立家目录 + 白名单清理，并补 3 条回归测试。
- 修复未归一路径会在 cwd 下造出字面 `~` 目录的问题（Engine 构造与热加载时统一展开）。
- 修复 Web 任务详情时间列为空（camelCase/snake_case 不一致）。
- 修复插件日志调用 `ctx.logger.info` 未绑定导致整个 profile 加载失败（改为恒写 stderr）。

### 变更

- `lcs-mcp init` 生成的初始配置**不再预置任何厂商**：先起服务，再到 Web「添加 LLM」，
  避免新用户第一次 `doctor` 就看到「有厂商但没 Key」的失败项。
- 厂商参数（route / api / baseURL / apiKeyEnv / models）由厂商预设写死，用户只能选模型；
  API Key 只通过环境变量注入，不写入 patch 与命令行。

## [未发布]

- 第二个厂商预设（OpenAI 兼容 / DeepSeek），用于验证多厂商抽象。
- 任务完成通知（webhook / 命令钩子）与运行统计面板。
- Web 本地 API 的 Host / Origin 校验（防 DNS rebinding）。
