# _lib.sh —— tri-a-multifile 只读取证脚本共用件（被 01-multi-file.sh source，不是独立脚本）
#
# 安全契约（整个目录一致）：
#   * 只读：不修改 EU 上任何文件/服务/DB/容器状态，不重启容器，不发送 Telegram 消息，不外呼 API
#   * 不读取 secret 内容（不 cat token/key 文件；脚本内不出现 /srv/secrets 路径）
#   * 不打印用户消息正文（本包关心的是「几个文件」，不是文件内容）
#   * 所有外部命令带 timeout 兜底，单个子命令失败不中断整脚本
#
# 路径与时长均可被环境变量覆盖（现场路径不同时无需改脚本）：
#   PATCH_DIR   宿主侧插件源目录            默认 /srv/wagate/patches
#   PLUGIN_DIR  容器内插件目录              默认 /app/extensions/plugins
#   CONTAINER   容器名                      默认 wagate
#   DOCKER      docker 可执行文件           默认 docker
#   WAGATE_UNIT systemd 单元名              默认 wagate.service
#   TENANTS_DIR 租户 workspace 根           默认 /srv/tenants
#   EU_TG_LOG_DAYS journalctl 回看天数      默认 7
#   T_SHORT / T_LONG 单命令超时秒数         默认 15 / 30

PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
PLUGIN_DIR="${PLUGIN_DIR:-/app/extensions/plugins}"
CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
TENANTS_DIR="${TENANTS_DIR:-/srv/tenants}"
EU_TG_LOG_DAYS="${EU_TG_LOG_DAYS:-7}"
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-30}"

PASS_N=0
FAIL_N=0
WARN_N=0

pass() { PASS_N=$((PASS_N + 1)); printf '[PASS] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '[WARN] %s\n' "$*"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '[FAIL] %s\n' "$*"; }

hr() { printf '\n===== %s =====\n' "$*"; }

# safe <cmd...> —— 任何失败都降级为 [warn]，绝不中断整脚本（取证脚本不能因为一条命令挂掉）
safe() { "$@" 2>&1 || printf '[warn] 命令失败或无输出: %s\n' "$*"; }

# grep_count <file> <extended-regex> —— 先证明锚点存在，再谈后面的事
grep_count() {
  local f="$1" pat="$2" n
  if [ ! -f "$f" ]; then
    warn "grep_count: 文件不存在 $f"
    return
  fi
  n=$(grep -cE "$pat" "$f" 2>/dev/null || true)
  printf '  %-22s %s 次   (grep -cE %s %s)\n' "$pat" "${n:-0}" "'$pat'" "$f"
}

# grep_glob <dir> <extended-regex> [额外 grep 参数...] —— 全目录带行号与文件名打印命中
grep_glob() {
  local dir="$1" pat="$2"; shift 2
  if [ ! -d "$dir" ]; then
    printf '[warn] 目录不存在: %s\n' "$dir"
    return 1
  fi
  local out
  out=$(grep -rnE "$pat" "$dir" --include='*.ts' --include='*.js' "$@" 2>/dev/null)
  if [ -z "$out" ]; then
    printf '(无命中: %s 下没有匹配 /%s/ 的 .ts/.js)\n' "$dir" "$pat"
    return 1
  fi
  printf '%s\n' "$out"
  printf '(命中行数: %s)\n' "$(printf '%s\n' "$out" | wc -l)"
}

# md5_pair <名字> <宿主文件> <容器文件> —— 不一致 = 容器跑的不是你改的那一份，后面所有判读都会错位
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
