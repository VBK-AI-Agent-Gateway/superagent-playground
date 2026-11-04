#!/usr/bin/env bash
# 05-billingsync-interval.sh — claw-billing-sync.timer 改为 5 分钟间隔
#
# 作用：
#   把 claw-billing-sync.timer 的触发频率改为每 5 分钟一次。先 `systemctl cat` 看清当前配置，
#   备份 unit 文件为 `claw-billing-sync.timer.bak.bill5m.<时间戳>`，再写入 5 分钟配置：
#     [Timer]
#     OnCalendar=
#     OnUnitActiveSec=5min
#     Persistent=true
#   （清空 OnCalendar 是为了避免“OnCalendar 与 OnUnitActiveSec 同时存在、实际按分钟级别跑”的坑；
#     若你的实例依赖 OnCalendar，可改用 `OnCalendar=*:0/5`，脚本会同时打印该可选方案。）
#   然后 daemon-reload → restart timer → `systemctl list-timers` 确认下次触发时间。
#
# 回退方法：
#   `cp -a /etc/systemd/system/claw-billing-sync.timer.bak.bill5m.<ts> /etc/systemd/system/claw-billing-sync.timer`
#   → `systemctl daemon-reload` → `systemctl restart claw-billing-sync.timer`。
#   （脚本会把这条命令在结尾原样打印，备份不存在时也可以直接手写回原间隔。）
#
# 风险：
#   * 改 unit 文件写坏 → timer 无法启动，计费同步停止；因此脚本在写入后立即用
#     `systemctl daemon-reload` + `restart` + `is-active` + `list-timers` 做门禁，失败即提示回滚。
#   * 频率从原值提到 5 分钟会让同步任务跑得更勤：请确认 claw-billing-sync.service 是幂等、
#     且不会给上游 API 造成压力；如需更保守可改用 10min（脚本只写 5min，这是操作员指定值）。
#   * 只改定时器频率，不改 claw-billing-sync.service 的内容，不碰 asg-harness2-bypass、
#     m3 链路、gstack.v6。

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

parse_args "05-billingsync-interval.sh" "$@"
require_root_if_apply

UNIT_DIR="/etc/systemd/system"
UNIT="$UNIT_DIR/$BILLING_TIMER"
BAK="$UNIT.bak.bill5m.$(ts)"

print_mode_banner "$BILLING_TIMER → $BILLING_INTERVAL"

# ---------------------------------------------------------------------------------
step "第 1 步：查看当前 timer 配置"
run "查看 unit 与当前触发配置" systemctl cat "$BILLING_TIMER"
run "查看下次触发时间" systemctl list-timers "$BILLING_TIMER" --no-pager

if is_apply; then
  [ -f "$UNIT" ] || die "unit 文件不存在：$UNIT（实际路径可能不同，请用 systemctl cat 结果确认后调整 UNIT_DIR）。"
  info "当前 [Timer] 段："
  awk '/^\[Timer\]/{f=1} f' "$UNIT" | sed 's/^/    /'
  info "当前 NextElapse：$(systemctl show -p NextElapseUSecRealtime --value "$BILLING_TIMER" 2>/dev/null || echo '?')"
else
  info "[dry-run] 将读取 $UNIT 并把当前 [Timer] 段打印出来对照。"
fi

# ---------------------------------------------------------------------------------
step "第 2 步：备份 unit 文件"
run "备份 timer unit" cp -a "$UNIT" "$BAK"
info "回滚命令：cp -a $BAK $UNIT && systemctl daemon-reload && systemctl restart $BILLING_TIMER"

# ---------------------------------------------------------------------------------
step "第 3 步：写入 5 分钟间隔（保留 [Unit]/[Install]，替换 [Timer] 段）"
new_timer_block() {
  cat <<EOF
[Timer]
# 由 eu-fix/05-billingsync-interval.sh 于 $(date -Is) 修改：每 5 分钟触发一次
OnCalendar=
OnUnitActiveSec=$BILLING_INTERVAL
Persistent=true
EOF
}

if is_apply; then
  # 保留 [Unit] 段与 [Install] 段，只把 [Timer] 段替换为新块（改写前已备份）
  tmp="$(mktemp)"
  awk -v newblock="$(new_timer_block)" '
    /^\[Timer\]/ { print newblock; intimer=1; next }
    /^\[/ { intimer=0 }
    intimer==1 { next }
    { print }
  ' "$UNIT" > "$tmp"
  cat "$tmp" > "$UNIT"
  rm -f "$tmp"
  info "写入后 [Timer] 段："
  awk '/^\[Timer\]/{f=1} f' "$UNIT" | sed 's/^/    /'
  grep -qE "^OnUnitActiveSec=$BILLING_INTERVAL" "$UNIT" || die "写入校验失败（未找到 OnUnitActiveSec=$BILLING_INTERVAL），请用备份回滚。"
else
  printf '[dry-run] 新的 [Timer] 段（写入时保留其余段，覆盖整段 [Timer]）：\n'
  new_timer_block | sed 's/^/    /'
  printf '          可选方案（若你的实例必须用日历表达式）：OnCalendar=*:0/5 并去掉 OnUnitActiveSec\n'
  printf '          写入方式：awk 替换 [Timer] 段后用 cat > 覆盖（已先备份 %s）\n' "$BAK"
fi

# ---------------------------------------------------------------------------------
step "第 4 步：daemon-reload + 重启 timer"
run "重载 systemd 配置" systemctl daemon-reload
run "重启 $BILLING_TIMER" systemctl restart "$BILLING_TIMER"

# ---------------------------------------------------------------------------------
step "第 5 步：门禁校验（is-active / list-timers）"
if is_apply; then
  systemctl is-active --quiet "$BILLING_TIMER" || die "timer 未处于 active 状态，请立即回滚：cp -a $BAK $UNIT && systemctl daemon-reload && systemctl restart $BILLING_TIMER"
  info "timer active。"
  systemctl list-timers "$BILLING_TIMER" --no-pager | sed 's/^/    /'
  NEXT="$(systemctl show -p NextElapseUSecRealtime --value "$BILLING_TIMER" 2>/dev/null || echo '?')"
  info "新的 NextElapse：$NEXT"
  info "请人工确认 NEXT 距今约 ≤5 分钟，且不在 1 分钟内（避免与原 OnCalendar 叠加）。"
else
  printf '[dry-run] 将执行：\n'
  printf '          $ systemctl daemon-reload\n'
  printf '          $ systemctl restart %s\n' "$BILLING_TIMER"
  printf '          $ systemctl is-active %s            # 期望 active\n' "$BILLING_TIMER"
  printf '          $ systemctl list-timers %s --no-pager   # 期望 NEXT 约 5 分钟内\n' "$BILLING_TIMER"
fi

step "完成"
if is_apply; then
  info "已改为每 $BILLING_INTERVAL 触发。备份：$BAK"
else
  info "以上为 dry-run 计划，未改动任何 unit。确认无误后执行：sudo $0 --apply"
fi
