#!/usr/bin/env bash
# regrD.sh —— 故障修复 D 机械回归：一键重跑，验证「工单结果必定回传 TG」
#
# 对应 issue #40 要求②：机械回归（一键重跑）。
#
# 本脚本在 EU 服务器 5.189.129.216 上运行，**不改任何生产文件、不发任何真实 TG 消息**：
# 它用合成数据驱动真实的 poller 代码，走完整的「读映射 → 判终态 → 组消息 → 去重」链路，
# 只在最后一步把「发送」替换成落盘记录（WAGATE_DISPATCH_DRY=1）。
#
# 执行位置：EU 5.189.129.216
# 参数：
#   无            跑全部用例
#   --offline     只跑不需要 GitHub 令牌的用例（离线沙箱用；跳过 GH 查询类断言）
#   --keep        保留临时目录便于排查
# 预期时长：<90s（每个用例一次 poller 调用，无等待）
#
# 前置：fixD-tgpush.sh --apply 已成功（poller 与 runner 已落盘、映射文件已在用）。
#
# 退出码：0 = REGR_PASS；非 0 = REGR_FAIL（并打印哪条断言挂了）
set -u

OFFLINE=0
KEEP=0
for a in "$@"; do
  case "$a" in
    --offline) OFFLINE=1 ;;
    --keep)    KEEP=1 ;;
    *) echo "[regrD] [FATAL] 未知参数：$a（可用：--offline | --keep）" >&2; exit 2 ;;
  esac
done

PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
POLLER="${POLLER:-$PATCH_DIR/aa-dev-tgpush-poll.ts}"
POLLER_IN_CONTAINER="${POLLER_IN_CONTAINER:-/app/aa-dev-tgpush-poll.ts}"
CONTAINER="${CONTAINER:-wagate}"
HOST_ISSUE="${HOST_ISSUE:-40}"      # 用真实存在且已关闭的 issue 当「已终结工单」样本
HOST_ISSUE_OPEN="${HOST_ISSUE_OPEN:-}"  # 可选：一张仍开着的工单，用于验证「未终结不误报」

WORK=$(mktemp -d /tmp/regrD.XXXXXX) || { echo "[regrD] [FATAL] mktemp 失败" >&2; exit 1; }
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0
FAIL=0
note() { printf '[regrD] %s\n' "$*"; }
hr()   { printf '\n===== %s =====\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '[regrD]   ✅ %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '[regrD]   ❌ %s\n' "$*"; }
check(){ # check <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then ok "$1（= $2）"; else bad "$1：实际 [$2] 期望 [$3]"; fi
}
checkne(){ # checkne <描述> <实际> <不应等于>
  if [ "$2" != "$3" ]; then ok "$1"; else bad "$1：实际 [$2] 不应等于 [$3]"; fi
}

hr "0/5 前置检查"
[ -f "$POLLER" ] || { echo "[regrD] [FATAL] 找不到 poller：$POLLER（请先跑 fixes/fixD-tgpush.sh --apply）" >&2; exit 1; }
note "poller：$POLLER（$(wc -l < "$POLLER") 行）"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"; then
  RUNNER_MODE="docker"
  docker exec "$CONTAINER" sh -c 'command -v bun >/dev/null 2>&1' \
    || { echo "[regrD] [FATAL] 容器 $CONTAINER 内没有 bun" >&2; exit 1; }
  note "执行方式：docker exec $CONTAINER bun $POLLER_IN_CONTAINER"
else
  if command -v bun >/dev/null 2>&1; then
    RUNNER_MODE="host"
    note "执行方式：宿主 bun $POLLER（容器 $CONTAINER 不可用）"
  else
    echo "[regrD] [FATAL] 既没有在跑的容器 $CONTAINER，宿主也没有 bun —— 无法执行 poller" >&2
    exit 1
  fi
fi

run_poller() {  # run_poller <mapping> <state> <alert> <extra env...>
  local mapping="$1" state="$2" alertf="$3"; shift 3
  if [ "$RUNNER_MODE" = "docker" ]; then
    docker exec \
      -e WAGATE_DISPATCH_MAPPING="$mapping" \
      -e WAGATE_DISPATCH_STATE="$state" \
      -e WAGATE_DISPATCH_ALERT_LOG="$alertf" \
      -e WAGATE_DISPATCH_DRY=1 \
      -e WAGATE_DISPATCH_TG_PUSH="${TG_PUSH:-1}" \
      -e WAGATE_DISPATCH_SILENT_MIN="${SILENT_MIN:-30}" \
      "$@" \
      "$CONTAINER" bun "$POLLER_IN_CONTAINER" 2>&1
  else
    env WAGATE_DISPATCH_MAPPING="$mapping" \
        WAGATE_DISPATCH_STATE="$state" \
        WAGATE_DISPATCH_ALERT_LOG="$alertf" \
        WAGATE_DISPATCH_DRY=1 \
        WAGATE_DISPATCH_TG_PUSH="${TG_PUSH:-1}" \
        WAGATE_DISPATCH_SILENT_MIN="${SILENT_MIN:-30}" \
        "$@" bun "$POLLER" 2>&1
  fi
}

# ---------------------------------------------------------------------------
hr "用例 1：已终结工单 → 必须产生一条带链接的回传，且标记 pushed"
# ---------------------------------------------------------------------------
M1="$WORK/m1.json"; S1="$WORK/s1.json"; A1="$WORK/a1.log"
cat > "$M1" <<EOF
[{"sid":"regrD1","chatKey":"telegram:100000001","issue":$HOST_ISSUE,
  "url":"https://github.com/VBK-AI-Agent-Gateway/superagent-playground/issues/$HOST_ISSUE",
  "title":"regrD 合成回归样本","dispatchedAt":$(( $(date +%s) * 1000 - 3600000 ))}]
EOF
echo '{}' > "$S1"; : > "$A1"
OUT1=$(run_poller "$M1" "$S1" "$A1")
printf '%s\n' "$OUT1" | sed 's/^/[regrD]     | /'

if printf '%s' "$OUT1" | grep -q '\[dry\] 本应发送到 100000001'; then
  ok "产生了发往正确 chat_id 的回传（100000001）"
else
  if [ "$OFFLINE" = "1" ]; then
    note "  （--offline：跳过发送断言；本用例依赖 GitHub 令牌判定终态）"
  else
    bad "没有产生回传 —— 检查 GitHub 令牌 / KEY_PATH 是否可用"
  fi
fi
if printf '%s' "$OUT1" | grep -q "issues/$HOST_ISSUE"; then
  ok "回传正文包含工单链接"
else
  [ "$OFFLINE" = "1" ] || bad "回传正文缺少工单链接"
fi
if grep -q '"pushed": *true' "$S1" 2>/dev/null; then
  ok "state 写入了 pushed=true（幂等标记）"
else
  [ "$OFFLINE" = "1" ] || bad "state 未写入 pushed=true"
fi

# ---------------------------------------------------------------------------
hr "用例 2：重跑 → 0 次重复推送"
# ---------------------------------------------------------------------------
OUT2=$(run_poller "$M1" "$S1" "$A1")
printf '%s\n' "$OUT2" | sed 's/^/[regrD]     | /'
if printf '%s' "$OUT2" | grep -q '\[dry\] 本应发送到'; then
  bad "重跑又发了一次 —— 幂等失效（用户会收到重复消息）"
else
  ok "重跑 0 次重复推送"
fi
if printf '%s' "$OUT2" | grep -q '已回传'; then
  ok "重跑明确报告「已回传，无需动作」"
fi

# ---------------------------------------------------------------------------
hr "用例 3：逃生阀 WAGATE_DISPATCH_TG_PUSH=0 → 完全静默"
# ---------------------------------------------------------------------------
M3="$WORK/m3.json"; S3="$WORK/s3.json"; A3="$WORK/a3.log"
cp "$M1" "$M3"; echo '{}' > "$S3"; : > "$A3"
TG_PUSH=0 OUT3=$(run_poller "$M3" "$S3" "$A3") || true
OUT3=$(TG_PUSH=0 run_poller "$M3" "$S3" "$A3")
printf '%s\n' "$OUT3" | sed 's/^/[regrD]     | /'
if printf '%s' "$OUT3" | grep -q '逃生阀'; then
  ok "逃生阀生效（明确打印跳过原因，不是静默消失）"
else
  bad "逃生阀未生效或未留痕"
fi
if printf '%s' "$OUT3" | grep -q '\[dry\] 本应发送到'; then
  bad "逃生阀开了却仍然发送"
else
  ok "逃生阀开启期间 0 次发送"
fi

# ---------------------------------------------------------------------------
hr "用例 4：静默门禁（30 分钟无终态 → 主动说话）"
# ---------------------------------------------------------------------------
OPEN_ISSUE="${HOST_ISSUE_OPEN:-1}"
if [ "$OFFLINE" = "1" ] || [ -z "$OPEN_ISSUE" ]; then
  note "  跳过（需要一张仍开着的工单；设置 HOST_ISSUE_OPEN=<n> 可启用）"
else
  M4="$WORK/m4.json"; S4="$WORK/s4.json"; A4="$WORK/a4.log"
  cat > "$M4" <<EOF
[{"sid":"regrD4","chatKey":"telegram:100000002","issue":$OPEN_ISSUE,
  "url":"https://github.com/VBK-AI-Agent-Gateway/superagent-playground/issues/$OPEN_ISSUE",
  "title":"regrD 静默门禁样本","dispatchedAt":$(( $(date +%s) * 1000 - 3600000 ))}]
EOF
  echo '{}' > "$S4"; : > "$A4"
  SILENT_MIN=30 OUT4=$(SILENT_MIN=30 run_poller "$M4" "$S4" "$A4")
  printf '%s\n' "$OUT4" | sed 's/^/[regrD]     | /'
  if printf '%s' "$OUT4" | grep -q '\[dry\] 本应发送到 100000002'; then
    ok "静默门禁触发，主动发出进度消息（用户不再经历 90 分钟静默）"
  else
    bad "静默门禁未触发 —— 这正是本次事故的原始病症"
  fi
  if printf '%s' "$OUT4" | grep -q '已派单.*分钟'; then
    ok "进度消息包含已等待时长"
  fi
fi

# ---------------------------------------------------------------------------
hr "用例 5：发送面异常必须留痕，绝不静默"
# ---------------------------------------------------------------------------
M5="$WORK/m5.json"; S5="$WORK/s5.json"; A5="$WORK/a5.log"
cp "$M1" "$M5"; echo '{}' > "$S5"; : > "$A5"
# chatKey 不是 telegram → 无法回传，必须进告警日志
python3 - "$M5" <<'PY'
import io,json,sys
p=sys.argv[1]; d=json.load(io.open(p,encoding="utf-8"))
d[0]["chatKey"]="discord:999"; io.open(p,"w",encoding="utf-8").write(json.dumps(d,ensure_ascii=False))
PY
OUT5=$(run_poller "$M5" "$S5" "$A5")
printf '%s\n' "$OUT5" | sed 's/^/[regrD]     | /'
if [ "$OFFLINE" = "1" ]; then
  note "  （--offline：跳过；该断言需要能判定终态）"
else
  if printf '%s' "$OUT5" | grep -q 'ALERT'; then
    ok "无法回传时明确告警（不静默丢弃）"
  else
    bad "无法回传时没有告警 —— 违反「绝不静默」红线"
  fi
  if grep -q 'discord:999' "$A5" 2>/dev/null; then
    ok "告警落进了 dispatch-alerts.log 可供操作员 tail"
  else
    bad "告警未落盘到 $A5"
  fi
fi

# ---------------------------------------------------------------------------
hr "汇总"
printf '\n[regrD] 通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" = "0" ]; then
  printf '[regrD] REGR_PASS\n'
  [ "$KEEP" = "1" ] && note "临时目录保留：$WORK"
  exit 0
fi
printf '[regrD] REGR_FAIL —— 上述 ❌ 即回归缺口，请把本输出交给开发\n'
note "临时目录保留：$WORK（便于排查）"
KEEP=1
trap - EXIT
exit 1
