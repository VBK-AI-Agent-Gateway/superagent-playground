#!/usr/bin/env bash
# 02-eu-model-gateway.sh —— EU 侧模型网关 / 服务面 / 资源只读取证
#
# 执行位置：EU 服务器 5.189.129.216（操作员笔记本 SSH 上去跑）
# 参数：$1 = 网关 token（**必须由操作员在命令行/环境变量传入，严禁写进脚本、仓库或报告**）
# 预期时长：<90s（含 5 个模型探针）
# 输出：stdout；建议 `... | tee /tmp/eu-skill-arch-out/02.txt`
#
# 只读声明：只做 curl 只读探测（/v1/models 与 max_tokens=1 探针）、systemctl is-active（查询态）、
# docker stats --no-stream、grep 配置摘录、df/free/du。不重启服务、不改配置、不写文件
# （唯一写入是 tee 到 /tmp/eu-skill-arch-out/）。脚本内不出现任何 token 字面量，token 只经 $1 传入，
# 且不落盘、不回显（下方输出统一脱敏）。
set -u

TOKEN="${1:-}"
if [ -z "$TOKEN" ]; then
  echo "用法: $0 <token>" >&2
  echo "说明: token 由操作员从 EU 侧注入（如 $0 \"\$WAGATE_TOKEN\"），本脚本不内置任何 token。" >&2
  exit 2
fi

OUT=/tmp/eu-skill-arch-out
mkdir -p "$OUT" 2>/dev/null || true
API=http://127.0.0.1:8888/v1

hr() { printf '\n===== %s =====\n' "$*"; }
# 统一脱敏：任何输出里都不该出现 token 字面量
redact() { sed -e "s/${TOKEN}/<redacted>/g" 2>/dev/null || cat; }

printf '### 02 EU 模型网关/服务面只读取证 ###\n'
printf '采集时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
printf '主机名: %s\n' "$(hostname 2>/dev/null || echo unknown)"

hr "1. GET $API/models（Bearer 脱敏）"
curl -sS --max-time 20 -H "Authorization: Bearer $TOKEN" "$API/models" 2>&1 | redact | head -60 \
  || echo "[warn] /v1/models 请求失败"

hr "2. 白名单模型探针（max_tokens=1，记录 HTTP 状态 + 延迟）"
# 模型清单以 /v1/models 实测为准；此处列出已知白名单，逐个探测、失败不中断
MODELS='m3
zai-org/GLM-5.3
zai-org/GLM-5.3-Flash
gemma4:12b
ingloryon/Qwen3.8-27B:Q2_K_S'
printf '%s\n' "$MODELS" | while IFS= read -r m; do
  [ -n "$m" ] || continue
  resp=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code} %{time_total}s' \
    -X POST "$API/chat/completions" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}" 2>&1) \
    || resp='[请求失败]'
  printf '%-32s %s\n' "$m" "$resp"
done

hr "3. 服务面：inngest / wagate-inngest 活跃态 + wagate 容器资源"
for u in inngest wagate-inngest; do
  printf '%-18s is-active=%s is-enabled=%s\n' "$u" \
    "$(systemctl is-active "$u" 2>/dev/null || echo unknown)" \
    "$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)"
done
echo "--- docker stats --no-stream wagate ---"
timeout 20 docker stats --no-stream wagate 2>&1 || echo "[warn] docker stats 失败/超时"

hr "4. claw-engine：v2_agent.sh 进程计数 + pool_size 配置摘录"
echo "--- v2_agent.sh 进程数 ---"
pgrep -fc 'v2_agent\.sh' 2>/dev/null || echo "[warn] 无匹配或 pgrep 不可用"
echo "--- server.py pool_size 摘录 ---"
grep -n 'pool_size' /home/qt/claw-exp/scripts/server.py 2>/dev/null | head -10 || echo "[warn] 无匹配"
echo "--- 当前沙箱任务目录数（sbx-*，口径参考） ---"
ls -1d /home/qt/claw-exp/*/sbx-* 2>/dev/null | wc -l || echo "[warn] 无匹配"

hr "5. 资源：df -h / + free -h + /srv/tenants 顶层 du（timeout 30，前 10 大）"
df -h / 2>&1 || echo "[warn] df 失败"
free -h 2>&1 || echo "[warn] free 失败"
echo "--- /srv/tenants 前 10 大租户 ---"
timeout 30 du -sh /srv/tenants/*/ 2>/dev/null | sort -rh | head -10 || echo "[warn] du 失败/超时/无匹配"

hr "6. 交付主链四开关：/etc/wagate.env"
grep -nE 'WAGATE_LOCAL_ONLY|SBX_VERIFY_PAGES|SBX_VERIFY_CONTENT|DELIVER_REQUIRE_LOCAL' /etc/wagate.env 2>/dev/null \
  | redact || echo "[warn] 无匹配（检查 /etc/wagate.env 是否存在）"

printf '\n### 02 采集结束 ###\n'
