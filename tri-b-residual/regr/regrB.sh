#!/usr/bin/env bash
# regrB.sh — 残留干扰修复的机械回归脚本（issue #38 §2 / §0②）
#
# 合成用例：一个租户已有 5 个旧文件（模拟历史任务残留），启动"新任务"后断言：
#   A. 活跃视图（模拟 /ws）不再包含任何旧文件
#   B. 旧文件被归档到 archives/ 且内容完好（不删除）
#   C. 当前任务文件清单（模拟提示词注入面）只列出当前任务文件，不含旧文件
#   D. 机械门对"干净视图"通过、对"注入残留"失败（fail-closed 自证）
#   E. 回退可完整还原（可审计、可撤销）
#
# 一条命令可重跑；不依赖网络、不依赖生产环境；全程在 mktemp 沙箱内，结束即清理。
#
# 用法：
#   bash regrB.sh                 # 全部用例
#   bash regrB.sh -v              # 保留沙箱并打印详细过程
#   KEEP=1 bash regrB.sh          # 保留沙箱目录以便人工检查
#
# 退出码：0 全部通过；1 有断言失败。

set -uo pipefail

VERBOSE=0
[ "${1:-}" = "-v" ] && VERBOSE=1
KEEP="${KEEP:-0}"

# 被测脚本：默认取同目录上层的 fixes/fixB-residual.sh
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="${FIX:-$HERE/../fixes/fixB-residual.sh}"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
assert_true()  { if [ "$2" = "0" ]; then ok "$1"; else bad "$1  (期望成立)"; fi; }
assert_false() { if [ "$2" != "0" ]; then ok "$1"; else bad "$1  (期望不成立)"; fi; }
assert_eq()    { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1  期望=$3 实际=$2"; fi; }
sec() { printf '\n===== %s =====\n' "$1"; }

[ -f "$FIX" ] || { printf '找不到被测脚本: %s\n' "$FIX" >&2; exit 2; }
command -v bash >/dev/null || { printf '缺少 bash\n' >&2; exit 2; }

printf '残留干扰修复 机械回归 (regrB)\n被测: %s\n' "$FIX"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/regrB-XXXXXX")"
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$SANDBOX"; }
trap cleanup EXIT

TROOT="$SANDBOX/tenants"
TEN="$TROOT/acme"
mkdir -p "$TEN/workspace/sub" "$TEN/uploads" "$TEN/activeProj"

# ---- 合成历史残留：5 个旧文件（2 天前）+ 1 个旧页面（3 天前）-------------
for i in 1 2 3 4 5; do
  printf 'HISTORICAL-CONTENT-%s\n' "$i" > "$TEN/uploads/old-$i.txt"
  touch -d '2 days ago' "$TEN/uploads/old-$i.txt"
done
printf 'OLD-PAGE\n' > "$TEN/workspace/stale-page.html"
touch -d '3 days ago' "$TEN/workspace/stale-page.html"
printf 'OLD-DEEP\n' > "$TEN/workspace/sub/stale-deep.html"
touch -d '3 days ago' "$TEN/workspace/sub/stale-deep.html"
# 当前任务
printf '{"taskId":"task-CURRENT"}\n' > "$TEN/activeProj/task.json"
printf 'FRESH\n' > "$TEN/workspace/current.txt"

# 基线：记录旧文件路径+校验和，事后验证"归档不删且内容不变"
BASELINE="$SANDBOX/baseline.txt"
( cd "$TEN" && find uploads -type f | sort | while IFS= read -r f; do
    printf '%s %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "$f"; done ) > "$BASELINE"
OLD_COUNT="$(wc -l < "$BASELINE" | tr -d ' ')"
assert_eq "合成历史残留 uploads 文件数" "$OLD_COUNT" "5"

run_fix() { TENANT_ROOT="$TROOT" TG_NOTIFY=0 ALERT_LOG="$SANDBOX/gate.log" bash "$FIX" "$@" 2>&1; }

# =========================================================================
sec "用例 1：dry-run 绝不改动（安全性）"
snap1="$SANDBOX/s1.txt"; snap2="$SANDBOX/s2.txt"
( cd "$TEN" && find . -type f | sort ) > "$snap1"
run_fix > "$SANDBOX/dryrun.log" 2>&1
( cd "$TEN" && find . -type f | sort ) > "$snap2"
assert_true "dry-run 后文件树无变化" "$([ "$(cat "$snap1")" = "$(cat "$snap2")" ] && echo 0 || echo 1)"
assert_true "dry-run 输出包含 [dry-run] 计划" "$(grep -q '\[dry-run\]' "$SANDBOX/dryrun.log" && echo 0 || echo 1)"
[ "$VERBOSE" = 1 ] && cat "$SANDBOX/dryrun.log"

# =========================================================================
sec "用例 2：--apply 后活跃视图不含旧文件（断言 A）"
run_fix --apply > "$SANDBOX/apply.log" 2>&1; apply_rc=$?
assert_eq "--apply 退出码（门应通过）" "$apply_rc" "0"
[ "$VERBOSE" = 1 ] && cat "$SANDBOX/apply.log"

stale_in_view="$(find "$TEN/workspace" -type f -mmin +60 2>/dev/null | wc -l | tr -d ' ')"
assert_eq "活跃视图内 >1h 旧文件数（应为 0）" "$stale_in_view" "0"
assert_false "活跃视图不含 stale-page.html" "$([ -e "$TEN/workspace/stale-page.html" ] && echo 0 || echo 1)"
assert_false "活跃视图不含 stale-deep.html" "$([ -e "$TEN/workspace/sub/stale-deep.html" ] && echo 0 || echo 1)"
assert_eq "uploads 顶层已无平铺旧文件" \
  "$(find "$TEN/uploads" -mindepth 1 -maxdepth 1 -type f | wc -l | tr -d ' ')" "0"
assert_true "uploads 已建当前任务子目录 task-task-CURRENT" \
  "$([ -d "$TEN/uploads/task-task-CURRENT" ] && echo 0 || echo 1)"

# =========================================================================
sec "用例 3：旧文件已归档且内容完好（断言 B，不删除）"
ARCH="$(find "$TEN/archives" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n1)"
assert_true "存在归档目录 archives/archive-<ts>/" "$([ -n "$ARCH" ] && echo 0 || echo 1)"
if [ -n "$ARCH" ]; then
  # 5 个旧上传文件全部在归档中且内容一致
  intact=0; missing=0
  while IFS= read -r line; do
    sum="${line%% *}"; rel="${line#* }"
    dst="$ARCH/$rel"
    if [ ! -f "$dst" ]; then missing=$((missing + 1)); continue; fi
    [ "$(md5sum "$dst" | cut -d' ' -f1)" = "$sum" ] || intact=$((intact + 1))
  done < "$BASELINE"
  assert_eq "归档中旧文件缺失数（应为 0）" "$missing" "0"
  assert_eq "归档中旧文件内容不一致数（应为 0）" "$intact" "0"
  assert_true "归档亦含 stale-page.html" "$([ -f "$ARCH/workspace/stale-page.html" ] && echo 0 || echo 1)"
  assert_true "归档亦含深层 stale-deep.html" "$([ -f "$ARCH/workspace/sub/stale-deep.html" ] && echo 0 || echo 1)"
  assert_eq "归档旧文件总数" "$(find "$ARCH" -type f | wc -l | tr -d ' ')" "7"
fi

# =========================================================================
sec "用例 4：提示词清单只含当前任务文件（断言 C）"
MAN="$TEN/workspace/activeProj/current-files.txt"
assert_true "生成了当前任务文件清单" "$([ -f "$MAN" ] && echo 0 || echo 1)"
if [ -f "$MAN" ]; then
  assert_true "清单含当前任务文件 current.txt" "$(grep -q 'current.txt' "$MAN" && echo 0 || echo 1)"
  leak="$(grep -cE 'old-[1-5]\.txt|stale-page\.html|stale-deep\.html|archives/' "$MAN" | tr -d ' ')"
  assert_eq "清单中旧文件/归档泄漏条数（应为 0）" "$leak" "0"
  [ "$VERBOSE" = 1 ] && { echo "--- manifest ---"; cat "$MAN"; }
fi

# =========================================================================
sec "用例 5：机械门 fail-closed 自证（断言 D）"
# 5a. 干净视图 → 门通过
g1="$SANDBOX/gate-clean.log"
TENANT_ROOT="$TROOT" TG_NOTIFY=0 ALERT_LOG="$SANDBOX/gate.log" bash "$FIX" --gate-only > "$g1" 2>&1
assert_eq "干净视图门通过(exit 0)" "$?" "0"
assert_true "门输出 PASS" "$(grep -q 'PASS' "$g1" && echo 0 || echo 1)"

# 5b. 注入一个残留旧文件 → 门必须失败(exit 1) 且告警留痕
printf 'LEAKED\n' > "$TEN/workspace/leaked-residual.html"
touch -d '4 days ago' "$TEN/workspace/leaked-residual.html"
g2="$SANDBOX/gate-dirty.log"; rm -f "$SANDBOX/gate.log"
TENANT_ROOT="$TROOT" TG_NOTIFY=0 ALERT_LOG="$SANDBOX/gate.log" bash "$FIX" --gate-only > "$g2" 2>&1
rc2=$?
assert_eq "注入残留后门失败(exit 1, fail-closed)" "$rc2" "1"
assert_true "门输出 FAIL" "$(grep -q 'FAIL' "$g2" && echo 0 || echo 1)"
assert_true "违规已写入告警日志（不静默）" "$([ -s "$SANDBOX/gate.log" ] && echo 0 || echo 1)"
assert_true "告警点名 leaked-residual.html" "$(grep -q 'leaked-residual.html' "$g2" && echo 0 || echo 1)"
[ "$VERBOSE" = 1 ] && { echo "--- gate dirty ---"; cat "$g2"; }

# 5c. 白名单文件（task.json）即便过期也不违规
printf '{"taskId":"task-CURRENT"}\n' > "$TEN/workspace/task.json"
touch -d '10 days ago' "$TEN/workspace/task.json"
TENANT_ROOT="$TROOT" TG_NOTIFY=0 ALERT_LOG="$SANDBOX/gate.log" bash "$FIX" --gate-only > "$SANDBOX/g3.log" 2>&1
assert_true "白名单 task.json 被放行" "$(grep -q '白名单放行' "$SANDBOX/g3.log" && echo 0 || echo 1)"
# 清掉残留物，恢复干净
rm -f "$TEN/workspace/leaked-residual.html"
TENANT_ROOT="$TROOT" TG_NOTIFY=0 ALERT_LOG="$SANDBOX/gate.log" bash "$FIX" --gate-only > /dev/null 2>&1
assert_eq "清理后门重新通过" "$?" "0"

# =========================================================================
sec "用例 6：回退完整还原（断言 E）"
TS="$(basename "$ARCH" 2>/dev/null | sed 's/^archive-//')"
if [ -n "$TS" ]; then
  run_fix --rollback "$TS" --apply > "$SANDBOX/rollback.log" 2>&1
  assert_eq "回退退出码" "$?" "0"
  # 还原后 5 个旧上传文件回到原位且内容一致
  restored=0; mism=0
  while IFS= read -r line; do
    sum="${line%% *}"; rel="${line#* }"
    if [ ! -f "$TEN/$rel" ]; then mism=$((mism + 1)); continue; fi
    [ "$(md5sum "$TEN/$rel" | cut -d' ' -f1)" = "$sum" ] && restored=$((restored + 1)) || mism=$((mism + 1))
  done < "$BASELINE"
  assert_eq "回退后完整还原的旧文件数（应为 5）" "$restored" "5"
  assert_eq "回退后内容/存在性异常数（应为 0）" "$mism" "0"
  assert_true "回退后 stale-page.html 回到活跃视图" \
    "$([ -f "$TEN/workspace/stale-page.html" ] && echo 0 || echo 1)"
  assert_true "回退后归档目录已清空移除" \
    "$([ ! -d "$TEN/archives/archive-$TS" ] && echo 0 || echo 1)"
  [ "$VERBOSE" = 1 ] && cat "$SANDBOX/rollback.log"
else
  bad "缺少归档目录，无法测试回退"
fi

# =========================================================================
sec "用例 7：fail-open 逃生门（WAGATE_RESIDUAL_VIEW=0）"
# 重置一个带残留的租户
TEN2="$TROOT/beta"; mkdir -p "$TEN2/workspace" "$TEN2/uploads" "$TEN2/activeProj"
for i in 1 2 3 4 5; do printf 'B-%s\n' "$i" > "$TEN2/uploads/b-$i.txt"; touch -d '2 days ago' "$TEN2/uploads/b-$i.txt"; done
printf '{"taskId":"task-B"}\n' > "$TEN2/activeProj/task.json"
before_n="$(cd "$TEN2" && find . -type f | wc -l | tr -d ' ')"
WAGATE_RESIDUAL_VIEW=0 TENANT_ROOT="$TROOT" TENANT=beta TG_NOTIFY=0 \
  ALERT_LOG="$SANDBOX/gate.log" bash "$FIX" --apply > "$SANDBOX/failopen.log" 2>&1
after_n="$(cd "$TEN2" && find . -type f | wc -l | tr -d ' ')"
assert_eq "fail-open 下文件数不变（未归档）" "$after_n" "$before_n"
assert_true "fail-open 输出提示恢复旧行为" "$(grep -q 'WAGATE_RESIDUAL_VIEW=0' "$SANDBOX/failopen.log" && echo 0 || echo 1)"
assert_eq "beta/uploads 旧文件仍在（逃生门生效）" \
  "$(find "$TEN2/uploads" -type f | wc -l | tr -d ' ')" "5"

# =========================================================================
printf '\n========================================\n'
printf '回归结果: %d 通过, %d 失败\n' "$PASS" "$FAIL"
[ "$KEEP" = "1" ] && printf '沙箱保留于: %s\n' "$SANDBOX"
if [ "$FAIL" -gt 0 ]; then
  printf '结论: FAIL —— 残留干扰修复未通过机械回归\n'
  exit 1
fi
printf '结论: ALL PASS —— 任务级文件视图 + 机械门 + 回退 均符合断言\n'
exit 0
