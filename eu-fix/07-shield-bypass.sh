#!/usr/bin/env bash
# 07-shield-bypass.sh — 完全屏蔽 asg-bypass-collect（写风暴源），单文件自包含（issue #17）
#
# 作用：
#   把 asg-bypass-collect 这个“写风暴源”**彻底屏蔽**：停掉并禁用 timer、停掉循环重启的
#   oneshot service、mask 两个 unit、清掉残留 analyze.py 进程、把代码目录改名隔离、
#   清除历史数据（out/ harness2-ext/ state/ logs/ library/ proposals/，删除前先记录各目录
#   体积），最后做验证：unit 已屏蔽且无活动实例、bypass 用户无残留进程、90 秒后 out/ 零新写入、
#   主系统健康与执行前一致。
#   **只屏蔽执行路径，绝不触碰主系统**（wagate / ASG 网关 / ai-gateway / m3 / billing / nginx
#   零改动，只在首尾各只读采集一次健康快照做前后对比）。
#
# 回退方法（脚本结尾也会再次打印）：
#   * 功能（unit）可恢复：
#       systemctl unmask asg-bypass-collect.timer asg-bypass-collect.service
#       systemctl enable --now asg-bypass-collect.timer
#       mv /opt/asg-harness2-bypass/bin.disabled /opt/asg-harness2-bypass/bin
#     （`disable` 只是移除 wants 软链，`enable --now` 会重建；unmask 会删除 /etc/systemd/system
#       下的 /dev/null 软链，恢复 unit 可见性。）
#   * 数据不可恢复：第 6 步删除的 out/ harness2-ext/ state/ logs/ library/ proposals/
#     **无法还原**（操作员已知情），这就是该步骤的目的——消除 7.8G+ 的写风暴产物与历史观测数据。
#   * 不在回退范围内的保留物：/opt/asg-harness2-bypass/README.md、CONCLUSION*.md（原地保留存档）。
#   * 日志：/var/log/eu-fix/07-shield-bypass.<ts>.log 记录每一步与删除前体积。
#
# 风险：
#   * **第 6 步 rm -rf 是不可逆的数据删除**（操作员明确追加指令，知情授权）。删除清单硬编码在
#     脚本常量 DATA_PURGE_DIRS 中，只允许 /opt/asg-harness2-bypass/ 下的直接子目录；任何一项
#     解析异常（为空、非绝对路径、越出 BYPASS_ROOT）都会直接 die，绝不递归到父目录。
#   * 误伤主系统的风险由三条兜底控制：(1) 全程只操作 asg-bypass-collect 的 unit 与
#     /opt/asg-harness2-bypass 下的路径；(2) pkill 限定 `-u bypass` 与 `-f analyze.py`；
#     (3) 首尾主系统健康快照必须一致，不一致则打印醒目告警（脚本自身不应造成差异）。
#   * mask 之后即使有人手动 `systemctl start` 也会被拒绝，属预期效果；恢复见上面的回退方法。
#   * 建议在业务低峰执行；脚本不重启任何主系统服务，也不执行 daemon-reload。
#
# 自检说明（开发机无法模拟 systemd）：
#   本脚本只用 `bash -n` 做语法校验；because 本机没有 systemd/现场，**无法真实演练**，所以 dry-run
#   分支只做三件事：(a) 打印 --apply 将执行的**全部命令**（按步骤编号，含 `systemctl stop/disable/
#   mask`、`pkill`、`mv`、`du -sh`、`rm -rf` 等原文与将要执行的判定命令）；(b) 重查两项“防新变化”
#   事实：bypass 用户是否有 crontab、其它 unit 是否引用 harness2；(c) 打印主系统健康快照的采集命令
#   与当前实际快照。dry-run 不产生任何系统改动（只读探测 + 打印），可以随时安全重跑。
#   现场执行前建议先跑一遍 dry-run（不需要 root），核对删除清单与 unit 名，再 `sudo ... --apply`。
#
# 执行方式：
#   ./07-shield-bypass.sh            # dry-run（默认，安全，只打印）
#   sudo ./07-shield-bypass.sh --apply
#
# 本文件是自包含单脚本：**不 source 同目录的 lib/common.sh**，可单独拷到任何机器执行。

set -eu

# ---------------------------------------------------------------------------------
# 常量（目标现场信息，来自 issue #17）
# ---------------------------------------------------------------------------------
BYPASS_ROOT="/opt/asg-harness2-bypass"
BYPASS_BIN="$BYPASS_ROOT/bin"
BYPASS_BIN_DISABLED="$BYPASS_ROOT/bin.disabled"
BYPASS_USER="bypass"
BYPASS_PROC_TOKEN="analyze.py"          # pkill/pgrep -f 匹配的进程命令行特征
BYPASS_SERVICE="asg-bypass-collect.service"
BYPASS_TIMER="asg-bypass-collect.timer"
UNIT_DIR="/etc/systemd/system"
BYPASS_UNITS=("$BYPASS_SERVICE" "$BYPASS_TIMER")

# 主系统健康核对（只读；脚本不得改变它们）
HEALTH_SERVICES="wagate gateway ai-gateway m3-service"
HEALTH_CONTAINER="wagate"

# 第 6 步：历史数据清除清单（只允许 BYPASS_ROOT 下的直接子目录；README.md / CONCLUSION*.md 不在其中）
DATA_PURGE_DIRS=(
  "out"
  "harness2-ext"
  "state"
  "logs"
  "library"
  "proposals"
)

OUT_DIR="$BYPASS_ROOT/out"
FLOW_IDLE_SECONDS=90                    # 等待多少秒后核对 out/ 零新写入
FLOW_WINDOW_MIN="$((FLOW_IDLE_SECONDS / 60))"   # = 1 分钟（find -mmin 窗口）
LOG_DIR="/var/log/eu-fix"
LOG_FILE="$LOG_DIR/07-shield-bypass.$(date +%Y%m%d%H%M%S).log"

# ---------------------------------------------------------------------------------
# 运行模式
# ---------------------------------------------------------------------------------
MODE="dry-run"
DEFAULT_LOG_COLLECTED=0

usage() {
  cat <<'EOF'
用法：07-shield-bypass.sh [--apply] [--help]

  （无参数）    dry-run：只打印将要执行的全部命令 + 重查项 + 健康采集命令，不做任何改动（默认）
  --apply      真正执行屏蔽动作（需要 root）；第 6 步 rm -rf 不可逆
  --help       显示本帮助
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply)   MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

is_apply() { [ "$MODE" = "apply" ]; }

# ---------------------------------------------------------------------------------
# 输出工具：dry-run 只打印，apply 才真执行
# ---------------------------------------------------------------------------------
log()  { printf '%s\n' "$*"; }
info() { printf '[info] %s\n' "$*"; }
warn() { printf '[warn] %s\n' "$*"; }
err()  { printf '[error] %s\n' "$*" >&2; }
step() { printf '\n===== %s =====\n' "$*"; }
die()  { err "$*"; exit 1; }

# 记录进执行日志（apply 时同时写日志文件）
record() {
  printf '%s\n' "$*"
  if is_apply && [ "$DEFAULT_LOG_COLLECTED" = "1" ]; then
    printf '%s\n' "$*" >> "$LOG_FILE"
  fi
}

# run <说明> <命令...>：dry-run 只打印；apply 执行并把退出码原样抛出（set -e 生效）
run() {
  local desc="$1"; shift
  if is_apply; then
    record "[exec] $desc"
    record "       \$ $*"
    "$@" 2>&1 | tee -a "$LOG_FILE"
    return "${PIPESTATUS[0]}"
  else
    printf '[dry-run] %s\n' "$desc"
    printf '          $ %s\n' "$*"
  fi
}

# run_allow_fail <说明> <命令...>：apply 时允许失败（例如 stop 一个已非活动的 unit）
run_allow_fail() {
  local desc="$1"; shift
  if is_apply; then
    record "[exec] $desc（允许失败）"
    record "       \$ $*"
    set +e
    "$@" >> "$LOG_FILE" 2>&1
    local rc=$?
    set -e
    record "       -> exit=$rc（非 0 视为预期，继续）"
    return 0
  else
    printf '[dry-run] %s（允许失败，继续）\n' "$desc"
    printf '          $ %s\n' "$*"
  fi
}

# show_cmd <命令...>：dry-run 打印“将执行的判定/采集命令”；apply 时执行并回显输出
show_cmd() {
  if is_apply; then
    printf '       \$ %s\n' "$*"
    "$@" 2>&1 | tee -a "$LOG_FILE" || true
  else
    printf '          $ %s\n' "$*"
  fi
}

print_mode_banner() {
  log '##### eu-fix 07：完全屏蔽 asg-bypass-collect（写风暴源） #####'
  if is_apply; then
    log '模式：APPLY（真实执行；第 6 步数据删除不可逆）'
  else
    log '模式：DRY-RUN（默认；只打印将执行的全部命令 + 重查项 + 健康采集命令，不做任何改动）'
  fi
  log "目标：$BYPASS_SERVICE / $BYPASS_TIMER / $BYPASS_USER 用户的 $BYPASS_PROC_TOKEN / $BYPASS_BIN"
  log '边界：只屏蔽 asg-bypass-collect；主系统（wagate/ASG 网关/ai-gateway/m3/billing/nginx）零改动。'
  log "日志：$LOG_FILE（apply 时创建）"
}

# ---------------------------------------------------------------------------------
# 主系统健康快照（只读）
# ---------------------------------------------------------------------------------
health_snapshot() {
  local svc out=""
  for svc in $HEALTH_SERVICES; do
    if command -v systemctl >/dev/null 2>&1; then
      out="$out$svc=$(systemctl is-active "$svc" 2>/dev/null || true)"$'\n'
    else
      out="$out$svc=unknown(no systemctl)"$'\n'
    fi
  done
  if command -v docker >/dev/null 2>&1; then
    out="$out$HEALTH_CONTAINER.Running=$(docker inspect "$HEALTH_CONTAINER" --format '{{.State.Running}}' 2>/dev/null || echo 'unknown')"$'\n'
  else
    out="$out$HEALTH_CONTAINER.Running=unknown(no docker)"$'\n'
  fi
  printf '%s' "$out"
}

print_health_commands() {
  printf '          $ systemctl is-active %s\n' "$HEALTH_SERVICES"
  printf '          $ docker inspect %s --format {{.State.Running}}\n' "$HEALTH_CONTAINER"
}

# ---------------------------------------------------------------------------------
# 重查项（dry-run 必跑；apply 也跑，作为执行前的现场核对）
# ---------------------------------------------------------------------------------
recheck_crontab() {
  if command -v crontab >/dev/null 2>&1; then
    printf '          $ crontab -u %s -l\n' "$BYPASS_USER"
    if is_apply; then
      crontab -u "$BYPASS_USER" -l 2>&1 | tee -a "$LOG_FILE" || true
    else
      local out
      out="$(crontab -u "$BYPASS_USER" -l 2>&1 || true)"
      case "$out" in
        *"no crontab"*|*"No such user"*|*"must be privileged"*|*"Operation not permitted"*|*"permission denied"*)
          printf '          重查结果：无 bypass 用户 crontab（或当前身份读不到：%s）\n' "$out" ;;
        *)
          printf '          重查结果（原文）：\n%s\n' "$out" ;;
      esac
    fi
  else
    printf '          （未找到 crontab 命令，跳过该项重查）\n'
  fi
}

recheck_unit_refs() {
  printf '          $ grep -rl "harness2\\|asg-bypass" /etc/systemd/system /etc/cron.d /etc/crontab 2>/dev/null\n'
  local hits=""
  if command -v grep >/dev/null 2>&1; then
    hits="$(grep -rl -e 'harness2' -e 'asg-bypass' /etc/systemd/system /etc/cron.d /etc/crontab 2>/dev/null || true)"
  fi
  if [ -n "$hits" ]; then
    printf '          重查结果：仍被引用的文件如下（需人工确认是否为本脚本目标之外的引用）：\n'
    printf '%s\n' "$hits" | sed 's/^/            /'
  else
    printf '          重查结果：除本脚本两个 unit 外，未发现其它 unit/cron 引用 harness2/asg-bypass。\n'
  fi
}

# 删除清单安全检查 + 体积记录（dry-run 与 apply 共用）
print_purge_plan() {
  local d path
  for d in "${DATA_PURGE_DIRS[@]}"; do
    case "$d" in
      ""|/*|*..*) die "数据清除清单含非法项（'$d'）：只允许 $BYPASS_ROOT 下的直接子目录名。" ;;
    esac
    path="$BYPASS_ROOT/$d"
    case "$path" in
      "$BYPASS_ROOT"/*) : ;;
      *) die "数据清除路径越界：$path" ;;
    esac
    if [ -e "$path" ]; then
      printf '          %s\n' "$(du -sh "$path" 2>/dev/null || echo "?  $path")"
    else
      printf '          （不存在，跳过）%s\n' "$path"
    fi
  done
  printf '          保留不动：%s/README.md、%s/CONCLUSION*.md、%s（隔离态）\n' \
    "$BYPASS_ROOT" "$BYPASS_ROOT" "$BYPASS_BIN_DISABLED"
}

# ---------------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------------
print_mode_banner

if is_apply && [ "$(id -u)" != "0" ]; then
  die "apply 模式需要 root 权限（EU 服务器上以 root 执行）。"
fi

# ---- 执行前：主系统健康快照（只读） ---------------------------------------------
step "第 0 步：主系统健康快照（执行前，只读）"
print_health_commands
HEALTH_BEFORE="$(health_snapshot)"
printf '%s\n' "$HEALTH_BEFORE" | sed 's/^/    /'

# ---- dry-run 专项：重查 crontab / 其它 unit 引用 ---------------------------------
step "dry-run 重查：bypass crontab 与其它 unit 引用（防新变化，只读）"
recheck_crontab
recheck_unit_refs

# apply 时创建日志文件
if is_apply; then
  mkdir -p "$LOG_DIR"
  : > "$LOG_FILE"
  DEFAULT_LOG_COLLECTED=1
  record "==== eu-fix 07 shield-bypass apply $(date -Is) ===="
  record "执行前主系统健康快照："
  printf '%s' "$HEALTH_BEFORE" | sed 's/^/    /' >> "$LOG_FILE"
  record "重查（crontab / unit 引用）："
  { recheck_crontab; recheck_unit_refs; } >> "$LOG_FILE" 2>&1 || true
  info "本次日志：$LOG_FILE"
fi

# ---- 第 1 步：停用并禁用 timer ---------------------------------------------------
step "第 1 步：停止并禁用 $BYPASS_TIMER（切断 10 分钟一次的拉起源）"
run "停止 timer" systemctl stop "$BYPASS_TIMER"
run "禁用 timer（移除 wants 软链，可 enable 恢复）" systemctl disable "$BYPASS_TIMER"

# ---- 第 2 步：停止 service（忽略非活动报错） ------------------------------------
step "第 2 步：停止 $BYPASS_SERVICE（当前非活动时报错忽略）"
run_allow_fail "停止 service（已非活动则报错忽略）" systemctl stop "$BYPASS_SERVICE"

# ---- 第 3 步：mask 两个 unit ----------------------------------------------------
step "第 3 步：mask 两个 unit（防任何手动/依赖拉起）"
run "mask service 与 timer" systemctl mask "${BYPASS_UNITS[@]}"

# ---- 第 4 步：清理残留 analyze.py 进程 ------------------------------------------
step "第 4 步：清理 $BYPASS_USER 用户的残留 $BYPASS_PROC_TOKEN 进程，并断言为 0"
if is_apply; then
  # 先打印将要清理的进程（便于复盘），再发信号
  pgrep -u "$BYPASS_USER" -af "$BYPASS_PROC_TOKEN" 2>&1 | tee -a "$LOG_FILE" || info "（当前无匹配进程）"
fi
run_allow_fail "向残留进程发送 SIGTERM" pkill -u "$BYPASS_USER" -f "$BYPASS_PROC_TOKEN"
if is_apply; then
  sleep 3
fi
run "断言：残留进程数为 0（非 0 立即退出）" \
  bash -c "n=\$(pgrep -u '$BYPASS_USER' -f '$BYPASS_PROC_TOKEN' | wc -l); echo \"pgrep -u $BYPASS_USER -f $BYPASS_PROC_TOKEN | wc -l => \$n\"; [ \"\$n\" -eq 0 ]"
printf '          $ pgrep -u %s -f %s | wc -l   # 期望 0\n' "$BYPASS_USER" "$BYPASS_PROC_TOKEN"

# ---- 第 5 步：代码目录隔离 ------------------------------------------------------
step "第 5 步：代码隔离 $BYPASS_BIN -> $BYPASS_BIN_DISABLED（ConditionPathExists 从此不满足）"
printf '          $ test -d %s && mv %s %s\n' "$BYPASS_BIN" "$BYPASS_BIN" "$BYPASS_BIN_DISABLED"
if is_apply; then
  if [ -d "$BYPASS_BIN" ]; then
    run "改名隔离代码目录" mv "$BYPASS_BIN" "$BYPASS_BIN_DISABLED"
  elif [ -d "$BYPASS_BIN_DISABLED" ]; then
    info "已经是隔离态，跳过：$BYPASS_BIN_DISABLED 已存在且 $BYPASS_BIN 不存在。"
  else
    warn "两个目录都不存在（$BYPASS_BIN / $BYPASS_BIN_DISABLED），跳过改名；请人工确认现场。"
  fi
else
  printf '          （apply 时二选一：bin 存在则 mv；已是 bin.disabled 则跳过并提示）\n'
fi

# ---- 第 6 步：历史数据清除（操作员追加指令，不可逆） -----------------------------
step "第 6 步：清除历史数据（不可逆；删除前记录各目录体积）"
info "删除清单（保留 README.md 与 CONCLUSION*.md）："
print_purge_plan
if is_apply; then
  {
    printf '---- 删除前体积记录 %s ----\n' "$(date -Is)"
    for d in "${DATA_PURGE_DIRS[@]}"; do
      p="$BYPASS_ROOT/$d"
      [ -e "$p" ] && du -sh "$p" 2>/dev/null || true
    done
    printf '---- 保留（未删除）：README.md / CONCLUSION*.md / bin.disabled ----\n'
  } | tee -a "$LOG_FILE"
  for d in "${DATA_PURGE_DIRS[@]}"; do
    p="$BYPASS_ROOT/$d"
    if [ -e "$p" ]; then
      run "删除 $p" rm -rf -- "$p"
    else
      info "不存在，跳过：$p"
    fi
  done
  info "数据清除完成：删除内容不可恢复（操作员已知情）。"
else
  printf '          $ rm -rf'
  for d in "${DATA_PURGE_DIRS[@]}"; do printf ' %s/%s' "$BYPASS_ROOT" "$d"; done
  printf '\n'
  printf '          （保留 %s/README.md、%s/CONCLUSION*.md；%s 保持隔离态）\n' \
    "$BYPASS_ROOT" "$BYPASS_ROOT" "$BYPASS_BIN_DISABLED"
fi

# ---- 第 7 步：验证 --------------------------------------------------------------
step "第 7 步：验证（unit 屏蔽/无活动实例、进程为 0、90 秒后 out/ 零新写入、主系统健康前后一致）"

info "(a) unit 状态："
for u in "${BYPASS_UNITS[@]}"; do
  show_cmd systemctl is-enabled "$u"
  show_cmd systemctl is-active "$u"
done
printf '          期望：is-enabled 输出 masked；is-active 输出 inactive。\n'

info "(b) $BYPASS_USER 用户的 $BYPASS_PROC_TOKEN 残留进程："
show_cmd bash -c "pgrep -u $BYPASS_USER -f $BYPASS_PROC_TOKEN | wc -l"
printf '          期望：0。\n'

if is_apply; then
  info "$(printf '(c) 零新写入：等待 %s 秒后统计 %s 下 1 分钟内的新文件数' "$FLOW_IDLE_SECONDS" "$OUT_DIR")"
  sleep "$FLOW_IDLE_SECONDS"
  NEW_FILES="$(find "$OUT_DIR" -mmin "-$FLOW_WINDOW_MIN" -type f 2>/dev/null | wc -l || true)"
  record "          $ find $OUT_DIR -mmin -$FLOW_WINDOW_MIN -type f | wc -l"
  record "          -> 新文件数 = $NEW_FILES"
  if [ "$NEW_FILES" -eq 0 ]; then
    info "零新写入：未见新的写盘（写风暴已停止）。"
  else
    warn "仍有 $NEW_FILES 个新文件写入 $OUT_DIR —— 可能有其它写者，请人工排查（脚本未发现）。"
  fi
else
  info "$(printf '(c) 零新写入：apply 时将执行（dry-run 不等待）：')"
  printf '          $ sleep %s\n' "$FLOW_IDLE_SECONDS"
  printf '          $ find %s -mmin -%s -type f | wc -l   # 期望 0\n' "$OUT_DIR" "$FLOW_WINDOW_MIN"
fi

info "(d) 主系统健康对比（执行前后必须一致）："
print_health_commands
HEALTH_AFTER="$(health_snapshot)"
printf '    执行前：\n'
printf '%s\n' "$HEALTH_BEFORE" | sed 's/^/      /'
printf '    执行后：\n'
printf '%s\n' "$HEALTH_AFTER" | sed 's/^/      /'
if [ "$HEALTH_BEFORE" = "$HEALTH_AFTER" ]; then
  info "主系统健康前后一致：脚本只屏蔽了 bypass，未影响 wagate / ASG 网关 / ai-gateway / m3。"
else
  warn "======================================================================"
  warn "  醒目告警：主系统健康快照前后不一致！脚本本身不应造成差异。"
  warn "  请立即人工核对 wagate / gateway / ai-gateway / m3-service 与 docker wagate。"
  warn "======================================================================"
fi

# 命令核对：确认关键命令集合（apply/dry-run 都打印，便于审查）
step "本次动作的命令清单（核对用）"
if is_apply; then
  record "(apply 已执行，完整命令与输出见日志：$LOG_FILE)"
fi
  printf '  systemctl stop/disable %s\n' "$BYPASS_TIMER"
printf '  systemctl stop %s（忽略非活动报错）\n' "$BYPASS_SERVICE"
printf '  systemctl mask %s %s\n' "${BYPASS_UNITS[0]}" "${BYPASS_UNITS[1]}"
printf '  pkill -u %s -f %s ; 断言 pgrep 计数为 0\n' "$BYPASS_USER" "$BYPASS_PROC_TOKEN"
printf '  mv %s %s\n' "$BYPASS_BIN" "$BYPASS_BIN_DISABLED"
for d in "${DATA_PURGE_DIRS[@]}"; do printf '  du -sh %s/%s ; rm -rf %s/%s\n' "$BYPASS_ROOT" "$d" "$BYPASS_ROOT" "$d"; done
printf '  systemctl is-enabled/is-active %s %s\n' "${BYPASS_UNITS[0]}" "${BYPASS_UNITS[1]}"
printf '  pgrep -u %s -f %s | wc -l\n' "$BYPASS_USER" "$BYPASS_PROC_TOKEN"
printf '  sleep %s ; find %s -mmin -%s -type f | wc -l\n' "$FLOW_IDLE_SECONDS" "$OUT_DIR" "$FLOW_WINDOW_MIN"
printf '  systemctl is-active %s ; docker inspect %s --format {{.State.Running}}\n' "$HEALTH_SERVICES" "$HEALTH_CONTAINER"
printf '  （apply 前的防新变化重查）crontab -u %s -l ; grep -rl "harness2\\|asg-bypass" /etc/systemd/system /etc/cron.d /etc/crontab\n' "$BYPASS_USER"

step "回退方法（请连同输出一起存档）"
log "  1) 恢复功能（unit 与代码目录）："
log "     systemctl unmask $BYPASS_TIMER $BYPASS_SERVICE"
log "     systemctl enable --now $BYPASS_TIMER"
log "     mv $BYPASS_BIN_DISABLED $BYPASS_BIN"
log "  2) 数据不可恢复：第 6 步删除的 ${DATA_PURGE_DIRS[*]} 无法还原（操作员已知情）。"
log "  3) 未删除的存档：$BYPASS_ROOT/README.md 与 $BYPASS_ROOT/CONCLUSION*.md 仍在原地。"

step "完成"
if is_apply; then
  info "屏蔽已执行；日志：$LOG_FILE（请按上面第 7 步结果确认四项验证均通过）。"
else
  info "以上为 dry-run 计划，未做任何改动。确认无误后执行：sudo $0 --apply"
fi
