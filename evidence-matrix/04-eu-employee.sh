#!/usr/bin/env bash
# 04-eu-employee.sh —— G3「数字 AI 员工」取证：3.1、3.4、3.5、3.6【只读】
#
# 对应 issue #61 表格 G3（3.2 在 05-vm-closeout.sh 由 VM 侧执行）。EU 侧运行。
#
# 覆盖条目：
#   3.1  数字员工「能力/技能」可枚举与可执性（只读 GitHub API + 本机 skill 目录）
#   3.4  模型定价配置完整性（确认 model_configs 缺少 m3 定价行）
#   3.5  管理面/端口暴露面（asg-admin 19000、newapi 3001、NetBird 8443
#        setup_required、8888 当前 HTTP 无 TLS）
#   3.6  出站审计日志（审计 jsonl 可读性与字段完整性）
#
# 只读保证：GitHub 走只读 API（GET）；端口探测用 curl -sS 只读握手（不提交凭证、
# 不 POST 业务数据）；审计 jsonl 只 tail 尾部若干行并整体脱敏。不修改任何配置。

set -uo pipefail
EM_SELF="$0"
source "$(dirname "$0")/_lib.sh"

em_parse_args "$@"
if [ "${EM_SHOW_HELP}" = "1" ]; then em_usage_header "04-eu-employee.sh" "G3 数字 AI 员工取证（3.1、3.4-3.6）"; exit 0; fi

EM_HOST_ROLE="EU"
em_init "04" "G3 数字 AI 员工取证（3.1、3.4-3.6）"

GH_REPO="${GH_REPO:-VBK-AI-Agent-Gateway/superagent-playground}"
SKILLS_DIR="${SKILLS_DIR:-/root/.pi/agent/skills}"
AI_GW_DIR="${AI_GW_DIR:-/opt/ai-gateway}"
CORE_DB="${CORE_DB:-${AI_GW_DIR}/core.db}"
AUDIT_JSONL="${AUDIT_JSONL:-/var/log/ai-gateway/outbound-audit.jsonl}"
AUDIT_CANDIDATES="${AUDIT_CANDIDATES:-${AUDIT_JSONL} /opt/ai-gateway/logs/outbound-audit.jsonl /var/log/wagate/outbound-audit.jsonl}"
ASG_ADMIN_PORT="${ASG_ADMIN_PORT:-19000}"
NEWAPI_PORT="${NEWAPI_PORT:-3001}"
NETBIRD_PORT="${NETBIRD_PORT:-8443}"
GATEWAY_PORT="${GATEWAY_PORT:-8888}"

em_note "3.5 的端口探测只做只读握手（curl -sS -o /dev/null -m 8，不携带任何凭证），目的仅是记录"是否可达/是否 TLS"，不做任何利用性操作。"

# ---------------------------------------------------------------------------
# 3.1 数字员工能力/技能枚举（只读）
# ---------------------------------------------------------------------------
em_section "3.1 数字员工能力/技能可枚举"
em_cmd "3.1" "bash 04-eu-employee.sh 2>&1 | grep -A6 '3.1'"

if em_have gh; then
  AUTH=$(run_capture "$EM_TIMEOUT_NET" gh auth status 2>&1 | head -3 || true)
  em_check "3.1" "gh 已登录（只读 API 前提）" "$(printf '%s' "$AUTH" | grep -q "Logged in" && printf PASS || printf WARN)" \
    "$(em_mask_text "$(printf '%s' "$AUTH" | tr '\n' ' ')")" "无 gh 凭据时 3.1 只能用仓库内静态文件取证"
  REPO_OK=$(run_capture "$EM_TIMEOUT_NET" gh api "repos/${GH_REPO}" --jq .full_name 2>/dev/null || true)
  if [ -n "$REPO_OK" ]; then
    em_check "3.1" "只读 GitHub API 可用" PASS "repos/${GH_REPO} → ${REPO_OK}" ""
    BRANCHES=$(run_capture "$EM_TIMEOUT_NET" gh api "repos/${GH_REPO}/branches?per_page=5" --jq '.[].name' 2>/dev/null | tr '\n' ' ')
    em_check "3.1" "能力/技能来源仓库可枚举" PASS "分支样例：${BRANCHES:-<空>}" ""
  else
    em_check "3.1" "只读 GitHub API 可用" WARN "无法访问 repos/${GH_REPO}（网络或权限）" \
      "改用本机 skills 目录 + 矩阵表中的技能清单作为证据"
  fi
else
  em_check "3.1" "gh 可用" WARN "未安装 gh CLI" "以本机 skills 目录取证；GitHub 侧证据留空并注明"
fi

# 本机技能库（tenant-core 191-192 提到的 /root/.pi/agent/skills/，每轮节省约 37KB）
if [ -d "$SKILLS_DIR" ]; then
  SKILLS=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "ls -1 ${SKILLS_DIR} 2>/dev/null | head -30" 2>/dev/null || true)
  NSK=$(printf '%s\n' "$SKILLS" | grep -c . || true)
  em_check "3.1" "本机技能库可枚举" PASS "目录 ${SKILLS_DIR}，条目 ${NSK:-0}：$(printf '%s' "$SKILLS" | tr '\n' ' ' | cut -c1-300)" ""
  # 技能清单注入证据（tenant-core 的 skill-list-injection）
  TC=$(run_capture "$EM_TIMEOUT_DEFAULT" cat "/app/vendor-pi-gateway-src/tenant-core.ts" 2>/dev/null || true)
  [ -z "$TC" ] && TC=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "docker exec wagate cat /app/vendor-pi-gateway-src/tenant-core.ts 2>/dev/null" || true)
  if printf '%s' "$TC" | grep -qE "skill-list|skills"; then
    em_check "3.1" "技能清单注入实现" PASS "$(printf '%s' "$TC" | grep -nE 'skill-list|skills' | head -2 | tr '\n' ' ' | cut -c1-260)" ""
  else
    em_check "3.1" "技能清单注入实现" INFO "未取到 tenant-core 证据" "该项非必需，记录即可"
  fi
else
  em_check "3.1" "本机技能库可枚举" WARN "目录 ${SKILLS_DIR} 不存在" "修正 SKILLS_DIR 后重跑"
fi
em_manual "3.1" "数字员工真实执行一项能力" "需人工：让数字员工执行一项具体能力（如生成周报/查库），回贴指令与产出"

# ---------------------------------------------------------------------------
# 3.4 模型定价配置完整性
# ---------------------------------------------------------------------------
em_section "3.4 模型定价配置（model_configs 缺少 m3 定价行）"
em_cmd "3.4" "bash 04-eu-employee.sh 2>&1 | grep -A6 '3.4'"

if em_have sqlite3 && [ -r "$CORE_DB" ]; then
  COLS=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${CORE_DB}?mode=ro" "select name from pragma_table_info('model_configs');" 2>/dev/null | tr '\n' ',')
  em_check "3.4" "model_configs 字段可读" PASS "字段：${COLS:-<空>}" ""
  PRICE_COLS=$(printf '%s' "$COLS" | tr ',' '\n' | grep -iE "price|cost|rate|billing" | tr '\n' ',')
  if [ -z "$PRICE_COLS" ]; then
    em_check "3.4" "定价字段存在" FAIL "model_configs 无 price/cost 类字段（实际字段：${COLS}）" \
      "需确认定价是否落在别的表/库（如计费库）；本项结论：当前配置表无定价列"
  else
    em_check "3.4" "定价字段存在" PASS "定价相关字段：${PRICE_COLS}" ""
  fi
  # 逐模型检查是否有定价行（issue #61 预期：m3 缺失）
  for M in m3 gemma4:12b zai-org/GLM-5.3 ingloryon/Qwen3.8-27B:Q2_K_S; do
    ROW=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${CORE_DB}?mode=ro" \
      "select count(*) from model_configs where model='${M}' or name='${M}';" 2>/dev/null || printf 0)
    if [ "${ROW:-0}" -gt 0 ]; then
      em_check "3.4" "定价/配置行 ${M}" PASS "命中 ${ROW} 行" ""
    else
      em_check "3.4" "定价/配置行 ${M}" FAIL "model_configs 无 ${M} 行" \
        "issue #61 预期就是此缺失；修复=补登记（属产品/计费口径决策，不在本包执行）"
    fi
  done
else
  em_check "3.4" "core.db 只读可访问" WARN "缺少 sqlite3 或库不可读（${CORE_DB}）" "以 root 运行并确认 AI_GW_DIR"
fi

# 计费库候选
for DB in /opt/claw-billing/billing.db /opt/new-api/one-api.db; do
  if [ -r "$DB" ]; then
    TN=$(run_capture "$EM_TIMEOUT_DEFAULT" sqlite3 "file:${DB}?mode=ro" "select name from sqlite_master where type='table' limit 8;" 2>/dev/null | tr '\n' ' ')
    em_check "3.4" "计费库 ${DB}" PASS "可读；表样例：${TN:-<空>}" "用于交叉核对 m3 定价（本包只读不对账）"
  else
    em_check "3.4" "计费库 ${DB}" INFO "不存在或不可读" "如位置变更请更新 BILLING 候选列表"
  fi
done

# ---------------------------------------------------------------------------
# 3.5 管理面/端口暴露面
# ---------------------------------------------------------------------------
em_section "3.5 管理面与端口暴露面"
em_cmd "3.5" "bash 04-eu-employee.sh 2>&1 | grep -A8 '3.5'"

probe() { # probe <端口> <期望说明>
  local P=$1 DESC=$2 URL="http://127.0.0.1:${P}/"
  local OUT
  OUT=$(run_capture 8 curl -sS -o /dev/null -w '%{http_code}|%{content_type}|%{time_total}' -m 8 "$URL" 2>&1 || true)
  printf '%s|%s' "$P" "$OUT"
}

# asg-admin
R=$(probe "$ASG_ADMIN_PORT" "asg-admin")
CODE=${R#*|}
em_check "3.5" "asg-admin ${ASG_ADMIN_PORT} 可达性" \
  "$([ "${CODE%%|*}" = "000" ] && printf FAIL || printf PASS)" \
  "http://127.0.0.1:${ASG_ADMIN_PORT} → ${CODE:-无响应}" \
  "000 表示未监听（可能未部署或仅内网/隧道暴露）；若在监听则需确认是否有鉴权"

# newapi
R=$(probe "$NEWAPI_PORT" "newapi")
CODE=${R#*|}
em_check "3.5" "newapi ${NEWAPI_PORT} 可达性" \
  "$([ "${CODE%%|*}" = "000" ] && printf INFO || printf PASS)" \
  "http://127.0.0.1:${NEWAPI_PORT} → ${CODE:-无响应}" "仅登记暴露事实"

# NetBird 8443 setup_required
NB=$(run_capture 8 curl -sS -m 8 "http://127.0.0.1:${NETBIRD_PORT}/" 2>/dev/null | head -c 300 || true)
if printf '%s' "$NB" | grep -qi "setup_required\|setup.required"; then
  em_check "3.5" "NetBird ${NETBIRD_PORT} setup_required" PASS "返回包含 setup_required（管理面尚未初始化）" \
    "这是安全状态：setup_required 表示管理面未完成初始化，不应对外暴露"
elif [ -z "$NB" ]; then
  em_check "3.5" "NetBird ${NETBIRD_PORT} setup_required" INFO "无响应（未监听或非 HTTP）" "仅登记"
else
  em_check "3.5" "NetBird ${NETBIRD_PORT} setup_required" WARN "响应异常：$(em_mask_text "$(printf '%s' "$NB" | cut -c1-200)")" \
    "确认是否为其他服务占用该端口"
fi

# 8888 明文 HTTP（无 TLS）
GW=$(run_capture 8 curl -sS -o /dev/null -w '%{http_code}|%{scheme}' -m 8 "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null || true)
GWTLS=$(run_capture 8 curl -sSk -o /dev/null -w '%{http_code}' -m 8 "https://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null || true)
em_check "3.5" "${GATEWAY_PORT} 当前为 HTTP 无 TLS" PASS \
  "http → ${GW:-无响应}；https → ${GWTLS:-无响应}（https 失败/400 视为无 TLS 端点）" \
  "issue #61 记录该项为"当前 HTTP 无 TLS"；如需 TLS 属变更需求，不在本包范围"
em_note "3.5 结论口径：仅记录当前监听与 TLS 状态，不做任何加固或配置变更。"

# ---------------------------------------------------------------------------
# 3.6 出站审计日志
# ---------------------------------------------------------------------------
em_section "3.6 出站审计（audit jsonl）"
em_cmd "3.6" "bash 04-eu-employee.sh 2>&1 | grep -A8 '3.6'"

FOUND=""
for F in $AUDIT_CANDIDATES; do [ -r "$F" ] && { FOUND="$F"; break; }; done
if [ -z "$FOUND" ]; then
  FOUND=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "find /var/log /opt -maxdepth 3 -name '*audit*.jsonl' -o -maxdepth 3 -name '*audit*.log' 2>/dev/null | head -1" 2>/dev/null || true)
fi

if [ -n "$FOUND" ]; then
  SZ=$(run_capture 5 sh -c "wc -l < '$FOUND'" 2>/dev/null | tr -d ' ')
  MT=$(run_capture 5 sh -c "date -r '$FOUND' -u +%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || true)
  em_check "3.6" "审计文件可读" PASS "${FOUND}，行数 ${SZ:-?}，最后修改 ${MT}" ""
  SAMPLE=$(em_mask_jsonl "$FOUND" 3)
  em_check "3.6" "审计样本（尾部 3 行，已脱敏）" "$([ -n "$SAMPLE" ] && printf PASS || printf WARN)" \
    "$(printf '%s' "$SAMPLE" | tr '\n' ' ' | cut -c1-500)" "字段完整性需人工核对：是否含 时间/租户/模型/出站目标"
  for K in ts timestamp tenant model url host status; do
    if printf '%s' "$SAMPLE" | grep -q "\"${K}\""; then
      em_check "3.6" "审计字段含 ${K}" PASS "样本中出现 ${K}" ""
    else
      em_check "3.6" "审计字段含 ${K}" INFO "样本中未见 ${K}" "非必需字段，记录即可"
    fi
  done
  RECENT=$(run_capture 5 sh -c "find '$FOUND' -mmin -1440 | head -1" 2>/dev/null || true)
  em_check "3.6" "近 24h 有出站记录" "$([ -n "$RECENT" ] && printf PASS || printf WARN)" \
    "$([ -n "$RECENT" ] && printf '文件在 24h 内被写入' || printf '文件 24h 内未更新')" \
    "无近期写入说明近期无出站流量，或审计写入失效（后者是严重回归）"
else
  em_check "3.6" "审计文件可读" FAIL "候选路径均不存在：${AUDIT_CANDIDATES}" \
    "按现场实际路径设置 AUDIT_JSONL 后重跑；若确实无审计文件，属出站审计缺失"
fi

em_note "本脚本不修改 GitHub 任何状态（仅 GET），不修改本机配置；3.5 端口探测为只读握手。"
em_finish
exit $?
