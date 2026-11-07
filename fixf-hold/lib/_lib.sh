# _lib.sh —— fixf-hold 只读取证/回归脚本共用件（被 regr/regrF.sh source，不是独立脚本）
#
# 安全契约（与 tri-a/tri-b 同族）：
#   * 只读：不修改 EU 上任何源码/服务/容器状态，不重启容器，不发送 Telegram/WhatsApp 真实消息
#   * 不读取 secret 内容（不 cat token/key 文件；脚本内不出现 /srv/secrets 路径）
#   * 所有外部命令带 timeout 兜底，单个子命令失败不中断整脚本
#
# 路径与时长均可被环境变量覆盖（现场路径不同时无需改脚本）：
#   PATCH_DIR   宿主侧 bot.ts 所在目录       默认 /srv/wagate/patches
#   CONTAINER   容器名                       默认 wagate
#   DOCKER      docker 可执行文件            默认 docker
#   WAGATE_UNIT systemd 单元名               默认 wagate.service
#   T_SHORT / T_LONG 单命令超时秒数          默认 15 / 30

PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-30}"

PASS_N=0
FAIL_N=0
WARN_N=0

pass() { PASS_N=$((PASS_N + 1)); printf '[PASS] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '[WARN] %s\n' "$*"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '[FAIL] %s\n' "$*"; }

hr() { printf '\n===== %s =====\n' "$*"; }

# safe <cmd...> —— 任何失败都降级为 [warn]，绝不中断整脚本
safe() { "$@" 2>&1 || printf '[warn] 命令失败或无输出: %s\n' "$*"; }

# grep_count <file> <extended-regex> —— 先证明锚点存在，再谈后面的事
grep_count() {
  local f="$1" pat="$2" n
  if [ ! -f "$f" ]; then
    warn "grep_count: 文件不存在 $f"
    return
  fi
  n=$(grep -cE "$pat" "$f" 2>/dev/null || true)
  printf '  %-30s %s 次   (grep -cE %s %s)\n' "$pat" "${n:-0}" "'$pat'" "$f"
}

# md5_pair <名字> <宿主文件> <容器文件> —— 不一致 = 容器跑的不是你审的那一份
md5_pair() {
  local name="$1" host="$2" ct="$3" h c
  if [ ! -f "$host" ]; then
    warn "md5 $name: 宿主文件不存在 $host"
    return
  fi
  h=$(md5sum "$host" 2>/dev/null | awk '{print $1}')
  c=$(timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" md5sum "$ct" 2>/dev/null | awk '{print $1}')
  if [ -z "$c" ]; then
    warn "md5 $name: 容器内读不到 $ct（docker exec 失败或路径不同）"
  elif [ "$h" = "$c" ]; then
    pass "md5 $name: 宿主=容器 ($h)"
  else
    fail "md5 $name: 宿主=$h 容器=$c —— 容器加载的不是宿主这份，先解决这个再谈根因"
  fi
}

# summary —— 统一页脚与退出码（0 全绿 / 1 有 FAIL）
summary() {
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  exit $([ "$FAIL_N" -eq 0 ] && echo 0 || echo 1)
}
