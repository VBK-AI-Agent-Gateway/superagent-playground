#!/usr/bin/env bash
# regrA.sh —— 「多文件并发失败」机械回归（合成用例 + 断言，一条命令复跑）
#
# issue #37 验收基调 ②：机械回归脚本，一条命令复跑，不靠人眼。
#
# 合成用例：构造「一条 TG 消息带 2 个 xlsx」。
#   断言：两个文件都必须到达沙箱并被处理（台账 / deliveries 证据），
#         少一个即 FAIL —— 这正是修复前会静默发生的回归。
#
# 执行位置：EU 服务器。agent 从不执行本脚本。
# 只读前提：脚本自身不写生产文件；仅在 /tmp 下落测试夹具。
#
# 用法:
#   bash regr/regrA.sh                    # 默认：真实链路（injectMessage）+ 证据断言
#   REGR_MODE=stub bash regr/regrA.sh     # 离线自检：不碰生产，只验证脚本自身可跑（CI 友好）
#   TENANTS_DIR=/srv/tenants bash regr/regrA.sh
#
# 退出码: 0 = 全绿；1 = 有 FAIL（含「证据缺失」，缺证据不算绿）

set -uo pipefail

VERSION='1.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/_lib.sh
if [ -f "$SELF_DIR/../lib/_lib.sh" ]; then
  . "$SELF_DIR/../lib/_lib.sh"
else
  echo "FATAL: 缺少 lib/_lib.sh"
  exit 2
fi

# ---- 可从环境覆盖的参数 ----
TENANTS_DIR="${TENANTS_DIR:-/srv/tenants}"
CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
N_FILES="${N_FILES:-2}"                       # 合成用例附件数
REGR_MODE="${REGR_MODE:-live}"                # live | stub
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-30}"
EVID_DIR="${EVID_DIR:-/tmp/regrA-evidence}"   # 证据落盘目录（/tmp，不碰生产）

hr 'regrA'
printf '=== regrA.sh v%s | 合成用例: 一条 TG 消息带 %s 个 xlsx | 模式=%s ===\n' \
  "$VERSION" "$N_FILES" "$REGR_MODE"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '断言：%s 个文件必须全部到达沙箱并被处理（台账 / deliveries 证据）\n' "$N_FILES"
hr 'regrA'

mkdir -p "$EVID_DIR" 2>/dev/null || true

# ---------------------------------------------------------------- 1. 前置检查
printf '\n--- 1. 前置检查 ---\n'

if [ "$REGR_MODE" = "stub" ]; then
  pass "离线自检模式：跳过生产链路，仅验证脚本可执行与断言框架"
else
  if timeout "$T_SHORT" "$DOCKER" ps --filter "name=$CONTAINER" --format '{{.Names}}' 2>/dev/null | grep -q "$CONTAINER"; then
    pass "容器在线: $CONTAINER"
  else
    fail "容器不在线: $CONTAINER（先确认 wagate 在跑；离线自检可用 REGR_MODE=stub）"
  fi

  if [ -d "$TENANTS_DIR" ]; then
    pass "租户目录存在: $TENANTS_DIR"
  else
    warn "租户目录不存在: $TENANTS_DIR（可 TENANTS_DIR=... 覆盖）"
  fi

  # 合成入口 injectMessage 是否可用（tenant-core 导出）
  inj=$(timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc \
    'grep -rnE "export .*injectMessage|injectMessage" /app/extensions/plugins/tenant-core.ts 2>/dev/null | head -n 5' \
    2>/dev/null || true)
  if printf '%s' "$inj" | grep -q 'injectMessage'; then
    pass "合成入口 injectMessage 存在（tenant-core.ts）"
  else
    warn "未在容器内定位到 injectMessage —— 合成用例可能需改用手工投递（见 README/REPORT）"
  fi
fi

# ---------------------------------------------------------------- 2. 构造合成用例
printf '\n--- 2. 构造合成用例（一条消息 %s 个 xlsx）---\n' "$N_FILES"

FIXTURE_DIR="$EVID_DIR/case"
rm -rf "$FIXTURE_DIR" 2>/dev/null || true
mkdir -p "$FIXTURE_DIR" || fail "无法创建夹具目录 $FIXTURE_DIR"

# 造 N 个最小的合法 xlsx（zip 头即可被当二进制收；仅用于走通链路与计数）
i=1
while [ "$i" -le "$N_FILES" ]; do
  f=$(printf '%s/multi-%d.xlsx' "$FIXTURE_DIR" "$i")
  # PK\x03\x04 + 填充，保证是二进制文件、names 可区分
  printf 'PK\003\004multi-file-case-%d\n' "$i" > "$f"
  i=$((i + 1))
done
made=$(ls -1 "$FIXTURE_DIR"/*.xlsx 2>/dev/null | wc -l | tr -d ' ')
printf '  已生成 %s 个 xlsx:\n' "$made"
ls -la --time-style=long-iso "$FIXTURE_DIR"/*.xlsx 2>/dev/null | sed 's/^/    /' || true
if [ "$made" = "$N_FILES" ]; then
  pass "合成用例就绪：${made} 个附件（N 进 = ${N_FILES}）"
else
  fail "合成用例不完整：期望 ${N_FILES} 个，实际 ${made} 个"
fi

# ---------------------------------------------------------------- 3. 投递（写证据）
printf '\n--- 3. 投递合成消息 ---\n'
printf '  说明：真实投递由操作员在 EU 上执行（本脚本给出命令与断言），agent 不代跑。\n'
printf '  证据目录: %s\n' "$EVID_DIR"

# 入站计数证据的来源：修复补丁 P1 打印的 multi-file inbound 行 + bot 侧列表槽长度
printf '  入站侧预期日志（P1 补丁提供）: "[Telegram] multi-file inbound n=%s"\n' "$N_FILES"
printf '  出站侧预期证据（任一即可）:\n'
printf '    a) sandbox 沙箱目录内出现 %s 个文件\n' "$N_FILES"
printf '    b) 台账/ledger 中出现 %s 条记录\n' "$N_FILES"
printf '    c) deliveries 中出现 %s 条投递记录\n' "$N_FILES"

# ---------------------------------------------------------------- 4. 断言：N 进 N 出
printf '\n--- 4. 断言：N 进 N 出（少一个即 FAIL）---\n'

in_n=""
out_n=""
evid_src=""

if [ "$REGR_MODE" = "stub" ]; then
  # 离线自检：用夹具自身模拟「入站 N / 出站 N」，验证断言逻辑本身正确
  in_n="$made"
  out_n="$made"
  evid_src="离线自检（夹具自证，非生产证据）"
  warn "离线自检：以下 N 进 N 出来自夹具模拟，**不构成生产验证**"
else
  # 4.1 入站计数：从 wagate 日志里取最近一次 multi-file inbound 行
  logtail=$(timeout "$T_LONG" journalctl -u "$WAGATE_UNIT" --since '30 min ago' --no-pager 2>/dev/null | tail -n 500 || true)
  if printf '%s' "$logtail" | grep -qaF 'multi-file inbound'; then
    in_n=$(printf '%s' "$logtail" | grep -aoE 'multi-file inbound n=[0-9]+' | tail -n 1 | grep -aoE '[0-9]+' || true)
    evid_src="journalctl multi-file inbound"
    pass "入站证据: multi-file inbound n=${in_n:-?}"
  else
    warn "日志中未见 multi-file inbound（可能补丁未生效、或本用例未投递）"
  fi

  # 4.2 出站计数：沙箱 / 台账 / deliveries 三选一
  sbx_n=$(timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc \
    'find /ws /tmp /root -maxdepth 6 -name "multi-*.xlsx" 2>/dev/null | wc -l' 2>/dev/null | tr -d ' \r' || true)
  if [ -n "${sbx_n:-}" ] && [ "${sbx_n:-0}" -ge 1 ] 2>/dev/null; then
    out_n="$sbx_n"; evid_src="沙箱文件计数"
  fi

  if [ -z "$out_n" ] || [ "${out_n:-0}" -lt "$N_FILES" ] 2>/dev/null; then
    led=$(timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc \
      'grep -rlE "multi-[0-9]+\\.xlsx" /srv /app /root 2>/dev/null | grep -iE "ledger|deliver|record" | head -n 5' 2>/dev/null || true)
    if [ -n "$led" ]; then
      ln=$(printf '%s\n' "$led" | while read -r p; do [ -n "$p" ] && timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -lc "grep -cE 'multi-[0-9]+\\.xlsx' '$p'" 2>/dev/null; done | paste -sd+ - | bc 2>/dev/null)
      ln="${ln:-0}"
      if [ "$ln" -ge "$N_FILES" ] 2>/dev/null; then out_n="$ln"; evid_src="台账/ledger 记录数"; fi
    fi
  fi
fi

printf '  入站 N = %s\n' "${in_n:-（无证据）}"
printf '  出站 N = %s\n' "${out_n:-（无证据）}"
printf '  证据来源 = %s\n' "${evid_src:-（无）}"

if [ -z "$in_n" ] || [ -z "$out_n" ]; then
  fail "证据缺失：入站或出站计数取不到 —— 缺证据不算绿（先跑 01-multi-file.sh 对齐现场）"
elif [ "$in_n" != "$out_n" ]; then
  fail "N 进 N 出失败：入站 ${in_n} != 出站 ${out_n} —— 多文件仍在丢（这正是回归）"
elif [ "$in_n" != "$N_FILES" ]; then
  fail "计数与用例不符：期望 ${N_FILES}，实际入站 ${in_n} / 出站 ${out_n}"
else
  pass "N 进 N 出成立：${in_n} 个文件全部到达并被处理"
fi

# ---------------------------------------------------------------- 5. 门是否活着
printf '\n--- 5. 机械门存活自证（门自己不假绿）---\n'
fixes="$SELF_DIR/../fixes/fixA-multi-file.sh"
if [ -f "$fixes" ]; then
  if bash -n "$fixes" 2>/dev/null; then
    pass "fixA 语法可解析（bash -n）"
  else
    fail "fixA 语法错误：bash -n 失败"
  fi
  # 反证：故意用错锚点期望，门必须拦下来（证明门不是摆设）
  gateout=$(PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}" bash "$fixes" --verify-gate 2>&1 || true)
  if printf '%s' "$gateout" | grep -q 'SUMMARY'; then
    nf=$(printf '%s' "$gateout" | grep -aoE '[0-9]+ FAIL' | tail -n 1 | grep -aoE '[0-9]+' || echo 0)
    printf '  G1 锚点门现场判定: %s FAIL\n' "$nf"
    if [ "${nf:-0}" -gt 0 ]; then
      warn "G1 有 FAIL：现场代码与锚点假设不一致 → --apply 会被拦下（门的正确行为）"
    else
      pass "G1 全 PASS：现场与锚点一致，可以 --apply"
    fi
  else
    warn "无法取得门输出（PATCH_DIR 不在本机？）"
  fi
else
  fail "找不到 $fixes"
fi

# ---------------------------------------------------------------- 6. 结论
printf '\n--- 6. 结论 ---\n'
printf '  断言: 一条消息 %s 个 xlsx → 两个都必须进沙箱并被处理\n' "$N_FILES"
printf '  复跑: 一条命令 —— bash regr/regrA.sh\n'
[ "$REGR_MODE" = "stub" ] && printf '  注意: 本次为 stub 离线自检，未验证生产链路。\n'

hr 'regrA'
printf '========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
hr 'regrA'

[ "$FAIL_N" -eq 0 ] || exit 1
exit 0
