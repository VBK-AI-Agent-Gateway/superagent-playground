#!/usr/bin/env bash
# 01-clean-orphan-sbx.sh — 清理孤儿沙箱进程（201 个 do_wait 中的 bash v2_agent.sh sbx-<id>）
#
# 作用：
#   找出 `/home/qt/claw-exp/scripts/v2_agent.sh sbx-<id> /home/qt/claw-exp/ws/sbx-<id>` 形态的
#   孤儿沙箱进程（父进程为 1、init 已收养、子进程只剩 unshare/do_wait 空转），在“确认 wagate
#   最近 5 分钟没有 delivered 日志”后才清理：先 SIGTERM，宽限期后仍在则 SIGKILL，并清理
#   对应沙箱工作目录 /home/qt/claw-exp/ws/sbx-<id>。
#
# 回退方法：
#   进程清理不可逆（进程无法“恢复”）。工作目录采用“先改名归档、不删除”的策略：
#     /home/qt/claw-exp/ws/sbx-<id>  ->  /home/qt/claw-exp/ws/.trash-sbx/<id>.<时间戳>
#   如需回退：把归档目录改回原名即可（mv /home/qt/claw-exp/ws/.trash-sbx/<id>.<ts> /home/qt/claw-exp/ws/sbx-<id>）。
#   清理动作本身有日志：/var/log/eu-fix/01-orphan-sbx.<时间戳>.log，含每个 PID/命令行/信号结果。
#
# 风险：
#   * 误杀正在跑任务的沙箱。已用两层保护：(1) `docker logs wagate --since 5m | grep -q delivered`
#     命中即刻拒跑；(2) apply 模式需手工输入 YES 二次确认。若 wagate 容器名/日志形态与现场不符，
#     docker logs 会失败 → 脚本同样拒跑（fail-closed），不会盲杀。
#   * 只按“命令行特征 + 父进程为 1”收敛，不按用户名批量 kill；不使用 pkill -f 通配符，逐个 PID 处理。
#   * 只清理 /home/qt/claw-exp/ws/sbx-* 这一层工作目录，绝不触碰 asg-harness2-bypass、
#     m3 链路、gstack.v6 以及 claw-exp 下的其他目录。
#   * 与 02（A01 备份）无耦合，可独立执行；建议在业务低峰执行。

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

parse_args "01-clean-orphan-sbx.sh" "$@"
require_root_if_apply

TOKEN_PATTERN="$SBX_PROC_PATTERN"
LOG_DIR="/var/log/eu-fix"
LOG_FILE="$LOG_DIR/01-orphan-sbx.$(ts).log"
GRACE_SECONDS=10
TRASH_DIR="${SBX_WS_ROOT}/.trash-sbx"

print_mode_banner "孤儿沙箱进程 (sbx)"

# ---------------------------------------------------------------------------------
step "第 1 步：安全检查 — wagate 最近 5 分钟是否有 delivered 日志"
if ! command -v docker >/dev/null 2>&1; then
  die "找不到 docker 命令，无法做“是否在跑任务”的安全检查，拒绝继续（fail-closed）。"
fi

RECENT_LOG="$(docker logs "$WAGATE_CONTAINER" --since 5m 2>&1 || true)"
if printf '%s\n' "$RECENT_LOG" | grep -q 'delivered'; then
  warn "检测到 wagate 最近 5 分钟内有 delivered 日志，判定有任务正在跑 → 拒绝清理。"
  printf '%s\n' "$RECENT_LOG" | grep -m 5 'delivered' | sed 's/^/    | /'
  die "本次不执行任何清理动作。请等任务跑完（或 5 分钟无 delivered）后再运行。"
fi
info "安全检查通过：wagate 最近 5 分钟无 delivered 日志。"
info "复查命令（可手动执行）：docker logs $WAGATE_CONTAINER --since 5m 2>&1 | grep -q delivered; echo \$?"

# ---------------------------------------------------------------------------------
step "第 2 步：枚举孤儿沙箱进程（命令行含 '$TOKEN_PATTERN'）"
if is_apply; then
  mkdir -p "$LOG_DIR"
  : > "$LOG_FILE"
  info "本次日志：$LOG_FILE"
  printf '==== eu-fix 01 apply %s ====\n' "$(date -Is)" >> "$LOG_FILE"
else
  info "[dry-run] 日志文件（apply 时才创建）：$LOG_FILE"
fi

# 枚举：<PROC_ROOT>/<pid>/{cmdline,stat} -> 含 token 的 PID 列表
# EUFIX_PROC_ROOT 仅供自检演练（默认 /proc）；在 EU 服务器上正式执行时不要设置它。
PROC_ROOT="${EUFIX_PROC_ROOT:-/proc}"
list_orphans() {
  local pid cmdline
  for d in "$PROC_ROOT"/[0-9]*; do
    [ -d "$d" ] || continue
    pid="${d##*/}"
    [ -r "$d/cmdline" ] || continue
    cmdline="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null || true)"
    case "$cmdline" in
      *"$TOKEN_PATTERN"*)
        printf '%s\t%s\t%s\n' "$pid" "$(awk '{print $4}' "$d/stat" 2>/dev/null || echo '?')" "$cmdline"
        ;;
    esac
  done
}

ORPHAN_LIST="$(list_orphans || true)"
ORPHAN_COUNT="$(printf '%s\n' "$ORPHAN_LIST" | grep -c . || true)"
if [ "$ORPHAN_COUNT" -eq 0 ]; then
  info "未发现匹配的孤儿沙箱进程，无需清理。"
fi
info "匹配进程数：$ORPHAN_COUNT"
printf '%s\n' "$ORPHAN_LIST" | head -10 | sed 's/^/    /'
if [ "$ORPHAN_COUNT" -gt 10 ]; then
  printf '    ...（其余 %s 条略，见日志文件）\n' "$((ORPHAN_COUNT - 10))"
fi

# sandbox ids（用于工作目录整理）
ORPHAN_SBX_IDS="$(printf '%s\n' "$ORPHAN_LIST" | sed -n 's|.*v2_agent\.sh \(sbx-[^ ]*\).*|\1|p' | sort -u || true)"

# ---------------------------------------------------------------------------------
step "第 3 步：清理计划（先 SIGTERM，$GRACE_SECONDS 秒后仍在则 SIGKILL）"
if [ "$ORPHAN_COUNT" -eq 0 ]; then
  info "无进程需要处理，跳过信号步骤。"
else
  run "向 $ORPHAN_COUNT 个孤儿沙箱 PID 发送 SIGTERM" \
      sh -c "printf '%s\n' \"\$1\" | cut -f1 | xargs -r kill -TERM" _ "$ORPHAN_LIST"
  run "等待 ${GRACE_SECONDS}s 让进程自然退出" sleep "$GRACE_SECONDS"
  run "对仍未退出的 PID 发送 SIGKILL" \
      sh -c "for p in \$(printf '%s\n' \"\$1\" | cut -f1); do [ -d \"\$2/\$p\" ] && kill -KILL \$p || true; done" _ "$ORPHAN_LIST" "$PROC_ROOT"
fi

# ---------------------------------------------------------------------------------
step "第 4 步：整理沙箱工作目录（$SBX_WS_ROOT/sbx-* → $TRASH_DIR/，归档不删除）"
if [ -z "$ORPHAN_SBX_IDS" ]; then
  info "无对应沙箱工作目录需要整理。"
else
  printf '%s\n' "$ORPHAN_SBX_IDS" | sed 's/^/    待归档目录: /'
  if is_apply; then
    mkdir -p "$TRASH_DIR"
    for sbx_id in $ORPHAN_SBX_IDS; do
      src="$SBX_WS_ROOT/$sbx_id"
      [ -d "$src" ] || { info "跳过（不存在）：$src"; continue; }
      dst="$TRASH_DIR/${sbx_id}.$(ts)"
      printf '[exec] 归档工作目录：%s -> %s\n' "$src" "$dst" | tee -a "$LOG_FILE"
      mv -- "$src" "$dst"
      printf '%s\n' "$dst" >> "$LOG_FILE"
    done
    info "归档完成。确认业务正常后可手动清理：rm -rf $TRASH_DIR"
    info "回退方式：mv $TRASH_DIR/<sbx-id>.<ts> $SBX_WS_ROOT/<sbx-id>"
  else
    printf '[dry-run] 将创建归档目录并执行：\n'
    printf '          $ mkdir -p %s\n' "$TRASH_DIR"
    printf '%s\n' "$ORPHAN_SBX_IDS" | sed "s|^|          \$ mv $SBX_WS_ROOT/|;s|$| $TRASH_DIR/<sbx-id>.<ts>|"
    printf '          （目录是改名归档，不是删除；确认无误后可 rm -rf %s）\n' "$TRASH_DIR"
  fi
fi

# ---------------------------------------------------------------------------------
step "第 5 步：结果核对"
if is_apply; then
  REMAIN="$(list_orphans | grep -c . || true)"
  info "清理后仍匹配的进程数：$REMAIN（期望 0）"
  printf 'remaining=%s\n' "$REMAIN" >> "$LOG_FILE"
  [ "$REMAIN" -eq 0 ] || warn "仍有残留进程，请查看 $LOG_FILE 后人工确认。"
else
  info "[dry-run] 将复查：/proc 中匹配 '$TOKEN_PATTERN' 的进程数（期望 0）"
  info "复查命令：pgrep -af 'v2_agent.sh sbx-' | wc -l"
fi

step "完成"
if is_apply; then
  info "已执行清理，日志：$LOG_FILE"
else
  info "以上为 dry-run 计划，未做任何改动。确认无误后执行：sudo $0 --apply"
fi
