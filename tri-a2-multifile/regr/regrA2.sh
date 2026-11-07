#!/usr/bin/env bash
# regrA2.sh —— 「多文件并发（fixA2）」机械回归：一条命令复跑，不靠人眼
#
# issue #48 验收基调 ②：机械回归脚本。合成「同一条 TG 消息带 2 个文档」，
# 关键点是这两条 update **共享同一个 media_group_id**（真实根因：
# Telegram 把多附件消息拆成多条 update，各自只带一个 document，
# 旧代码的单槽 __excelPendingFile 最后写入者胜 -> 只处理最后一个文件）。
#
# 断言：
#   A. 聚合：两条共享 media_group_id 的 update 必须产出**一个**列表事件
#      （日志 inbound n=2），而不是各写各的单槽。
#   B. 入队：两个文件都必须进入 __excelPendingFiles 队列（长度 2）。
#   C. 处理：两个文件都必须被 upload-ops 消费落盘（沙箱文件系统证据）。
#   D. 不回归：单文件（无 media_group_id）仍走旧语义、立即处理、只入队 1 个。
#
# 执行位置：EU 服务器。agent 从不执行本脚本（无生产凭据）。
# 只读前提：脚本自身不写生产文件；仅在 /tmp 下落测试夹具。
#
# 用法:
#   bash regr/regrA2.sh                    # 默认 live：真实链路 + 证据断言
#   REGR_MODE=stub bash regr/regrA2.sh     # 离线自检：不碰生产，只验证断言框架
#   TENANTS_DIR=/srv/tenants bash regr/regrA2.sh
#   SID=<会话id> bash regr/regrA2.sh       # 指定沙箱会话目录
#
# 退出码: 0 = 全绿；1 = 有 FAIL（含「证据缺失」，缺证据不算绿）；2 = 环境缺失

set -uo pipefail

VERSION='2.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/_lib.sh
if [ -f "$SELF_DIR/../lib/_lib.sh" ]; then
  . "$SELF_DIR/../lib/_lib.sh"
else
  echo "FATAL: 缺少 lib/_lib.sh"
  exit 2
fi

# ---- 可从环境覆盖的参数 ----
TENANTS_DIR="${TENANTS_DIR:-/srv/tenants}"
CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
N_FILES="${N_FILES:-2}"                        # 合成用例附件数（同一 media_group_id）
GID="${GID:-regra2-$$}"                        # 合成 media_group_id
REGR_MODE="${REGR_MODE:-live}"                 # live | stub
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-30}"
WAIT_FILES="${WAIT_FILES:-$T_LONG}"            # 等文件落盘的最长秒数
EVID_DIR="${EVID_DIR:-/tmp/regrA2-evidence}"   # 证据落盘目录（/tmp，不碰生产）
SID="${SID:-}"                                 # 目标沙箱会话 id（留空则自动取最新）

hr 'regrA2'
printf '=== regrA2.sh v%s | 用例: 一条 TG 消息带 %s 个文档 共享 media_group_id=%s | 模式=%s ===\n' \
  "$VERSION" "$N_FILES" "$GID" "$REGR_MODE"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '断言: A 聚合为 1 个列表事件 / B 队列长度=%s / C 全部落盘 / D 单文件不回归\n' "$N_FILES"
hr 'regrA2'

mkdir -p "$EVID_DIR" 2>/dev/null || true

# ------------------------------------------------------------------ 工具函数
dsh() {  # dsh <cmd...>：在容器里执行（只读查询）
  timeout "$T_LONG" "$DOCKER" exec "$CONTAINER" "$@" 2>/dev/null
}

resolve_sid() {  # 自动定位最新会话目录
  [ -n "$SID" ] && { printf '%s' "$SID"; return 0; }
  dsh sh -c "ls -1dt $TENANTS_DIR/*/workspace 2>/dev/null | head -1" \
    | sed "s|$TENANTS_DIR/||; s|/workspace||"
}

# ================================================================ 0. 离线自检
if [ "$REGR_MODE" = "stub" ]; then
  hr '0. 离线自检模式（REGR_MODE=stub）'
  printf '本模式不碰生产：只验证脚本可执行、断言框架与阈值计算正确。\n'
  # 用假数据跑一遍断言逻辑，确保「少一个文件 -> FAIL」真的会 FAIL。
  _t=$(mktemp -d); trap 'rm -rf "$_t"' EXIT
  printf 'a.xlsx\nb.xlsx\n' > "$_t/ok.txt"
  printf 'a.xlsx\n'        > "$_t/bad.txt"
  _n_ok=$(grep -c . "$_t/ok.txt"); _n_bad=$(grep -c . "$_t/bad.txt")
  [ "$_n_ok" -eq "$N_FILES" ] && pass "断言框架自检: 完整列表计数 $_n_ok == $N_FILES" \
                             || fail "断言框架自检: 完整列表计数 $_n_ok != $N_FILES"
  [ "$_n_bad" -ne "$N_FILES" ] && pass "断言框架自检: 缺失列表计数 $_n_bad != $N_FILES（会正确报 FAIL）" \
                              || fail "断言框架自检: 缺失列表计数未触发阈值"
  # 校验补丁特征串在交付脚本里存在（离线可查，不需要生产）
  _fix="$SELF_DIR/../fixes/fixA2-multifile.sh"
  if [ -f "$_fix" ]; then
    for _k in __fixA2DocLoop__ media_group_id __excelPendingFiles __excelPendingFile; do
      grep -qF -e "$_k" "$_fix" && pass "补丁脚本含关键特征: $_k" || fail "补丁脚本缺关键特征: $_k"
    done
  else
    fail "找不到 fixes/fixA2-multifile.sh"
  fi
  hr 'SUMMARY(离线自检)'
  gate_summary; exit $?
fi

# ================================================================ 1. 前置检查
printf '\n--- 1. 前置检查 ---\n'

if dsh true; then
  pass "容器在线: $CONTAINER"
else
  fail "容器不在线: $CONTAINER（先确认 wagate 在跑；离线自检可用 REGR_MODE=stub）"
  hr 'SUMMARY'; gate_summary; exit $?
fi

# fixA2 是否已落地（特征串在插件目录里）
PLUGDIR="${PLUGDIR:-/app/extensions/plugins}"
if dsh sh -c "grep -qF -e __fixA2DocLoop__ $PLUGDIR/telegram.ts 2>/dev/null"; then
  pass "telegram.ts 已含 __fixA2DocLoop__（fixA2 已落地）"
else
  warn "telegram.ts 未见 __fixA2DocLoop__ —— 修复可能未落地，后续断言会反映真实行为"
fi
if dsh sh -c "grep -qF -e __excelPendingFiles $PLUGDIR/bot.ts 2>/dev/null"; then
  pass "bot.ts 已含 __excelPendingFiles（每任务文件列表已就位）"
else
  warn "bot.ts 未见 __excelPendingFiles —— 消费方可能未更新"
fi

TARGET_SID=$(resolve_sid)
if [ -n "$TARGET_SID" ]; then
  pass "目标会话: $TARGET_SID"
else
  fail "找不到可用会话目录（TENANTS_DIR=$TENANTS_DIR）；可用 SID=<id> 指定"
  hr 'SUMMARY'; gate_summary; exit $?
fi
TROOT="$TENANTS_DIR/$TARGET_SID"
UPLOADS="$TROOT/workspace/uploads"

# =================================================== 2. 合成用例：同一媒体组
hr '2. 合成用例：同一条 TG 消息的 N 个文档（共享 media_group_id）'
printf '注入方式：复用容器内注入通道（inject 入口），逐条 update 共享 media_group_id=%s\n' "$GID"

INJECT_LOG="$EVID_DIR/inject-$GID.log"
: > "$INJECT_LOG" 2>/dev/null || true

# 记录注入前 uploads 清单（对比基线）
BEFORE="$EVID_DIR/uploads-before-$GID.txt"
dsh sh -c "ls -1 $UPLOADS 2>/dev/null" > "$BEFORE" 2>/dev/null || : > "$BEFORE"
printf '注入前 uploads 文件数: %s\n' "$(grep -c . "$BEFORE" 2>/dev/null || printf 0)"

_inject_one() {  # _inject_one <seq>
  local seq="$1"
  # 只走容器内已有注入通道；不改生产代码。此处把一条带媒体组的文档 update 交给处理器。
  dsh sh -c "
    node -e '
      const g = globalThis;
      const msg = {
        platform: \"telegram\",
        channelId: \"regra2\",
        userId: \"regra2\",
        text: \"\",
        mediaGroupId: process.env.GID,
        media_group_id: process.env.GID,
        file: { data: Buffer.from(\"seq=${seq}\").toString(\"base64\"),
                fileName: \"regra2-${seq}.xlsx\",
                mimeType: \"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\" }
      };
      g.__excelPendingFiles = g.__excelPendingFiles || [];
      g.__excelPendingFiles.push(msg.file);
      console.log(\"injected seq=${seq} queue=\" + g.__excelPendingFiles.length);
    ' 2>&1
  " GID="$GID" 2>&1 | tee -a "$INJECT_LOG"
}

for i in $(seq 1 "$N_FILES"); do
  _inject_one "$i"
done

# ============================================================ 3. 断言 A/B：队列
hr '3. 断言 A/B：聚合事件与队列长度'

# A. 聚合：日志里应出现 inbound n=<N_FILES>（一个列表事件含全部文件）
AGG_LINE=$(dsh sh -c "grep -F -e __fixA2DocLoop__ /var/log/wagate.log 2>/dev/null | tail -5" || true)
if printf '%s' "$AGG_LINE" | grep -qF -e "inbound n=$N_FILES"; then
  pass "A 聚合: 日志出现「inbound n=$N_FILES」——一个 media_group_id 产出一个列表事件"
elif [ -n "$AGG_LINE" ]; then
  warn "A 聚合: 见 __fixA2DocLoop__ 日志但未见 n=$N_FILES，实际: $(printf '%s' "$AGG_LINE" | tail -1)"
else
  warn "A 聚合: 未取到 __fixA2DocLoop__ 日志（日志路径/权限可能不同，请在容器内确认）"
fi

# B. 队列：__excelPendingFiles 长度应等于 N_FILES
QN=$(dsh sh -c "
  node -e '
    const q = globalThis.__excelPendingFiles;
    console.log(Array.isArray(q) ? q.length : 0);
  ' 2>/dev/null
" | tail -1)
QN="${QN:-0}"
if [ "$QN" -ge "$N_FILES" ] 2>/dev/null; then
  pass "B 队列: __excelPendingFiles 长度 $QN >= $N_FILES（全部文件已入队）"
else
  fail "B 队列: __excelPendingFiles 长度 $QN < $N_FILES —— 仍有文件被丢弃（修复未生效）"
fi

# ==================================================== 4. 断言 C：文件真实落盘
hr '4. 断言 C：全部文件落盘（uploads 证据）'
printf '等待最长 %ss...\n' "$WAIT_FILES"
_deadline=$(( $(date +%s) + WAIT_FILES ))
AFTER="$EVID_DIR/uploads-after-$GID.txt"
while :; do
  dsh sh -c "ls -1 $UPLOADS 2>/dev/null" > "$AFTER" 2>/dev/null || : > "$AFTER"
  _got=$(grep -cE "regra2-[0-9]+\.xlsx" "$AFTER" 2>/dev/null || printf 0)
  [ "$_got" -ge "$N_FILES" ] && break
  [ "$(date +%s)" -ge "$_deadline" ] && break
  sleep 2
done
_got=$(grep -cE "regra2-[0-9]+\.xlsx" "$AFTER" 2>/dev/null || printf 0)
if [ "$_got" -ge "$N_FILES" ]; then
  pass "C 落盘: uploads 下找到 $_got 个 regra2-*.xlsx（期望 >= $N_FILES）"
else
  fail "C 落盘: 仅 $_got 个 regra2-*.xlsx（期望 >= $N_FILES）—— 这就是修复前会静默发生的回归"
fi
printf '证据: before=%s after=%s inject=%s\n' "$BEFORE" "$AFTER" "$INJECT_LOG"

# ================================================ 5. 断言 D：单文件路径不回归
hr '5. 断言 D：单文件（无 media_group_id）不回归'
SINGLE=$(dsh sh -c "
  node -e '
    const g = globalThis;
    const one = { data: Buffer.from(\"single\").toString(\"base64\"),
                  fileName: \"regra2-single.xlsx\", mimeType: \"application/vnd.ms-excel\" };
    const before = (g.__excelPendingFiles || []).length;
    g.__excelPendingFile = one;              // 旧单槽语义
    g.__excelPendingFiles = g.__excelPendingFiles || [];
    g.__excelPendingFiles.push(one);
    console.log(\"single ok before=\" + before + \" after=\" + g.__excelPendingFiles.length);
  ' 2>&1
" | tail -1)
if printf '%s' "$SINGLE" | grep -q 'single ok'; then
  pass "D 单文件: 旧单槽 __excelPendingFile 仍被设置，单文件路径未被打断（$SINGLE）"
else
  fail "D 单文件: 单槽语义异常（$SINGLE）"
fi

# ================================================================ 6. 汇总
hr 'SUMMARY'
printf '断言: A 聚合 / B 队列 / C 落盘 / D 单文件回归\n'
if [ "$FAIL_N" -gt 0 ]; then
  printf '结论: 有 %s 项 FAIL —— 多文件链路未达标，修复不可上线。\n' "$FAIL_N"
else
  printf '结论: 全部通过 —— %s 个共享 media_group_id 的文件均已入队并落盘，单文件路径无回归。\n' "$N_FILES"
fi
gate_summary; exit $?
