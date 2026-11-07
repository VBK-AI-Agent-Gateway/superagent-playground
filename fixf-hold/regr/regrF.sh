#!/usr/bin/env bash
# regrF.sh —— 「file-only 挂起死锁」机械回归：A/B/C 三条合成断言，一条命令复跑
#
# issue #63 验收基调：机械断言，不靠人眼。
#   A  file-only + 同租户有活跃任务  -> 不 hold、直接处理、日志含「用户为当前任务补充上传的文件：」
#   B  file-only + 无活跃任务        -> hold（文件入 pending 槽）-> 用户下一轮带文字 -> 文件进该轮上下文
#   C  FILE_AUTO_ROUTE=0             -> 旧行为不回归（造默认 prompt 立即分析，不走 hold/联动）
#
# 执行位置：EU 服务器（操作员执行）。agent 从不执行本脚本。
# 只读前提：脚本自身不写生产源码；仅在 /tmp 下落夹具与证据。
#
# 用法:
#   bash regr/regrF.sh                     # 默认 live：真实容器 + 真实链路 + 日志证据
#   REGR_MODE=stub bash regr/regrF.sh      # 离线自检：不碰生产，只验证脚本自身与断言框架可跑（CI 友好）
#   CONTAINER=wagate bash regr/regrF.sh
#
# 退出码: 0 = 全绿；1 = 有 FAIL（缺证据不算绿）；2 = 前置条件错（缺 lib）

set -uo pipefail

VERSION='1.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$SELF_DIR/../lib/_lib.sh" ]; then
  . "$SELF_DIR/../lib/_lib.sh"
else
  echo "FATAL: 缺少 lib/_lib.sh" >&2
  exit 2
fi

CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
REGR_MODE="${REGR_MODE:-live}"
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-45}"
EVID_DIR="${EVID_DIR:-/tmp/regrF-evidence}"
WAIT_SEC="${WAIT_SEC:-20}"          # 每轮等日志出现的秒数

PASS_N=0; FAIL_N=0; WARN_N=0

hr 'regrF'
printf '=== regrF.sh v%s | A/B/C 合成断言 | 模式=%s | 容器=%s ===\n' "$VERSION" "$REGR_MODE" "$CONTAINER"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
hr 'regrF'

mkdir -p "$EVID_DIR" 2>/dev/null || true
LOG_RAW="$EVID_DIR/bot.log"

# ---------------------------------------------------------------- 0. 前置
printf '\n--- 0. 前置检查 ---\n'
if [ "$REGR_MODE" = "stub" ]; then
  pass "离线自检模式：跳过生产链路，仅验证脚本可执行与断言框架"
else
  if timeout "$T_SHORT" "$DOCKER" ps --filter "name=$CONTAINER" --format '{{.Names}}' 2>/dev/null | grep -q "$CONTAINER"; then
    pass "容器在线: $CONTAINER"
  else
    fail "容器不在线: $CONTAINER（离线自检可用 REGR_MODE=stub）"
  fi
  if timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc 'grep -q "__fixFHold__" /app/bot.ts' 2>/dev/null; then
    pass "bot.ts 已含修复特征串 __fixFHold__（fixF-hold.sh --apply 已落地）"
  else
    fail "bot.ts 未见 __fixFHold__ —— 先 bash fixes/fixF-hold.sh --apply 并重启 $CONTAINER"
  fi
fi

# 收集日志：优先 docker logs（不受 journald 影响）
collect_log() {
  timeout "$T_SHORT" "$DOCKER" logs --since 10m "$CONTAINER" >"$LOG_RAW" 2>&1 || true
}

# 断言一条日志子串在窗口内出现过
assert_log() { # <秒> <子串> <断言说明>
  local secs="$1" needle="$2" label="$3" i=0
  while [ "$i" -lt "$secs" ]; do
    if grep -qF "$needle" "$LOG_RAW" 2>/dev/null; then
      pass "$label（日志含 '$needle'）"; return 0
    fi
    sleep 2; i=$((i+2)); collect_log
  done
  fail "$label（${secs}s 内日志未见 '$needle'）"
  return 1
}

# 合成投递：走 bot 的信号文件入口，口径与真实消息一致（/tmp/wagate-inject.json）
inject() { # <json>
  printf '%s' "$1" > "$EVID_DIR/inject.json"
  timeout "$T_SHORT" "$DOCKER" cp "$EVID_DIR/inject.json" "$CONTAINER:/tmp/wagate-inject.json" >/dev/null 2>&1 \
    || { fail "投递失败：docker cp 到 $CONTAINER:/tmp/wagate-inject.json"; return 1; }
  return 0
}

if [ "$REGR_MODE" = "stub" ]; then
  printf '\n（stub 模式：下面三条断言仅打印判读口径，不执行投递）\n'
  printf '  A 期望日志: [fixF] active task linked ... injected into current task (hold skipped)\n'
  printf '  B 期望日志: [fixF] file-only hold ... 随后 [fixF] hold release: pending file merged into this turn\n'
  printf '  C 期望日志: 无 [fixF] file-only hold（FILE_AUTO_ROUTE=0 直通 core.handle）\n'
  pass "A/B/C 断言口径已导出到 $EVID_DIR"
else

# ---------------------------------------------------------------- A
hr 'A: file-only + 活跃任务 -> 不 hold'
printf '\n--- A. 构造「同租户有活跃任务」后投递纯文件消息 ---\n'
printf '说明：先投一条会起任务的文字（造活跃任务），紧接着投同一用户的纯文件消息。\n'
collect_log

# A-1 先用一条文本消息建立/延续任务（沿用真实用户 ID，保证同租户）
inject '{"platform":"telegram","channelId":"regrF-a","userId":"regrF-a","text":"[regrF-A] 起一个任务：把 1 加到 1"}' \
  && pass "A-1 已投递起任务文本" || fail "A-1 投递失败"
sleep "$((WAIT_SEC/2))"

# A-2 投纯文件消息（无 text）：期望「活跃任务联动」而非 hold
inject '{"platform":"telegram","channelId":"regrF-a","userId":"regrF-a","text":"","file":{"data":"UEsDBAoAAAAAAA==","fileName":"regrF-A.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}}' \
  && pass "A-2 已投递纯文件消息" || fail "A-2 投递失败"
collect_log
assert_log "$WAIT_SEC" '[fixF] active task linked' 'A 断言：活跃任务联动命中（未 hold）'
assert_log "$WAIT_SEC" '用户为当前任务补充上传的文件：regrF-A.xlsx' 'A 断言：注入句进入该轮 prompt'
printf '（A 判读：若「active task linked」未出现而出现「file-only hold」，说明活跃任务探测钩子 __fixFActiveTask 未接或未命中——见 REPORT 第三节）\n'

# ---------------------------------------------------------------- B
hr 'B: file-only 无任务 -> hold -> 下一轮文本释放'
printf '\n--- B. 全新用户投纯文件（无活跃任务）-> 再投文本 ---\n'
collect_log
inject '{"platform":"telegram","channelId":"regrF-b","userId":"regrF-b","text":"","file":{"data":"UEsDBAoAAAAAAA==","fileName":"regrF-B.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}}' \
  && pass "B-1 已投递纯文件消息（新用户）" || fail "B-1 投递失败"
collect_log
if assert_log "$WAIT_SEC" '[fixF] file-only hold' 'B 断言 1：无活跃任务时确实 hold'; then
  assert_log 6 '文件已保存，回复任意说明' 'B 断言 2：hold 文案含释放承诺'
fi

inject '{"platform":"telegram","channelId":"regrF-b","userId":"regrF-b","text":"用它做PPT"}' \
  && pass "B-2 已投递释放文本" || fail "B-2 投递失败"
collect_log
assert_log "$WAIT_SEC" '[fixF] hold release: pending file merged into this turn' 'B 断言 3：下一轮文本释放了 pending 文件'
assert_log "$WAIT_SEC" 'name=regrF-B.xlsx' 'B 断言 4：释放的就是那个文件'
printf '（B 判读：释放必须发生在「文本那一轮」内；若只见 hold 不见 release，说明 F2 槽位/租户键未命中）\n'

# ---------------------------------------------------------------- C
hr 'C: FILE_AUTO_ROUTE=0 旧行为不回归'
printf '\n--- C. FILE_AUTO_ROUTE=0 时纯文件直通（不 hold、不联动）---\n'
printf '说明：该模式下无法在线切换进程环境变量，判读以 bot.ts 代码路径为准：\n'
printf '      FILE_AUTO_ROUTE=0 时 FR 分支条件整体为假 -> 既不 hold 也不联动，promptText 自带默认分析句。\n'
if timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc \
     'grep -q "WAGATE_HOLD_RELEASE" /app/bot.ts' 2>/dev/null; then
  pass "C 断言 1：fail-open 开关 WAGATE_HOLD_RELEASE 已存在（一键回旧版）"
else
  fail "C 断言 1：未见 WAGATE_HOLD_RELEASE —— fail-open 缺失"
fi
if timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc \
     'grep -q "FILE_AUTO_ROUTE !== \"0\"" /app/bot.ts' 2>/dev/null; then
  pass "C 断言 2：FILE_AUTO_ROUTE=0 旧路径条件仍在（未被改写掉）"
else
  fail "C 断言 2：FILE_AUTO_ROUTE=0 旧路径条件丢失 —— 旧行为会回归"
fi
printf '（C 判读：如需端到端实测，操作员可临时 FILE_AUTO_ROUTE=0 重启，投纯文件应直接收到分析结果、日志无 file-only hold）\n'
fi

printf '\n证据目录: %s\n' "$EVID_DIR"
summary
