#!/usr/bin/env bash
# deploy-plugin.sh —— EU 侧派单插件 B1 部署脚本（dry-run 默认，--apply 才执行）
#
# 部署铁律（违反即 ABORT）：
#   bun build 真退出码（禁管道取码） → 容器内 import smoke( SMOKE_OK ) → md5 宿主=容器
#   → systemctl is-active wagate 且无在途任务(running=0) 才允许 restart → 重启后复核
#
# 本脚本由操作员在 EU 宿主执行；worker 不执行任何一步。
# 私钥只按路径挂载，脚本内不硬编码任何 key；PLANNER_KEY 由操作员交互输入。
set -euo pipefail

PLUGIN_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/aa-dev-dispatch.ts"
HOST_PATCH_DIR="/srv/wagate/patches"
HOST_PLUGIN="$HOST_PATCH_DIR/aa-dev-dispatch.ts"
CONTAINER_PLUGIN="/app/extensions/plugins/aa-dev-dispatch.ts"
CONTAINER="wagate"
UNIT="/etc/systemd/system/wagate.service"
DROPIN_DIR="$UNIT.d"
DROPIN="$DROPIN_DIR/route-mount.conf"
ENV_FILE="/etc/wagate.env"
KEY_PATH_DEFAULT="/srv/secrets/dispatch-app/sandbox-dispatch.private-key.pem"
PLANNER_MODEL_DEFAULT="deepseek-ai/DeepSeek-V4.1-Flash"

APPLY=0
TS="$(date +%s)"

usage() {
	sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	echo
	echo "用法: $0 [--apply] [--plugin PATH] [--help]"
	echo "  默认 dry-run：只打印将执行的每一步"
	echo "  --apply      真正执行部署"
	exit 0
}

PLUGIN_SRC_OVERRIDE=""
while [ $# -gt 0 ]; do
	case "$1" in
		--apply) APPLY=1 ;;
		--plugin) shift; PLUGIN_SRC_OVERRIDE="${1:-}" ;;
		-h|--help) usage ;;
		*) echo "未知参数: $1" >&2; exit 2 ;;
	esac
	shift
done

[ -n "$PLUGIN_SRC_OVERRIDE" ] && PLUGIN_SRC="$PLUGIN_SRC_OVERRIDE"

say()  { echo "[deploy] $*"; }
step() { echo; echo "=== $* ==="; }
abort() {
	echo
	echo "ABORT: $*" >&2
	echo "已完成的步骤需要按下面命令回退：" >&2
	print_rollback >&2
	exit 1
}

ROLLBACK=()
note_rollback() { ROLLBACK+=("$1"); }
print_rollback() {
	if [ "${#ROLLBACK[@]}" -eq 0 ]; then
		echo "  （尚未改动任何东西）"
		return
	fi
	for r in "${ROLLBACK[@]}"; do echo "  $r"; done
}

# ---------------------------------------------------------------------------
step "0) 前置检查"
[ -f "$PLUGIN_SRC" ] || abort "找不到插件源文件: $PLUGIN_SRC"
if [ "$APPLY" -eq 1 ]; then
	command -v docker >/dev/null 2>&1 || abort "找不到 docker"
	command -v systemctl >/dev/null 2>&1 || abort "找不到 systemctl"
	docker inspect "$CONTAINER" >/dev/null 2>&1 || abort "容器不存在或不可访问: $CONTAINER"
else
	say "（dry-run：跳过 docker/systemctl/容器存在性检查）"
fi
say "插件源: $PLUGIN_SRC"
say "宿主落地: $HOST_PLUGIN"
say "容器路径: $CONTAINER_PLUGIN"
say "容器: $CONTAINER"
say "drop-in: $DROPIN"
say "env: $ENV_FILE"

if [ "$APPLY" -eq 0 ]; then
	cat <<EOF

[dry-run] 以下步骤将按顺序执行（加 --apply 才真正执行）：

  1. mkdir -p $HOST_PATCH_DIR && cp $PLUGIN_SRC $HOST_PLUGIN（旧文件先备份 .bak.route.<ts>）
  2. 备份 unit 与 drop-in，写入 $DROPIN 两行 BindMount（插件与私钥，:ro），
     然后 daemon-reload + 一次 restart 让挂载生效（否则容器看不到插件）
  3. 容器内构建验证（真退出码，禁管道取码）：
       docker exec $CONTAINER sh -c 'bun build $CONTAINER_PLUGIN --outdir /tmp/frc > /tmp/frc-build.log 2>&1; echo \$?'
     退出码非 0 → ABORT 并 cat /tmp/frc-build.log
  4. 运行时 smoke：
       docker exec $CONTAINER bun -e 'await import("$CONTAINER_PLUGIN");console.log("SMOKE_OK")'
     输出无 SMOKE_OK → ABORT
  5. 备份 $ENV_FILE，追加 env 段：WAGATE_DISPATCH_OFF=0 /
     WAGATE_DISPATCH_KEY_PATH / WAGATE_DISPATCH_PLANNER_MODEL /
     WAGATE_DISPATCH_PLANNER_URL（容器内探测 3001 端口，取第一个 /v1/models 通的）
     PLANNER_KEY 由操作员交互输入（不落盘到本脚本）
  6. daemon-reload → 校验 is-active=active 且无在途任务(running=0) → restart
     → 复核容器 env 与 md5 宿主==容器

每一步失败即 ABORT，并打印已做步骤的回退命令。
EOF
	exit 0
fi

# ---------------------------------------------------------------------------
step "1) 拷贝插件到宿主补丁目录"
mkdir -p "$HOST_PATCH_DIR"
if [ -f "$HOST_PLUGIN" ]; then
	cp -p "$HOST_PLUGIN" "$HOST_PLUGIN.bak.route.$TS"
	say "备份旧插件: $HOST_PLUGIN.bak.route.$TS"
	note_rollback "cp -p $HOST_PLUGIN.bak.route.$TS $HOST_PLUGIN"
fi
cp "$PLUGIN_SRC" "$HOST_PLUGIN"
say "已拷贝: $PLUGIN_SRC -> $HOST_PLUGIN"

# ---------------------------------------------------------------------------
step "2) unit drop-in（BindMount）"
# 先做 drop-in，保证第 2/3 步的容器路径可见（首次部署时容器里还没有该文件）。
mkdir -p "$DROPIN_DIR"
[ -f "$UNIT" ] && cp -p "$UNIT" "$UNIT.bak.route.$TS" && say "备份 unit: $UNIT.bak.route.$TS"
if [ -f "$DROPIN" ]; then
	cp -p "$DROPIN" "$DROPIN.bak.route.$TS"
	say "备份 drop-in: $DROPIN.bak.route.$TS"
	note_rollback "cp -p $DROPIN.bak.route.$TS $DROPIN"
else
	note_rollback "rm -f $DROPIN   # 首次创建，回退即删除"
fi

KEY_PATH="${WAGATE_DISPATCH_KEY_PATH:-$KEY_PATH_DEFAULT}"
[ -f "$KEY_PATH" ] || abort "私钥文件不存在: $KEY_PATH（可用 WAGATE_DISPATCH_KEY_PATH 覆盖）"

cat >"$DROPIN" <<EOF
[Service]
BindMount=$HOST_PLUGIN:$CONTAINER_PLUGIN:ro
BindMount=$KEY_PATH:$KEY_PATH:ro
EOF
say "已写入 $DROPIN:"
sed 's/^/    /' "$DROPIN"

# 让挂载生效（restart 前先 reload+restart 一次，使容器能看到插件以做构建/smoke 验证）
say "reload + 临时 restart 以使 BindMount 生效（用于第 2/3 步验证）"
systemctl daemon-reload
systemctl restart "$CONTAINER" || abort "首次 restart 失败（挂载可能不合法）"

# ---------------------------------------------------------------------------
step "3) 容器内构建验证（真退出码，禁管道取码）"
set +e
docker exec "$CONTAINER" sh -c "bun build $CONTAINER_PLUGIN --outdir /tmp/frc > /tmp/frc-build.log 2>&1; echo \$?" >/tmp/frc-rc.txt 2>&1
RC="$(tr -d '[:space:]' </tmp/frc-rc.txt)"
set -e
say "bun build 退出码: ${RC:-<空>}"
if [ "${RC:-}" != "0" ]; then
	echo "--- /tmp/frc-build.log ---" >&2
	docker exec "$CONTAINER" cat /tmp/frc-build.log >&2 || true
	abort "bun build 失败（退出码 ${RC:-空}）"
fi
say "构建验证通过"

# ---------------------------------------------------------------------------
step "4) 运行时 smoke（容器内 import）"
SMOKE_OUT="$(docker exec "$CONTAINER" bun -e "await import(\"$CONTAINER_PLUGIN\");console.log(\"SMOKE_OK\")" 2>&1 || true)"
echo "$SMOKE_OUT" | sed 's/^/    /'
case "$SMOKE_OUT" in
	*SMOKE_OK*) say "运行时 smoke 通过" ;;
	*) abort "运行时 smoke 未输出 SMOKE_OK" ;;
esac

# ---------------------------------------------------------------------------
step "5) env 注入"
[ -f "$ENV_FILE" ] || { touch "$ENV_FILE"; say "env 文件不存在，已创建空文件"; }
cp -p "$ENV_FILE" "$ENV_FILE.bak.route.$TS"
say "备份 env: $ENV_FILE.bak.route.$TS"
note_rollback "cp -p $ENV_FILE.bak.route.$TS $ENV_FILE"

# 探测规划官可达地址：容器内依次试两个候选，取第一个 /v1/models 通的
PLANNER_BASE=""
for cand in "http://127.0.0.1:3001/v1" "http://172.17.0.1:3001/v1"; do
	say "探测规划官: $cand/models"
	if docker exec "$CONTAINER" sh -c "curl -fsS -m 5 '$cand/models' >/dev/null 2>&1"; then
		PLANNER_BASE="$cand"
		break
	fi
done
[ -n "$PLANNER_BASE" ] || abort "规划官不可达（已试 127.0.0.1:3001 与 172.17.0.1:3001）；请人工确认地址后手动写入 WAGATE_DISPATCH_PLANNER_URL"
say "规划官地址: $PLANNER_BASE"

PLANNER_MODEL="${WAGATE_DISPATCH_PLANNER_MODEL:-$PLANNER_MODEL_DEFAULT}"

# PLANNER_KEY：交互输入，不回显、不写日志
if [ -t 0 ]; then
	printf '[deploy] 请输入规划官 API Key（直接回车=跳过，留空则插件用无鉴权请求）: '
	read -rs PLANNER_KEY_IN || PLANNER_KEY_IN=""
	echo
else
	PLANNER_KEY_IN="${WAGATE_DISPATCH_PLANNER_KEY:-}"
	[ -n "$PLANNER_KEY_IN" ] || say "非交互执行且未提供 WAGATE_DISPATCH_PLANNER_KEY，将写入空值"
fi

{
	echo ""
	echo "# --- fast-route dispatch (added by deploy-plugin.sh $TS) ---"
	echo "WAGATE_DISPATCH_OFF=0"
	echo "WAGATE_DISPATCH_KEY_PATH=$KEY_PATH"
	echo "WAGATE_DISPATCH_PLANNER_MODEL=$PLANNER_MODEL"
	echo "WAGATE_DISPATCH_PLANNER_URL=$PLANNER_BASE/chat/completions"
	if [ -n "$PLANNER_KEY_IN" ]; then
		echo "WAGATE_DISPATCH_PLANNER_KEY=$PLANNER_KEY_IN"
	fi
} >>"$ENV_FILE"
say "已追加 env 段（key 值不回显）"

# ---------------------------------------------------------------------------
step "6) 门禁 → restart → 复核"
systemctl daemon-reload

ACTIVE="$(systemctl is-active "$CONTAINER" 2>/dev/null || true)"
say "systemctl is-active $CONTAINER = $ACTIVE"
[ "$ACTIVE" = "active" ] || abort "服务非 active（当前 $ACTIVE），不允许 restart"

# 在途任务检查：running=0 才允许 restart
RUNNING="$(docker exec "$CONTAINER" sh -c 'wget -qO- http://127.0.0.1:3001/healthz 2>/dev/null || curl -fsS -m 5 http://127.0.0.1:3001/healthz 2>/dev/null' || true)"
if [ -n "$RUNNING" ]; then
	echo "$RUNNING" | sed 's/^/    healthz: /'
	case "$RUNNING" in
		*'"running":0'*|*'"running": 0'*) say "running=0，允许 restart" ;;
		*) abort "检测到在途任务（running≠0）。请等任务跑完再执行；本次已改动 ${#ROLLBACK[@]} 处，可用上面命令回退。" ;;
	esac
else
	say "healthz 不可读（可能无该端点）——按铁律需人工确认 running=0"
	if [ -t 0 ]; then
		printf '[deploy] 确认当前无在途任务可安全 restart？(yes/no): '
		read -r ok || ok="no"
		[ "$ok" = "yes" ] || abort "操作员未确认 running=0"
	else
		abort "非交互执行且无法自动确认 running=0；请人工确认后重跑，或先手工 restart"
	fi
fi

systemctl restart "$CONTAINER" || abort "restart 失败"
sleep 3
ACTIVE2="$(systemctl is-active "$CONTAINER" 2>/dev/null || true)"
[ "$ACTIVE2" = "active" ] || abort "restart 后服务非 active（当前 $ACTIVE2）"

# 复核 env 与 md5
say "复核容器内 env："
docker exec "$CONTAINER" sh -c 'env | grep -E "^WAGATE_DISPATCH_" | sed "s/\(KEY=\).*/\1***/"' | sed 's/^/    /' || abort "容器内未见 WAGATE_DISPATCH_* 变量"

HOST_MD5="$(md5sum "$HOST_PLUGIN" | awk '{print $1}')"
CONT_MD5="$(docker exec "$CONTAINER" md5sum "$CONTAINER_PLUGIN" | awk '{print $1}')"
say "宿主 md5:   $HOST_MD5"
say "容器 md5:   $CONT_MD5"
[ "$HOST_MD5" = "$CONT_MD5" ] || abort "md5 不一致：宿主与容器内容不同"

echo
echo "OK: 部署完成。"
echo "回退命令："
print_rollback
