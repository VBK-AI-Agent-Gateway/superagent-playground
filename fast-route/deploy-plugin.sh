#!/usr/bin/env bash
# deploy-plugin.sh v2 —— EU 侧派单插件 B1 部署脚本（操作员修正版）
#
# v2 修正（操作员审查 worker v1 后）：
#   1. wagate.service 是 docker 型 unit，挂载=ExecStart 内 -v 参数（systemd BindMount 对容器无效）
#   2. /srv/secrets 已整体挂载进容器（-v /srv/secrets:/srv/secrets），私钥无需单独挂载
#   3. 合并为单次 restart，running=0 门禁前置于 restart（v1 的临时 restart 无门禁）
#
# 部署铁律：真退出码 → SMOKE_OK → md5 宿主=容器 → running=0 门禁 → restart → 复核
# 由操作员在 EU 宿主执行；worker 不执行任何一步。
set -euo pipefail

PLUGIN_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aa-dev-dispatch.ts"
HOST_PATCH_DIR="/srv/wagate/patches"
HOST_PLUGIN="$HOST_PATCH_DIR/aa-dev-dispatch.ts"
CONTAINER_PLUGIN="/app/extensions/plugins/aa-dev-dispatch.ts"
CONTAINER="wagate"
UNIT="/etc/systemd/system/wagate.service"
ENV_FILE="/etc/wagate.env"
KEY_PATH_DEFAULT="/srv/secrets/dispatch-app/sandbox-dispatch.private-key.pem"
PLANNER_MODEL_DEFAULT="deepseek-ai/DeepSeek-V4.1-Flash"
MOUNT_FRAG="-v /srv/wagate/patches/aa-dev-dispatch.ts:/app/extensions/plugins/aa-dev-dispatch.ts:ro"

APPLY=0
TS="$(date +%s)"
while [ $# -gt 0 ]; do
	case "$1" in
		--apply) APPLY=1 ;;
		-h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
		*) echo "未知参数: $1" >&2; exit 2 ;;
	esac
	shift
done

say()  { echo "[deploy] $*"; }
step() { echo; echo "=== $* ==="; }
ROLLBACK=()
note_rollback() { ROLLBACK+=("$1"); }
print_rollback() {
	if [ "${#ROLLBACK[@]}" -eq 0 ]; then echo "  （尚未改动任何东西）"; return; fi
	for r in "${ROLLBACK[@]}"; do echo "  $r"; done
}
abort() {
	echo; echo "ABORT: $*" >&2; echo "已做步骤回退命令：" >&2; print_rollback >&2; exit 1
}

step "0) 前置检查"
[ -f "$PLUGIN_SRC" ] || abort "找不到插件源文件: $PLUGIN_SRC"
if [ "$APPLY" -eq 1 ]; then
	command -v docker >/dev/null 2>&1 || abort "找不到 docker"
	docker inspect "$CONTAINER" >/dev/null 2>&1 || abort "容器不存在: $CONTAINER"
	KEY_PATH="${WAGATE_DISPATCH_KEY_PATH:-$KEY_PATH_DEFAULT}"
	[ -f "$KEY_PATH" ] || abort "私钥不存在: $KEY_PATH"
	# 私钥容器内可见性（/srv/secrets 已整体挂载，仅需确认）
	docker exec "$CONTAINER" ls "$KEY_PATH" >/dev/null 2>&1 || abort "容器内看不到私钥: $KEY_PATH（检查 /srv/secrets 挂载）"
	say "私钥容器内可见: $KEY_PATH"
else
	say "（dry-run：跳过 docker 检查）"
fi
say "插件源: $PLUGIN_SRC → 宿主: $HOST_PLUGIN → 容器: $CONTAINER_PLUGIN"

if [ "$APPLY" -eq 0 ]; then
	cat <<EOF

[dry-run] 步骤（--apply 才执行）：
  1. 拷贝插件到 $HOST_PLUGIN（旧文件备份 .bak.route.<ts>）
  2. unit ExecStart 注入 $MOUNT_FRAG（幂等，unit 先备份）
  3. env 注入 /etc/wagate.env（备份后追加；PLANNER_KEY 交互输入不落脚本）
  4. daemon-reload → running=0 门禁（ledger 扫描 + 近 5 分钟无交付活动）→ 单次 restart
  5. 复核：active / 容器 env / md5 宿主=容器 / SMOKE_OK
EOF
	exit 0
fi

step "1) 拷贝插件到宿主补丁目录"
mkdir -p "$HOST_PATCH_DIR"
if [ -f "$HOST_PLUGIN" ]; then
	cp -p "$HOST_PLUGIN" "$HOST_PLUGIN.bak.route.$TS"
	say "备份旧插件: $HOST_PLUGIN.bak.route.$TS"
	note_rollback "cp -p $HOST_PLUGIN.bak.route.$TS $HOST_PLUGIN"
fi
cp "$PLUGIN_SRC" "$HOST_PLUGIN"
say "已拷贝"

step "2) unit ExecStart 注入 -v（幂等）"
UNIT_BAK="$UNIT.bak.route.$TS"
cp -p "$UNIT" "$UNIT_BAK"
say "备份 unit: $UNIT_BAK"
note_rollback "cp -p $UNIT_BAK $UNIT && systemctl daemon-reload && systemctl restart $CONTAINER"
if grep -q "patches/aa-dev-dispatch.ts" "$UNIT"; then
	say "SKIP: unit 已含 aa-dev-dispatch 挂载"
else
	# ExecStart 行以镜像名 wagate:3 结尾；在其前插入 -v 片段
	sed -i "s| wagate:3$| $MOUNT_FRAG wagate:3|" "$UNIT"
	grep -q "patches/aa-dev-dispatch.ts:/app/extensions/plugins/aa-dev-dispatch.ts:ro" "$UNIT" \
		|| { cp -p "$UNIT_BAK" "$UNIT"; abort "unit 注入失败（已回滚 unit）"; }
	say "已注入 ExecStart（新增 1 个 -v）"
fi

step "3) env 注入"
cp -p "$ENV_FILE" "$ENV_FILE.bak.route.$TS"
say "备份 env: $ENV_FILE.bak.route.$TS"
note_rollback "cp -p $ENV_FILE.bak.route.$TS $ENV_FILE"
PLANNER_BASE=""
for cand in "http://127.0.0.1:3001/v1" "http://172.17.0.1:3001/v1"; do
	say "探测规划官: $cand/models"
	if docker exec "$CONTAINER" sh -c "curl -fsS -m 5 '$cand/models' >/dev/null 2>&1"; then
		PLANNER_BASE="$cand"; break
	fi
done
[ -n "$PLANNER_BASE" ] || abort "规划官不可达（127.0.0.1:3001 与 172.17.0.1:3001 均不通）；人工确认后手填 WAGATE_DISPATCH_PLANNER_URL"
say "规划官地址: $PLANNER_BASE"
PLANNER_MODEL="${WAGATE_DISPATCH_PLANNER_MODEL:-$PLANNER_MODEL_DEFAULT}"
if [ -t 0 ]; then
	printf '[deploy] 请输入规划官 API Key（回车=跳过）: '
	read -rs PLANNER_KEY_IN || PLANNER_KEY_IN=""; echo
else
	PLANNER_KEY_IN="${WAGATE_DISPATCH_PLANNER_KEY:-}"
	[ -n "$PLANNER_KEY_IN" ] || say "非交互且未提供 WAGATE_DISPATCH_PLANNER_KEY，写入空值（插件调用规划官将 401）"
fi
{
	echo ""
	echo "# --- fast-route dispatch (added by deploy-plugin.sh v2 $TS) ---"
	echo "WAGATE_DISPATCH_OFF=0"
	echo "WAGATE_DISPATCH_KEY_PATH=$KEY_PATH"
	echo "WAGATE_DISPATCH_PLANNER_MODEL=$PLANNER_MODEL"
	echo "WAGATE_DISPATCH_PLANNER_URL=$PLANNER_BASE/chat/completions"
	[ -n "$PLANNER_KEY_IN" ] && echo "WAGATE_DISPATCH_PLANNER_KEY=$PLANNER_KEY_IN"
} >>"$ENV_FILE"
say "env 已追加（key 不回显）"

step "4) 门禁 → 单次 restart"
systemctl daemon-reload
ACTIVE="$(systemctl is-active "$CONTAINER" 2>/dev/null || true)"
[ "$ACTIVE" = "active" ] || abort "服务非 active（$ACTIVE）"
RUNNING_SUM=0
for db in /srv/tenants/*/ledger.db; do
	[ -f "$db" ] || continue
	C="$(docker exec "$CONTAINER" bun -e "import{Database} from 'bun:sqlite'; try{var d=new Database(process.argv[1],{readonly:true}); var r=d.prepare(\"select count(*) c from tasks where state='running'\").get(); console.log(r?r.c:0)}catch(e){console.log('ERR')}" "$db" 2>/dev/null || echo ERR)"
	say "  ledger $(basename "$db"): running=${C}"
	case "$C" in ERR|"") say "  （该账本不可读，跳过计数——靠下方日志门禁兜底）" ;; *) RUNNING_SUM=$((RUNNING_SUM + C)) ;; esac
done
[ "$RUNNING_SUM" -eq 0 ] || abort "检测到在途任务 running=$RUNNING_SUM，等收口后再部署"
RECENT="$(docker logs "$CONTAINER" --since 5m 2>&1 | grep -cE "deliver_local ok|delivered|task_started" || true)"
[ "$RECENT" -eq 0 ] || abort "近 5 分钟有交付活动（$RECENT 次），等空闲窗口"
say "门禁通过（running=0 且近 5 分钟零交付）"
systemctl restart "$CONTAINER"
sleep 3
systemctl is-active "$CONTAINER" >/dev/null || abort "restart 后服务非 active"

step "5) 复核"
say "容器 env："
docker exec "$CONTAINER" sh -c 'env | grep -E "^WAGATE_DISPATCH_" | sed "s/\(KEY=\).*/\1***/"' | sed 's/^/    /'
docker exec "$CONTAINER" sh -c 'env | grep -q "^WAGATE_DISPATCH_OFF=0"' || abort "容器内未见 WAGATE_DISPATCH_* env（EnvironmentFile 未生效？）"
HOST_MD5="$(md5sum "$HOST_PLUGIN" | awk "{print \$1}")"
CONT_MD5="$(docker exec "$CONTAINER" md5sum "$CONTAINER_PLUGIN" | awk "{print \$1}")"
say "md5 宿主=$HOST_MD5 容器=$CONT_MD5"
[ "$HOST_MD5" = "$CONT_MD5" ] || abort "md5 不一致"
SMOKE_OUT="$(docker exec "$CONTAINER" bun -e "await import(\"$CONTAINER_PLUGIN\");console.log(\"SMOKE_OK\")" 2>&1 || true)"
echo "$SMOKE_OUT" | sed 's/^/    /'
case "$SMOKE_OUT" in *SMOKE_OK*) say "SMOKE_OK" ;; *) abort "运行时 smoke 未通过" ;; esac

echo
echo "OK: 部署完成。回退命令："
print_rollback
