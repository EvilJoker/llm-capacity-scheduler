# LCS × DSH：角色划分、安装与初始化流程

> 结论先行：**LCS 是独立常驻的调度服务（7×24），dsh 只是执行器，MCP 与 dsh 插件都是它的客户端。**
>
> 插件的价值不是"把调度器搬进 dsh"，而是**让 dsh 里的 agent 一条命令就能拿到 `lcs_*` 工具**，
> 不必手写 MCP 配置；同时保证调度器与 dsh 的生死周期解耦。

分析基于本机实测：dsh `0.2.0-rc.2`、profile 目录 `~/.dsh/profiles/*`、
已装插件 `dshmarket` / `dsh-mmx-bridge` / `@openviking/dsh-memory-plugin`。

---

## 1. 最终架构

```
┌──────────────────────── 常驻进程（7×24，用户自己托管）─────────────────────┐
│  lcs-mcp serve                                                              │
│    · 调度器 tick（observe → reap → preempt → dispatch）                     │
│    · 容量观测 / reserve 策略 / 计量 / GC                                     │
│    · 状态：~/.lcs/state.json（单写者，锁保护）                              │
│    · Web 控制台：http://127.0.0.1:7788                                     │
│    · 执行器：拉起 dsh --profile lcs 子进程跑任务                            │
└───────────────┬──────────────────────────────────┬────────────────────────┘
                │ HTTP（127.0.0.1:7788）          │ 拉子进程
                ▼                                  ▼
        ┌───────────────┐              ┌────────────────────────┐
        │ 客户端（agent 侧）            │ dsh --profile lcs      │
        │  · MCP Server (stdio)        │  每 task 一个 session   │
        │  · dsh 插件（原生工具）       │  固定工作目录 + 产物     │
        └───────────────┘              └────────────────────────┘
```

| 角色 | 进程 | 职责 | 生命周期 |
|---|---|---|---|
| 调度服务 | `lcs-mcp serve` | 调度、计量、Web、起 dsh | 7×24 独立常驻 |
| 执行器 | `dsh --profile lcs` | 真正跑任务 | 调度服务拉起，随任务生灭 |
| 客户端 | `lcs-mcp`（MCP）/ dsh 插件 | 提交/查询/取消任务 | 随 agent 会话 |

**关键推论**：客户端可以随便挂几个、随时重启，状态只有一份（`~/.lcs/state.json`），
调度器只有一个（锁 + 代理模式）。

---

## 2. DSH 插件机制（实测）

### 2.1 插件长什么样

一个 dsh 插件 = 一个 npm 包 + 一个 patch 文件（参照本机 `@openviking/dsh-memory-plugin`）：

```
package.json
  "exports": { ".": "./index.mjs", "./plugin": "./dist/plugin/index.js" }
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }   ← 声明自己的 patch 层
  "peerDependencies": { "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2 <0.3.0" }

cordis.patch.yml
  - insert:
      - id: lcs-client                            ← 全局唯一的 row id
        name: './dist/plugin/index.js'             ← 包内相对路径，dsh 转成 file URL

dist/plugin/index.js
  export const name = "lcs";
  export function apply(ctx) { ... }               ← cordis 插件约定
```

- **插件自己不带入口定义**，只声明一个 row；真正的 row 由 `cordis.patch.yml` 的 `insert` 产生。
- row 的 `id` 必须**全局唯一**：与其它 bundle 冲突会导致下次启动直接失败
  （`dshmarket/lib/install.js` 的 `conflictingEntryIds` 分支会判死并卸载）。
- 插件提供的原生工具直接进 agent 的工具集（本会话里的 `mmx_bridge` 就是 `dsh-mmx-bridge` 提供的）。

### 2.2 装载顺序（决定一切优先级）

来自 `dsh-app-boot` README：

```
1. 各 bundle 的 patch（按 package.json → dsh.profile.bundles 的顺序）
2. profile 自己的 cordis.patch.yml          ← 用户层
3. $DSH_HOME/cordis.patch.yml               ← 家目录层（更高）
4. --patch 覆盖层
```

**用户层永远压过 bundle 层**，且 patch 是**整段替换**目标 row 的 config。

### 2.3 安装命令做了什么

`dsh plugin --profile <p> add <pkg>`（= pnpm add 到该 profile 的 `node_modules`），
pnpm 成功后由 `dsh-plugin-manager` 的 `reconcile()` 自动把新包名**追加进
`package.json` 的 `dsh.profile.bundles`**（`plugin-manager/lib/index.js:237-262,669`）。

→ **一条命令即完成「装包 + 启用 bundle」**，用户不用改 package.json。

### 2.4 安装期的闸门

| 闸门 | 行为 | 本机实证 |
|---|---|---|
| **peer 版本兼容** | 安装前用 `peerDependencies` 对 `dsh --version`（本机 `0.2.0-rc.2`）做 semver 范围检查；registry 包**在 pnpm 之前**就被拒 | `~/.dsh/profiles/web/compatibility.json` 里已有 4 条人工豁免（openviking / mmx-bridge / computer-use / brand） |
| **豁免是人工步骤** | `dsh plugin --profile <p> allow-version <pkg>@<ver> --dsh-version 0.2.0-rc.2 --accept-risk` | **LCS 声明 `>=0.2.0-rc.2 <0.3.0`，这一步直接消失** |
| **bundle 启动期再查一次** | profile 启动时再查每个 bundle 自己的 peer；不兼容且无豁免 → 跳过该 bundle（`skippedBundles`） | — |
| **row id 冲突** | 冲突 → 判死、卸载 | `dshmarket/lib/install.js` |
| **pnpm 失败回滚** | 安装失败会还原 `package.json` / `pnpm-lock.yaml` | `plugin-manager/README.md` |

### 2.5 生效时机

bundle 层是**启动时**读取的。
- 本机 `web` profile：`cordis.yml` 是 `[]`、没有 `dsh-hmr` row → **无服务端热重载 → 装完必须重启 dsh web**。
- 本机 `desktop` profile：`package.json` 里 `"patchReload": "live"` → 可热重载。

---

## 3. 安装 / 初始化流程

### 3.1 用户侧

| # | 步骤 | 谁做 | 备注 |
|---|---|---|---|
| 1 | `npm i -g llm-capacity-scheduler-mcp` | 用户 | |
| 2 | `lcs-mcp init` → 填 Key（或 `LCS_MINIMAX_API_KEY` 环境变量） | 用户 | 也可以在 Web 控制台「添加 LLM」 |
| 3 | 起常驻服务：`lcs-mcp serve`（怎么托管由用户定） | 用户 | 唯一写状态、唯一跑调度的进程 |
| 4 | `dsh plugin --profile web add llm-capacity-scheduler-mcp` | 用户 | 只为让 dsh 的 agent 有原生工具 |
| 5 | 重启 dsh web | 用户 | 本机 web profile 无 HMR |
| 6 | `lcs-mcp doctor` 自检 | 用户 | 一屏看清还差什么 |

### 3.2 插件侧要做的（否则装完是哑的）

```
插件 apply(ctx):
  1. 解析调度服务地址：LCS_URL → ~/.lcs/config.json 的 engine.web → 默认 127.0.0.1:7788
  2. 等 tools 服务就绪（patch/bundle 层与 tools 服务同一批事务激活，apply 时可能还拿不到）
  3. 注册 7 个原生工具，全部转发给调度服务（HTTP）
  4. 探测调度服务可达性，不可达就 warn（不影响插件加载）
  5. dispose：卸载工具
```

插件**不做**：不抢单实例锁、不监听端口、不起调度器、不写状态、不起 dsh 子进程。

---

## 4. 真机验证（2026-10-22）

```bash
# 1) 安装（本地路径，正式发布后是 npm 包名）
dsh plugin --profile lcs-demo add /media/vdc/github/llm-capacity-scheduler/mcp
→ dsh: initialized profile lcs-demo
→ dependencies: + llm-capacity-scheduler-mcp link:...

# 2) 自动登记进 bundles
~/.dsh/profiles/lcs-demo/package.json
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless",
                                    "llm-capacity-scheduler-mcp"] } }

# 3) 装载树里能看到我们的 row（相对路径已转成 file URL）
dsh --profile lcs-demo --dump-config
  # == llm-capacity-scheduler-mcp
  - id: lcs-client
    name: file:///.../profiles/lcs-demo/node_modules/llm-capacity-scheduler-mcp/dist/plugin/index.js

# 4) 真机 boot：插件挂载成功、7 个工具注册、调度服务可达
dsh --profile lcs-demo --json "ping"
  [lcs] lcs 插件已加载：7 个工具已注册 → 守护进程 http://127.0.0.1:7788
  [lcs] lcs 守护进程可达：http://127.0.0.1:7788

# 5) 端到端：dsh 里的 agent 真的调了插件工具
dsh --profile lcs-demo --json "请调用工具 lcs_submit_task 提交一个任务…再用 lcs_poll_tasks 查"
  "tool":"lcs_submit_task"  → task_id: task_mvj9jjq2dcf23bd3
  "tool":"lcs_poll_tasks"   → state: submitted
```

> 实测踩坑（已修）：`ctx.logger.info` 解绑后调用会抛 `this is not a function`，
> **直接让整个 profile 起不来**（cordis 的 `LoggerService.info` 依赖 `this` 拿 fiber 上下文）。
> 现在统一写 stderr，并以 logger 为 `this` 调用。

---

## 5. 设计结论（为什么这样切）

### 5.1 调度器必须独立进程

用户诉求：**空闲时也要跑任务、7×24**。若调度器寄生在 dsh 里，dsh 一关调度就停；
dsh web 的重启、升级、崩溃都会打断调度。所以调度器独立常驻，dsh 退化成"按需拉起的执行器"。

### 5.2 插件只能是客户端

插件跑在 dsh 进程内，若让它起调度器/监听端口：
- 和常驻服务抢 `~/.lcs/state.json` 的单实例锁；
- 和用户自己跑的 `lcs-mcp serve` 抢 7788 端口；
- 随 dsh 生死 → 与 7×24 的目标冲突。

客户端化后三者都不存在。

### 5.3 路由不能注入宿主 profile

本机 `web` profile 的用户 patch 里**已经**定义了 `llm-pi-ai`（6 个 provider）。
bundle 层（第 1 层）会被用户 patch（第 2 层）**整段替换** → 插件注入的路由会被抹掉。
所以执行器继续用**独立 `lcs` profile**（v0.3 已如此，不用改），插件不碰路由。

### 5.4 peer 版本豁免可以设计掉

现有两个社区插件都被迫人工豁免。LCS 声明 `>=0.2.0-rc.2 <0.3.0` → 用户零额外步骤。

---

## 6. 代码清单

| 文件 | 作用 |
|---|---|
| `mcp/cordis.patch.yml` | bundle patch 层：insert `lcs-client` row |
| `mcp/src/plugin/index.ts` | 插件入口：`name` / `apply`，等 tools 服务 → 注册 → 可卸载 |
| `mcp/src/plugin/tools.ts` | 7 个 `defineTool` 定义（dsh schema DSL） |
| `mcp/src/plugin/daemon.ts` | 调度服务地址解析（`LCS_URL` → 配置文件 → 默认） |
| `mcp/src/tool-specs.ts` | **工具契约唯一真源**：MCP（zod）与插件（dsh DSL）共用 |
| `mcp/src/mcp.ts` | MCP 出口改为从 `tool-specs.ts` 生成 zod schema |
| `mcp/src/doctor.ts` | `lcs-mcp doctor` 安装自检 |
| `mcp/src/cli.ts` | 新增 `doctor` 命令 |

测试：`mcp/src/test/plugin.test.ts`（6 例）→ 全量 **55 passed**。

---

## 7. 待办

1. **npm 发布**：包名 `llm-capacity-scheduler-mcp` 已占用；发布后 `dsh plugin --profile web add llm-capacity-scheduler-mcp` 走 registry 路径再验一次。
2. **装进 web profile**：本机验证用的是 `lcs-demo` 沙盒 profile；装进 `web` 需要重启 dsh web（用户决定时机）。
3. **插件侧的 client UI**：dsh web 里直接看 LCS 容量/任务页（可选，工作量大）。
4. **调度器托管**：常驻方式（systemd / pm2 / 容器）由用户决定，本仓库不绑定。

---

## 附录 A：证据索引

| 结论 | 出处 |
|---|---|
| 插件包结构 / row id 唯一 / `apply(ctx)` | `~/.dsh/profiles/web/node_modules/@openviking/dsh-memory-plugin/{package.json,cordis.patch.yml,index.mjs}` |
| 层序（bundle → profile patch → home patch → --patch） | `dsh-app-boot/README.md:50` |
| 安装后自动进 bundles | `dsh-plugin-manager/lib/index.js:237-262,669`（`reconcile` / `activateNewBundles`） |
| peer 兼容闸门与豁免 | `dsh-plugin-manager/README.md#version-compatibility-and-exemptions`；实证 `~/.dsh/profiles/web/compatibility.json` |
| row id 冲突 → 卸载 | `dshmarket/lib/install.js:455-470`、`profile.js#hasLoadableEntry` |
| web profile 无 HMR / desktop 有 | `~/.dsh/profiles/web/{cordis.yml,package.json}` vs `~/.dsh/profiles/desktop/package.json`（`patchReload: live`） |
| `ctx.logger.info` 依赖 `this` | `cordis/lib/index.js:647`（`LoggerService.prototype[type] = function(...){ return this()[type](...) }`） |
| LCS 现有自举 | `mcp/src/cli.ts`（`ensureDshProfile`、锁/代理）、`mcp/src/dsh-profile.ts` |
