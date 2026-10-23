#!/usr/bin/env bash
#
# LCS 发版流水线（本地与 GitHub Actions 共用同一份）。
#
#   build/test → npm pack → 产物内容校验 → 装到干净前缀里冒烟（CLI + 服务）→
#   （可选）把同一个 tarball 装进临时 dsh profile 验证插件角色 → sha256 + manifest
#
# 为什么只有**一个**产物：LCS 是一个 npm 包、两个角色。
#   - server/CLI：bin/lcs-mcp.js → dist/cli.js（常驻调度服务 + Web + MCP stdio）
#   - dsh 插件  ：dist/plugin/index.js（package.json 的 dsh.bundle.patch 指向 cordis.patch.yml）
#   插件入口只依赖同包的 dist/backend.js 等，拆成两个包只会重复代码 + 版本漂移，
#   所以一个 tarball 既能 `npm i -g` 当服务，也能 `dsh plugin add` 当插件。
#
# 用法:
#   scripts/release.sh [选项]
#
#   --out <dir>        产物目录（默认 <repo>/dist-release）
#   --install          先执行 `npm ci`（CI 用；本地默认复用已有 node_modules）
#   --skip-tests       跳过 npm test（仍会 build + 产物校验 + 冒烟）
#   --verify-plugin    额外验证「同一个 tarball 能装进 dsh profile」（需 dsh + pnpm + 网络）
#   --expect-tag <t>   校验 tag 与 package.json 版本一致（CI 传 v$GITHUB_REF_NAME）
#   -h, --help         显示帮助
#
# 退出码: 0 成功；1 校验/构建失败；2 参数错误。

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$ROOT/mcp"
OUT_DIR="$ROOT/dist-release"
DO_INSTALL=0
SKIP_TESTS=0
VERIFY_PLUGIN=0
EXPECT_TAG=""
PLUGIN_CHECK="skipped"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() {
  printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die "--out 需要一个目录参数"
      OUT_DIR="$2"
      shift 2
      ;;
    --install)
      DO_INSTALL=1
      shift
      ;;
    --skip-tests)
      SKIP_TESTS=1
      shift
      ;;
    --verify-plugin)
      VERIFY_PLUGIN=1
      shift
      ;;
    --expect-tag)
      [ $# -ge 2 ] || die "--expect-tag 需要 tag"
      EXPECT_TAG="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf '未知参数: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

TMP="$(mktemp -d)"
cleanup() {
  if [ -n "$TMP" ] && [ -d "$TMP" ]; then
    rm -rf "$TMP"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------- 0. 前置检查
step "[0/7] 前置检查"

[ -f "$PKG_DIR/package.json" ] || die "找不到 $PKG_DIR/package.json"
[ -f "$PKG_DIR/package-lock.json" ] || die "找不到 mcp/package-lock.json（发版必须锁依赖）"

command -v node >/dev/null 2>&1 || die "需要 node（>= 20）"
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const major=Number(process.versions.node.split(".")[0]);process.exit(major>=20?0:1)' ||
  die "Node 版本过低：$NODE_VERSION（要求 >= 20）"
ok "node $NODE_VERSION"

NAME="$(node -p "require('$PKG_DIR/package.json').name")"
VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
[ -n "$NAME" ] && [ -n "$VERSION" ] || die "package.json 的 name/version 不合法"
ok "$NAME@$VERSION"

if [ -n "$EXPECT_TAG" ]; then
  [ "$EXPECT_TAG" = "v$VERSION" ] ||
    die "tag $EXPECT_TAG 与 package.json 版本 v$VERSION 不一致：先改版本再打 tag"
  ok "tag $EXPECT_TAG 与版本一致"
fi

GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
GIT_TAG="$(git -C "$ROOT" describe --tags --exact-match 2>/dev/null || echo "")"
ok "git ${GIT_SHA}${GIT_TAG:+ (tag $GIT_TAG)}"

GIT_DIRTY=0
if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
  GIT_DIRTY=1
  warn "工作区不干净：manifest 会标记 dirty=true（CI 上的发版包一定是 dirty=false）"
fi

# ---------------------------------------------------------------- 1. 依赖
step "[1/7] 依赖"
if [ "$DO_INSTALL" = 1 ]; then
  (cd "$PKG_DIR" && npm ci --no-audit --no-fund)
  ok "npm ci 完成（锁文件安装）"
else
  [ -d "$PKG_DIR/node_modules" ] || die "node_modules 不存在：加 --install，或先在 mcp/ 里 npm ci"
  ok "复用已有 node_modules（--install 可强制重装）"
fi

# ---------------------------------------------------------------- 2. 构建 / 3. 测试
if [ "$SKIP_TESTS" = 1 ]; then
  step "[2/7] 构建（跳过测试）"
  # tsc 只增不删：先清掉 dist，保证本地产物与 CI（干净 checkout）一致
  rm -rf "$PKG_DIR/dist"
  (cd "$PKG_DIR" && npm run build)
  ok "构建完成"
else
  step "[2/7] 构建 + 测试"
  rm -rf "$PKG_DIR/dist"
  (cd "$PKG_DIR" && npm test)
  ok "测试通过（npm test 内含构建）"
fi

[ -f "$PKG_DIR/dist/cli.js" ] || die "构建产物缺失：dist/cli.js"
[ -f "$PKG_DIR/dist/plugin/index.js" ] || die "构建产物缺失：dist/plugin/index.js"
[ -f "$PKG_DIR/dist/web/public/index.html" ] || die "构建产物缺失：dist/web/public/index.html（copy-assets 没跑？）"
ok "dist 完整（cli / plugin / web）"

# 版本号只有 package.json 一处真源；产物里的 VERSION 必须和它一致（防止「包 0.4.2、--version 0.4.1」）
BUILT_VERSION="$(node -e "import('$PKG_DIR/dist/mcp.js').then((m) => console.log(m.VERSION))")"
[ "$BUILT_VERSION" = "$VERSION" ] ||
  die "构建产物 VERSION=$BUILT_VERSION 与 package.json 的 $VERSION 不一致"
ok "产物版本与 package.json 一致（$VERSION）"

# ---------------------------------------------------------------- 4. 打包
step "[3/7] 打包"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/$NAME-$VERSION.tgz"
(cd "$PKG_DIR" && npm pack --pack-destination "$OUT_DIR" >/dev/null)
[ -f "$TARBALL" ] || die "npm pack 没有产出 $TARBALL"
TARBALL_SIZE="$(wc -c <"$TARBALL" | tr -d ' ')"
ok "$(basename "$TARBALL")（$TARBALL_SIZE 字节）"

# ---------------------------------------------------------------- 5. 产物内容校验
step "[4/7] 产物内容校验"
# 一次性取出清单：不要用 `tar | grep -q`，grep -q 提前退出会让 tar 收到 SIGPIPE，
# 在 `set -o pipefail` 下整条管道会被判失败（踩过一次）。
TAR_LIST="$(tar -tzf "$TARBALL")"
ENTRIES="$(printf '%s\n' "$TAR_LIST" | wc -l | tr -d ' ')"
[ "$ENTRIES" -ge 60 ] || die "tarball 只有 $ENTRIES 个文件，疑似构建不完整"
ok "共 $ENTRIES 个文件"

has_entry() {
  case $'\n'"$TAR_LIST"$'\n' in
    *$'\n'"$1"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

case $'\n'"$TAR_LIST"$'\n' in
  *$'\n'package/dist/test/*) die "tarball 里混进了测试代码（dist/test），检查 package.json 的 files 排除项" ;;
esac
ok "不含测试代码"

for required in \
  package/package.json \
  package/bin/lcs-mcp.js \
  package/dist/cli.js \
  package/dist/plugin/index.js \
  package/dist/backend.js \
  package/dist/web/public/index.html \
  package/dist/web/public/app.js \
  package/cordis.patch.yml \
  package/LICENSE \
  package/CHANGELOG.md \
  package/README.md; do
  has_entry "$required" || die "tarball 缺少必需文件：$required"
done
ok "必需文件齐全（server + plugin + web + 元数据）"

# 包内 package.json 必须声明两个角色
PACK_MANIFEST="$TMP/packed-package.json"
tar -xOzf "$TARBALL" package/package.json >"$PACK_MANIFEST"
node - "$PACK_MANIFEST" <<'NODE' || die "包内 package.json 缺少 server/plugin 角色声明"
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fail = (m) => {
  console.error('  ' + m);
  process.exit(1);
};
if (!manifest.bin || !manifest.bin['lcs-mcp']) fail('缺少 bin.lcs-mcp（server/CLI 角色）');
if (!manifest.exports || !manifest.exports['./plugin']) fail('缺少 exports["./plugin"]（插件角色）');
if (!manifest.dsh || !manifest.dsh.bundle || !manifest.dsh.bundle.patch)
  fail('缺少 dsh.bundle.patch（dsh 插件装载点）');
NODE
ok "两个角色都在：bin.lcs-mcp（服务）+ exports['./plugin'] + dsh.bundle.patch（插件）"
rm -f "$PACK_MANIFEST"

# ---------------------------------------------------------------- 6. 冒烟
step "[5/7] 冒烟：装到干净前缀 → 起服务 → 查健康 → 停"
PREFIX="$TMP/prefix"
export HOME="$TMP/home"
mkdir -p "$HOME"
unset XDG_CONFIG_HOME XDG_DATA_HOME 2>/dev/null || true

npm install -g --prefix "$PREFIX" "$TARBALL" --no-audit --no-fund >/dev/null 2>&1 ||
  die "全局安装 tarball 失败"
BIN="$PREFIX/bin/lcs-mcp"
[ -x "$BIN" ] || die "安装后找不到 lcs-mcp 可执行文件"
INSTALLED_VERSION="$("$BIN" --version)"
[ "$INSTALLED_VERSION" = "$VERSION" ] || die "安装后版本不符：$INSTALLED_VERSION != $VERSION"
ok "安装成功，lcs-mcp --version = $INSTALLED_VERSION"

"$BIN" init >/dev/null 2>&1 || die "lcs-mcp init 失败"
ok "init 生成配置（零厂商）"

PORT="$(free_port)"
export LCS_PORT="$PORT"
"$BIN" start >"$TMP/start.log" 2>&1 || {
  sed 's/^/    /' "$TMP/start.log" | tail -30
  die "lcs-mcp start 失败"
}
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health")" || {
  "$BIN" stop >/dev/null 2>&1 || true
  die "启动后 /api/health 不通"
}
node -e '
const body = JSON.parse(process.argv[1]);
if (body.ok !== true) { console.error("health.ok != true"); process.exit(1); }
if (body.version !== process.argv[2]) { console.error(`health.version=${body.version}`); process.exit(1); }
' "$HEALTH" "$VERSION" || die "健康检查内容不符：$HEALTH"
ok "守护进程已启动，/api/health ok（:${PORT}）"

STATUS_OUT="$("$BIN" status 2>/dev/null || true)"
case "$STATUS_OUT" in
  *运行中*) ok "status 正常" ;;
  *) die "lcs-mcp status 没报告「运行中」：${STATUS_OUT}" ;;
esac

"$BIN" stop >/dev/null 2>&1 || die "lcs-mcp stop 失败"
if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  die "stop 之后 Web 仍在监听"
fi
ok "stop 干净退出"

node -e '
const entry = process.argv[1];
import(entry).then((m) => {
  const missing = ["name", "apply"].filter((k) => !(k in m));
  if (missing.length) { console.error("插件入口缺少导出: " + missing.join(",")); process.exit(1); }
}).catch((error) => { console.error(error.message); process.exit(1); });
' "$PREFIX/lib/node_modules/$NAME/dist/plugin/index.js" || die "插件入口无法加载"
ok "插件入口可加载（name / apply 存在）"

unset LCS_PORT

# ---------------------------------------------------------------- 7. 插件角色（可选）
if [ "$VERIFY_PLUGIN" = 1 ]; then
  step "[6/7] 插件角色：同一个 tarball 装进临时 dsh profile"
  command -v dsh >/dev/null 2>&1 || die "--verify-plugin 需要 dsh 在 PATH（npm i -g @deepseek-ai/dsh）"
  command -v pnpm >/dev/null 2>&1 || die "--verify-plugin 需要 pnpm（dsh plugin 转发给它）"

  ok "dsh $(dsh --version) · pnpm $(pnpm --version) · node $(node -p 'process.versions.node')"

  DSH_TMP_HOME="$TMP/dsh-home"
  mkdir -p "$DSH_TMP_HOME"
  if ! DSH_HOME="$DSH_TMP_HOME" dsh plugin --profile reltest add "$TARBALL" >"$TMP/plugin.log" 2>&1; then
    echo "  --- dsh plugin 输出 ---"
    tail -40 "$TMP/plugin.log" | sed 's/^/    /'
    die "dsh plugin add 失败"
  fi
  PROFILE_MANIFEST="$DSH_TMP_HOME/profiles/reltest/package.json"
  if [ ! -f "$PROFILE_MANIFEST" ]; then
    echo "  --- dsh plugin 输出 ---"
    tail -40 "$TMP/plugin.log" | sed 's/^/    /'
    echo "  --- $DSH_TMP_HOME 内容 ---"
    find "$DSH_TMP_HOME" -maxdepth 4 2>/dev/null | sed 's/^/    /' | head -20
    die "dsh plugin 退出码 0 但没生成 profile（$PROFILE_MANIFEST）"
  fi
  grep -q '"llm-capacity-scheduler-mcp"' "$PROFILE_MANIFEST" ||
    die "插件没进 profile 的 dependencies"
  ok "已安装到 profile（dependencies 已登记）"

  # bundle 注册独立断言：dsh plugin 在「依赖已存在」时会走 "Already up to date" 空操作，
  # 若首次 pnpm 阶段失败过，依赖写进去了、bundle 行却没写 → 装了但不加载。
  # 这里单独查一次，避免只靠 dump-config 的间接证据。
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const b = p.dsh?.profile?.bundles ?? [];
    if (!b.includes("llm-capacity-scheduler-mcp")) {
      console.error("bundles 现在的内容：" + JSON.stringify(b));
      process.exit(1);
    }
  ' "$PROFILE_MANIFEST" || die "插件没注册到 dsh.profile.bundles（装了但不加载）"
  ok "已注册到 dsh.profile.bundles"

  DSH_HOME="$DSH_TMP_HOME" dsh --profile reltest --dump-config >"$TMP/dump.yml" 2>/dev/null ||
    die "dsh --dump-config 失败"
  grep -q 'lcs-client' "$TMP/dump.yml" || die "插件 patch 行（lcs-client）没有进加载树"
  grep -q 'profiles/reltest/node_modules/.*/dist/plugin/index.js' "$TMP/dump.yml" ||
    die "插件入口路径没有解析到 profile 内的 node_modules"
  ok "插件 patch 行 lcs-client 已挂进 dsh 加载树"
  PLUGIN_CHECK="ok"
else
  step "[6/7] 插件角色（跳过）"
  warn "未加 --verify-plugin：只验证了安装包内容，没有真的装进 dsh profile"
fi

# ---------------------------------------------------------------- 8. 校验和 + manifest
step "[7/7] 校验和与 manifest"
TARBALL_SHA="$(sha256_of "$TARBALL")"
printf '%s  %s\n' "$TARBALL_SHA" "$(basename "$TARBALL")" >"$OUT_DIR/sha256sums.txt"
ok "sha256sums.txt"

MANIFEST="$OUT_DIR/manifest.json"
NAME="$NAME" VERSION="$VERSION" GIT_SHA="$GIT_SHA" GIT_TAG="$GIT_TAG" GIT_DIRTY="$GIT_DIRTY" \
  NODE_VERSION="$NODE_VERSION" TARBALL="$(basename "$TARBALL")" TARBALL_SIZE="$TARBALL_SIZE" \
  TARBALL_SHA="$TARBALL_SHA" ENTRIES="$ENTRIES" PLUGIN_CHECK="$PLUGIN_CHECK" \
  MANIFEST="$MANIFEST" node - <<'NODE'
const fs = require('fs');
const env = process.env;
const manifest = {
  name: env.NAME,
  version: env.VERSION,
  git: { sha: env.GIT_SHA, tag: env.GIT_TAG || null, dirty: env.GIT_DIRTY === "1" },
  builtAt: new Date().toISOString(),
  node: env.NODE_VERSION,
  artifact: {
    file: env.TARBALL,
    sizeBytes: Number(env.TARBALL_SIZE),
    entries: Number(env.ENTRIES),
    sha256: env.TARBALL_SHA,
  },
  roles: {
    server: 'bin/lcs-mcp.js → dist/cli.js（常驻调度服务 + Web + MCP stdio）',
    'dsh-plugin': 'dist/plugin/index.js（dsh.bundle.patch → cordis.patch.yml）',
  },
  verify: { tarballContents: 'ok', smoke: 'ok', pluginInstall: env.PLUGIN_CHECK },
};
fs.writeFileSync(env.MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
NODE
ok "manifest.json"

printf '\n\033[1;32m✔ 出包完成\033[0m\n'
printf '  产物目录  %s\n' "$OUT_DIR"
printf '    %s  (%s 字节)\n' "$(basename "$TARBALL")" "$TARBALL_SIZE"
printf '    sha256sums.txt\n    manifest.json\n'
printf '\n  安装 / 升级：\n'
printf '    npm install -g %s\n' "$TARBALL"
printf '    dsh plugin --profile web add %s\n' "$TARBALL"
printf '\n  上线到 npm（需要凭据，脚本不代劳）：\n'
printf '    cd mcp && npm publish %s\n' "$TARBALL"
