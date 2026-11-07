# _lib.sh —— tri-a2-multifile 补丁脚本共用件（被 fixes/*.sh source，不是独立脚本）
#
# 安全契约（整个 tri-a2-multifile/ 目录一致）：
#   * 默认 dry-run：不动现场任何文件；只有显式 --apply 才写，且写前必备份
#   * 不改 secret 内容（本脚本不出现 /srv/secrets 路径，不 cat 任何 token/key 文件）
#   * 不打印用户消息正文；不发送任何用户可见消息（除显式 TG_NOTIFY=1 的告警）
#   * 所有外部命令带 timeout 兜底
#   * 锚点不匹配 = 中止（fail-closed），绝不「猜着补」、绝不按行号硬切
#
# 路径与时长均可被环境变量覆盖（现场路径不同时无需改脚本）：
#   PATCH_DIR   宿主侧插件源目录            默认 /srv/wagate/patches
#   PLUGIN_DIR  容器内插件目录              默认 /app/extensions/plugins
#   CONTAINER   容器名                      默认 wagate
#   DOCKER      docker 可执行文件           默认 docker
#   WAGATE_UNIT systemd 单元名              默认 wagate.service
#   T_SHORT / T_LONG 单命令超时秒数         默认 15 / 30

PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
PLUGIN_DIR="${PLUGIN_DIR:-/app/extensions/plugins}"
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

# count_fixed <file> <fixed-string> —— 固定串出现次数（锚点门的基础原语）
count_fixed() {
  local f="$1" s="$2" n
  [ -f "$f" ] || { printf '0'; return; }
  n=$(grep -cF -e "$s" "$f" 2>/dev/null) || n=0
  printf '%s' "${n:-0}"
}

# count_re <file> <extended-regex>
count_re() {
  local f="$1" s="$2" n
  [ -f "$f" ] || { printf '0'; return; }
  n=$(grep -cE -e "$s" "$f" 2>/dev/null) || n=0
  printf '%s' "${n:-0}"
}

# sha_of <file> —— 用于 REPORT/日志留痕，证明「改的是哪一份」
sha_of() {
  [ -f "$1" ] && sha256sum "$1" 2>/dev/null | awk '{print $1}' || printf 'N/A'
}

# ts_now —— 批次戳（YYYYMMDD-HHMMSS，UTC）
ts_now() { date -u '+%Y%m%d-%H%M%S' 2>/dev/null || printf 'unknown'; }

# backup_of <abs-path> <ts> —— 备份文件名（与原文件同目录，便于 --rollback 找到）
backup_of() { printf '%s.bak-%s' "$1" "$2"; }

# require_file <path> <说明> —— 缺文件直接 fail（补丁脚本不能对着空气工作）
require_file() {
  local f="$1" what="$2"
  if [ ! -f "$f" ]; then
    fail "$what 不存在：$f（用 PATCH_DIR=... 覆盖后重跑）"
    return 1
  fi
  return 0
}

# ts_parse_gate <file.ts> [...] —— 真实 TS 解析门（node + typescript）
# 返回：0 = 全部可解析；1 = 有语法错误（调用方必须 fail-closed 中止，绝不写盘）
#       2 = 环境缺少 node/typescript（调用方降级为显式 WARN，绝不静默通过）
ts_parse_gate() {
  local pg="$SELF_DIR/parsegate.js" n
  [ -f "$pg" ] || pg="$SELF_DIR/../lib/parsegate.js"
  if [ ! -f "$pg" ]; then
    printf '[syntax] 找不到 parsegate.js\n'
    return 2
  fi
  if ! command -v node >/dev/null 2>&1; then
    printf '[syntax] 环境无 node\n'
    return 2
  fi
  n=$(node "$pg" "$@" 2>&1); local rc=$?
  printf '%s\n' "$n"
  return $rc
}

# gate_summary —— 唯一收尾出口，保证 PASS/FAIL/WARN 一定被打印
gate_summary() {
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  [ "$FAIL_N" -eq 0 ] && return 0 || return 1
}
