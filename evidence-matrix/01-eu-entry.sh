#!/usr/bin/env bash
# 01-eu-entry.sh —— G1「入口与多模态」逐项取证（1.1 - 1.7）【只读】
#
# 对应 issue #61 表格 G1。在 EU 侧（5.189.129.216）运行，需 root（docker exec wagate）。
#
# 覆盖条目：
#   1.1 TG 文字入口 + 多租户识别            —— bot.ts 日志/单 channel 路由证据
#   1.2 语音消息 → DeepInfra STT 实call      —— 真实出网（唯一允许的实call 之一）
#   1.3 语音转写 opus / wav 对照             —— 实测响应前 4 字节（OggS vs RIFF）
#   1.4 图片（photo）→ vision               —— 静态代码锚点 + 日志证据
#   1.5 视频（video）→ img-lab               —— 静态代码锚点 + 日志证据
#   1.6 文件（document/excel）→ file-only hold
#   1.7 多模态去重/dedupKey 边界             —— 已知小坑：image 空 text 会撞 key
#
# 只读保证：全部命令为 grep/tail/cat/stat/docker exec(只读)/curl(只读 GET 或
#           issue #61 明确授权的模型实call)。不写 EU 任何文件（中间产物只落 /tmp）。
#
# 注：1.4/1.5 是「运行中真实代码是否已具备分支」的静态锚点取证；矩阵里这两项
#     要求的最终判定依赖真实发图/发视频回归（脚本会同时登记 MANUAL 行说明）。
#     锚点文件为 eu-fix-img-voice/context 的现场快照，md5 见快照 CONTEXT.md；
#     现场漂移时脚本只报 WARN 并打印命中行，不误判为失败。

set -uo pipefail
EM_SELF="$0"
source "$(dirname "$0")/_lib.sh"

em_parse_args "$@"
if [ "${EM_SHOW_HELP}" = "1" ]; then em_usage_header "01-eu-entry.sh" "G1 入口与多模态逐项取证（1.1-1.7）"; exit 0; fi

EM_HOST_ROLE="EU"
em_init "01" "G1 入口与多模态逐项取证"

# --- 可覆盖的现场路径（默认按 issue #61 与 CONTEXT.md 记录的部署事实）---------
WAGATE_CT="${WAGATE_CT:-wagate}"
HOST_TS="${HOST_TS:-/srv/wagate/patches/telegram.ts}"
HOST_BOT="${HOST_BOT:-/srv/wagate/patches/bot.ts}"
CT_TS="${CT_TS:-/app/vendor-pi-gateway-src/adapters/telegram.ts}"
CT_BOT="${CT_BOT:-/app/bot.ts}"
CT_IMGLAB="${CT_IMGLAB:-/app/extensions/plugins/img-lab.ts}"
CT_IMGOPS="${CT_IMGOPS:-/app/extensions/plugins/img-ops.ts}"
CT_TC="${CT_TC:-/app/vendor-pi-gateway-src/tenant-core.ts}"
DI_KEY_FILE="${DI_KEY_FILE:-/srv/secrets/_shared/deepinfra_stt}"
DI_STT_URL="${DI_STT_URL:-https://api.deepinfra.com/v1/openai/audio/transcriptions}"
TG_TOKEN_FILE="${TG_TOKEN_FILE:-/srv/wagate/tg.token}"
SNAP_DIR="${SNAP_DIR:-$(cd "$(dirname "$0")" && pwd)/../eu-fix-img-voice/context}"

em_note "快照目录 \`${SNAP_DIR}\`（eu-fix-img-voice/context）为操作员 11-05 从 EU 拉取的真实代码，md5 见其 CONTEXT.md；现场文件可能已漂移，锚点检查只作"是否具备该分支"的信息性判定。"
em_note "1.2 是本包唯一对 DeepInfra 的真实出网调用（issue #61 授权），密钥只从 \`${DI_KEY_FILE}\` 读取，不落盘、不回显。"

# ---------------------------------------------------------------------------
# 依赖与前置
# ---------------------------------------------------------------------------
if ! em_have docker; then
  em_check "前置" "docker 可用" FAIL "未找到 docker" "在 EU 主机以 root 运行；无法 docker exec wagate 时 1.1/1.4/1.5/1.6 只能靠主机挂载文件取证"
fi
if ! em_have curl; then
  em_check "前置" "curl 可用" FAIL "未找到 curl" "安装 curl 后重跑 1.2/1.3"
fi

DOCKER_OK=0
run_capture "$EM_TIMEOUT_DEFAULT" docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$WAGATE_CT" && DOCKER_OK=1
em_check "前置" "容器 ${WAGATE_CT} 在运行" "$([ "$DOCKER_OK" = 1 ] && printf PASS || printf FAIL)" \
  "$([ "$DOCKER_OK" = 1 ] && printf 'docker ps 命中 %s' "$WAGATE_CT" || printf 'docker ps 未命中 %s' "$WAGATE_CT")" \
  "容器不在位时先查 systemd unit wagate 状态（只读：systemctl status wagate）"

# 统一取文件内容：容器内优先，主机挂载兜底
grab() { # grab <容器内路径> <主机路径>
  local out=""
  if [ "$DOCKER_OK" = 1 ]; then out=$(em_docker_exec "$EM_TIMEOUT_DEFAULT" "$WAGATE_CT" cat "$1"); fi
  [ -z "$out" ] && out=$(run_capture "$EM_TIMEOUT_DEFAULT" cat "$2" 2>/dev/null || true)
  printf '%s' "$out"
}

# ===========================================================================
# 1.1 TG 文字入口 + 多租户识别
# ===========================================================================
em_section "1.1 TG 文字入口 + 多租户识别"
em_cmd "1.1" "bash 01-eu-entry.sh 2>&1 | grep -A3 '1.1'"

TGTS=$(grab "$CT_TS" "$HOST_TS")
BOTSRC=$(grab "$CT_BOT" "$HOST_BOT")

if [ -z "$TGTS" ]; then
  em_check "1.1" "telegram.ts 可读" FAIL "容器与主机均未取到 telegram.ts（容器=${CT_TS} 主机=${HOST_TS}）" \
    "确认 wagate 单元是否仍挂载 /srv/wagate/patches"
else
  em_check "1.1" "telegram.ts 可读" PASS "$(printf '%s' "$TGTS" | wc -l | tr -d ' ') 行，来源 $([ "$DOCKER_OK" = 1 ] && printf '容器 %s' "$CT_TS" || printf '主机 %s' "$HOST_TS")" ""
  TXT_HITS=$(printf '%s' "$TGTS" | grep -n "message.text" | head -3)
  if [ -n "$TXT_HITS" ]; then
    em_check "1.1" "文字消息入口分支存在" PASS "$(printf '%s' "$TXT_HITS" | tr '\n' ' ' | cut -c1-300)" ""
  else
    em_check "1.1" "文字消息入口分支存在" WARN "telegram.ts 未见 message.text 取用点" "人工确认是否有其他适配层接管文字入口"
  fi
fi

# 多租户识别：日志里同一 channel 的租户路由
if [ "$DOCKER_OK" = 1 ]; then
  TEN_LOG=$(em_docker_exec "$EM_TIMEOUT_NET" "$WAGATE_CT" sh -c "tail -n 4000 /app/logs/wagate.log 2>/dev/null || journalctl -n 4000 --no-pager 2>/dev/null" 2>/dev/null)
  [ -z "$TEN_LOG" ] && TEN_LOG=$(em_docker_exec "$EM_TIMEOUT_NET" "$WAGATE_CT" sh -c "docker logs --tail 2000 \$HOSTNAME 2>/dev/null" 2>/dev/null)
fi
if [ -z "${TEN_LOG:-}" ]; then
  TEN_LOG=$(run_capture "$EM_TIMEOUT_NET" sh -c "journalctl -u wagate --since '48 hours ago' --no-pager 2>/dev/null | tail -2000" || true)
fi
TEN_LOG=$(em_mask_text "${TEN_LOG:-}")

if [ -n "$TEN_LOG" ]; then
  CHANNELS=$(printf '%s' "$TEN_LOG" | grep -oE 'channelId[=: ]+[^ ]+' | sort -u | head -5)
  INBOUND=$(printf '%s' "$TEN_LOG" | grep -c "\[bot\] inbound" || true)
  em_check "1.1" "近期入站文字消息日志" "$([ "${INBOUND:-0}" -gt 0 ] && printf PASS || printf WARN)" \
    "48h 内 [bot] inbound ${INBOUND:-0} 条；样例 channel：$(printf '%s' "$CHANNELS" | tr '\n' ' ' | cut -c1-200)" \
    "无日志时确认日志落点（容器 /app/logs 或 journald）"
  if [ -n "$CHANNELS" ]; then
    NCH=$(printf '%s\n' "$CHANNELS" | grep -c . || true)
    em_check "1.1" "多租户（多 channel）区分能力" "$([ "${NCH:-0}" -gt 1 ] && printf PASS || printf INFO)" \
      "观察到 ${NCH:-0} 个不同 channelId" "单 channel 时不足以证明多租户隔离，建议补发第二个租户 TG 消息"
  fi
else
  em_check "1.1" "近期入站日志" WARN "未能取到 wagate 运行日志" "确认日志路径后重跑（DOCKER_OK=${DOCKER_OK}）"
fi

em_raw "$EM_TIMEOUT_DEFAULT" "journalctl -u wagate --since '2 hours ago' | grep -E '\\[bot\\] (inbound|unified)' | tail -5" \
  sh -c "journalctl -u wagate --since '2 hours ago' --no-pager 2>/dev/null | grep -E '\[bot\] (inbound|unified)' | tail -5"

# ===========================================================================
# 1.2 语音消息 → DeepInfra STT 真实调用
# ===========================================================================
em_section "1.2 语音消息 → DeepInfra STT（真实出网实call）"
em_cmd "1.2" "bash 01-eu-entry.sh 2>&1 | grep -A4 '1.2'"

# 1.2-a 代码侧：voice 分支存在（先证"入口会走 STT"）
VHITS=$(printf '%s' "$TGTS" | grep -n "voice" | head -5)
if [ -n "$VHITS" ]; then
  em_check "1.2" "telegram.ts voice 分支存在" PASS "$(printf '%s' "$VHITS" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "1.2" "telegram.ts voice 分支存在" WARN "未见 voice 分支" "确认语音入口是否由上游适配层处理"
fi

# 1.2-b 密钥可读性（只报存在性与指纹，不回显内容）
if [ -r "$DI_KEY_FILE" ]; then
  KSZ=$(run_capture 5 wc -c <"$DI_KEY_FILE" 2>/dev/null | tr -d ' ')
  KMASK=$(em_mask "$(run_capture 5 tr -d '\n' <"$DI_KEY_FILE" 2>/dev/null)")
  em_check "1.2" "DeepInfra STT 密钥可读" PASS "文件 ${DI_KEY_FILE}，长度 ${KSZ} 字节，指纹 ${KMASK}" ""
else
  em_check "1.2" "DeepInfra STT 密钥可读" FAIL "无法读取 ${DI_KEY_FILE}" "以 root 运行或修正 DI_KEY_FILE 后重跑"
fi

# 1.2-c 真实调用：一段 1 秒静音 WAV（现场生成于 /tmp，不碰被检系统）
if [ -r "$DI_KEY_FILE" ] && em_have curl; then
  WAV=$(em_tmpfile "stt-probe.wav")
  if em_have ffmpeg; then
    run_timed "$EM_TIMEOUT_NET" ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -y "$WAV" >/dev/null 2>&1
  elif em_have python3; then
    run_capture "$EM_TIMEOUT_NET" python3 -c "
import struct,sys,wave
w=wave.open(sys.argv[1],'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
w.writeframes(b'\x00\x00'*16000); w.close()" "$WAV" >/dev/null 2>&1
  fi
  if [ -s "${WAV:-/nonexistent}" ]; then
    RESP=$(em_tmpfile "stt-resp.json")
    CODE=$(run_capture "$EM_TIMEOUT_CALL" curl -sS -o "$RESP" -w '%{http_code}' \
      -X POST "$DI_STT_URL" \
      -H "Authorization: Bearer $(tr -d '\n' <"$DI_KEY_FILE")" \
      -F "model=openai/whisper-large-v3" \
      -F "file=@${WAV};type=audio/wav" 2>/dev/null || true)
    BODY=$(em_mask_text "$(run_capture 5 head -c 400 "$RESP" 2>/dev/null || true)")
    if [ "${CODE:-000}" = "200" ]; then
      em_check "1.2" "DeepInfra STT 实call（1s 静音 wav）" PASS "HTTP ${CODE}，响应摘录：${BODY}" ""
    else
      em_check "1.2" "DeepInfra STT 实call（1s 静音 wav）" FAIL "HTTP ${CODE:-无响应}，响应摘录：${BODY}" \
        "401/403 查密钥与账号额度；超时查 EU 出网策略；本条是"STT 可用性"最直接证据"
    fi
    rm -f "$WAV" "$RESP" 2>/dev/null || true
  else
    em_check "1.2" "生成探测音频" WARN "ffmpeg 与 python3 均不可用，无法生成静音 wav" "安装 ffmpeg 或 python3 后重跑"
  fi
elif ! em_have curl; then
  em_check "1.2" "DeepInfra STT 实call" WARN "缺少 curl，未执行" "安装 curl 后重跑"
fi

# 1.2-d 真实语音消息的端到端证据（机器无法发 TG 语音 → 人工回归）
em_manual "1.2" "真实 TG 语音端到端" "需人工：向 bot 发一条真实语音，回贴转写文本 + 日志中 STT 调用行"

# ===========================================================================
# 1.3 语音转写 opus / wav 对照（响应头字节）
# ===========================================================================
em_section "1.3 语音转写 opus / wav 对照（前 4 字节）"
em_cmd "1.3" "bash 01-eu-entry.sh 2>&1 | grep -A6 '1.3'"

if [ -s "${WAV:-/nonexistent}" ] || true; then
  # 复用同一段静音音频；若上一步已删除则重建
  WAV2=$(em_tmpfile "tts-probe.wav")
  if [ ! -s "$WAV2" ]; then
    if em_have ffmpeg; then
      run_timed "$EM_TIMEOUT_NET" ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=22050:cl=mono -t 1 -y "$WAV2" >/dev/null 2>&1
    elif em_have python3; then
      run_capture "$EM_TIMEOUT_NET" python3 -c "
import sys,wave
w=wave.open(sys.argv[1],'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(22050)
w.writeframes(b'\x00\x00'*22050); w.close()" "$WAV2" >/dev/null 2>&1
    fi
  fi
fi

TTS_URL="${DI_TTS_URL:-https://api.deepinfra.com/v1/openai/audio/speech}"
if [ -r "$DI_KEY_FILE" ] && em_have curl && [ -s "${WAV2:-/nonexistent}" ]; then
  # A 组：显式 response_format=opus（issue #61 期望前四字节 OggS）
  A=$(em_tmpfile "tts-opus.bin")
  AC=$(run_capture "$EM_TIMEOUT_CALL" curl -sS -o "$A" -w '%{http_code}' -X POST "$TTS_URL" \
    -H "Authorization: Bearer $(tr -d '\n' <"$DI_KEY_FILE")" -H 'Content-Type: application/json' \
    -d '{"model":"openai/tts-1","input":"evidence probe","voice":"alloy","response_format":"opus"}' 2>/dev/null || true)
  A_MAGIC=$(run_capture 5 sh -c "head -c 4 '$A' 2>/dev/null | od -An -c | tr -s ' '" 2>/dev/null || true)
  A_TXT=$(em_mask_text "$(run_capture 5 head -c 120 "$A" 2>/dev/null | tr -d '\0' || true)")

  # B 组：不带 response_format（对照组，期望 wav / RIFF）
  B=$(em_tmpfile "tts-default.bin")
  BC=$(run_capture "$EM_TIMEOUT_CALL" curl -sS -o "$B" -w '%{http_code}' -X POST "$TTS_URL" \
    -H "Authorization: Bearer $(tr -d '\n' <"$DI_KEY_FILE")" -H 'Content-Type: application/json' \
    -d '{"model":"openai/tts-1","input":"evidence probe","voice":"alloy"}' 2>/dev/null || true)
  B_MAGIC=$(run_capture 5 sh -c "head -c 4 '$B' 2>/dev/null | od -An -c | tr -s ' '" 2>/dev/null || true)

  if [ "${AC:-000}" != "200" ] || [ "${BC:-000}" != "200" ]; then
    em_check "1.3" "TTS 对照实call" FAIL "opus 组 HTTP ${AC:-无响应}；默认组 HTTP ${BC:-无响应}（opus 组响应摘录：${A_TXT}）" \
      "确认模型名/额度；本项对照的前提是两次调用都成功"
  else
    if printf '%s' "$A_MAGIC" | grep -q "O"; then
      em_check "1.3" "response_format=opus 前 4 字节" PASS "A 组=${A_MAGIC}" ""
    else
      em_check "1.3" "response_format=opus 前 4 字节" FAIL "A 组=${A_MAGIC}（期望 OggS）" \
        "若返回 RIFF 说明服务端忽略 response_format —— 这正是本项要抓的回归"
    fi
    if printf '%s' "$B_MAGIC" | grep -qi "R"; then
      em_check "1.3" "不带 response_format 对照组" PASS "B 组=${B_MAGIC}（期望 wav/RIFF）" ""
    else
      em_check "1.3" "不带 response_format 对照组" WARN "B 组=${B_MAGIC}" "与服务端默认格式不符合预期时人工确认模型默认值"
    fi
    em_note "1.3 对照组字节（脱敏后）：A(opus)=${A_MAGIC}　B(default)=${B_MAGIC}"
  fi
  rm -f "$A" "$B" "$WAV2" 2>/dev/null || true
else
  em_check "1.3" "TTS 对照实call" WARN "前置不足（需可读密钥 + curl + 可生成音频）" "配齐后重跑"
fi
em_manual "1.3" "真实语音回复格式" "需人工：接收 bot 语音回复，确认可在 TG 播放（客户端能播即格式正确）"

# ===========================================================================
# 1.4 图片（photo）→ vision
# ===========================================================================
em_section "1.4 图片（photo）→ vision"
em_cmd "1.4" "bash 01-eu-entry.sh 2>&1 | grep -A5 '1.4'"

PH_HITS=$(printf '%s' "$TGTS" | grep -nE "msg\.photo|photo:" | head -5)
if [ -n "$PH_HITS" ]; then
  em_check "1.4" "telegram.ts photo 分支（快照/现场）" PASS "$(printf '%s' "$PH_HITS" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "1.4" "telegram.ts photo 分支（快照/现场）" FAIL \
    "telegram.ts 未见 msg.photo 分支（快照 md5 249f485718ea7f42695c98f62c52797c 亦无 photo 分支）" \
    "这正是 tri-a2/eufix2 系列补丁要修的点；确认补丁是否已 apply（只读检查：md5sum ${HOST_TS}）"
fi

IMG_CONSUME=$(printf '%s' "$BOTSRC" | grep -nE "image,|\\bimage\\b" | head -3)
if [ -n "$IMG_CONSUME" ]; then
  em_check "1.4" "bot.ts 消费 image 字段（现成管道）" PASS "$(printf '%s' "$IMG_CONSUME" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "1.4" "bot.ts 消费 image 字段" WARN "bot.ts 未见 image 透传点" "人工确认 image 通道是否改名"
fi

IMGOPS=$(grab "$CT_IMGOPS" "/srv/wagate/patches/img-ops.ts")
if [ -n "$IMGOPS" ]; then
  if printf '%s' "$IMGOPS" | grep -q "before_agent_start"; then
    em_check "1.4" "img-ops.ts before_agent_start 注入" PASS "命中 before_agent_start，插件管道在位" ""
  else
    em_check "1.4" "img-ops.ts before_agent_start 注入" WARN "未见 before_agent_start" "确认插件是否加载（bun import 冒烟）"
  fi
fi

VISION_LOG=$(printf '%s' "${TEN_LOG:-}" | grep -cE "unified message type=image|__pendingImage|收到图片" || true)
em_check "1.4" "近期图片轮次日志" "$([ "${VISION_LOG:-0}" -gt 0 ] && printf PASS || printf WARN)" \
  "48h 内图片相关日志 ${VISION_LOG:-0} 条" "无日志属正常（近 48h 无人发图），最终判定以真实发图回归为准"
em_manual "1.4" "真实 TG 发图 → vision 识别" "需人工：发一张可辨识内容的图 + 问题，回贴模型回答与图片描述"

# ===========================================================================
# 1.5 视频（video）→ img-lab
# ===========================================================================
em_section "1.5 视频（video）→ img-lab"
em_cmd "1.5" "bash 01-eu-entry.sh 2>&1 | grep -A5 '1.5'"

VD_HITS=$(printf '%s' "$TGTS" | grep -nE "msg\.video|video:" | head -5)
if [ -n "$VD_HITS" ]; then
  em_check "1.5" "telegram.ts video 分支（快照/现场）" PASS "$(printf '%s' "$VD_HITS" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "1.5" "telegram.ts video 分支（快照/现场）" FAIL \
    "telegram.ts 未见 video 分支（CONTEXT.md 指出只有 document/voice 分支）" \
    "与 1.4 同源缺口；补丁需同时补 telegram.ts video 分支 + bot.ts videos 透传"
fi

VIDS=$(printf '%s' "$BOTSRC" | grep -nE "videos" | head -3)
if [ -n "$VIDS" ]; then
  em_check "1.5" "bot.ts 透传 videos" PASS "$(printf '%s' "$VIDS" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "1.5" "bot.ts 透传 videos" FAIL "bot.ts 未见 videos 透传（tenant-core 的 __videoPending 因此收不到数据）" \
    "补丁点：core.handle 参数增加 videos: [{data}]，与 img-lab 的 InMsg.videos 对齐"
fi

IMGLAB=$(grab "$CT_IMGLAB" "/srv/wagate/patches/img-lab.ts")
if [ -n "$IMGLAB" ]; then
  if printf '%s' "$IMGLAB" | grep -q "VIDEO_B64_RE"; then
    em_check "1.5" "img-lab.ts VIDEO_B64_RE 提取器" PASS "命中 VIDEO_B64_RE（从 prompt 文本抽取内联 base64）" ""
  else
    em_check "1.5" "img-lab.ts VIDEO_B64_RE 提取器" WARN "未见 VIDEO_B64_RE" "确认 img-lab 版本"
  fi
else
  em_check "1.5" "img-lab.ts 可读" WARN "容器与主机均未取到 img-lab.ts" "确认插件挂载（CONTEXT.md：需从容器复制到 /srv/wagate/patches 才可挂载）"
fi
em_manual "1.5" "真实 TG 发视频 → img-lab 处理" "需人工：发一段 ≤10s 视频 + 指令（如截首帧/转码），回贴模型回答与产物"

# ===========================================================================
# 1.6 文件（document/excel）→ file-only hold
# ===========================================================================
em_section "1.6 文件（document/excel）→ file-only hold"
em_cmd "1.6" "bash 01-eu-entry.sh 2>&1 | grep -A6 '1.6'"

DOC_HITS=$(printf '%s' "$TGTS" | grep -nE "document" | head -3)
[ -n "$DOC_HITS" ] && em_check "1.6" "telegram.ts document 分支" PASS "$(printf '%s' "$DOC_HITS" | tr '\n' ' ' | cut -c1-240)" "" \
  || em_check "1.6" "telegram.ts document 分支" WARN "未见 document 分支" "人工确认文件入口"

HOLD_HITS=$(printf '%s' "$BOTSRC" | grep -nE "file-only hold|__excelPendingFile" | head -3)
if [ -n "$HOLD_HITS" ]; then
  em_check "1.6" "bot.ts file-only hold（未带说明先挂起）" PASS "$(printf '%s' "$HOLD_HITS" | tr '\n' ' ' | cut -c1-300)" ""
else
  em_check "1.6" "bot.ts file-only hold" FAIL "未见 file-only hold / __excelPendingFile" \
    "确认 FILE_AUTO_ROUTE 语义是否被改动（默认 on = 等待用户补充说明）"
fi

HOLD_LOG=$(printf '%s' "${TEN_LOG:-}" | grep -c "file-only hold" || true)
em_check "1.6" "近期 file-only hold 日志" INFO "48h 内 ${HOLD_LOG:-0} 条" "0 条不判失败；以真实发文件回归为准"
em_manual "1.6" "真实发文件 → 挂起 → 补说明后执行" "需人工：发一个 xlsx 不带文字，确认收到"请说明你的要求"；再发指令确认开始处理"

# ===========================================================================
# 1.7 多模态去重 / dedupKey 边界
# ===========================================================================
em_section "1.7 多模态去重（dedupKey）边界"
em_cmd "1.7" "bash 01-eu-entry.sh 2>&1 | grep -A4 '1.7'"

DEDUP=$(printf '%s' "$BOTSRC" | grep -nE "dedup" | head -5)
if [ -n "$DEDUP" ]; then
  em_check "1.7" "dedupKey 计算点存在" PASS "$(printf '%s' "$DEDUP" | tr '\n' ' ' | cut -c1-300)" ""
  if printf '%s' "$DEDUP" | grep -qE "m\.image|\.video|image\b"; then
    em_check "1.7" "dedupKey 已纳入媒体维度" PASS "dedupKey 表达式中含媒体字段，连续裸图不会互吞" ""
  else
    em_check "1.7" "dedupKey 已纳入媒体维度" WARN \
      "dedupKey 仅基于 channelId+text：连续两条空 text 裸图（photo/video）会撞 key 被吞第二条" \
      "已知小坑（CONTEXT.md 坑 E）。修复：把 image/video 的 data 长度并入 dedupKey；未修则列入人工回归"
  fi
else
  em_check "1.7" "dedupKey 计算点存在" WARN "bot.ts 未见 dedup 相关代码" "人工定位去重逻辑"
fi

DEDUP_LOG=$(printf '%s' "${TEN_LOG:-}" | grep -ciE "dedup|duplicate" || true)
em_check "1.7" "近期去重命中日志" INFO "48h 内 ${DEDUP_LOG:-0} 条" ""
em_manual "1.7" "连续两条裸图/裸视频" "需人工：连续发两张不带文字的图片，确认两条都被处理（这是本项唯一有效判定）"

# ---------------------------------------------------------------------------
em_note "本脚本不修改 EU 任何文件；1.2/1.3 的对外请求仅 DeepInfra STT/TTS（issue #61 授权），全部带 timeout。"
em_finish
exit $?
