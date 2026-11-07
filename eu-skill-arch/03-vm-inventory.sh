#!/usr/bin/env bash
# 03-vm-inventory.sh —— VM（superagent 宿主）只读取证
#
# 执行位置：VM 192.168.58.133（本仓库 worker 所在机器，qt@）
# 参数：无（可用 $DSH_SA_SRC 覆盖运行时源码路径，默认 /home/qt/src/dsh-sa-git）
# 预期时长：<30s
# 输出：stdout；建议 `... | tee /tmp/eu-skill-arch-out/03.txt`
#
# 只读声明：只做 ls/cat/grep/wc/md5sum/find/ps/free/df/du 与对本机 3082 的只读 GET。
# 不写任何文件（除 tee 到 /tmp）、不改配置、不重启服务、不读 secret 内容。
set -u

SRC="${DSH_SA_SRC:-/home/qt/src/dsh-sa-git}"
OUT=/tmp/eu-skill-arch-out
mkdir -p "$OUT" 2>/dev/null || true

hr() { printf '\n===== %s =====\n' "$*"; }
safe() { "$@" 2>&1 || echo "[warn] 命令失败或无输出: $*"; }

printf '### 03 VM superagent 只读取证 ###\n'
printf '采集时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
printf '主机名: %s\n' "$(hostname 2>/dev/null || echo unknown)"
printf '内核/发行版: %s / %s\n' "$(uname -r 2>/dev/null)" "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"

hr "1. 主机规模：nproc + free -h + df -h / + swap"
nproc 2>&1 || echo "[warn] nproc 失败"
free -h 2>&1 || echo "[warn] free 失败"
df -h / 2>&1 || echo "[warn] df 失败"

hr "2. DSH 运行时版本与部署方式"
safe npm ls -g @deepseek-ai/dsh
echo "--- 本地 checkout HEAD ---"
if [ -d "$SRC/.git" ]; then
  ( cd "$SRC" && git log --oneline -3 2>&1 )
  echo "--- 最近改动时间（前 10 个文件） ---"
  ( cd "$SRC" && find . -maxdepth 2 -name '*.ts' -newer package.json -not -path './node_modules/*' 2>/dev/null | head -10 )
else
  echo "[warn] $SRC 不是 git 仓库"
fi

hr "3. 账号与仓库配置"
echo "--- 监听端口 3082 ---"
( ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null ) | grep -E '3082|LISTEN' | head -15 || echo "[warn] 无匹配"

hr "4. 当前工单数 / 队列 / 运行中 worker / maxWorkers"
curl -sS --max-time 10 -H 'x-orchestrator-request: 1' \
  http://127.0.0.1:3082/orchestrator/api/tickets 2>&1 | head -c 2000 || echo "[warn] tickets API 不可达"
echo
echo "--- 工单计数 ---"
curl -sS --max-time 10 -H 'x-orchestrator-request: 1' \
  http://127.0.0.1:3082/orchestrator/api/tickets 2>/dev/null \
  | grep -o '"state":"[a-z]*"' | sort | uniq -c || echo "[warn] 无法统计"

hr "5. worktree 占用：/home/qt/src 下 agent/ 工作树"
ls -1d /home/qt/src/*/ 2>/dev/null | head -20 || echo "[warn] 无匹配"
echo "--- worktree 总数 ---"
ls -1d /home/qt/src/*/ 2>/dev/null | wc -l || true
echo "--- 各 worktree du -sh（timeout 30，前 10 大） ---"
timeout 30 du -sh /home/qt/src/*/ 2>/dev/null | sort -rh | head -10 || echo "[warn] du 失败/超时"

hr "6. prompts/ 清单 + 行数"
if [ -d "$SRC/prompts" ]; then
  ( cd "$SRC" && wc -l prompts/*.md prompts/team/*.md 2>/dev/null )
  echo "--- 备份文件数（.bak.*，提示词演进痕迹） ---"
  find "$SRC/prompts" -name '*.bak*' 2>/dev/null | wc -l || true
else
  echo "[warn] 无 prompts 目录: $SRC/prompts"
fi
echo "--- 是否存在技能/playbook 机制文件（口径核对） ---"
grep -ril 'skill\|playbook\|技能' "$SRC/prompts" 2>/dev/null | head -10 || echo "[warn] 无匹配"

hr "7. WORK_TOOLS 工具面（源码实测）"
sed -n "/const WORK_TOOLS = /,/^\/\*\* What the main Session/p" "$SRC/src/app/sessions.ts" 2>/dev/null | head -12 \
  || echo "[warn] 无法提取 WORK_TOOLS"

hr "8. 交付链三件套在位性 + 定时任务"
for f in /home/qt/bin/sa-deliver.sh /home/qt/bin/sa-watchdog.sh \
         /home/qt/src/superagent-playground/scripts/smoke.sh \
         /home/qt/src/superagent-playground/scripts/smoke.js; do
  if [ -f "$f" ]; then
    printf '%-58s 存在 md5=%s\n' "$f" "$(md5sum "$f" 2>/dev/null | awk '{print $1}')"
  else
    printf '%-58s [缺失]\n' "$f"
  fi
done
echo "--- crontab ---"
crontab -l 2>&1 | grep -v '^#' | grep -v '^$' || echo "[warn] 无 crontab"

hr "9. 质量门阈值（sa-deliver / sa-watchdog 关键行摘录）"
grep -nE 'smoke|FLAG|600|900|timeout|Pages' /home/qt/bin/sa-deliver.sh 2>/dev/null | head -15 || echo "[warn] 无匹配"
echo "--- watchdog ---"
grep -nE 'FLAG|600|900|stop|timeout' /home/qt/bin/sa-watchdog.sh 2>/dev/null | head -15 || echo "[warn] 无匹配"

hr "10. playground 仓库结构（executor 目录）"
REPO=/home/qt/src/superagent-playground
if [ -d "$REPO" ]; then
  echo "--- 顶层 ---"
  ls -1 "$REPO" 2>/dev/null
  echo "--- 交付目录清单（各 agent 目录） ---"
  ls -1d "$REPO"/*/ 2>/dev/null
  echo "--- preview/apps 清单（既有站点） ---"
  ls -1 "$REPO/preview/apps" 2>/dev/null || echo "[warn] 无 preview/apps"
else
  echo "[warn] 仓库不存在: $REPO"
fi

hr "11. 磁盘水位与 node_modules 体积（容量约束核对）"
du -sh /home/qt/src/dsh-sa-git/node_modules 2>/dev/null || echo "[warn] du 失败"
du -sh /home/qt/src/superagent-playground 2>/dev/null || echo "[warn] du 失败"
echo "--- /tmp 水位 ---"
df -h /tmp 2>&1 || true

printf '\n### 03 采集结束 ###\n'
