#!/usr/bin/env bash
# 02-eu-delivery.sh —— G2「投递链」逐项取证 2.1 - 2.10【只读】
#
# 对应 issue #61 表格 G2 前半（2.11-2.14 在 03-eu-models.sh）。EU 侧运行。
#
# 覆盖条目：
#   2.1  TG 文本回复送达
#   2.2  TG 长文切分（MAX_LEN）送达
#   2.3  TG 图片出站 [IMG:路径] 传输接线 + 白名单
#   2.4  TG 语音出站（TTS）
#   2.5  TG 视频/文件出站
#   2.6  WhatsApp 通道状态（已禁用 → 预期不通过/INFO）
#   2.7  消息顺序与并发（同一 channel 串行）
#   2.8  /stop 立即中断
#   2.9  失败可见性（handle 异常必回一句可诊断错误）
#   2.10 长任务进度回传（progressRoute）
#
# 只读保证：grep/tail/stat/md5sum/docker exec(只读)。不重启、不写任何被检文件。

set -uo pipefail
EM_SELF="$0"
source "$(dirname "$0")/_lib.sh"

em_parse_args "$@"
if [ "${EM_SHOW_HELP}" = "1" ]; then em_usage_header "02-eu-delivery.sh" "G2 投递链逐项取证（2.1-2.10）"; exit 0; fi

EM_HOST_ROLE="EU"
em_init "02" "G2 投递链逐项取证"

WAGATE_CT="${WAGATE_CT:-wagate}"
HOST_BOT="${HOST_BOT:-/srv/wagate/patches/bot.ts}"
HOST_TS="${HOST_TS:-/srv/wagate/patches/telegram.ts}"
CT_BOT="${CT_BOT:-/app/bot.ts}"
CT_TS="${CT_TS:-/app/vendor-pi-gateway-src/adapters/telegram.ts}"
CT_WHATSAPP="${CT_WHATSAPP:-/app/vendor-pi-gateway-src/adapters/whatsapp.ts}"
CT_IMG="${CT_IMG:-/app/extensions/plugins/img-ops.ts}"
TG_TOKEN_FILE="${TG_TOKEN_FILE:-/srv/wagate/tg.token}"
SNAP_DIR="${SNAP_DIR:-$(cd "$(dirname "$0")" && pwd)/../eu-fix-img-voice/context}"

em_note "2.x 的"送达"类条目无法用机器单方面证明"用户真的看到了"，脚本给出发送链路证据 + 日志证据，最终判定以 README「人工回归清单」的实收截图为准。"

DOCKER_OK=0
run_capture "$EM_TIMEOUT_DEFAULT" docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$WAGATE_CT" && DOCKER_OK=1
em_check "前置" "容器 ${WAGATE_CT} 在运行" "$([ "$DOCKER_OK" = 1 ] && printf PASS || printf FAIL)" \
  "docker ps $([ "$DOCKER_OK" = 1 ] && printf '命中' || printf '未命中') ${WAGATE_CT}" "容器不在位则投递类条目全部只能静态取证"

grab() { local out=""; [ "$DOCKER_OK" = 1 ] && out=$(em_docker_exec "$EM_TIMEOUT_DEFAULT" "$WAGATE_CT" cat "$1"); [ -z "$out" ] && out=$(run_capture "$EM_TIMEOUT_DEFAULT" cat "$2" 2>/dev/null || true); printf '%s' "$out"; }

BOTSRC=$(grab "$CT_BOT" "$HOST_BOT")
TGTS=$(grab "$CT_TS" "$HOST_TS")
if [ -z "$BOTSRC" ]; then
  em_check "前置" "bot.ts 可读" FAIL "容器与主机均未取到 bot.ts" "确认 ${HOST_BOT} 挂载"
fi

# 日志（容器优先，journald 兜底）
LOGS=""
if [ "$DOCKER_OK" = 1 ]; then
  LOGS=$(em_docker_exec "$EM_TIMEOUT_NET" "$WAGATE_CT" sh -c "tail -n 6000 /app/logs/wagate.log 2>/dev/null" 2>/dev/null)
fi
[ -z "$LOGS" ] && LOGS=$(run_capture "$EM_TIMEOUT_NET" sh -c "journalctl -u wagate --since '48 hours ago' --no-pager 2>/dev/null | tail -6000" || true)
LOGS=$(em_mask_text "${LOGS:-}")
[ -z "$LOGS" ] && em_check "前置" "运行日志可读" WARN "未取到 wagate 日志" "日志相关判定降级为静态代码证据"

# ---------------------------------------------------------------------------
# 2.1 TG 文本回复送达
# ---------------------------------------------------------------------------
em_section "2.1 TG 文本回复送达"
em_cmd "2.1" "bash 02-eu-delivery.sh 2>&1 | grep -A4 '2.1'"

SEND=$(printf '%s' "$TGTS" | grep -nE "sendMessage" | head -3)
[ -n "$SEND" ] && em_check "2.1" "telegram.ts sendMessage 实现" PASS "$(printf '%s' "$SEND" | tr '\n' ' ' | cut -c1-240)" "" \
  || em_check "2.1" "telegram.ts sendMessage 实现" FAIL "telegram.ts 未见 sendMessage" "适配层不完整，文本回复无出口"

# getMe：只读验证返回通道可用（token 不落盘、不回显）
if [ -r "$TG_TOKEN_FILE" ] && em_have curl; then
  ME=$(em_mask_text "$(run_capture "$EM_TIMEOUT_NET" curl -sS "https://api.telegram.org/bot$(tr -d '\n' <"$TG_TOKEN_FILE")/getMe" 2>/dev/null || true)")
  if printf '%s' "$ME" | grep -q '"ok":true'; then
    em_check "2.1" "TG Bot API 可达（getMe ok）" PASS "getMe 返回 ok=true：$(printf '%s' "$ME" | cut -c1-160)" ""
  else
    em_check "2.1" "TG Bot API 可达" FAIL "getMe 非 ok：$(printf '%s' "$ME" | cut -c1-200)" "查 token/出网/代理"
  fi
else
  em_check "2.1" "TG Bot API 可达" WARN "缺少 ${TG_TOKEN_FILE} 或 curl" "该检查可跳过；以日志中 sendMessage 成功为准"
fi

SENT=$(printf '%s' "$LOGS" | grep -ciE "sendMessage|outbound" || true)
em_check "2.1" "近期出站发送日志" "$([ "${SENT:-0}" -gt 0 ] && printf PASS || printf WARN)" "48h 内出站相关日志 ${SENT:-0} 条" "0 条不判失败"
em_manual "2.1" "真实 TG 文本实收" "需人工：发一句文本，回贴 bot 回复截图 + 时间戳（这是本项唯一有效证据）"

# ---------------------------------------------------------------------------
# 2.2 长文切分送达
# ---------------------------------------------------------------------------
em_section "2.2 TG 长文切分（MAX_LEN）"
em_cmd "2.2" "bash 02-eu-delivery.sh 2>&1 | grep -A4 '2.2'"

SPLIT=$(printf '%s' "$BOTSRC" | grep -nE "MAX_LEN|slice\(i" | head -4)
if [ -n "$SPLIT" ]; then
  em_check "2.2" "长文切分实现（MAX_LEN 循环）" PASS "$(printf '%s' "$SPLIT" | tr '\n' ' ' | cut -c1-300)" ""
  MLEN=$(printf '%s' "$BOTSRC" | grep -oE "MAX_LEN[[:space:]]*=[[:space:]]*[0-9]+" | head -1)
  [ -n "$MLEN" ] && em_note "切分阈值：${MLEN}（TG 单条上限约 4096 字符）"
else
  em_check "2.2" "长文切分实现" FAIL "bot.ts 未见 MAX_LEN 切分" "超长回复会发送失败或被截断"
fi
SPLIT_LOG=$(printf '%s' "$LOGS" | grep -ciE "slice|chunk|too long" || true)
em_check "2.2" "切分痕迹日志" INFO "48h 内 ${SPLIT_LOG:-0} 条" ""
em_manual "2.2" "真实长文回复" "需人工：让 bot 输出 >4096 字符（如"分段列出 200 条"），确认多条消息按序到达且无截断"

# ---------------------------------------------------------------------------
# 2.3 图片出站（[IMG:路径] 传输接线）
# ---------------------------------------------------------------------------
em_section "2.3 TG 图片出站（[IMG:路径] 接线）"
em_cmd "2.3" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.3'"

IMGRE=$(printf '%s' "$BOTSRC" | grep -nE "\[IMG:|imgRe" | head -4)
if [ -n "$IMGRE" ]; then
  em_check "2.3" "[IMG:路径] 标记解析" PASS "$(printf '%s' "$IMGRE" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "2.3" "[IMG:路径] 标记解析" FAIL "bot.ts 未见 [IMG:] 接线" "图片成品无法出站"
fi
SAFE=$(printf '%s' "$BOTSRC" | grep -nE "TENANT_ROOT|白名单|extname|\.png|\.jpg" | head -4)
if [ -n "$SAFE" ]; then
  em_check "2.3" "路径安全约束（前缀 + 扩展名白名单）" PASS "$(printf '%s' "$SAFE" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "2.3" "路径安全约束" WARN "未见 TENANT_ROOT 前缀/扩展名白名单约束" "若确实缺失则为越权读文件风险，需人工确认"
fi
IMGOPS=$(grab "$CT_IMG" "/srv/wagate/patches/img-ops.ts")
if [ -n "$IMGOPS" ]; then
  SRC_LATEST=$(printf '%s' "$IMGOPS" | grep -nE "source-latest|图片任务处理指引" | head -3)
  [ -n "$SRC_LATEST" ] && em_check "2.3" "img-ops 产物落盘约定" PASS "$(printf '%s' "$SRC_LATEST" | tr '\n' ' ' | cut -c1-240)" "" \
    || em_check "2.3" "img-ops 产物落盘约定" WARN "未见 source-latest.png / 处理指引" "确认插件版本"
fi
IMG_SENT=$(printf '%s' "$LOGS" | grep -ciE "sendPhoto|\[IMG:" || true)
em_check "2.3" "近期图片出站日志" INFO "48h 内 ${IMG_SENT:-0} 条" ""
em_manual "2.3" "真实 TG 收图" "需人工：让 bot 生成一张图（如"画一张红色圆形"），确认收到图片附件而非路径文本"

# ---------------------------------------------------------------------------
# 2.4 语音出站（TTS）
# ---------------------------------------------------------------------------
em_section "2.4 TG 语音出站（TTS）"
em_cmd "2.4" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.4'"

VOICE_OUT=$(printf '%s' "$TGTS" | grep -nE "sendVoice|sendAudio" | head -3)
if [ -n "$VOICE_OUT" ]; then
  em_check "2.4" "telegram.ts 语音发送实现" PASS "$(printf '%s' "$VOICE_OUT" | tr '\n' ' ' | cut -c1-240)" ""
else
  em_check "2.4" "telegram.ts 语音发送实现" FAIL "telegram.ts 未见 sendVoice/sendAudio" "TTS 产物无出站通道"
fi
TTS_HITS=$(printf '%s' "$LOGS" | grep -ciE "tts|voice|opus" || true)
em_check "2.4" "近期 TTS/语音日志" INFO "48h 内 ${TTS_HITS:-0} 条" ""
em_manual "2.4" "真实语音回复" "需人工：触发一次语音回复，确认可播放；若为文件（.oga/.ogg 附件）而非语音气泡，如实记录"

# ---------------------------------------------------------------------------
# 2.5 视频/文件出站
# ---------------------------------------------------------------------------
em_section "2.5 TG 视频/文件出站"
em_cmd "2.5" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.5'"

VID_OUT=$(printf '%s' "$TGTS" | grep -nE "sendVideo|sendDocument" | head -3)
if [ -n "$VID_OUT" ]; then
  em_check "2.5" "telegram.ts 视频/文件发送实现" PASS "$(printf '%s' "$VID_OUT" | tr '\n' ' ' | cut -c1-240)" ""
else
  em_check "2.5" "telegram.ts 视频/文件发送实现" FAIL "telegram.ts 未见 sendVideo/sendDocument" \
    "视频/成品文件无法出站（与 G1 1.5 视频入口缺口同源，需一并确认）"
fi
em_manual "2.5" "真实收视频/文件" "需人工：请求一段转码后视频或一个成品文件，确认收到可用附件"

# ---------------------------------------------------------------------------
# 2.6 WhatsApp 通道（已禁用）
# ---------------------------------------------------------------------------
em_section "2.6 WhatsApp 通道状态"
em_cmd "2.6" "bash 02-eu-delivery.sh 2>&1 | grep -A4 '2.6'"

WA_SRC=$(grab "$CT_WHATSAPP" "/srv/wagate/patches/whatsapp.ts")
WA_ENABLED=$(printf '%s' "$LOGS" | grep -ciE "whatsapp.*(connected|ready|qr)" || true)
WA_PRESENT=$([ -n "$WA_SRC" ] && printf yes || printf no)
em_check "2.6" "WhatsApp 通道状态" INFO \
  "适配器文件在位=${WA_PRESENT}（快照 md5 e232797d4fae1f113ce59b11bd7f563c）；48h 内 WA 活动日志 ${WA_ENABLED:-0} 条" \
  "按 CONTEXT.md，WA 通道已禁用：本项以"未启用且不影响 TG"为通过语义；若产品要求启用，属新需求，不在本包范围"
em_manual "2.6" "WA 是否需要启用" "需人工判定：本矩阵只记录"已禁用"事实；启用属新需求"

# ---------------------------------------------------------------------------
# 2.7 消息顺序与并发
# ---------------------------------------------------------------------------
em_section "2.7 消息顺序与并发"
em_cmd "2.7" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.7'"

QUEUE=$(printf '%s' "$BOTSRC" | grep -nE "队列|queue|progressRoute" | head -4)
if [ -n "$QUEUE" ]; then
  em_check "2.7" "同 channel 串行/队列机制" PASS "$(printf '%s' "$QUEUE" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "2.7" "同 channel 串行/队列机制" WARN "bot.ts 未见显式队列" "核心队列可能在 tenant-core；人工确认并发模型"
fi
EMPTY_SKIP=$(printf '%s' "$BOTSRC" | grep -nE "if \(!body.trim\(\)\) continue" | head -2)
[ -n "$EMPTY_SKIP" ] && em_check "2.7" "空回复不发空消息" PASS "命中空回复跳过（避免 TG 发送失败）" "" \
  || em_check "2.7" "空回复不发空消息" INFO "未定位到该守卫" "非必需项，记录即可"
em_manual "2.7" "并发两条指令的顺序性" "需人工：同一 TG 会话快速连发两条指令，确认回复顺序与指令顺序一致且无串台"

# ---------------------------------------------------------------------------
# 2.8 /stop 立即中断
# ---------------------------------------------------------------------------
em_section "2.8 /stop 立即中断"
em_cmd "2.8" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.8'"

STOP=$(printf '%s' "$BOTSRC" | grep -nE "_isStopIntent|/stop|__abortActive" | head -5)
if [ -n "$STOP" ]; then
  em_check "2.8" "/stop 立即中断实现" PASS "$(printf '%s' "$STOP" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "2.8" "/stop 立即中断实现" FAIL "bot.ts 未见 /stop 中断路径" "长任务将无法停止"
fi
STOP_LOG=$(printf '%s' "$LOGS" | grep -ciE "\[bot\] /stop 立即中断" || true)
em_check "2.8" "近期 /stop 命中日志" INFO "48h 内 ${STOP_LOG:-0} 条" ""
em_manual "2.8" "真实 /stop" "需人工：起一个长任务后发 /stop，回贴 bot 回复与任务确实停止的证据"

# ---------------------------------------------------------------------------
# 2.9 失败可见性
# ---------------------------------------------------------------------------
em_section "2.9 失败可见性（异常必回可诊断错误）"
em_cmd "2.9" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.9'"

ERRPATH=$(printf '%s' "$BOTSRC" | grep -nE "handle failed|处理失败" | head -3)
if [ -n "$ERRPATH" ]; then
  em_check "2.9" "handle 异常回可诊断错误" PASS "$(printf '%s' "$ERRPATH" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "2.9" "handle 异常回可诊断错误" FAIL "未见 catch 分支回错误文本" "用户会静默等待"
fi
ERR_LOG=$(printf '%s' "$LOGS" | grep -ciE "handle failed|unhandled rejection" || true)
em_check "2.9" "近期异常日志" INFO "48h 内 ${ERR_LOG:-0} 条" ">0 说明确有失败被记录；需人工确认当时用户是否收到错误提示"
em_manual "2.9" "真实故障可见性" "需人工：制造一次失败（如请求不存在的能力），确认收到可诊断错误而非沉默"

# ---------------------------------------------------------------------------
# 2.10 长任务进度回传
# ---------------------------------------------------------------------------
em_section "2.10 长任务进度回传"
em_cmd "2.10" "bash 02-eu-delivery.sh 2>&1 | grep -A5 '2.10'"

PROG=$(printf '%s' "$BOTSRC" | grep -nE "progressRoute" | head -3)
if [ -n "$PROG" ]; then
  em_check "2.10" "progressRoute 注册点" PASS "$(printf '%s' "$PROG" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "2.10" "progressRoute 注册点" FAIL "bot.ts 未见 progressRoute" "长任务无进度出口"
fi
PROG_LOG=$(printf '%s' "$LOGS" | grep -ciE "progress" || true)
em_check "2.10" "近期进度回传日志" INFO "48h 内 ${PROG_LOG:-0} 条" ""
em_manual "2.10" "真实长任务进度" "需人工：起一个 >2 分钟任务，确认期间收到至少一次进度消息（这是本项唯一有效判定）"

# ---------------------------------------------------------------------------
em_note "本脚本全部为只读命令（grep/tail/curl getMe/docker exec 只读）；未修改 EU 任何文件或进程状态。"
em_finish
exit $?
