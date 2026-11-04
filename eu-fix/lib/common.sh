#!/usr/bin/env bash
# eu-fix/lib/common.sh — 共享工具库（不单独执行，由 01~06 脚本 source 引入）
#
# 作用：统一处理 --apply/--help 解析、dry-run/apply 执行包装、时间戳、日志与断言。
# 回退方法：本文件是纯函数库，不产生任何系统改动；删除或修改它只影响 01~06 脚本的运行方式。
# 风险：无系统风险。注意本文件被 source，不要在这里写“立即执行”的顶层副作用。

# ---- 目标机常量（单一事实来源，便于在 EU 服务器上核对）---------------------------
EU_HOST_EXPECTED="5.189.129.216"          # 现场信息中的 EU 服务器 IP（仅作展示/核对）
WAGATE_CONTAINER="wagate"
AIGW_DB="/opt/ai-gateway/data/core.db"
AIGW_ROOT_EXTRA=""                        # 预留：如需 sudo -u 运行可在此加前缀
DOCPACK="/srv/wagate/patches/doc-pack.ts"
WAGATE_HOST_VIEW="/srv/wagate/patches"    # 宿主侧目录（容器内为 /app/... 挂载）
BILLING_TIMER="claw-billing-sync.timer"
NGINX_BAK="/etc/nginx/sites-enabled/privacy-policy.bak_qr"
NGINX_AVAILABLE_DIR="/etc/nginx/sites-available"

# 01 孤儿沙箱
SBX_PROC_PATTERN="bash /home/qt/claw-exp/scripts/v2_agent.sh sbx-"
SBX_WS_ROOT="/home/qt/claw-exp/ws"

# 02 A01 增量备份
A01_SRC_ROOT="/srv/wagate/patches"
A01_LIVE_BASENAMES=".ts"                  # 只收 live .ts
A01_DENY_GLOB="*.bak.*"                   # 排除备份文件
A01_PROTECTED=(
  "/srv/wagate/HANDOFF.md"
  "/etc/wagate.env"
  "/etc/systemd/system/wagate.service"
  "/etc/nginx/sites-enabled/workspace-static"
  "/usr/local/bin/session-rotate.sh"
  "/etc/cron.d/session-rotate"
)

# 03 ai-gateway
AIGW_TOKEN="sk-user03-m3-e34bfe06a71ead8e"
AIGW_ADD_MODEL="Qwen3.8-27B"
AIGW_EXPECT_MODELS="m3,zai-org/GLM-5.3,zai-org/GLM-5.3-Flash,gemma4:12b"   # 现状（仅作展示）

# 04 doc-pack
DOCPACK_TAG="ANCHOR-DIAG"
DOCPACK_CONTAINER_FILE="/app/extensions/plugins/doc-pack.ts"

# 05 billing-sync
BILLING_INTERVAL="5min"

# 06 nginx
NGINX_SERVICE="nginx"

# ---------------------------------------------------------------------------------
# 运行模式
# ---------------------------------------------------------------------------------
MODE="dry-run"

usage_common() {
  cat <<'EOF'
用法：
  <script> [--apply] [--help]

  （无参数）    dry-run：只打印将要执行的动作，不做任何系统改动（默认，安全）
  --apply      真正执行修复动作（部分步骤仍需在交互式终端输入 YES 二次确认）
  --help       显示帮助
EOF
}

parse_args() {
  local script_name="$1"; shift
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --apply) MODE="apply" ;;
      --dry-run) MODE="dry-run" ;;
      -h|--help) usage_common; exit 0 ;;
      *) echo "未知参数：$1" >&2; usage_common >&2; exit 2 ;;
    esac
    shift
  done
  : "$script_name"
}

is_apply() { [ "$MODE" = "apply" ]; }

ts() { date +%Y%m%d%H%M%S; }

log()  { printf '%s\n' "$*"; }
info() { printf '[info] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*"; }
err()  { printf '[error] %s\n' "$*" >&2; }

# 第 N 步标题
step() { printf '\n===== %s =====\n' "$*"; }

# run <人类可读说明> <命令...>
# dry-run：只打印；apply：执行并把退出码原样抛给调用者（set -e 生效）
run() {
  local desc="$1"; shift
  if is_apply; then
    printf '[exec] %s\n' "$desc"
    printf '       $ %s\n' "$*"
    "$@"
  else
    printf '[dry-run] %s\n' "$desc"
    printf '          $ %s\n' "$*"
  fi
}

# die <消息>：立即终止，绝不继续执行后续破坏性步骤
die() { err "$*"; exit 1; }

# apply_confirm <问题>：apply 模式下要求交互式二次确认；dry-run 模式下自动通过
apply_confirm() {
  if ! is_apply; then return 0; fi
  printf '%s\n请输入 YES 继续（其他任意输入将中止且不做改动）：' "$*"
  local answer=""
  if [ -t 0 ]; then
    read -r answer || answer=""
  elif [ -r /dev/tty ]; then
    read -r answer < /dev/tty || answer=""
  else
    answer=""
  fi
  [ "$answer" = "YES" ] || die "未确认，已中止（未执行任何修复动作）。"
}

# apply 模式前置检查：必须以 root 运行
require_root_if_apply() {
  if is_apply && [ "$(id -u)" != "0" ]; then
    die "apply 模式需要 root 权限（EU 服务器上以 root 执行）。"
  fi
}

# 备份文件命名后缀：.bak.<tag>.<ts>
bak_suffix() { printf '.bak.%s.%s' "$1" "$(ts)"; }

print_mode_banner() {
  local what="$1"
  printf '##### eu-fix: %s #####\n' "$what"
  if is_apply; then
    printf '模式：APPLY（真实执行）\n'
  else
    printf '模式：DRY-RUN（默认，只打印不执行；加 --apply 才真正执行）\n'
  fi
  printf '提示：本脚本只改 %s 相关的最小范围，不触碰 asg-harness2-bypass / m3 链路 / gstack.v6。\n' "$what"
}
