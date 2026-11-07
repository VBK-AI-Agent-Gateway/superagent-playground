#!/usr/bin/env bash
# 01-eu-skill-inventory.sh —— EU 侧技能机制只读取证
#
# 执行位置：EU 服务器 5.189.129.216（操作员笔记本 SSH 上去跑）
# 参数：无
# 预期时长：<60s
# 输出：stdout；建议 `... | tee /tmp/eu-skill-arch-out/01.txt`
#
# 只读声明：本脚本只做 ls/cat/grep/du/wc/md5sum/docker exec(只读命令)/journalctl 查询，
# 不写任何配置、不改权限、不删文件、不重启任何服务；唯一写入是 tee 到 /tmp/eu-skill-arch-out/。
# 不读取任何 secret 文件内容（不碰 /srv/secrets，不 cat token/key 文件）。
set -u

OUT=/tmp/eu-skill-arch-out
mkdir -p "$OUT" 2>/dev/null || true

hr() { printf '\n===== %s =====\n' "$*"; }
# 防御式：任何子命令失败都不中断整脚本
safe() { "$@" 2>&1 || echo "[warn] 命令失败或无输出: $*"; }

printf '### 01 EU 技能机制只读取证 ###\n'
printf '采集时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
printf '主机名: %s\n' "$(hostname 2>/dev/null || echo unknown)"

hr "1. /srv/wagate/skills 目录树：岗位子目录 / SKILL.md 计数 / 各岗位 du -sh / 总量"
SKILLS=/srv/wagate/skills
if [ -d "$SKILLS" ]; then
  safe ls -1 "$SKILLS"
  echo "--- 各岗位 SKILL.md 计数 ---"
  for d in "$SKILLS"/*/; do
    [ -d "$d" ] || continue
    n=$(find "$d" -name 'SKILL.md' 2>/dev/null | wc -l)
    printf '%-30s SKILL.md=%s\n' "$(basename "$d")" "$n"
  done
  echo "--- SKILL.md 总数 ---"
  find "$SKILLS" -name 'SKILL.md' 2>/dev/null | wc -l
  echo "--- 各岗位 du -sh ---"
  for d in "$SKILLS"/*/; do
    [ -d "$d" ] || continue
    du -sh "$d" 2>/dev/null || echo "[warn] du 失败: $d"
  done
  echo "--- 总量 ---"
  du -sh "$SKILLS" 2>/dev/null || echo "[warn] du 失败: $SKILLS"
  echo "--- 非目录文件（口径核对） ---"
  find "$SKILLS" -maxdepth 1 -type f 2>/dev/null | head -20
else
  echo "[warn] 目录不存在: $SKILLS"
fi

hr "2. 容器内对应物：docker exec wagate ls /root/.pi/agent/skills"
safe docker exec wagate ls -1 /root/.pi/agent/skills
echo "--- 容器内岗位目录计数（一级子目录数） ---"
docker exec wagate sh -c 'ls -1d /root/.pi/agent/skills/*/ 2>/dev/null | wc -l' 2>&1 || echo "[warn] docker exec 失败"
echo "--- 容器内 SKILL.md 总数 ---"
docker exec wagate sh -c 'find /root/.pi/agent/skills -name SKILL.md 2>/dev/null | wc -l' 2>&1 || echo "[warn] docker exec 失败"

hr "3. skill-tools.ts：宿主 vs 容器 md5 + wagate.service 挂载行"
HOST_ST=/srv/wagate/patches/skill-tools.ts
CONT_ST=/app/extensions/plugins/skill-tools.ts
[ -f "$HOST_ST" ] && md5sum "$HOST_ST" 2>&1 || echo "[warn] 宿主不存在: $HOST_ST"
docker exec wagate md5sum "$CONT_ST" 2>&1 || echo "[warn] 容器内不存在: $CONT_ST"
echo "--- wagate.service 中 skill-tools 挂载行 ---"
grep -n 'skill-tools' /etc/systemd/system/wagate.service 2>/dev/null || echo "[warn] 无匹配（或无读取权限）"

hr "4. personal-assistant.ts：宿主 vs 容器 md5 + skillGuide 注入段摘录"
HOST_PA=/srv/wagate/patches/personal-assistant.ts
CONT_PA=/app/personal-assistant.ts
[ -f "$HOST_PA" ] && md5sum "$HOST_PA" 2>&1 || echo "[warn] 宿主不存在: $HOST_PA"
docker exec wagate md5sum "$CONT_PA" 2>&1 || echo "[warn] 容器内不存在: $CONT_PA（可能路径不同，见下方 find）"
echo "--- 容器内定位 personal-assistant.ts（备用口径） ---"
docker exec wagate sh -c 'find /app -maxdepth 3 -name personal-assistant.ts 2>/dev/null' 2>&1 || true
echo "--- skillGuide 出现位置（宿主，上下文各 10 行） ---"
if [ -f "$HOST_PA" ]; then
  grep -n 'skillGuide' "$HOST_PA" 2>/dev/null | head -20 || echo "[warn] 无匹配"
  grep -n -B10 -A10 'skillGuide' "$HOST_PA" 2>/dev/null | head -80 || true
else
  echo "[warn] 跳过：宿主文件不存在"
fi
echo "--- skillGuide 规则段（qaonly 相关行，宿主） ---"
if [ -f "$HOST_PA" ]; then
  grep -n -i 'qaonly\|skill_read\|skill_ls\|fastpath' "$HOST_PA" 2>/dev/null | head -40 || echo "[warn] 无匹配"
fi

hr "5. tenant-core：settle 豁免分支（__turnSbxUsed，两处，上下文各 5 行）"
HOST_TC=/srv/wagate/patches/tenant-core.ts
if [ -f "$HOST_TC" ]; then
  grep -n '__turnSbxUsed' "$HOST_TC" 2>/dev/null | head -10 || echo "[warn] 无匹配"
  grep -n -B5 -A5 '__turnSbxUsed' "$HOST_TC" 2>/dev/null | head -60 || true
else
  echo "[warn] 宿主不存在: $HOST_TC"
  docker exec wagate sh -c 'grep -n -B5 -A5 __turnSbxUsed /app/tenant-core.ts 2>/dev/null | head -60' 2>&1 || true
fi

hr "6. 近 7 天技能真实调用统计（journalctl -u wagate，timeout 30）"
echo "--- 优先：audit jsonl ---"
ls -1 /srv/wagate/*.jsonl /srv/wagate/audit*.jsonl /var/log/wagate*.jsonl 2>/dev/null | head -10 || echo "[warn] 未发现 audit jsonl（或无匹配）"
echo "--- journalctl 总量：skill_ls|skill_read 命中行数 ---"
timeout 30 journalctl -u wagate --since '7 days ago' --no-pager 2>/dev/null \
  | grep -cE 'skill_ls|skill_read' || echo "[warn] journalctl 无匹配/超时/无权限"
echo "--- 命中行样例（前 20 行） ---"
timeout 30 journalctl -u wagate --since '7 days ago' --no-pager 2>/dev/null \
  | grep -E 'skill_ls|skill_read' | head -20 || echo "[warn] journalctl 无匹配/超时/无权限"
echo "--- 按技能名分布（前 30） ---"
timeout 30 journalctl -u wagate --since '7 days ago' --no-pager 2>/dev/null \
  | grep -oE 'skill_(ls|read)[^ "]*' | sort | uniq -c | sort -rn | head -30 || echo "[warn] 分布统计无匹配"

hr "7. 容器内 pi 进程形态"
docker exec wagate ps aux 2>&1 | grep -E 'pi|bun' | head -20 || echo "[warn] ps 无匹配"

hr "8. fast-route 三件套在位性：宿主 vs 容器 md5"
for f in aa-dev-dispatch.ts aa-dev-route-guard.ts tenant-core.ts; do
  H="/srv/wagate/patches/$f"
  C="/app/$f"
  if [ -f "$H" ]; then
    printf '%-28s 宿主 ' "$f"; md5sum "$H" 2>&1 | awk '{print $1}'
  else
    printf '%-28s 宿主 [缺失]\n' "$f"
  fi
  printf '%-28s 容器 ' "$f"
  docker exec wagate md5sum "$C" 2>/dev/null | awk '{print $1}' || echo "[缺失或路径不同]"
done

printf '\n### 01 采集结束 ###\n'
