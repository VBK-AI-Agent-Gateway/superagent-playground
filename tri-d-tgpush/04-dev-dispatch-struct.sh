#!/usr/bin/env bash
# 04-dev-dispatch-struct.sh —— 只读取证：派单链路现有结构 + 补齐 TG 回调的四个落点
#
# 执行位置：EU 服务器 5.189.129.216（操作员笔记本 SSH 上去跑）
# 参数：无
# 预期时长：<60s
# 输出：stdout；建议 `bash 04-dev-dispatch-struct.sh 2>&1 | tee /tmp/wagate-d-tgpush/04.txt`
#
# 本脚本回答四个问题（fixD-tgpush.sh 的补丁锚点全部来自这里）：
#   ① aa-dev-dispatch.ts 的派单结构：issue 创建点、触发点、成功/失败返回点在哪一行
#   ② 会话标识与回程地址：sid 怎么派生、sid → chat(channelId) 有没有现成通道
#   ③ TG 发送面：bot 进程里发 TG 需要什么（token / chat_id / HTTP 端点）
#   ④ GitHub App 的 issue 只读权限：轮询 issue/PR 状态能不能用现有安装令牌
#
# 只读声明：全部是 ls / wc / grep / md5sum / systemctl is-active / curl GET / 浏览器页面抓取，
# 不写任何业务文件、不改配置、不重启服务（唯一写入是 tee 到 /tmp/wagate-d-tgpush/）；
# **不读取任何密钥内容**：/srv/secrets/dispatch-app/ 只 `ls -la`，绝不 cat 那个 .pem；
# token 只判「有没有 / 长度」，绝不回显。
set -u

OUT=/tmp/wagate-d-tgpush
mkdir -p "$OUT" 2>/dev/null || true

hr() { printf '\n===== %s =====\n' "$*"; }
safe() { "$@" 2>&1 || echo "[warn] 命令失败或无输出: $*"; }
# 统一脱敏：任何形如 bot<数字>:<串> 或长 token 都不许出现在输出里
redact() { sed -E -e 's/[0-9]{6,12}:[A-Za-z0-9_-]{30,}/<redacted-tg-token>/g' \
                   -e 's/gh[pousr]_[A-Za-z0-9]{20,}/<redacted-gh-token>/g' \
                   -e 's/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/<redacted-jwt>/g' 2>/dev/null || cat; }

PATCH_DIR=/srv/wagate/patches
DISPATCH_TS=$PATCH_DIR/aa-dev-dispatch.ts
CONTAINER_DISPATCH=/app/aa-dev-dispatch.ts
WAGATE_ENV=/etc/wagate.env

printf '### 04 派单链路结构 + TG 回调落点只读取证 ###\n'
printf '采集时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
printf '主机名: %s\n' "$(hostname 2>/dev/null || echo unknown)"
printf '脚本版本: D-tgpush/04 v1（对应 tri-d-tgpush 交付）\n'

# ---------------------------------------------------------------------------
hr "① aa-dev-dispatch.ts 在位性与结构（派单主链）"
# ---------------------------------------------------------------------------
printf -- '--- 宿主/容器 md5（不一致 = 补丁未生效或容器未重启） ---\n'
if [ -f "$DISPATCH_TS" ]; then
  printf '%-34s 宿主 ' "$DISPATCH_TS"; md5sum "$DISPATCH_TS" 2>&1 | awk '{print $1}'
  printf '%-34s 行数 ' "$DISPATCH_TS"; wc -l < "$DISPATCH_TS" 2>/dev/null || echo "?"
else
  echo "[warn] 宿主不存在: $DISPATCH_TS（fast-route 未部署到本机？）"
fi
printf '%-34s 容器 ' "$CONTAINER_DISPATCH"
docker exec wagate md5sum "$CONTAINER_DISPATCH" 2>/dev/null | awk '{print $1}' || echo "[缺失或路径不同]"

printf -- '\n--- 派单关键符号行号（fixD 的锚点全集） ---\n'
if [ -f "$DISPATCH_TS" ]; then
  # 只导结构与行号，不导出正文（正文可能含 planner 提示词长文本）
  grep -nE 'registerTool|name: "dispatch_dev"|execute: async|issueBody|TRIGGER_COMMENT|workflow_dispatch|issues|installationToken|appJwt|function gh|audit\(|const out =|已派单|自动触发失败|dispatchDisabled|export default' \
    "$DISPATCH_TS" 2>/dev/null | redact | head -60 || echo "[warn] 无匹配"
else
  echo "[warn] 跳过：宿主文件不存在"
fi

printf -- '\n--- issue 创建 / 触发 / 返回 三段的行号区间（含行内容，便于定位插入点） ---\n'
if [ -f "$DISPATCH_TS" ]; then
  grep -nE 'issues|html_url|issueNumber|issueUrl|workflow_dispatch|issue: issueNumber|已派单|自动触发失败|工单已创建' \
    "$DISPATCH_TS" 2>/dev/null | redact | head -40 || echo "[warn] 无匹配"
fi

printf -- '\n--- 现有环境变量开关（决定 fixD 的逃生阀落点） ---\n'
if [ -f "$DISPATCH_TS" ]; then
  grep -nE 'process\.env\.[A-Z_]+|env\("[A-Z_]+' "$DISPATCH_TS" 2>/dev/null | redact | head -30 || echo "[warn] 无匹配"
fi

# ---------------------------------------------------------------------------
hr "② 会话标识与回程地址：sid 怎么来、sid → chat(channelId) 有没有现成通道"
# ---------------------------------------------------------------------------
# 事实（源码确认）：sid = t<base36(31 哈希)>+平台前两字；每租户的群/私聊地址叫 chatKey = "platform:channelId"。
# bot.ts 已在 onProgress 里挂了 __sidChat（Map<sid, chatKey>），并用 __progressRoute（Map<chatKey, {adapter,channelId}>）
# 发进度 —— 这正是 fixD 要复用的「回程地址」通道。
BOT_TS=$PATCH_DIR/bot.ts
printf -- '--- bot.ts 里的回程地址通道（__sidChat / __progressRoute / progressRoute.set） ---\n'
if [ -f "$BOT_TS" ]; then
  grep -nE '__sidChat|__progressRoute|progressRoute\.set|progressRoute = new Map|adapter\.sendMessage\(r\.channelId' "$BOT_TS" 2>/dev/null \
    | redact | head -20 || echo "[warn] 无匹配"
else
  echo "[warn] 宿主不存在: $BOT_TS（改用容器内副本）"
  docker exec wagate sh -c 'grep -nE "__sidChat|__progressRoute|progressRoute\.set" /app/bot.ts 2>/dev/null | head -20' 2>&1 || echo "[warn] 容器内也无匹配"
fi

printf -- '\n--- tenant-core.ts 里的 sid 派生与 chatKey 生成（回程地址的上游） ---\n'
TC_TS=$PATCH_DIR/tenant-core.ts
if [ -f "$TC_TS" ]; then
  grep -nE 'function sidFor|return "t" \+ h|chatKey: `\$?\{?msg\.platform|chatKey: `sched|__currentSid = t\.sid' "$TC_TS" 2>/dev/null \
    | redact | head -20 || echo "[warn] 无匹配"
else
  echo "[warn] 宿主不存在: $TC_TS"
fi

printf -- '\n--- 运行期证据：__sidChat 是否真被填过（journalctl 里 progress 行） ---\n'
timeout 25 journalctl -u wagate --since '7 days ago' --no-pager 2>/dev/null \
  | grep -E '\[progress\] sid=|\[progress-raw\] sid=' | tail -5 || echo "[warn] journalctl 无匹配/超时/无权限"

printf -- '\n--- 派单审计落盘（哪张工单被派给哪个 sid） ---\n'
AUDIT_DIR=/srv/tenants/.dispatch-audit
if [ -d "$AUDIT_DIR" ]; then
  safe ls -la "$AUDIT_DIR" | tail -8
  printf -- '--- 最近派单事件（action=dispatch，前 5 条） ---\n'
  # 只打印 action/issue/result 三列，sid 保留（它就是回程键）
  cat "$AUDIT_DIR"/dispatch-*.jsonl 2>/dev/null | grep '"action":"dispatch"' | tail -5 || echo "[warn] 无 dispatch 事件"
  printf -- '--- 事件总数 ---\n'
  cat "$AUDIT_DIR"/dispatch-*.jsonl 2>/dev/null | wc -l || echo 0
else
  echo "[warn] 审计目录不存在: $AUDIT_DIR（尚未派过单，或路径不同）"
fi

printf -- '\n--- 派单映射文件（fixD 将新增：sid → issue 映射）当前是否已存在 ---\n'
for f in /srv/wagate/dispatch-mapping.json /srv/tenants/.dispatch-audit/dispatch-mapping.json; do
  if [ -f "$f" ]; then printf '%-52s 已存在，行数/字节 ' "$f"; wc -lc < "$f"; else printf '%-52s [不存在]\n' "$f"; fi
done

# ---------------------------------------------------------------------------
hr "③ TG 发送面：bot 进程发 TG 需要什么（token / chat_id / 端点）"
# ---------------------------------------------------------------------------
printf -- '--- TELEGRAM_BOT_TOKEN 是否配置（只判有无与长度，绝不回显） ---\n'
if [ -f "$WAGATE_ENV" ]; then
  TG_LINE=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$WAGATE_ENV" 2>/dev/null || true)
  if [ -n "$TG_LINE" ]; then
    TG_VAL=${TG_LINE#TELEGRAM_BOT_TOKEN=}
    TG_VAL=$(printf '%s' "$TG_VAL" | tr -d '"'"'"' \r\n')
    printf 'TELEGRAM_BOT_TOKEN: 已配置，长度=%s（值不回显）\n' "${#TG_VAL}"
    unset TG_VAL TG_LINE
  else
    echo "[warn] $WAGATE_ENV 中无 TELEGRAM_BOT_TOKEN（fixD 的 TG 回调将无凭证可用）"
  fi
  printf -- '--- 其他相关开关（仅键名，值脱敏） ---\n'
  grep -nE '^(TELEGRAM|WA_QR|WAGATE_DISPATCH|ALERT|TG_)' "$WAGATE_ENV" 2>/dev/null \
    | sed -E 's/=(.{0,4}).*/=\1…(已截断)/' | redact || echo "[warn] 无匹配"
else
  echo "[warn] 不存在: $WAGATE_ENV"
fi

printf -- '\n--- 容器内是否也能看到 TELEGRAM_BOT_TOKEN（bot 在容器里跑） ---\n'
docker exec wagate sh -c 'if [ -n "$TELEGRAM_BOT_TOKEN" ]; then echo "容器内 TELEGRAM_BOT_TOKEN: 已注入 长度=${#TELEGRAM_BOT_TOKEN}"; else echo "[warn] 容器内无 TELEGRAM_BOT_TOKEN"; fi' 2>&1 || echo "[warn] docker exec 失败"

printf -- '\n--- TG API 连通性（getMe，只读；token 不进命令行参数以外的任何地方） ---\n'
# 刻意用容器内的 token 抓一遍 getMe：证明「从容器里发 TG」这条链路通
docker exec wagate sh -c 'if [ -n "$TELEGRAM_BOT_TOKEN" ]; then curl -sS --max-time 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe" | head -c 300; else echo "[warn] skip: no token"; fi' 2>&1 | redact || echo "[warn] TG getMe 失败（网络策略？）"

printf -- '\n--- 谁在跑 bot 发消息（进程/服务） ---\n'
for u in wagate wagate-inngest inngest; do
  printf '%-18s is-active=%s is-enabled=%s\n' "$u" \
    "$(systemctl is-active "$u" 2>/dev/null || echo unknown)" \
    "$(systemctl is-enabled "$u" 2>/dev/null || echo unknown)"
done

# ---------------------------------------------------------------------------
hr "④ GitHub App（sandbox-dispatch）issue 只读权限：轮询 issue/PR 状态够不够"
# ---------------------------------------------------------------------------
printf -- '--- App 私钥目录（只列元数据，绝不读取内容） ---\n'
if [ -d /srv/secrets/dispatch-app ]; then
  safe ls -la /srv/secrets/dispatch-app
else
  echo "[warn] 目录不存在: /srv/secrets/dispatch-app"
fi

printf -- '\n--- 安装 id / app id 常量（从派单插件里取，属非机密标识） ---\n'
if [ -f "$DISPATCH_TS" ]; then
  grep -nE '^(const )?(APP_ID|INSTALLATION_ID|OWNER|REPO|API|DEFAULT_KEY_PATH|AUDIT_DIR) *=' "$DISPATCH_TS" 2>/dev/null | head -12 || echo "[warn] 无匹配"
fi

printf -- '\n--- 派单插件是否已用安装令牌读 issue（决定 fixD 能否直接复用 gh()） ---\n'
if [ -f "$DISPATCH_TS" ]; then
  grep -nE 'gh\("(GET|POST|PATCH)"' "$DISPATCH_TS" 2>/dev/null | head -10 || echo "[warn] 无匹配"
fi

printf -- '\n--- 近期派单结果的 GitHub 侧证据（触发 workflow 是否成功） ---\n'
timeout 25 journalctl -u wagate --since '7 days ago' --no-pager 2>/dev/null \
  | grep -E 'dispatch|issue create|trigger failed' | tail -8 || echo "[warn] journalctl 无匹配/超时"

printf -- '\n### 04 采集结束（下一步：按上述锚点审 fixes/fixD-tgpush.sh） ###\n'
