#!/usr/bin/env bash
# 05-vm-closeout.sh —— G3「数字 AI 员工」3.2 收口取证【只读】—— VM 侧执行
#
# 对应 issue #61：3.2 在 VM（192.168.58.133）侧运行；本脚本是执行顺序里的最后一环
# （EU 侧 01-04 完成后执行）。
#
# 覆盖条目：
#   3.2 数字员工收口（VM 侧端到端可用性）
#       - 服务/进程在位性（只读：systemctl is-active、docker ps、ss -ltnp）
#       - dsh（DeepSeek Harness）服务是否在跑 —— **只查状态，禁 stop/start/restart**
#       - VM → EU 网关连通性（只读 TCP/HTTP 探活）
#       - VM 侧磁盘/内存余量（避免"数字员工"因资源枯竭静默失效）
#       - 本地脚本包自身的可运行性（bash -n 全量 + --help）
#
# 铁律（继承 CONTEXT.md）：VM 侧只做只读调查。**禁 stop/start/restart dsh**，
# 禁写 state，禁改任何配置文件。本脚本连 systemctl 的写动词都不出现。

set -uo pipefail
EM_SELF="$0"
source "$(dirname "$0")/_lib.sh"

em_parse_args "$@"
if [ "${EM_SHOW_HELP}" = "1" ]; then em_usage_header "05-vm-closeout.sh" "VM 侧 3.2 收口取证（只读调查）"; exit 0; fi

EM_HOST_ROLE="VM"
em_init "05" "VM 侧 3.2 收口取证（只读）"

EU_HOST="${EU_HOST:-5.189.129.216}"
GATEWAY_PORT="${GATEWAY_PORT:-8888}"
DSH_UNIT="${DSH_UNIT:-dsh}"
PACK_DIR="${PACK_DIR:-$(cd "$(dirname "$0")" && pwd)}"

em_note "3.2 在 VM（预期 192.168.58.133）侧执行；本脚本严格只读：不 stop/start/restart 任何服务（尤其 dsh），不写 state，不改配置。"

# ---------------------------------------------------------------------------
# 3.2-a 主机身份与资源余量
# ---------------------------------------------------------------------------
em_section "3.2-a 主机身份与资源余量"
em_cmd "3.2" "bash 05-vm-closeout.sh 2>&1 | grep -A8 '3.2-a'"

HN=$(run_capture 5 hostname)
IP=$(run_capture 5 sh -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)
[ -z "$IP" ] && IP=$(run_capture 5 sh -c "ip -4 -o addr show scope global 2>/dev/null | awk '{print \$4}' | head -1" 2>/dev/null || true)
em_check "3.2" "VM 身份" PASS "hostname=${HN} 主 IPv4=${IP:-未知}（期望 192.168.58.133 段）" ""
if [ -n "$IP" ] && ! printf '%s' "$IP" | grep -q "^192.168.58."; then
  em_check "3.2" "VM 网段是否符合预期" WARN "当前 IPv4=${IP}，与 issue #61 记录的 192.168.58.133 不同段" \
    "确认是否换了主机；不同主机时后续判定需重新基线"
fi

DISK=$(run_capture 5 sh -c "df -h / 2>/dev/null | tail -1" 2>/dev/null || true)
DISK_PCT=$(printf '%s' "$DISK" | awk '{print $5}' | tr -d '%')
em_check "3.2" "根分区余量" "$([ "${DISK_PCT:-100}" -lt 90 ] && printf PASS || printf WARN)" \
  "${DISK:-<无 df 输出>}" "≥90% 会引发静默写入失败；清理属人工运维动作"

MEM=$(run_capture 5 sh -c "free -m 2>/dev/null | awk '/^Mem:/{print \$3\"/\"\$2\" MB used, avail \"\$7\" MB\"}'" 2>/dev/null || true)
[ -z "$MEM" ] && MEM=$(run_capture 5 sh -c "free -m 2>/dev/null | sed -n 2p" 2>/dev/null || true)
em_check "3.2" "内存余量" INFO "${MEM:-<无 free 输出>}" "OOM 会表现为任务静默中断"

LOAD=$(run_capture 5 sh -c "cat /proc/loadavg 2>/dev/null" 2>/dev/null || true)
em_check "3.2" "负载" INFO "${LOAD:-<无>}" ""

# ---------------------------------------------------------------------------
# 3.2-b 服务在位性（只读）
# ---------------------------------------------------------------------------
em_section "3.2-b 服务在位性（只读）"
em_cmd "3.2" "bash 05-vm-closeout.sh 2>&1 | grep -A10 '3.2-b'"

if em_have systemctl; then
  ACT=$(run_capture "$EM_TIMEOUT_DEFAULT" systemctl is-active "$DSH_UNIT" 2>/dev/null || true)
  ENB=$(run_capture "$EM_TIMEOUT_DEFAULT" systemctl is-enabled "$DSH_UNIT" 2>/dev/null || true)
  if [ -n "$ACT" ]; then
    em_check "3.2" "dsh 服务状态（只读查询）" "$([ "$ACT" = "active" ] && printf PASS || printf WARN)" \
      "is-active=${ACT} is-enabled=${ENB:-n/a}" \
      "仅记录状态：本脚本禁止 stop/start/restart；状态异常时由人工决定处置"
  else
    em_check "3.2" "dsh 服务状态（只读查询）" INFO "未找到单元 ${DSH_UNIT}（可能以其他方式运行，如 tmux/pm2/容器）" \
      "用进程与端口证据替代（见下）"
  fi
  # 只列单元名，不读单元内容中的敏感环境变量
  UNITS=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | awk '{print \$1}' | grep -iE 'dsh|gateway|ai|poll|netbird' | head -10" 2>/dev/null || true)
  em_check "3.2" "相关运行中单元" INFO "$(printf '%s' "$UNITS" | tr '\n' ' ' | cut -c1-300)" ""
fi

PROCS=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "ps -eo comm= 2>/dev/null | grep -iE '^(dsh|node|bun)$' | sort | uniq -c | tr '\n' ' '" 2>/dev/null || true)
em_check "3.2" "关键进程（dsh/node/bun）" "$([ -n "$PROCS" ] && printf PASS || printf WARN)" "${PROCS:-未发现}" \
  "VM 上数字员工/Harness 进程缺失时，3.2 无法通过"

if em_have ss; then
  LISTEN=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "ss -ltn 2>/dev/null | awk 'NR>1{print \$4}' | sort -u | tr '\n' ' '" 2>/dev/null || true)
  em_check "3.2" "本机监听端口清单" INFO "$(printf '%s' "$LISTEN" | cut -c1-400)" ""
elif em_have netstat; then
  LISTEN=$(run_capture "$EM_TIMEOUT_DEFAULT" sh -c "netstat -ltn 2>/dev/null | awk 'NR>2{print \$4}' | sort -u | tr '\n' ' '" 2>/dev/null || true)
  em_check "3.2" "本机监听端口清单" INFO "$(printf '%s' "$LISTEN" | cut -c1-400)" ""
else
  em_check "3.2" "监听端口清单" WARN "ss/netstat 均不可用" "安装 iproute2 后重跑"
fi

if em_have docker; then
  DC=$(run_capture "$EM_TIMEOUT_DEFAULT" docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
  em_check "3.2" "VM 侧容器（如有）" INFO "${DC:-无容器或权限不足}" ""
fi

# ---------------------------------------------------------------------------
# 3.2-c VM → EU 网关连通性（只读探活）
# ---------------------------------------------------------------------------
em_section "3.2-c VM → EU 网关连通性"
em_cmd "3.2" "bash 05-vm-closeout.sh 2>&1 | grep -A6 '3.2-c'"

PING=$(run_capture 8 sh -c "ping -c 2 -W 2 ${EU_HOST} 2>/dev/null | tail -2" 2>/dev/null || true)
em_check "3.2" "VM → EU ICMP" "$([ -n "$PING" ] && printf PASS || printf WARN)" "$(printf '%s' "$PING" | tr '\n' ' ' | cut -c1-240)" \
  "ICMP 常被策略屏蔽，不通过不代表网关不可用；以下 HTTP 探活为准"

HTTP=$(run_capture 8 curl -sS -o /dev/null -w '%{http_code}' -m 8 "http://${EU_HOST}:${GATEWAY_PORT}/health" 2>/dev/null || true)
if [ "${HTTP:-000}" != "000" ] && [ -n "$HTTP" ]; then
  em_check "3.2" "VM → EU:${GATEWAY_PORT} HTTP 探活" PASS "HTTP ${HTTP}" ""
else
  em_check "3.2" "VM → EU:${GATEWAY_PORT} HTTP 探活" WARN "无响应（000）" \
    "若 VM 与 EU 之间需隧道/专线，请在回归说明中注明链路拓扑"
fi

TCP=$(run_capture 8 sh -c "timeout 5 bash -c '</dev/tcp/${EU_HOST}/${GATEWAY_PORT}' 2>/dev/null && echo open || echo closed" 2>/dev/null || true)
em_check "3.2" "VM → EU:${GATEWAY_PORT} TCP 连通" "$([ "$TCP" = "open" ] && printf PASS || printf INFO)" "TCP ${TCP:-未知}" ""

# ---------------------------------------------------------------------------
# 3.2-d 脚本包自身可运行性（收口自检）
# ---------------------------------------------------------------------------
em_section "3.2-d 取证包自身自检"
em_cmd "3.2" "cd ${PACK_DIR} && for f in _lib.sh 0*.sh; do bash -n \"\$f\" || echo \"FAIL \$f\"; done"

if [ -d "$PACK_DIR" ]; then
  BAD=0; TOTAL=0; DETAIL=""
  for F in "$PACK_DIR"/_lib.sh "$PACK_DIR"/0*.sh; do
    [ -f "$F" ] || continue
    TOTAL=$((TOTAL+1))
    if run_capture "$EM_TIMEOUT_DEFAULT" bash -n "$F" 2>/dev/null; then :; else
      BAD=$((BAD+1)); DETAIL="${DETAIL}$(basename "$F") "
    fi
  done
  em_check "3.2" "bash -n 全量语法检查" "$([ "$BAD" = 0 ] && printf PASS || printf FAIL)" \
    "共 ${TOTAL} 个脚本，语法失败 ${BAD} 个 ${DETAIL}" "失败脚本必须修复后重跑整包"
  HELP_OK=0
  HELP_CMD='for f in _lib.sh 0*.sh; do bash -n "$f" || echo "FAIL $f"; done; bash 01-eu-entry.sh --help'
  for F in "$PACK_DIR"/0*.sh; do
    [ -f "$F" ] || continue
    # 纯只读自检：语法检查 + --help（--help 在 helper 内即退出，不产生任何副作用）。
    # 注意：--help 输出走 stderr，故 stdout 重定向到 /dev/null 不影响退出码判定。
    if run_capture "$EM_TIMEOUT_DEFAULT" bash -n "$F" >/dev/null 2>&1 && \
       run_capture "$EM_TIMEOUT_DEFAULT" bash "$F" --help >/dev/null 2>&1; then
      HELP_OK=$((HELP_OK+1))
    fi
  done
  em_check "3.2" "包内脚本可解析且 --help 可用" "$([ "$HELP_OK" -gt 0 ] && printf PASS || printf WARN)" \
    "${HELP_OK} 个脚本通过语法检查与 --help 自检" "操作员可执行：${HELP_CMD}"
  em_cmd "3.2" "$HELP_CMD"
else
  em_check "3.2" "取证包目录存在" FAIL "目录不存在：${PACK_DIR}" "设置 PACK_DIR 后重跑"
fi

em_manual "3.2" "VM 侧数字员工端到端收口" "需人工：在 VM 上跑一次真实数字员工任务（只读或可控动作），回贴指令、产出与时间戳"

em_note "VM 侧铁律复核：本脚本不含 stop/start/restart/mask/enable/disable 任何写动词；不写 state；不改配置；仅 systemctl is-active/is-enabled/list-units 与 ps/ss/df/free/curl 只读查询。"
em_finish
exit $?
