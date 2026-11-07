#!/usr/bin/env bash
# regrF2.sh — file-only 挂起死锁修复 v2 的机械回归断言（A/B/C）+ 容器内 bun build 门
#
# 对应 issue #66 的 v2-4：**先** 容器内 `bun build /app/bot.ts`，**再** A/B/C。
# 构建不过 = 整轮 FAIL（这正是能抓住 v1「const 裸赋值崩容器」的那道网：
# v1 的门全绿却让容器死在加载期，因为没有一道门真编译过产物）。
#
# 用法：
#   bash regrF2.sh                 # live：对容器 wagate 跑真实验证（需要容器在跑）
#   bash regrF2.sh --stub          # 只打印 A/B/C 的判读口径，不做任何真实注入（无凭据环境用）
#   CONTAINER=wagate bash regrF2.sh
#   REGR_MODE=stub bash regrF2.sh
#
# 前置：容器 wagate 在跑，且 /app/bot.ts 已含 __fixF2Hold__（即已 apply）。
#       未打补丁则明确 SKIP 并退出 1（不是 FAIL：说明还没到回归阶段）。
#
# 硬约束：本脚本**只读诊断 + 一次性注入消息**；不重启服务、不改任何文件、不含任何密钥。
#        注入用的 JSON 只写 /tmp 与容器 /tmp，测试结束后清理。
#
# 退出码：0 全 PASS；1 有 FAIL（含构建失败）；2 前置不满足（环境没到回归阶段）。

set -uo pipefail

VERSION='2.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-45}"
REGR_MODE="${REGR_MODE:-live}"
WAIT_SEC="${WAIT_SEC:-25}"          # 单条断言最长等待
EVID_DIR="${EVID_DIR:-/tmp/regrF2-evidence}"
NEEDLE='__fixF2Hold__'              # 已打补丁特征串（与 fixF2-hold.sh 一致）
PENDING_NEEDLE='__fixF2PendingFiles'

while [ $# -gt 0 ]; do
  case "$1" in
    --stub)      REGR_MODE="stub" ;;
    --live)      REGR_MODE="live" ;;
    -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 查看用法）\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

PASS_N=0; FAIL_N=0; WARN_N=0; SKIP_N=0
pass() { PASS_N=$((PASS_N+1)); printf '  [PASS] %s\n' "$1"; }
fail() { FAIL_N=$((FAIL_N+1)); printf '  [FAIL] %s\n' "$1"; }
warn() { WARN_N=$((WARN_N+1)); printf '  [WARN] %s\n' "$1"; }
skip() { SKIP_N=$((SKIP_N+1)); printf '  [SKIP] %s\n' "$1"; }
hr()   { printf '%s\n' '------------------------------------------------------------------------'; }

printf '=== regrF2.sh v%s | 模式=%s | 容器=%s ===\n' "$VERSION" "$REGR_MODE" "$CONTAINER"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
mkdir -p "$EVID_DIR" 2>/dev/null || true

# --------------------------------------------------------------------------
# --stub：只打印判读口径，不做真实注入（无生产凭据的环境用这个）
# --------------------------------------------------------------------------
if [ "$REGR_MODE" = "stub" ]; then
  printf '\nstub 模式：不接触容器，仅打印 A/B/C 判读口径。\n'
  hr
  printf '门禁 0（构建）：docker exec %s bun build /app/bot.ts  -> 必须 0\n' "$CONTAINER"
  printf '                 这一条是 v1 事故的网：v1 产物加载期崩，构建即不过。\n'
  printf '用例 A（活跃任务联动，不挂起）：\n'
  printf '  先投一条文本消息造活跃任务 -> 再投纯文件消息\n'
  printf '  期望日志: [bot][fixF2] active task linked\n'
  printf '  期望日志: 用户为当前任务补充上传的文件：<文件名>   （注入句进了当轮，模型能看见）\n'
  printf '  不得出现: file-only hold（有活跃任务还 hold 就是 F1 没生效）\n'
  printf '用例 B（全新用户纯文件 -> hold -> 下一轮释放）：\n'
  printf '  全新用户 regrF2-b 投纯文件 -> 期望 [bot][fixF2] file-only hold\n'
  printf '  下一轮带文字 -> 期望 [bot][fixF2] hold release: pending file merged into this turn\n'
  printf '用例 C（FILE_AUTO_ROUTE=0 直通）：\n'
  printf '  期望: 不 hold、不联动，直接进 handle（旧行为保留）\n'
  hr
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN / %d SKIP ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N" "$SKIP_N"
  printf 'stub 模式不产生真实验证结论；live 需容器在跑。\n'
  exit 0
fi

# --------------------------------------------------------------------------
# 前置检查
# --------------------------------------------------------------------------
printf '\n-- 前置检查 --\n'
if ! command -v "$DOCKER" >/dev/null 2>&1; then
  # 前置不满足 ≠ 回归失败：用 SKIP 语义 + exit 2，避免把「环境没到」误报成「修复有问题」。
  skip "找不到 $DOCKER（本机没有 docker CLI）—— 环境不具备，未到回归阶段"
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN / %d SKIP ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N" "$SKIP_N"
  exit 2
fi
if ! timeout "$T_SHORT" "$DOCKER" ps --filter "name=^${CONTAINER}$" 2>/dev/null | grep -q "$CONTAINER"; then
  skip "容器 $CONTAINER 未在运行（先 systemctl status wagate / docker ps 确认）—— 环境不具备，未到回归阶段"
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN / %d SKIP ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N" "$SKIP_N"
  exit 2
fi
pass "容器 $CONTAINER 在运行"

if timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc "grep -q '$NEEDLE' /app/bot.ts" 2>/dev/null; then
  pass "容器内 /app/bot.ts 已含 $NEEDLE（已 apply）"
else
  skip "容器内 /app/bot.ts 未含 $NEEDLE —— 还没 apply，回归阶段未到"
  printf '\n先执行：bash fixes/fixF2-hold.sh --apply（并**先**验证 bun build，再重启）\n'
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN / %d SKIP ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N" "$SKIP_N"
  exit 2
fi

# --------------------------------------------------------------------------
# 门禁 0（v2-4，最关键）：容器内真编译产物
#   这是唯一能在「重启前」抓住 v1 式崩溃的门：const 裸赋值在 bun 加载/编译期即抛。
#   构建失败 = 整轮 FAIL，后面的 A/B/C 不再跑（产物都不合法，跑用例没有意义）。
# --------------------------------------------------------------------------
hr
printf '门禁 0：容器内 bun build（v2-4；构建不过则整轮 FAIL）\n'
BUILD_OUT=$(timeout "$T_LONG" "$DOCKER" exec "$CONTAINER" sh -lc 'bun build /app/bot.ts 2>&1' 2>&1)
BUILD_RC=$?
printf '%s\n' "$BUILD_OUT" | sed -n '1,15p' | sed 's/^/    /'
if [ "$BUILD_RC" -eq 0 ] && ! printf '%s' "$BUILD_OUT" | grep -qiE 'error|throw|will throw'; then
  pass "门禁 0 通过：容器内 bun build /app/bot.ts 成功（产物加载期合法）"
else
  fail "门禁 0 失败：容器内 bun build /app/bot.ts 不通过（rc=$BUILD_RC）—— 产物会让容器崩，禁止重启"
  printf '    判读：若报 "will throw because ... is a constant"，即为 v1 的 const 裸赋值事故重演。\n'
  printf '    处置：立刻回退 bash fixes/fixF2-hold.sh --rollback --from <戳>，不要重启。\n'
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN / %d SKIP ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N" "$SKIP_N"
  exit 1
fi

# --------------------------------------------------------------------------
# 注入 helper
# --------------------------------------------------------------------------
collect_log() { timeout "$T_SHORT" "$DOCKER" logs --since 10m "$CONTAINER" 2>&1 | tail -n 400; }

# assert_log <子串> <说明> —— 轮询等待，命中即 PASS
assert_log() {
  local sub="$1" desc="$2" waited=0
  while [ "$waited" -lt "$WAIT_SEC" ]; do
    if collect_log | grep -qF "$sub"; then pass "$desc（日志命中: $sub）"; return 0; fi
    sleep 2; waited=$((waited+2))
  done
  fail "$desc（等了 ${WAIT_SEC}s 没等到日志: $sub）"
  printf '    最近日志尾部：\n'; collect_log | tail -n 12 | sed 's/^/      /'
  return 1
}

# refute_log <子串> <说明> —— 窗口内**不得**出现
refute_log() {
  local sub="$1" desc="$2"
  if collect_log | grep -qF "$sub"; then
    fail "$desc（日志里出现了不该有的: $sub）"
    return 1
  fi
  pass "$desc（未出现 $sub）"
  return 0
}

# inject <json文件> —— 把一条消息投进容器（只写 /tmp，测完清）
inject() {
  local src="$1"
  if ! timeout "$T_SHORT" "$DOCKER" cp "$src" "$CONTAINER:/tmp/regrF2-inject.json" 2>/dev/null; then
    fail "注入失败：docker cp $src -> $CONTAINER:/tmp/regrF2-inject.json"
    return 1
  fi
  timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc 'cat /tmp/regrF2-inject.json > /tmp/regrF2-inbox.jsonl' 2>/dev/null || true
  return 0
}

# --------------------------------------------------------------------------
# 用例 A：活跃任务联动 —— 有活跃任务时纯文件**不挂起**
# --------------------------------------------------------------------------
hr
printf '用例 A：活跃任务联动（file-only 不挂起，且文件进入当轮）\n'
A_TXT="$EVID_DIR/A-text.json"; A_FILE="$EVID_DIR/A-file.json"
cat > "$A_TXT" <<'JSON'
{"platform":"regr","userId":"regrF2-a","channelId":"regrF2-a-chan","content":"帮我分析一下这份数据","msgType":"text"}
JSON
cat > "$A_FILE" <<'JSON'
{"platform":"regr","userId":"regrF2-a","channelId":"regrF2-a-chan","content":"","msgType":"file","file":{"fileName":"regrF2-A.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","data":""}}
JSON
inject "$A_TXT"  && printf '  已投：文本（造活跃任务）\n'
sleep 3
inject "$A_FILE" && printf '  已投：纯文件（应联动到活跃任务）\n'
assert_log "[bot][fixF2] active task linked" "A1 活跃任务联动命中（未走 hold）"
assert_log "用户为当前任务补充上传的文件：regrF2-A.xlsx" "A2 注入句进入当轮（模型可见该文件）"
refute_log "file-only hold" "A3 有活跃任务时不得 hold"

# --------------------------------------------------------------------------
# 用例 B：全新用户纯文件 -> hold -> 下一轮文字释放
# --------------------------------------------------------------------------
hr
printf '用例 B：全新用户纯文件 hold -> 下一轮带文字释放（死锁解除）\n'
B_FILE="$EVID_DIR/B-file.json"; B_TXT="$EVID_DIR/B-text.json"
cat > "$B_FILE" <<'JSON'
{"platform":"regr","userId":"regrF2-b","channelId":"regrF2-b-chan","content":"","msgType":"file","file":{"fileName":"regrF2-B.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","data":""}}
JSON
cat > "$B_TXT" <<'JSON'
{"platform":"regr","userId":"regrF2-b","channelId":"regrF2-b-chan","content":"用它做一份PPT","msgType":"text"}
JSON
inject "$B_FILE" && printf '  已投：全新用户纯文件（应 hold）\n'
assert_log "[bot][fixF2] file-only hold" "B1 全新用户纯文件正确 hold（旧行为保留）"
inject "$B_TXT" && printf '  已投：下一轮带文字（应释放上一轮的文件）\n'
assert_log "[bot][fixF2] hold release: pending file merged into this turn" "B2 下一轮成功释放 pending 文件（死锁解除）"

# --------------------------------------------------------------------------
# 用例 C：FILE_AUTO_ROUTE=0 直通（旧行为保留）
# --------------------------------------------------------------------------
hr
printf '用例 C：FILE_AUTO_ROUTE=0 直通不 hold\n'
if timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc 'grep -q "FILE_AUTO_ROUTE" /app/bot.ts' 2>/dev/null; then
  C_FILE="$EVID_DIR/C-file.json"
  cat > "$C_FILE" <<'JSON'
{"platform":"regr","userId":"regrF2-c","channelId":"regrF2-c-chan","content":"","msgType":"file","file":{"fileName":"regrF2-C.xlsx","mimeType":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","data":""}}
JSON
  printf '  提示：env FILE_AUTO_ROUTE=0 需在重启时生效；本用例按「直通分支存在」判定。\n'
  if timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc 'printenv FILE_AUTO_ROUTE' 2>/dev/null | grep -q '^0$'; then
    inject "$C_FILE" && printf '  已投：纯文件（FILE_AUTO_ROUTE=0）\n'
    refute_log "file-only hold" "C1 FILE_AUTO_ROUTE=0 时不得 hold（直通旧行为）"
  else
    skip "C：容器 env FILE_AUTO_ROUTE 非 0，直通分支本次不可观测（改行为需重启，操作员决定）"
  fi
else
  skip "C：/app/bot.ts 未见 FILE_AUTO_ROUTE 判定分支"
fi

# --------------------------------------------------------------------------
hr
printf '清理注入文件…\n'
timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc 'rm -f /tmp/regrF2-inject.json /tmp/regrF2-inbox.jsonl' 2>/dev/null || true
rm -f "$EVID_DIR"/A-*.json "$EVID_DIR"/B-*.json "$EVID_DIR"/C-*.json 2>/dev/null || true

printf '\n判读：门禁 0（bun build）必须过才允许重启；A/B/C 全 PASS 才算修复生效。\n'
printf '回退：bash fixes/fixF2-hold.sh --rollback --from <戳>\n'
printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN / %d SKIP ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N" "$SKIP_N"
exit $([ "$FAIL_N" -eq 0 ] && echo 0 || echo 1)
