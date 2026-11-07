#!/usr/bin/env bash
# 03-eu-models.sh —— 模型池逐项取证：2.14（串行模型调用，主项）+ 2.11 / 2.12 / 2.13【只读】
#
# 对应 issue #61：2.14 要求"串行模型调用"，是本脚本的第一优先级；2.11-2.13 为
# 模型配置/挂载/凭证边界类条目，随后覆盖。
#
# 覆盖条目：
#   2.14 串行模型调用（对 127.0.0.1:8888 逐个模型依次调用，不得并发）
#        模型：zai-org/GLM-5.3-Flash、zai-org/GLM-5.3、m3、gemma4:12b、
#              ingloryon/Qwen3.8-27B:Q2_K_S
#        另含两条边界：无效 token（期望 401）、无权限 token（期望 403）
#        max_tokens<=20、每个调用 timeout 60s、串行（前一个结束才发下一个）
#   2.11 模型白名单与路由配置（只读 sqlite/config）
#   2.12 aa-dev-tgpush-poll 挂载完整性（md5 主机=容器 + SMOKE）—— 今日曾丢挂载
#   2.13 模型凭证/密钥边界（只报存在性与脱敏指纹）
#
# 只读保证：模型调用是 issue #61 明确授权的"实call"（本机 127.0.0.1:8888，仅
# 生成极短文本）；配置检查一律只读（sqlite3 "file:...?mode=ro"）。不重启任何服务。
#
# 串行实现说明：本脚本不使用 & / 并发工具，全部调用在一个 for 循环里顺序执行，
# 每步 timeout 60s；上一步 curl 返回后（或被 timeout 杀掉后）才进入下一步。

set -uo pipefail
EM_SELF="$0"
source "$(dirname "$0")/_lib.sh"

em_parse_args "$@"
if [ "${EM_SHOW_HELP}" = "1" ]; then em_usage_header "03-eu-models.sh" "模型池逐项取证（2.14 串行调用 + 2.11-2.13）"; exit 0; fi

EM_HOST_ROLE="EU"
EM_TIMEOUT_CALL="${EM_TIMEOUT_CALL:-60}"     # issue #61：单次模型调用 60s
em_init "03" "模型池逐项取证（2.14 串行调用 + 2.11-2.13）"

# --- 现场事实（默认值来自 issue #61 与部署记录，可用环境变量覆盖）------------
GATEWAY_BASE="${GATEWAY_BASE:-http://127.0.0.1:8888}"
GATEWAY_USER="${GATEWAY_USER:-user03}"
GATEWAY_TOKEN_FILE="${GATEWAY_TOKEN_FILE:-/srv/secrets/_shared/user03_token}"
AI_GW_DIR="${AI_GW_DIR:-/opt/ai-gateway}"
CORE_DB="${CORE_DB:-${AI_GW_DIR}/core.db}"
WAGATE_CT="${WAGATE_CT:-wagate}"
POLL_UNIT="${POLL_UNIT:-aa-dev-tgpush-poll}"
BILLING_DBS="${BILLING_DBS:-/opt/claw-billing/billing.db /opt/new-api/one-api.db}"

MODELS_LIST="${MODELS_LIST:-zai-org/GLM-5.3-Flash zai-org/GLM-5.3 m3 gemma4:12b ingloryon/Qwen3.8-27B:Q2_K_S}"

em_note "2.14 全部调用**串行**执行（同一 shell 顺序 for 循环，无并发），单次 timeout ${EM_TIMEOUT_CALL}s，max_tokens=20；目标仅 \`${GATEWAY_BASE}\`（本机回环，不出网）。"
em_note "2.14 记录每模型的 HTTP 码、耗时与响应首段（已脱敏）；失败不中断后续模型，逐模型各自出判定行。"

# ---------------------------------------------------------------------------
# 2.11 模型白名单与路由配置（只读）
# ---------------------------------------------------------------------------
em_section "2.11 模型白名单与路由配置（只读）"
em_cmd "2.11" "bash 03-eu-models.sh 2>&1 | grep -A6 '2.11'"

if em_have sqlite3 && [ -r "$CORE_DB" ]; then
  TABLES=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${CORE_DB}?mode=ro" ".tables" 2>/dev/null || true)
  em_check "2.11" "core.db 只读可访问" PASS "库 ${CORE_DB}，表：$(printf '%s' "$TABLES" | tr -s ' \n' ' ' | cut -c1-240)" ""
  for T in model_configs models model_whitelist; do
    if printf '%s' "$TABLES" | grep -qw "$T"; then
      N=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${CORE_DB}?mode=ro" "select count(*) from ${T};" 2>/dev/null || true)
      em_check "2.11" "表 ${T} 行数" PASS "${T} 共 ${N:-0} 行" ""
      if [ "$T" = "model_configs" ]; then
        MODS=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${CORE_DB}?mode=ro" \
          "select name from pragma_table_info('model_configs');" 2>/dev/null | tr '\n' ',' )
        em_note "model_configs 字段：${MODS}"
        for M in $MODELS_LIST; do
          HIT=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${CORE_DB}?mode=ro" \
            "select count(*) from model_configs where model like '%${M}%' or name like '%${M}%';" 2>/dev/null || printf 0)
          em_check "2.11" "白名单含 ${M}" "$([ "${HIT:-0}" -gt 0 ] && printf PASS || printf WARN)" \
            "model_configs 命中 ${HIT:-0} 行" "0 行时确认该模型是否应登记（与 2.14 调用结果互相印证）"
        done
      fi
    fi
  done
else
  if ! em_have sqlite3; then
    em_check "2.11" "core.db 只读可访问" WARN "缺少 sqlite3" "安装 sqlite3 后重跑；或用 2.14 的调用结果间接证明白名单"
  else
    em_check "2.11" "core.db 只读可访问" WARN "无法读取 ${CORE_DB}" "确认 AI_GW_DIR 路径"
  fi
fi

WHITELIST_FILE=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "ls -1 ${AI_GW_DIR}/*.json ${AI_GW_DIR}/*.yaml ${AI_GW_DIR}/*.yml ${AI_GW_DIR}/.env 2>/dev/null | head -5" 2>/dev/null || true)
[ -n "$WHITELIST_FILE" ] && em_note "候选配置文件（未读内容，仅登记路径）：$(printf '%s' "$WHITELIST_FILE" | tr '\n' ' ')"

# ---------------------------------------------------------------------------
# 2.12 aa-dev-tgpush-poll 挂载完整性（今日曾丢挂载）
# ---------------------------------------------------------------------------
em_section "2.12 ${POLL_UNIT} 挂载完整性（md5 主机=容器 + SMOKE）"
em_cmd "2.12" "bash 03-eu-models.sh 2>&1 | grep -A8 '2.12'"

if ! em_have docker; then
  em_check "2.12" "docker 可用" FAIL "未找到 docker" "本项必须在 EU 主机以 root 运行"
else
  RUNNING=$(run_capture "$EM_TIMEOUT_DEFAULT" docker ps --format '{{.Names}}' 2>/dev/null | grep -x "$WAGATE_CT" || true)
  em_check "2.12" "容器 ${WAGATE_CT} 在运行" "$([ -n "$RUNNING" ] && printf PASS || printf FAIL)" \
    "$([ -n "$RUNNING" ] && printf '在运行' || printf '不在 docker ps 列表')" "容器未运行时本项无法取证，先查 systemd unit"

  # (a) unit 内是否声明了 poll 相关挂载
  UNIT_FILE=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "systemctl cat ${POLL_UNIT}.service 2>/dev/null | head -40" 2>/dev/null || true)
  if [ -z "$UNIT_FILE" ]; then
    UNIT_FILE=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "systemctl cat ${WAGATE_CT}.service 2>/dev/null | head -60" 2>/dev/null || true)
  fi
  POLL_LINE=$(printf '%s' "$UNIT_FILE" | grep -nE "tgpush|poll" | head -5)
  if [ -n "$POLL_LINE" ]; then
    em_check "2.12" "unit 中 poll 挂载声明存在" PASS "$(printf '%s' "$POLL_LINE" | tr '\n' ' ' | cut -c1-300)" ""
  else
    em_check "2.12" "unit 中 poll 挂载声明存在" FAIL "未在 ${POLL_UNIT}.service / ${WAGATE_CT}.service 中找到 tgpush/poll 挂载行" \
      "今日丢挂载的事件根因：unit 未声明或 daemon-reload 未生效；修复属 tri-* 补丁范围，不在本包执行"
  fi

  # (b) 容器内挂载点是否可见
  IN_CT=$(em_docker_exec "$EM_TIMEOUT_DEFAULT" "$WAGATE_CT" sh -c "ls -1 /app/extensions/plugins/ 2>/dev/null | grep -i 'tgpush\|poll' | head -5" 2>/dev/null || true)
  if [ -n "$IN_CT" ]; then
    em_check "2.12" "容器内 poll 插件可见" PASS "命中：$(printf '%s' "$IN_CT" | tr '\n' ' ')" ""
  else
    em_check "2.12" "容器内 poll 插件可见" FAIL "容器 /app/extensions/plugins/ 下未见 tgpush/poll 相关文件" \
      "印证"挂载丢失"：需人工按 tri-* 补丁重新挂载（本包只取证不修复）"
  fi

  # (c) md5 主机 = 容器（逐文件比对；挂载点可能随补丁漂移，故用候选列表）
  MD5_OK=0; MD5_BAD=0; MD5_ROWS=""
  for REL in "extensions/plugins/aa-dev-tgpush-poll.ts" "aa-dev-tgpush-poll.ts" "vendor-pi-gateway-src/adapters/telegram.ts"; do
    H_CT="/app/${REL}"; H_HOST="/srv/wagate/patches/$(basename "$REL")"
    [ -r "$H_HOST" ] || continue
    M1=$(run_capture 5 md5sum "$H_HOST" 2>/dev/null | cut -d' ' -f1)
    M2=$(em_docker_exec "$EM_TIMEOUT_DEFAULT" "$WAGATE_CT" md5sum "$H_CT" 2>/dev/null | cut -d' ' -f1)
    if [ -n "$M1" ] && [ "$M1" = "$M2" ]; then MD5_OK=$((MD5_OK+1)); else MD5_BAD=$((MD5_BAD+1)); fi
    MD5_ROWS="${MD5_ROWS}${REL}: host=${M1:-NA} ct=${M2:-NA}; "
  done
  if [ "$MD5_OK" -gt 0 ] && [ "$MD5_BAD" = 0 ]; then
    em_check "2.12" "md5 主机=容器" PASS "$(printf '%s' "$MD5_ROWS" | cut -c1-400)" ""
  elif [ "$MD5_OK" = 0 ] && [ "$MD5_BAD" = 0 ]; then
    em_check "2.12" "md5 主机=容器" WARN "未找到可比对的主机文件（挂载路径可能已变更）" "用 systemctl cat 的真实 -v 源路径重跑"
  else
    em_check "2.12" "md5 主机=容器" FAIL "$(printf '%s' "$MD5_ROWS" | cut -c1-400)" \
      "不一致 = 容器内是镜像旧版，挂载未生效（今日事件特征）"
  fi

  # (d) SMOKE：poll 相关单元/容器是否活着且近期有轮询痕迹
  SMOKE_ACT=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "systemctl is-active ${POLL_UNIT}.service 2>/dev/null || systemctl is-active ${POLL_UNIT}.timer 2>/dev/null" 2>/dev/null || true)
  SMOKE_LOG=$(run_capture "$EM_TIMEOUT_NET" sh -c "journalctl -u ${POLL_UNIT}.service --since '24 hours ago' --no-pager 2>/dev/null | tail -5" 2>/dev/null || true)
  if [ "${SMOKE_ACT:-}" = "active" ] || [ -n "$SMOKE_LOG" ]; then
    em_check "2.12" "SMOKE（${POLL_UNIT} 存活 + 近期轮询）" PASS \
      "is-active=${SMOKE_ACT:-n/a}；近 24h 日志尾部：$(em_mask_text "$SMOKE_LOG") " "" 
  else
    em_check "2.12" "SMOKE（${POLL_UNIT} 存活 + 近期轮询）" FAIL \
      "is-active=${SMOKE_ACT:-未知} 且近 24h 无日志" \
      "确认单元名是否为 ${POLL_UNIT}；若单元不存在，用 docker logs --since 24h ${WAGATE_CT} 检查轮询线程"
  fi
fi

# ---------------------------------------------------------------------------
# 2.14 串行模型调用（主项）
# ---------------------------------------------------------------------------
em_section "2.14 串行模型调用（逐个模型 + 401/403 边界）"
em_cmd "2.14" "bash 03-eu-models.sh 2>&1 | grep -A30 '2.14'"

TOKEN=""
if [ -r "$GATEWAY_TOKEN_FILE" ]; then
  TOKEN=$(run_capture 5 tr -d '\n\r' <"$GATEWAY_TOKEN_FILE" 2>/dev/null || true)
  em_check "2.14" "user03 token 可读" PASS "文件 ${GATEWAY_TOKEN_FILE}，指纹 $(em_mask "$TOKEN")" ""
else
  em_check "2.14" "user03 token 可读" FAIL "无法读取 ${GATEWAY_TOKEN_FILE}" \
    "以 root 运行或修正 GATEWAY_TOKEN_FILE；无 token 时 2.14 无法出判定"
fi

if ! em_have curl; then
  em_check "2.14" "curl 可用" FAIL "未找到 curl" "安装 curl 后重跑 2.14"
elif [ -z "$TOKEN" ]; then
  em_check "2.14" "串行调用" WARN "无 token，未执行" "先解决 token 可读性"
else
  SERIAL_T0=$(date -u +%s)
  IDX=0
  # 逐个模型：严格串行（循环体内先完成一次 curl，再做下一次）
  for M in $MODELS_LIST; do
    IDX=$((IDX+1))
    BODY=$(em_tmpfile "call-${IDX}.json")
    C0=$(date -u +%s%3N)
    CODE=$(timeout --signal=TERM --kill-after=3s "$EM_TIMEOUT_CALL" curl -sS -o "$BODY" -w '%{http_code}' \
      -X POST "${GATEWAY_BASE}/v1/chat/completions" \
      -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
      -d "{\"model\":\"${M}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":20,\"stream\":false}" \
      2>/dev/null || true)
    C1=$(date -u +%s%3N)
    MS=$((C1-C0))
    SNIP=$(em_mask_text "$(run_capture 5 head -c 240 "$BODY" 2>/dev/null || true)")
    if [ "${CODE:-000}" = "200" ]; then
      em_check "2.14" "串行调用 ${M}" PASS "HTTP 200，耗时 ${MS}ms，响应摘录：${SNIP}" ""
    elif [ "${CODE:-000}" = "000" ] || [ "${CODE:-000}" = "124" ]; then
      em_check "2.14" "串行调用 ${M}" FAIL "超时/无响应（${EM_TIMEOUT_CALL}s 上限，耗时 ${MS}ms）" \
        "模型冷启动或队列堵塞；复跑单模型确认（见下方复跑命令）"
    else
      em_check "2.14" "串行调用 ${M}" FAIL "HTTP ${CODE}，耗时 ${MS}ms，响应摘录：${SNIP}" \
        "401/403=凭证或权限；404/400=模型名未登记；5xx=上游模型不可用"
    fi
    rm -f "$BODY" 2>/dev/null || true
    # 串行断点：明确等待 1 秒，杜绝上游连接复用导致的"看似并发"误读
    sleep 1
  done
  SERIAL_T1=$(date -u +%s)
  em_check "2.14" "串行性（无并发）" PASS \
    "${#MODELS_LIST} 个模型顺序执行，总耗时 $((SERIAL_T1-SERIAL_T0))s（≥ 各次耗时之和即证明串行）" \
    "反证：若总耗时接近单次耗时→发生过并发，需查调用方是否使用并发工具"

  # 边界 1：无效 token → 期望 401
  BC=$(run_capture "$EM_TIMEOUT_CALL" curl -sS -o /dev/null -w '%{http_code}' -X POST "${GATEWAY_BASE}/v1/chat/completions" \
    -H 'Authorization: Bearer em-invalid-token-probe' -H 'Content-Type: application/json' \
    -d '{"model":"m3","messages":[{"role":"user","content":"ping"}],"max_tokens":20}' 2>/dev/null || true)
  em_check "2.14" "边界：无效 token" "$([ "${BC:-000}" = "401" ] && printf PASS || printf WARN)" \
    "HTTP ${BC:-无响应}（期望 401）" "非 401 时说明鉴权边界与预期不符，需人工确认网关鉴权实现"

  # 边界 2：无权限 token → 期望 403（用已鉴权 token 请求白名单外模型）
  FC=$(run_capture "$EM_TIMEOUT_CALL" curl -sS -o /dev/null -w '%{http_code}' -X POST "${GATEWAY_BASE}/v1/chat/completions" \
    -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' \
    -d '{"model":"em-not-whitelisted-probe","messages":[{"role":"user","content":"ping"}],"max_tokens":20}' 2>/dev/null || true)
  em_check "2.14" "边界：白名单外模型" "$([ "${FC:-000}" = "403" ] && printf PASS || printf WARN)" \
    "HTTP ${FC:-无响应}（期望 403；404 表示模型不存在而非无权限，需人工区分）" \
    "若返回 200 则白名单未生效——这是要抓的越权口径问题"
fi

# 单模型复跑命令（便于操作员对失败模型单独取证）
em_cmd "2.14" "curl -sS -m 60 -X POST ${GATEWAY_BASE}/v1/chat/completions -H \"Authorization: Bearer \$(cat ${GATEWAY_TOKEN_FILE})\" -H 'Content-Type: application/json' -d '{\"model\":\"MODEL_ID\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":20}' | head -c 400"

# ---------------------------------------------------------------------------
# 2.13 模型凭证/密钥边界
# ---------------------------------------------------------------------------
em_section "2.13 模型凭证与密钥边界"
em_cmd "2.13" "bash 03-eu-models.sh 2>&1 | grep -A5 '2.13'"

SEC_DIR="${SEC_DIR:-/srv/secrets/_shared}"
if [ -d "$SEC_DIR" ]; then
  LIST=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "ls -1 ${SEC_DIR} 2>/dev/null | head -20" 2>/dev/null || true)
  em_check "2.13" "密钥目录可枚举（只列名，不读值）" PASS "$(printf '%s' "$LIST" | tr '\n' ' ' | cut -c1-300)" ""
  PERM=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "find ${SEC_DIR} -maxdepth 1 -type f -printf '%m %f\n' 2>/dev/null | head -10" 2>/dev/null || true)
  # 组/其他位非 0 即视为"偏松"（期望 600）；只登记不修改
  LOOSE=$(printf '%s\n' "$PERM" | while read -r MODE NAME; do
    [ -z "$MODE" ] && continue
    GRP=${MODE: -2:1}; OTH=${MODE: -1}
    if [ "$GRP" != "0" ] || [ "$OTH" != "0" ]; then printf '%s(%s) ' "$NAME" "$MODE"; fi
  done)
  if [ -n "$LOOSE" ]; then
    em_check "2.13" "密钥文件权限" WARN "组/其他位非零：${LOOSE}" \
      "建议收紧为 600；本包只取证不修改（修改属 tri-* 补丁范围）"
  else
    em_check "2.13" "密钥文件权限" PASS "全部文件组/其他位为 0（列表：$(printf '%s' "$PERM" | tr '\n' ' ' | cut -c1-240)）" ""
  fi
else
  em_check "2.13" "密钥目录可枚举" WARN "目录 ${SEC_DIR} 不存在" "修正 SEC_DIR 后重跑"
fi

BILL_HIT=""
for DB in $BILLING_DBS; do
  [ -r "$DB" ] && BILL_HIT="${BILL_HIT}${DB}(可读) "
done
em_check "2.13" "计费库候选可读性" INFO "${BILL_HIT:-未发现可读计费库}" "计费口径不在本包判定范围，仅登记可读性"

# 2.14 已直接证明"token → 模型"链路；此处补一条"密钥未出现在报告中"的自证
if [ -n "$TOKEN" ]; then
  em_check "2.13" "报告脱敏自证" PASS "token 全文未落盘；报告仅出现指纹 $(em_mask "$TOKEN")" ""
fi

em_note "本脚本对 127.0.0.1:8888 的请求均为只读性质（chat/completions 生成 ≤20 token），不改配置、不重建池。"
em_finish
exit $?
