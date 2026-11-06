#!/usr/bin/env bash
# =============================================================================
# eu-fix2-img-voice / 20-apply.sh  —  issue #21 交付物 ①  (P0)
# EU 沙箱 wagate 图片/视频链入口恢复 —— 应用阶段：硬守卫 -> 重启 -> 健康门。
#
# 前提: 10-prepare.sh 已成功执行(改盘完成, 未重启)。
# 结构:
#   [1] 前置检查 + 硬守卫 (ledger.db state='running', >0 即 ABORT, --force 显式覆盖)
#   [2] daemon-reload
#   [3] 单次 docker restart wagate (不做多次, 不 mask)
#   [4] 健康门: docker ps / logs 无 FATAL·ParseError / bun import smoke
#              / 四文件 md5 host=container / getMe 200
#   [5] CONCLUSION
# 铁律: 单次 restart; 无 running 工单或 --force 才继续。
# =============================================================================
set -euo pipefail

SRC_DIR="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
UNIT="/etc/systemd/system/wagate.service"
CONTAINER="${CONTAINER:-wagate}"
PATCH_DIR="/srv/wagate/patches"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '[FATAL] %s\n' "$*" >&2; exit 1; }
warn(){ printf '[WARN] %s\n' "$*" >&2; }

# --- [1] 前置检查 + 硬守卫 --------------------------------------------------
log "=== 20-apply.sh 开始 (CONTAINER=$CONTAINER FORCE=$FORCE) ==="
[ "$(id -u)" = "0" ] || die "需要 root 执行"
[ -f "$UNIT" ] || die "unit 不存在: $UNIT"
docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 || die "容器 $CONTAINER 不存在"

# prepare 是否已跑过: 挂载点 + 改盘标记
grep -q 'BindReadOnlyPaths=/srv/wagate/patches/img-ops.ts' "$UNIT" \
	|| die "unit 未含 img-ops 挂载 — 请先执行 10-prepare.sh"
[ -s "$PATCH_DIR/img-ops.ts" ] && [ -s "$PATCH_DIR/img-lab.ts" ] \
	|| die "$PATCH_DIR 缺少 img-ops.ts / img-lab.ts — 请先执行 10-prepare.sh"

# 硬守卫: 只读 sqlite3 查 /srv/tenants/*/ledger.db 的 running 工单
log "[1] 硬守卫: 扫描 /srv/tenants/*/ledger.db state='running'"
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
except Exception as e:
    print("ERR")
finally:
    con.close()
PY
)"
	if [ "$cnt" = "ERR" ]; then
		warn "  无法只读读取 $db (schema 未知或权限), 记为未知"
		RUNNING_TOTAL=$((RUNNING_TOTAL + 1))
	elif [ "$cnt" != "0" ]; then
		log "  $db -> running=$cnt"
		RUNNING_TOTAL=$((RUNNING_TOTAL + cnt))
	fi
done
shopt -u nullglob

if [ "$RUNNING_TOTAL" != "0" ] && [ "$FORCE" != "1" ]; then
	die "检测到 $RUNNING_TOTAL 个 running/未知工单 — 重启会打断在跑任务。确认安全后用 --force 显式覆盖。"
fi
[ "$RUNNING_TOTAL" != "0" ] && warn "存在 $RUNNING_TOTAL 个 running/未知工单, 但 --force 已显式指定, 继续。"

# --- [2] daemon-reload ------------------------------------------------------
log "[2] systemctl daemon-reload"
systemctl daemon-reload || die "daemon-reload 失败"

# --- [3] 单次重启 -----------------------------------------------------------
log "[3] docker restart $CONTAINER (单次)"
docker restart "$CONTAINER" >/dev/null || die "docker restart 失败"
log "  restart 已发出, 等待健康门 (${HEALTH_TIMEOUT}s)"

# --- [4] 健康门 -------------------------------------------------------------
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
ok_ps=0
while [ "$(date +%s)" -lt "$deadline" ]; do
	st="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)"
	if [ "$st" = "true" ]; then ok_ps=1; break; fi
	sleep 2
done
[ "$ok_ps" = "1" ] || die "健康门失败: 容器未进入 running"
log "  [4.1] docker ps OK (running)"

# 4.2 logs 无 FATAL / ParseError
sleep 3
logs="$(docker logs --since 90s "$CONTAINER" 2>&1 || true)"
if printf '%s' "$logs" | grep -qE 'FATAL|ParseError|SyntaxError'; then
	printf '%s\n' "$logs" | grep -nE 'FATAL|ParseError|SyntaxError' | head -20 >&2
	die "健康门失败: 日志出现 FATAL/ParseError/SyntaxError"
fi
log "  [4.2] logs 无 FATAL/ParseError OK"

# 4.3 bun import smoke (img-ops + img-lab)
for f in img-ops.ts img-lab.ts; do
	if ! docker exec "$CONTAINER" bun build "/srv/wagate/$f" --no-bundle >/tmp/imp.log 2>&1; then
		sed -n '1,30p' /tmp/imp.log >&2
		die "健康门失败: bun import smoke $f 未通过"
	fi
done
log "  [4.3] bun import smoke img-ops + img-lab OK"

# 4.4 四文件 md5 host == container
for pair in "telegram.ts:/srv/wagate/telegram.ts" "bot.ts:/srv/wagate/bot.ts" \
            "patches/img-ops.ts:/srv/wagate/img-ops.ts" "patches/img-lab.ts:/srv/wagate/img-lab.ts"; do
	h="${pair%%:*}"; c="${pair##*:}"
	hh="$(md5sum "/srv/wagate/$h" | awk '{print $1}')"
	cc="$(docker exec "$CONTAINER" md5sum "$c" | awk '{print $1}')"
	[ "$hh" = "$cc" ] || die "健康门失败: md5 不一致 $h host=$hh container=$cc"
	log "  [4.4] md5 OK $h ($hh)"
done

# 4.5 getMe 200
TOKEN="$(docker exec "$CONTAINER" printenv TELEGRAM_BOT_TOKEN 2>/dev/null || true)"
if [ -n "$TOKEN" ]; then
	code="$(curl -s -o /tmp/getme.json -w '%{http_code}' --max-time 10 "https://api.telegram.org/bot${TOKEN}/getMe" || echo 000)"
	[ "$code" = "200" ] || die "健康门失败: getMe HTTP $code"
	log "  [4.5] getMe 200 OK"
else
	warn "  [4.5] 未取到 TELEGRAM_BOT_TOKEN(容器 env), 跳过 getMe"
fi

# --- [5] CONCLUSION ---------------------------------------------------------
log "=== CONCLUSION: OK ==="
log "图片/视频链补丁已生效。请人工验证: 发一张图 + 要求 / 发一段视频 + 要求。"
log "如需回退: bash 30-rollback.sh"
