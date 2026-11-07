#!/usr/bin/env bash
# regrG.sh —— 「文件清单自动滚动（fixG）」机械回归：一条命令复跑，不靠人眼
#
# issue #64 验收基调：机械门 A–D，一条命令复跑，退出码即结论。
#   A. 依次上传 2 个文件 -> 清单自动含 2 条
#   B. 重复上传同名文件 -> 清单不重复（幂等）
#   C. 已归档文件（archive-*/ 下）-> 清单不再列出
#   D. 写清单失败 -> 主链不受影响（fail-open）
#   E. 上限保护：保留最近 WAGATE_MANIFEST_MAX 条，裁最旧
#   F. bot.ts file-only hold 保存点同样入清单
#
# 执行位置：EU 服务器。agent 从不执行本脚本（无生产凭据）。
# 本脚本不写任何生产文件：默认在 /tmp 沙盒里放一份「目标文件副本」，改动副本。
#
# 用法:
#   bash regr/regrG.sh                       # 默认：在生产副本上 apply -> 断言 -> 还原副本
#   REGR_MODE=stub bash regr/regrG.sh        # 纯离线自检：只用 /tmp 合成夹具，不读生产
#   PATCH_DIR=/srv/wagate/patches bash regr/regrG.sh
#
# 退出码: 0 = 全绿；1 = 有 FAIL（含证据缺失，缺证据不算绿）；2 = 环境缺失

set -uo pipefail

VERSION='1.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
FIXER="$SELF_DIR/../fixes/fixG-manifest.sh"

PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
REGR_MODE="${REGR_MODE:-live}"
SANDBOX="${SANDBOX:-/tmp/regrG-sandbox}"

PASS_N=0
FAIL_N=0
WARN_N=0
pass() { PASS_N=$((PASS_N + 1)); printf '[PASS] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '[WARN] %s\n' "$*"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '[FAIL] %s\n' "$*"; }
hr() { printf '\n===== %s =====\n' "$*"; }
summary() {
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  [ "$FAIL_N" -eq 0 ] && return 0 || return 1
}

printf '=== regrG.sh v%s —— 文件清单自动滚动 机械回归（issue #64）===\n' "$VERSION"
printf '模式=%s | PATCH_DIR=%s | 沙盒=%s\n' "$REGR_MODE" "$PATCH_DIR" "$SANDBOX"
printf '断言: A 上传2文件->2条 / B 重传同名->不重复 / C 归档->不列出 / D 写失败->主链不受影响\n'
printf '      E 上限保护(裁最旧) / F hold 保存点入清单\n'
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

[ -f "$FIXER" ] || { printf 'FATAL: 找不到 %s\n' "$FIXER"; exit 2; }

rm -rf "$SANDBOX"; mkdir -p "$SANDBOX" || { printf 'FATAL: 无法创建沙盒\n'; exit 2; }

# ---------------------------------------------------------------------------
# 0) 目标文件：live 模式用生产副本（**只读拷贝**，改动只落在沙盒里）
# ---------------------------------------------------------------------------
hr '0 准备沙盒副本'
if [ "$REGR_MODE" = 'live' ]; then
  for rel in upload-ops.ts bot.ts; do
    if [ -f "$PATCH_DIR/$rel" ]; then
      cp -a "$PATCH_DIR/$rel" "$SANDBOX/$rel" && pass "已拷入沙盒（只读源）：$rel"
    else
      fail "目标文件缺失：$PATCH_DIR/$rel（用 PATCH_DIR= 覆盖或改用 REGR_MODE=stub）"
    fi
  done
else
  # stub：造两个「最小可用」目标文件，锚点文本与生产一致，用于验证断言框架本身
  cat > "$SANDBOX/upload-ops.ts" <<'TS'
export async function saveUpload(name: string, data: string): Promise<void> {
	try {
		await writeFile(target, Buffer.from(data, "base64"));
		console.log(`[upload-ops] saved ${target}`);
	} catch (e) {
		console.error(`[upload-ops] save failed: ${e}`);
	}
}
TS
  cat > "$SANDBOX/bot.ts" <<'TS'
const onMessage = async (m: any, adapter: any) => {
	if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {
		console.log(`[bot] file-only hold: ${file.fileName} saved pending, waiting for user instruction (FILE_AUTO_ROUTE=${process.env.FILE_AUTO_ROUTE || "on"})`);
		try {
			await adapter.sendMessage(m.channelId, `已收到文件 ${file.fileName}。`);
		} catch { /* 回复失败仍 hold */ }
		return;
	}
};
TS
  pass 'stub 模式：已生成锚点一致的最小目标文件（离线自检断言框架，不碰生产）'
fi

# ---------------------------------------------------------------------------
# 1) 补丁脚本自身：dry-run 必须**不写盘**，且锚点门行为正确
# ---------------------------------------------------------------------------
hr '1 补丁脚本 dry-run 安全性'
before_up=$(sha256sum "$SANDBOX/upload-ops.ts" 2>/dev/null | awk '{print $1}')
before_bot=$(sha256sum "$SANDBOX/bot.ts" 2>/dev/null | awk '{print $1}')
out=$(PATCH_DIR="$SANDBOX" bash "$FIXER" 2>&1); rc=$?
after_up=$(sha256sum "$SANDBOX/upload-ops.ts" 2>/dev/null | awk '{print $1}')
after_bot=$(sha256sum "$SANDBOX/bot.ts" 2>/dev/null | awk '{print $1}')
printf '%s\n' "$out" | tail -n 12 | sed 's/^/    /'
if [ "$before_up" = "$after_up" ] && [ "$before_bot" = "$after_bot" ]; then
  pass 'dry-run 未改动任何目标文件（sha256 不变）'
else
  fail 'dry-run 改动了目标文件（严重违规：默认必须零写入）'
fi
if [ "$rc" -eq 0 ]; then
  pass 'dry-run 退出码 0（锚点门 + A–F 机械门均通过）'
else
  fail "dry-run 退出码 $rc（锚点漂移或机械门 FAIL）"
fi
if printf '%s' "$out" | grep -q 'SUMMARY:'; then
  pass 'dry-run 打印 SUMMARY 汇总（可机械判读）'
else
  fail 'dry-run 未打印 SUMMARY'
fi
# 负例：锚点被破坏时必须**中止**（fail-closed），而不是勉强 patch
# 基线快照必须取在「破坏之后」：要证明的是「中止时补丁脚本没再动过文件」，
# 而不是「文件等于破坏前的原始内容」（后者恒假，会把正确的中止误判为写盘）。
sed -i 's/\[upload-ops\] saved/[upload-ops] SAVED-RENAMED/' "$SANDBOX/upload-ops.ts"
cp -a "$SANDBOX/upload-ops.ts" "$SANDBOX/upload-ops.ts.keep"
out2=$(PATCH_DIR="$SANDBOX" bash "$FIXER" 2>&1); rc2=$?
if [ "$rc2" -ne 0 ] && printf '%s' "$out2" | grep -q '锚点'; then
  pass "负例：锚点漂移时中止并报告（exit $rc2）—— 不强行 patch"
else
  fail "负例：锚点漂移时未中止（exit $rc2）"
fi
if [ "$(sha256sum "$SANDBOX/upload-ops.ts" | awk '{print $1}')" = "$(sha256sum "$SANDBOX/upload-ops.ts.keep" | awk '{print $1}')" ]; then
  pass '负例：中止时未写盘（文件与破坏后基线 sha256 一致）'
else
  fail '负例：中止时仍改动了文件'
fi
# 还原成**未破坏**的 stub（不能用 .keep：那已是破坏后的快照，会污染 §3 的锚点）
sed -i 's/\[upload-ops\] SAVED-RENAMED/[upload-ops] saved/' "$SANDBOX/upload-ops.ts"
rm -f "$SANDBOX/upload-ops.ts.keep"
if grep -qF '[upload-ops] saved' "$SANDBOX/upload-ops.ts"; then
  pass '负例：已还原未破坏 stub（§3 锚点基线干净）'
else
  fail '负例：stub 未还原，§3 起点被污染'
fi

# ---------------------------------------------------------------------------
# 2) 机械门 A–F：直接复用补丁脚本的 --verify-gate（同一份实现，不另写一套）
# ---------------------------------------------------------------------------
hr '2 机械门 A–F（合成夹具，/tmp，不碰生产）'
gate_out=$(PATCH_DIR="$SANDBOX" bash "$FIXER" --verify-gate 2>&1); gate_rc=$?
printf '%s\n' "$gate_out" | sed 's/^/    /'
if [ "$gate_rc" -eq 0 ]; then
  pass 'A–F 机械门全绿（exit 0）'
else
  fail "A–F 机械门存在 FAIL（exit $gate_rc）"
fi
for k in A B C D E F; do
  if printf '%s' "$gate_out" | grep -q "^\[PASS\] $k"; then
    pass "断言 $k 有 PASS 证据"
  else
    fail "断言 $k 缺 PASS 证据（缺证据不算绿）"
  fi
done
# 负例：上限门必须真的会 FAIL（证明断言不是恒真）
cp -a "$FIXER" "$SANDBOX/fixer-neg.sh"
sed -i "s/WAGATE_MANIFEST_MAX || \"30\"/WAGATE_MANIFEST_MAX || \"999999\"/" "$SANDBOX/fixer-neg.sh"
neg_out=$(PATCH_DIR="$SANDBOX" bash "$SANDBOX/fixer-neg.sh" --verify-gate 2>&1); neg_rc=$?
if [ "$neg_rc" -ne 0 ] && printf '%s' "$neg_out" | grep -q '^\[FAIL\] E'; then
  pass '负例：上限被改成 999999 后断言 E 立即 FAIL（断言非恒真）'
else
  fail "负例：断言 E 未在应失败时失败（exit $neg_rc）"
fi

# ---------------------------------------------------------------------------
# 3) apply -> 幂等 -> 回滚（在沙盒副本上，不碰生产）
# ---------------------------------------------------------------------------
hr '3 apply / 幂等 / 回滚（沙盒副本）'
out3=$(PATCH_DIR="$SANDBOX" bash "$FIXER" --apply 2>&1); rc3=$?
printf '%s\n' "$out3" | tail -n 8 | sed 's/^/    /'
if [ "$rc3" -eq 0 ]; then
  pass '--apply 退出码 0（备份 + 写盘 + 解析门）'
else
  fail "--apply 退出码 $rc3"
fi
bak_n=$(ls -1 "$SANDBOX"/*.bak-* 2>/dev/null | wc -l | tr -d ' ')
if [ "$bak_n" -ge 2 ]; then
  pass "--apply 前已生成备份（$bak_n 个 .bak-*）"
else
  fail "--apply 未生成备份（$bak_n 个）"
fi
if grep -qF '__fixGRoll__' "$SANDBOX/upload-ops.ts" && grep -qF '__fixGRoll__' "$SANDBOX/bot.ts"; then
  pass '两个目标文件都含特征串 __fixGRoll__'
else
  fail '目标文件缺少特征串 __fixGRoll__'
fi
if grep -qF 'MANIFEST_REL_PLACEHOLDER' "$SANDBOX/upload-ops.ts" || grep -qF 'ARCHIVE_RE_PLACEHOLDER' "$SANDBOX/bot.ts"; then
  fail '产物仍含未渲染的占位符（渲染漏了）'
else
  pass '产物无未渲染占位符'
fi
out4=$(PATCH_DIR="$SANDBOX" bash "$FIXER" --apply 2>&1); rc4=$?
if [ "$rc4" -eq 0 ] && printf '%s' "$out4" | grep -q '已打过补丁'; then
  pass '重复 --apply 幂等跳过（未重复改写）'
else
  fail "重复 --apply 未幂等跳过（exit $rc4）"
fi
stamp=$(ls -1 "$SANDBOX"/upload-ops.ts.bak-* 2>/dev/null | tail -n1 | sed 's/.*\.bak-//')
out5=$(PATCH_DIR="$SANDBOX" bash "$FIXER" --rollback --from "$stamp" 2>&1); rc5=$?
if [ "$rc5" -eq 0 ] && ! grep -qF '__fixGRoll__' "$SANDBOX/upload-ops.ts"; then
  pass "--rollback --from $stamp 还原成功（工作副本回到基线）"
else
  fail "--rollback 未还原（exit $rc5）"
fi

summary
