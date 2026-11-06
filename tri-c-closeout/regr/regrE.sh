#!/bin/sh
# regrE.sh — sa-watchdog 自动重派的隔离回归（issue #39 D4）
#
# 验证：STOP 之后恰好自动重派【一次】，第二次 STOP 升级给人类。
# 全程隔离：重派状态、日志、gh 调用全部指向临时路径；gh 用假脚本桩，
# 绝不创建真实 issue、不推送、不触碰生产状态。
#
# 用法：sh regrE.sh [v2脚本路径]

set -u

V2="${1:-$(dirname "$0")/../fixes/fixE-watchdog-redispatch.sh}"
[ -f "$V2" ] || { echo "!! 未找到 fixE 脚本：$V2"; exit 1; }

SANDBOX=$(mktemp -d) || exit 1
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- gh 桩
# 记录每次调用，不接触网络。
GHSTUB="$SANDBOX/gh-stub"
cat > "$GHSTUB" <<'EOF'
#!/bin/sh
# 每次调用恰好记一行：正文含换行，必须压平，否则调用计数被正文行数污染
echo "gh $(printf '%s' "$*" | tr '\n' ' ')" >> "$GH_LOG"
exit 0
EOF
chmod +x "$GHSTUB"
GH_LOG="$SANDBOX/gh.log"; : > "$GH_LOG"; export GH_LOG

# ---------------------------------------------------------------- 复刻重派逻辑
# 与 fixE 注入的 NEW 段同一规则：retries>=1 -> ESCALATE；否则建 retry issue 并 +1。
redispatch_once() {
  TID="$1"; RFILE="$2"; DRY="${3:-0}"; ESC="$4"
  python3 - "$TID" "$RFILE" "$DRY" "$ESC" "$GHSTUB" <<'PYEOF'
import json, os, subprocess, sys
tid, rfile, dry, esc = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
gh = sys.argv[5]
try:
    rstate = json.load(open(rfile))
except Exception:
    rstate = {}
n = int(rstate.get(tid, 0))
if n >= 1:
    print("ESCALATE %s retries=%d (>=1) -> human attention required" % (tid, n))
    with open(esc, "a") as fh:
        fh.write("%s retries=%d\n" % (tid, n))
else:
    body = "retry-of=%s\n\nwatchdog stopped this ticket after 900s idle; auto-redispatch once.\n" % tid
    title = "retry: %s (watchdog redispatch)" % tid
    if dry:
        print("DRY-RUN REDISPATCH %s would create: %s" % (tid, title))
    else:
        rc = subprocess.call([gh, "issue", "create", "--repo", "X/Y",
                              "--title", title, "--body", body],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("REDISPATCH %s rc=%d" % (tid, rc))
        if rc == 0:
            rstate[tid] = n + 1
            json.dump(rstate, open(rfile, "w"))
PYEOF
}

TID="1603499d3430e43e6f36091d5629d602"
RF="$SANDBOX/redispatch-state"; ESC="$SANDBOX/escalate.txt"

say "== 场景 1：首次 STOP -> 应重派一次 =="
O1=$(redispatch_once "$TID" "$RF" 0 "$ESC")
say "  $O1"
echo "$O1" | grep -q 'REDISPATCH .* rc=0' && ok "首次 STOP 触发重派" || bad "首次 STOP 未重派"
[ "$(wc -l < "$GH_LOG")" = "1" ] && ok "gh 被调用 1 次（创建 issue）" || bad "gh 调用次数=$(wc -l < "$GH_LOG")"
grep -q "retry-of=$TID" "$GH_LOG" && ok "issue 正文含 retry-of=<原工单>（auto-trigger 可识别）" || bad "正文缺 retry-of"
[ "$(python3 -c "import json;print(json.load(open('$RF')).get('$TID',0))")" = "1" ] \
  && ok "重试计数=1" || bad "重试计数未递增"
[ ! -s "$ESC" ] && ok "未产生升级记录" || bad "不应升级却写了 escalate"

say ""
say "== 场景 2：第二次 STOP -> 应升级，不再重派 =="
O2=$(redispatch_once "$TID" "$RF" 0 "$ESC")
say "  $O2"
echo "$O2" | grep -q 'ESCALATE' && ok "第二次 STOP 升级给人类" || bad "第二次 STOP 未升级"
[ "$(wc -l < "$GH_LOG")" = "1" ] && ok "gh 仍只被调用 1 次（未重复创建 issue）" || bad "gh 被重复调用"
[ -s "$ESC" ] && ok "已写升级记录 watchdog-escalate.txt" || bad "缺升级记录"
[ "$(python3 -c "import json;print(json.load(open('$RF')).get('$TID',0))")" = "1" ] \
  && ok "计数封顶在 1（上限生效）" || bad "计数越过上限"

say ""
say "== 场景 3：另一工单互不影响 =="
TID2="a6d02b40e68bef3e777af94f2d397882"
O3=$(redispatch_once "$TID2" "$RF" 0 "$ESC")
echo "$O3" | grep -q 'REDISPATCH .* rc=0' && ok "第二个工单独立获得一次重派" || bad "第二个工单未重派"
[ "$(wc -l < "$GH_LOG")" = "2" ] && ok "gh 累计 2 次（每工单各 1）" || bad "gh 累计=$(wc -l < "$GH_LOG")"

say ""
say "== 场景 4：DRY_RUN 不创建 issue =="
GH_BEFORE=$(wc -l < "$GH_LOG")
O4=$(redispatch_once "drytest-tid" "$RF" 1 "$ESC")
echo "$O4" | grep -q 'DRY-RUN REDISPATCH' && ok "DRY-RUN 只打印不创建" || bad "DRY-RUN 行为异常"
[ "$(wc -l < "$GH_LOG")" = "$GH_BEFORE" ] && ok "DRY-RUN 未调用 gh" || bad "DRY-RUN 调用了 gh"

say ""
say "== 脚本级检查（fixE 自身）=="
sh -n "$V2" && ok "fixE sh -n 语法通过" || bad "fixE 语法失败"

WB="$SANDBOX/bin"; mkdir -p "$WB"
cp /home/qt/bin/sa-watchdog.sh "$WB/sa-watchdog.sh" 2>/dev/null \
  || { say "  （宿主无 sa-watchdog.sh，跳过脚本级补丁验证）"; }
if [ -f "$WB/sa-watchdog.sh" ]; then
  OUT=$(sh "$V2" --apply --bin "$WB" 2>&1)
  echo "$OUT" | grep -q '已注入自动重派段' && ok "自动重派段已注入" || bad "注入失败"
  sh -n "$WB/sa-watchdog.sh" && ok "补丁后 sa-watchdog.sh 语法通过" || bad "补丁后语法失败"
  grep -q 'retry-of=' "$WB/sa-watchdog.sh" && ok "retry-of 标记存在（auto-trigger 契约）" || bad "缺 retry-of"
  grep -q 'ESCALATE' "$WB/sa-watchdog.sh" && ok "升级路径存在" || bad "缺 ESCALATE"

  # 关键：重派段必须落在 STOP 分支内，而不是 active 分支（否则正常活跃工单会被误重派）。
  # 位置约束：'ERROR stop' 行 < 重派标记 < 文件尾；且重派标记出现在 'idle < FLAG_S' 之后。
  L_ACTIVE=$(grep -n 'idle < FLAG_S' "$WB/sa-watchdog.sh" | head -1 | cut -d: -f1)
  L_ERRSTOP=$(grep -n 'ERROR stop' "$WB/sa-watchdog.sh" | head -1 | cut -d: -f1)
  L_MARK=$(grep -n 'v2 自动重派' "$WB/sa-watchdog.sh" | head -1 | cut -d: -f1)
  if [ -n "$L_MARK" ] && [ -n "$L_ERRSTOP" ] && [ "$L_MARK" -gt "$L_ERRSTOP" ]; then
    ok "重派段位于 STOP 分支内（mark=$L_MARK > ERROR stop=$L_ERRSTOP）"
  else
    bad "重派段未落在 STOP 分支（active=$L_ACTIVE errstop=$L_ERRSTOP mark=$L_MARK）"
  fi
  if [ -n "$L_MARK" ] && [ -n "$L_ACTIVE" ] && [ "$L_MARK" -gt "$L_ACTIVE" ]; then
    ok "重派段不在 active 分支（mark > FLAG_S=$L_ACTIVE）"
  else
    bad "重派段误入 active 分支（mark=$L_MARK <= FLAG_S=$L_ACTIVE）"
  fi
  # active 分支不得含 retry-of（防止误重派活跃工单）
  ACTIVE_BLOCK=$(sed -n "${L_ACTIVE},${L_ERRSTOP}p" "$WB/sa-watchdog.sh" 2>/dev/null)
  echo "$ACTIVE_BLOCK" | grep -q 'retry-of' && bad "active 分支误含重派逻辑" \
                                            || ok "active 分支无重派逻辑"

  OUT2=$(sh "$V2" --apply --bin "$WB" 2>&1)
  echo "$OUT2" | grep -q '已注入自动重派段，跳过' && ok "重复 --apply 幂等" || bad "重复 --apply 不幂等"
fi

say ""
say "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" = "0" ] || exit 1
