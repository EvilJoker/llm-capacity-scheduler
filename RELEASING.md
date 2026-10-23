# 发版手册（RELEASING）

> 目标：**打一个 tag，自动跑测试、出包、验证产物、建 GitHub Release**。
> 本地和 CI 用的是**同一份** `scripts/release.sh`，所以本地能出包，就说明 CI 能出包。

---

## 1. 产物只有一个：一个 npm 包，两个角色

这是被问过的问题，先把结论和证据写清楚。

```
dist-release/
├── llm-capacity-scheduler-mcp-<version>.tgz   ← 唯一产物（同时是 server 和 dsh 插件）
├── sha256sums.txt
└── manifest.json                              ← 版本 / git sha / sha256 / 验证结果
```

tarball 里同时包含两个入口：

| 角色 | 入口 | 怎么用 |
|---|---|---|
| **常驻服务 + CLI + Web + MCP stdio** | `bin/lcs-mcp.js` → `dist/cli.js` | `npm install -g <tgz>` |
| **dsh 插件** | `dist/plugin/index.js`（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml` 里 `lcs-client` 行） | `dsh plugin --profile web add <tgz>` |

**为什么合成一个包**（不是两个产物）：

- 插件是**纯客户端**，入口 `dist/plugin/index.js` 直接 `import { HttpBackend } from "../backend.js"`，
  和 server 共用 `dist/backend.js`、`dist/tool-specs.js` 等代码；拆成两个包会复制一遍这些代码，
  还要额外付出版本对齐（插件接口改了但服务没升）的代价。
- dsh 的插件加载方式就是「在 profile 里 `pnpm add` 一个包，再读它的 patch 层」，
  一个包天然可以两种角色；实测同一 tarball 两种安装方式都成立（见第 4 节）。
- 如果以后要做到「不装 Node 的机器上跑服务」，那才是第二个产物（单文件可执行 / 容器镜像），
  属于另一条产品线，目前不需要。

---

## 2. 本地出包（不推送、不发布）

```bash
# 完整流程：npm ci → build+test → npm pack → 产物校验 → 干净前缀安装冒烟 → sha256/manifest
bash scripts/release.sh --install

# 连插件角色一起验证（需要 dsh + pnpm 在 PATH 上）
bash scripts/release.sh --install --verify-plugin

# 快速迭代：复用已有 node_modules、跳过测试
bash scripts/release.sh --skip-tests

# 自定义产物目录
bash scripts/release.sh --out /tmp/lcs-build
```

产物固定落在 `dist-release/`（已 gitignore）。

### 脚本到底验证了什么

| 阶段 | 校验内容 |
|---|---|
| 前置 | Node ≥ 20；`package.json` 的 name/version 合法；tag 与版本一致（传 `--expect-tag` 时）；工作区脏会警告 |
| 版本一致性 | 构建出的 `dist/mcp.js` 里 `VERSION` 必须等于 `package.json` 的 version |
| 构建 | `npm test`（74 个用例，内含构建）；必须有 `dist/cli.js` / `dist/plugin/index.js` / `dist/web/public/index.html` |
| 打包 | `npm pack` 产出 tgz |
| 产物内容 | 文件数 ≥ 60；**不含 `dist/test/`**；必需文件齐全（bin / cli / plugin / backend / web / cordis.patch.yml / LICENSE / CHANGELOG / README） |
| 角色声明 | 包内 `package.json` 必须同时有 `bin.lcs-mcp`、`exports["./plugin"]`、`dsh.bundle.patch` |
| 冒烟 | 装到干净 `--prefix` → `lcs-mcp --version` 对版 → `init` → `start` → `/api/health` 返回 `ok:true` 且版本正确 → `status` 报「运行中」→ `stop` 后端口不再监听 → 插件入口可 `import`（有 `name`/`apply`） |
| 插件角色 | （`--verify-plugin`）把**同一个 tgz** 装进临时 `DSH_HOME` 的 profile：`dependencies` 登记成功、`--dump-config` 里出现 `lcs-client` 行且路径解析到 profile 内的 `node_modules` |
| 收尾 | `sha256sums.txt`（`sha256sum -c` 可直接校验）+ `manifest.json` |

---

## 3. 打 tag 触发 CI

### 3.1 流程

```bash
# 1) 改版本（只有一处：package.json；运行时 VERSION 从它读取，脚本还会二次校验）
cd mcp
npm version patch --no-git-tag-version        # 或手改 package.json 的 version
# 2) 更新 CHANGELOG.md（CI 用它生成 Release notes）
# 3) 提交
git add -A && git commit -m "chore(release): 0.4.2"
# 4) 打 tag 并推送（只推 tag；普通 commit push 不会触发发版）
git tag v0.4.2
git push origin main
git push origin v0.4.2
```

> ⚠️ 先把版本和 CHANGELOG 提交，再打 tag。CI 会校验 `tag == v<package.json version>`，
> 不一致会直接红。

### 3.2 CI 做了什么（`.github/workflows/release.yml`）

| job | 内容 |
|---|---|
| `test` | Node **20 与 22** 双版本 `npm ci` + `npm test`（矩阵，任一失败即停） |
| `package` | 装 dsh + pnpm → `bash scripts/release.sh --install --verify-plugin --expect-tag "$GITHUB_REF_NAME"` → 上传 `dist-release/` artifact，并把 manifest 写进 job summary |
| `release` | 下载 artifact → `sha256sum -c` 校验 → 从 `mcp/CHANGELOG.md` 抽出该版本段落当 notes → `gh release create` 挂上 `.tgz` + `sha256sums.txt` + `manifest.json` |

触发条件只有一个：`on.push.tags: ["v*"]`。**没有** `push` / `pull_request` 触发 —— 日常提交不烧 CI、
也不会误出包。

### 3.3 需要的一次性准备

- 仓库推到 GitHub 后，`Settings → Actions → General` 保持默认即可（`GITHUB_TOKEN` 有 `contents: write`
  就够建 Release，无需额外 secret）。
- 想同时发 npm 需要 `NPM_TOKEN`（见第 6 节，当前**没有**配）。

---

## 4. 从 Release 安装（不需要 npm 发布）

一个 tgz 三种装法，任选：

```bash
V=0.4.1
# ① 服务 / CLI
npm install -g ./llm-capacity-scheduler-mcp-$V.tgz

# ② dsh 插件（本地文件）
dsh plugin --profile web add ./llm-capacity-scheduler-mcp-$V.tgz

# ③ dsh 插件（直接给 Release 资产的 URL；pnpm 支持远端 tarball，已实测）
dsh plugin --profile web add \
  https://github.com/<owner>/<repo>/releases/download/v$V/llm-capacity-scheduler-mcp-$V.tgz
```

⚠️ **②③ 之后还要注册 bundle，否则「装了但不加载」**：`dsh plugin` 只是 pnpm 透传，
不会往 `dsh.profile.bundles` 写那一行。补完后 `dsh --profile web --dump-config | grep lcs-client`
能看到 `- id: lcs-client` 才算接上：

```bash
node -e '
  const fs = require("fs"), f = process.env.HOME + "/.dsh/profiles/web/package.json";
  const p = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!p.dsh.profile.bundles.includes("llm-capacity-scheduler-mcp")) {
    p.dsh.profile.bundles.push("llm-capacity-scheduler-mcp");
    fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
  }
'
```

> Release 流水线的插件验证（`scripts/release.sh --verify-plugin`）走的就是完整流程
> （装包 → 注册 bundle → 在 `--dump-config` 里查 `lcs-client`），所以 CI 绿 = 这条链路可用。
> 另外 `dsh plugin add` 可能因 pnpm 11 的 `allowBuilds` 占位符报 `ERR_PNPM_IGNORED_BUILDS`，
> 按提示把 `pnpm-workspace.yaml` 里那条改成 `true`/`false` 再重跑。

校验：

```bash
sha256sum -c sha256sums.txt
cat manifest.json          # 版本 / git sha / 文件大小 / 各阶段验证结果
```

> 把 `<owner>/<repo>` 换成实际仓库；`manifest.json` 里的 `git.tag` 只有在 tag 上构建时才有值
> （本地未打 tag 构建时为 `null`，这是正常的）。

---

## 5. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| CI 红：`tag vX 与 package.json 版本 vY 不一致` | 先改版本 + CHANGELOG，提交后再打 tag |
| CI 红：`tarball 里混进了测试代码` | `mcp/package.json` 的 `files` 排除项（`!dist/test/`）被改坏了 |
| CI 红：`dsh plugin add 失败` | runner 上 `pnpm` / `dsh` 没装好，或插件包内 `cordis.patch.yml` 丢了 |
| 想只出包不建 Release | 本地跑 `bash scripts/release.sh` 即可；CI 的 `package` job 也能单独看 artifact |
| 想重跑失败的发版 | 删掉 tag 重打（`git push origin :v0.4.2 && git tag -d v0.4.2 && git tag v0.4.2 && git push origin v0.4.2`）；已建 Release 需先 `gh release delete` |
| 发错了版本 | Release 可删；npm 已发布的版本不可复用（只能 `npm deprecate` + 发新版本） |

---

## 6. 可选：发到 npm

当前脚本**只出包、不发布**（发布需要凭据，且不可回滚）。确认要发时：

```bash
cd mcp
npm publish ../dist-release/llm-capacity-scheduler-mcp-<version>.tgz
```

若要自动化：在仓库加 `NPM_TOKEN` secret，然后在 `release` job 末尾追加一步
`npm publish dist-release/*.tgz --access public`（注意：npm 包名 `llm-capacity-scheduler-mcp`
需先在 npm 上占位，否则会 403）。

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `scripts/release.sh` | 唯一出包流水线（本地 / CI 共用） |
| `.github/workflows/release.yml` | tag 触发的三段式 CI（test → package → release） |
| `mcp/CHANGELOG.md` | Release notes 来源；发版必须更新 |
| `mcp/package.json` | `version` / `files` / `dsh.bundle.patch` / `bin` / `exports` |
| `dist-release/` | 本地产物（gitignore） |
