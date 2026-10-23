#!/usr/bin/env bash
# 把 LCS 常驻服务装成 systemd 用户级服务（开机自启、7×24、崩溃自动拉回）。
#
# 为什么是“用户级 + linger”而不是系统级：
#   - 服务要写 ~/.lcs（状态/会话/产物），跑 root 会把属主搞乱；
#   - 执行器是 dsh，要用当前用户的 node / dsh / 凭据；
#   - `loginctl enable-linger` 之后用户实例开机即起，不需要登录，
#     效果等同系统级服务，但不需要 sudo 改 /etc。
#
# 用法：
#   bash scripts/install-service.sh            # 安装 / 更新并启动
#   bash scripts/install-service.sh --dry-run  # 只打印将要写入的 unit，不动手
#   bash scripts/install-service.sh --check    # 看当前状态
#   bash scripts/install-service.sh --uninstall
#
# 可用环境变量覆盖：LCS_NODE / LCS_BIN / LCS_CONFIG / LCS_UNIT_NAME
set -euo pipefail

UNIT_NAME="${LCS_UNIT_NAME:-lcs-mcp.service}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT_NAME"
CONFIG="${LCS_CONFIG:-$HOME/.lcs/config.json}"

step() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---- 探测可执行文件 ------------------------------------------------------
find_node() {
  if [ -n "${LCS_NODE:-}" ]; then printf '%s' "$LCS_NODE"; return; fi
  command -v node || die "找不到 node（用 LCS_NODE=/path/to/node 指定）"
}
find_bin() {
  if [ -n "${LCS_BIN:-}" ]; then printf '%s' "$LCS_BIN"; return; fi
  local p
  p="$(command -v lcs-mcp || true)"
  [ -n "$p" ] || die "找不到 lcs-mcp（先 npm i -g llm-capacity-scheduler-mcp，或用 LCS_BIN 指定）"
  readlink -f "$p" 2>/dev/null || printf '%s' "$p"
}

have_user_systemd() { systemctl --user show-environment >/dev/null 2>&1; }

render_unit() {
  local node="$1" bin="$2" tz="${3:-Asia/Shanghai}" lang="$4"
  local path_main path_extra
  path_main="$(dirname "$node")"
  path_extra="$(dirname "$bin")"
  cat <<EOF
[Unit]
Description=LLM Capacity Scheduler (LCS) — 7x24 常驻调度服务
Documentation=https://github.com/EvilJoker/llm-capacity-scheduler
After=network-online.target
Wants=network-online.target
# 7x24：禁用启动频率限制，任何崩溃都由 Restart=always 无限拉回
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$HOME/.lcs
ExecStart=$node $bin serve --config $CONFIG

Restart=always
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
# 只杀本 cgroup：停服务时连正在跑的 dsh 执行器一起收掉，不留孤儿
KillMode=control-group
OOMPolicy=continue
SuccessExitStatus=0 143

Environment=HOME=$HOME
Environment=TMPDIR=/tmp
Environment=TZ=$tz
Environment=LANG=$lang
# dsh 执行器靠 PATH 解析；时区决定 policy 里的工作时段窗口
Environment=PATH=$path_main:$path_extra:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin

StandardOutput=journal
StandardError=journal
SyslogIdentifier=lcs-mcp

[Install]
WantedBy=default.target
EOF
}

status_report() {
  local node bin tz lang
  node="$(find_node)"; bin="$(find_bin)"; tz="$(timezone)"; lang="$(language)"
  echo "unit      : $UNIT_PATH"
  echo "node      : $node ($("$node" -v 2>/dev/null || echo '?'))"
  echo "lcs bin   : $bin"
  echo "config    : $CONFIG"
  echo "linger    : $(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo '?')"
  if have_user_systemd; then
    echo "enabled   : $(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || echo 'no')"
    echo "active    : $(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || echo 'no')"
    echo "main pid  : $(systemctl --user show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo '?')"
  else
    echo "enabled   : ? (systemctl --user 不可用)"
  fi
}

timezone() {
  local t
  t="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  [ -n "$t" ] && printf '%s' "$t" || printf 'Asia/Shanghai'
}

language() {
  local l
  l="$(locale 2>/dev/null | sed -n 's/^LANG=//p' | head -1 || true)"
  [ -n "$l" ] && printf '%s' "$l" || printf 'zh_CN.UTF-8'
}

wait_healthy() {
  local url="http://127.0.0.1:7788/api/health" i
  for i in $(seq 1 20); do
    if curl -fsS --max-time 1 "$url" >/dev/null 2>&1; then
      printf '  ✓ %s\n' "$(curl -fsS "$url")"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# ---- 子命令 --------------------------------------------------------------
MODE="${1:-install}"
case "$MODE" in
  --dry-run)
    step "dry-run：不会写文件、不会重启服务"
    render_unit "$(find_node)" "$(find_bin)" "$(timezone)" "$(language)"
    exit 0
    ;;
  --check)
    status_report
    exit 0
    ;;
  --uninstall)
    step "停用并删除 $UNIT_NAME"
    systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
    rm -f "$UNIT_PATH"
    systemctl --user daemon-reload 2>/dev/null || true
    echo "已卸载。linger 保留（其它用户级服务可能依赖）。要关：loginctl disable-linger $(id -un)"
    exit 0
    ;;
  install)
    ;;
  *)
    die "未知参数：$MODE（支持 --dry-run / --check / --uninstall）"
    ;;
esac

# ---- 安装 ----------------------------------------------------------------
[ -f "$CONFIG" ] || die "配置文件不存在：$CONFIG（先跑 lcs-mcp init）"
have_user_systemd || die "systemctl --user 不可用（需要 systemd 用户实例 + DBUS_SESSION_BUS_ADDRESS）"

NODE="$(find_node)"
BIN="$(find_bin)"
TZ_VAL="$(timezone)"
LANG_VAL="$(language)"

step "1/5 渲染 unit"
mkdir -p "$UNIT_DIR"
TMP_UNIT="$(mktemp)"
render_unit "$NODE" "$BIN" "$TZ_VAL" "$LANG_VAL" >"$TMP_UNIT"
if [ -f "$UNIT_PATH" ] && cmp -s "$TMP_UNIT" "$UNIT_PATH"; then
  echo "  = 内容未变，跳过写入"
else
  install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
  echo "  ✓ 已写入 $UNIT_PATH"
fi
rm -f "$TMP_UNIT"

step "2/5 开启 linger（开机无需登录即常驻）"
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" = "yes" ]; then
  echo "  = 已开启"
else
  loginctl enable-linger "$(id -un)" 2>/dev/null && echo "  ✓ 已开启" \
    || echo "  ! 开启失败（可能需要 sudo）：sudo loginctl enable-linger $(id -un)"
fi

step "3/5 重新加载并启用"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null
systemctl --user restart "$UNIT_NAME"

step "4/5 等健康检查"
if wait_healthy; then :; else
  echo "  ✗ 健康检查未通过，最近日志："
  journalctl "_PID=$(systemctl --user show -p MainPID --value "$UNIT_NAME")" -n 20 --no-pager 2>/dev/null || true
  die "启动失败（排查：lcs-mcp doctor）"
fi

step "5/5 自检"
if command -v lcs-mcp >/dev/null 2>&1; then
  lcs-mcp doctor 2>&1 | sed 's/^/  /' || true
fi

cat <<EOF

完成。服务已常驻，重启机器也会自动起来。

  systemctl --user status $UNIT_NAME
  systemctl --user restart $UNIT_NAME
  systemctl --user stop $UNIT_NAME
  journalctl _PID=\$(systemctl --user show -p MainPID --value $UNIT_NAME) -f   # 跟日志
  tail -f ~/.lcs/logs/lcs.log                                              # 引擎自己的日志

注意：服务由 systemd 托管时**不要**再用 \`lcs-mcp stop\` 停它（会被 Restart=always 拉回），
用 \`systemctl --user stop $UNIT_NAME\`。
EOF
