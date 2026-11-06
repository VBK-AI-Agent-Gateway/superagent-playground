#!/usr/bin/env bash
# 01-verify.sh — EU NetBird 复机机械验收脚本（只读，<30s）
#
# 用法:
#   bash 01-verify.sh                 # 默认检查 root@5.189.129.216
#   bash 01-verify.sh <ssh-target>    # 覆盖 SSH 目标，如 root@1.2.3.4
#   EU_SSH=<ssh-target> bash 01-verify.sh
#
# 行为:
#   * 全程只读：只执行 docker ps / curl / ss / docker exec 查询类命令
#   * 绝不 docker-compose up/down、绝不删卷、绝不改配置、绝不重启任何服务
#   * 每条检查逐行输出 PASS/FAIL，末尾给出汇总与退出码（全 PASS=0，否则=1）
#   * 总耗时预算 <30s（每条远程检查带超时）
#
# 自检: bash -n 01-verify.sh
set -u

SSH_TARGET="${1:-${EU_SSH:-root@5.189.129.216}}"
SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8)

PASS=0
FAIL=0

pass() { printf 'PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL + 1)); }
info() { printf '      %s\n' "$1"; }

# 在 EU 上执行一条只读命令；stdout 为结果，失败返回非 0
remote() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$1" 2>/dev/null
}

echo "== EU NetBird 复机验收 (target: $SSH_TARGET) =="

# --- 0. 连通性前置检查（不计入 PASS/FAIL，仅决定后续能否判定） -------------
if ! remote 'true' >/dev/null; then
  fail "SSH 连通性: 无法连接 $SSH_TARGET（后续检查无法判定）"
  echo
  echo "== 汇总: $PASS PASS / $FAIL FAIL =="
  exit 1
fi
pass "SSH 连通性: $SSH_TARGET 可达"

# --- 1. 三容器 Up 布尔 -----------------------------------------------------
# docker ps 只列运行中容器；逐个精确匹配 name 字段避免子串误判
for c in netbird-nginx netbird-dashboard netbird-server; do
  state="$(remote "docker inspect -f '{{.State.Status}}' $c")"
  if [ "$state" = "up" ] || [ "$state" = "running" ]; then
    pass "容器 $c: Up"
  else
    code="$(remote "docker inspect -f '{{.State.ExitCode}}' $c")"
    fail "容器 $c: 未运行 (status='${state:-unknown}' exitCode='${code:-?}')"
  fi
done

# --- 2. 8443 HTTPS 200 布尔 ------------------------------------------------
# 自签证书: -k 跳过校验；-o /dev/null 只取状态码
http_code="$(remote "curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://127.0.0.1:8443/")"
if [ "$http_code" = "200" ]; then
  pass "8443 HTTPS: HTTP $http_code"
else
  fail "8443 HTTPS: HTTP '${http_code:-无响应}' (期望 200)"
fi

# --- 3. 3478/udp 监听布尔 --------------------------------------------------
# ss -tlnup 同时列 TCP/UDP 监听；只筛 udp 且本地端口 3478
udp_line="$(remote "ss -tlnup 2>/dev/null | grep -E '[[:space:]]3478[[:space:]]' | grep -i udp" | head -1)"
if [ -n "$udp_line" ]; then
  pass "3478/udp 监听: 已监听"
  info "$(printf '%s' "$udp_line" | tr -s ' ')"
else
  fail "3478/udp 监听: 未发现 UDP 3478 监听"
fi

# --- 4. setup key 存在布尔 -------------------------------------------------
# 只读查询 store.db 中的 setup_keys 表。
# 实测：sqlite3 只存在于 EU 宿主（/usr/bin/sqlite3），alpine 与 netbird-server 镜像内均无。
# 因此主路径 = 宿主 sqlite3 以 mode=ro 打开卷内 store.db；全程只读，不写库、不调管理 API。
DB_PATH="$(remote "docker volume inspect netbird-server_netbird_data --format '{{.Mountpoint}}'")"
KEY_COUNT=""
if [ -n "$DB_PATH" ]; then
  # file:...?mode=ro 强制只读打开，即使 SQL 有写意图也会失败而非改数据
  KEY_COUNT="$(remote "sqlite3 -readonly '$DB_PATH/store.db' 'select count(*) from setup_keys' 2>/dev/null")"
fi

if [ -n "$KEY_COUNT" ] && [ "$KEY_COUNT" -ge 0 ] 2>/dev/null; then
  if [ "$KEY_COUNT" -gt 0 ]; then
    pass "setup key 存在: $KEY_COUNT 条记录 (store.db)"
  else
    fail "setup key 存在: store.db 中 setup_keys 为 0 条（尚无可用 setup key）"
  fi
else
  fail "setup key 存在: 无法确认（宿主 sqlite3 读取 store.db 失败；请在复机后用管理员会话调 GET /api/setup-keys 核对）"
fi

# --- 5. 汇总 ---------------------------------------------------------------
echo
echo "== 汇总: $PASS PASS / $FAIL FAIL =="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
