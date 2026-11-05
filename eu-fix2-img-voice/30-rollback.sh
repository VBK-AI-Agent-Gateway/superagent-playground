#!/usr/bin/env bash
# =============================================================================
# eu-fix2-img-voice / 30-rollback.sh  —  issue #21 交付物 ①  (P0)
# EU 沙箱 wagate 图片/视频链入口恢复 —— 回滚：恢复 .bak + 还原 unit + 重启。
#
# 结构:
#   [1] 前置检查 + 定位备份 (argv[1] 或 /root/eu-fix2-img-voice.LASTBAK)
#   [2] 硬守卫 (同 20-apply: running 工单 >0 需 --force)
#   [3] 恢复 telegram.ts / bot.ts (cat > 目标, 保 inode)
#   [4] 还原 unit (整文件覆盖, 保 inode) + 删 patches 挂载
#   [5] daemon-reload + 单次 restart + 健康门
#   [6] ROLLBACK OK
# =============================================================================
set -euo pipefail

UNIT="/etc/systemd/system/wagate.service"
CONTAINER="${CONTAINER:-wagate}"
PATCH_DIR="/srv/wagate/patches"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
FORCE=0
BAK_ARG=""
for a in "$@"; do
	case "$a" in
		--force) FORCE=1 ;;
		*) BAK_ARG="$a" ;;
	esac
done

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[FATAL] %s\n' "$*" >&2; exit 1; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }

# --- [1] 定位备份 -----------------------------------------------------------
log "=== 30-rollback.sh 开始 (CONTAINER=$CONTAINER FORCE=$FORCE) ==="
[ "$(id -u)" = "0" ] || die "需要 root 执行"

if [ -n "$BAK_ARG" ]; then
	BAK_DIR="$BAK_ARG"
elif [ -s /root/eu-fix2-img-voice.LASTBAK ]; then
	BAK_DIR="$(cat /root/eu-fix2-img-voice.LASTBAK)"
else
	BAK_DIR="$(ls -1d /root/eu-fix2-img-voice.bak.* 2>/dev/null | sort | tail -1 || true)"
fi
[ -n "$BAK_DIR" ] && [ -d "$BAK_DIR" ] || die "找不到备份目录(可用: bash 30-rollback.sh <bak_dir>)"
log "[1] 使用备份: $BAK_DIR"
for f in telegram.ts bot.ts wagate.service; do
	[ -s "$BAK_DIR/$f" ] || die "备份缺少 $f: $BAK_DIR/$f"
done

docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 || die "容器 $CONTAINER 不存在"

# --- [2] 硬守卫 (与 20-apply 同源) -----------------------------------------
log "[2] 硬守卫: 扫描 running 工单"
RUNNING_TOTAL=0
shopt -s nullglob
for db in /srv/tenants/*/ledger.db; do
	cnt="$(python3 - "$db" <<'PY' 2>/dev/null || echo "ERR"
import sqlite3, sys
con = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
try:
    rows = con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    names = {r[0] for r in rows}
    if "tasks" not in names and "tickets" not in names and "jobs" not in names:
        print("0"); raise SystemExit
    table = "tasks" if "tasks" in names else ("tickets" if "tickets" in names else "jobs")
    cols = {r[1] for r in con.execute("PRAGMA table_info(%s)" % table).fetchall()}
    if "state" not in cols:
        print("0"); raise SystemExit
    n = con.execute("SELECT COUNT(*) FROM %s WHERE state='running'" % table).fetchone()[0]
    print(int(n))
except Exception:
    print("ERR")
finally:
    con.close()
PY
)"
	if [ "$cnt" = "ERR" ]; then RUNNING_TOTAL=$((RUNNING_TOTAL + 1));
	elif [ "$cnt" != "0" ]; then RUNNING_TOTAL=$((RUNNING_TOTAL + cnt)); fi
done
shopt -u nullglob
if [ "$RUNNING_TOTAL" != "0" ] && [ "$FORCE" != "1" ]; then
	die "检测到 $RUNNING_TOTAL 个 running/未知工单 — 回滚重启会打断任务。确认安全后用 --force。"
fi

# --- [3] 恢复 host 文件 (保 inode) -----------------------------------------
log "[3] 恢复 telegram.ts / bot.ts"
for f in telegram.ts bot.ts; do
	cat "$BAK_DIR/$f" > "/srv/wagate/$f" || die "恢复 $f 失败"
	cmp -s "$BAK_DIR/$f" "/srv/wagate/$f" || die "恢复后 $f 与备份不一致"
	log "  restored in-place: /srv/wagate/$f"
done

# --- [4] 还原 unit (去掉 patches 挂载) -------------------------------------
log "[4] 还原 $UNIT"
cat "$BAK_DIR/wagate.service" > "$UNIT" || die "还原 unit 失败"
cmp -s "$BAK_DIR/wagate.service" "$UNIT" || die "unit 还原后与备份不一致"
if grep -q 'BindReadOnlyPaths=/srv/wagate/patches' "$UNIT"; then
	warn "  还原后的 unit 仍含 patches 挂载 — 备份可能取自 prepare 之后, 请人工确认"
fi
log "  unit restored"

# --- [5] daemon-reload + 单次重启 + 健康门 ---------------------------------
log "[5] daemon-reload + docker restart (单次)"
systemctl daemon-reload || die "daemon-reload 失败"
docker restart "$CONTAINER" >/dev/null || die "docker restart 失败"

deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ok=0
while [ "$(date +%s)" -lt "$deadline" ]; do
	[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ] && { ok=1; break; }
	sleep 2
done
[ "$ok" = "1" ] || die "回滚后容器未 running"
sleep 3
logs="$(docker logs --since 90s "$CONTAINER" 2>&1 || true)"
if printf '%s' "$logs" | grep -qE 'FATAL|ParseError|SyntaxError'; then
	printf '%s\n' "$logs" | grep -nE 'FATAL|ParseError|SyntaxError' | head -20 >&2
	die "回滚后日志出现 FATAL/ParseError, 请人工介入"
fi
log "  health OK (container running, logs clean)"

# --- [6] 收尾 ---------------------------------------------------------------
log "=== ROLLBACK OK ==="
log "已恢复: telegram.ts / bot.ts / wagate.service (基线: $BAK_DIR)"
log "注: $PATCH_DIR 保持原样(只读挂载已从 unit 移除, 不再生效); 如需清理请人工删除。"
