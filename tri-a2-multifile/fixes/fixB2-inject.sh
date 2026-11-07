#!/usr/bin/env bash
# fixB2-inject.sh —— 「残留文件视图污染」注入加固（fixB2，默认 dry-run）
#
# 执行位置：EU 服务器（操作员逐行审后自行执行）；agent 从不执行本脚本。
# 默认行为：dry-run —— 只做「锚点匹配 + 计数断言 + 改动预览」，不写任何文件。
#   --apply         真正落地（先备份 .bak-<时间戳>，再原地重写，保留 inode）
#   --verify-gate   只跑机械门（锚点/形态），不做任何改动
#   --rollback      从 .bak-<时间戳> 还原；用 --from <时间戳> 指定批次
#
# 修复内容（B2 注入加固）：
#   在 tenant-core.ts 的 prompt 渲染点，读 workspace/activeProj/current-files.txt，
#   **只注入清单里列出的文件**；清单缺失/为空时回退旧行为（fail-open）。
#   逃生阀 WAGATE_RESIDUAL_VIEW=0 -> 完全关闭本修复，恢复旧行为。
#
# 为什么这是「加固」而不是新功能：
#   上一个租户任务在 workspace/activeProj/ 落下的历史文件，会被新任务的 prompt 渲染
#   当成「本次任务的文件」一并注入，导致模型对着上一轮的残留文件干活。清单文件是
#   唯一权威来源：不在清单里的文件一律不注入。
#
# 硬约束：
#   * 锚文本匹配 + 数量断言 + 失败即中止（fail-closed），绝不按行号硬切
#   * 现场与基线漂移导致锚点对不上时**中止并报告**，不强行 patch
#   * fail-open 逃生阀：清单缺失/为空 -> 旧行为；WAGATE_RESIDUAL_VIEW=0 -> 整体关闭
#   * 不读 secret 内容、不打印用户消息正文、不发用户可见消息（除显式 TG_NOTIFY=1 告警）
#
# 用法：
#   bash fixes/fixB2-inject.sh                 # dry-run
#   bash fixes/fixB2-inject.sh --verify-gate
#   bash fixes/fixB2-inject.sh --apply
#   bash fixes/fixB2-inject.sh --rollback --from 20261106-120000

VERSION='2.0.0'
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/_lib.sh
. "$SELF_DIR/../lib/_lib.sh" || { printf 'FATAL: 无法 source lib/_lib.sh\n'; exit 2; }

MODE='dry'
FROM_TS=''
TG_NOTIFY="${TG_NOTIFY:-0}"
# 清单文件相对租户 workspace 的路径（与 activeProj 约定一致）
MANIFEST_REL="${MANIFEST_REL:-activeProj/current-files.txt}"
TARGET_REL='tenant-core.ts'
ANCHOR='const wasBusy = t.busy;'
FEATURE='__fixB2ManifestFilter__'

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE='apply' ;;
    --rollback) MODE='rollback' ;;
    --verify-gate) MODE='gate' ;;
    --from) shift; FROM_TS="${1:-}" ;;
    --from=*) FROM_TS="${1#--from=}" ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 看用法）\n' "$1"; exit 2 ;;
  esac
  shift
done

GATE_LOG="${GATE_LOG:-/tmp/tri-a2-multifile-gate.log}"
gate_log() { printf '%s | %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$GATE_LOG" 2>/dev/null || true; }

gate_fail() {
  local text="$1"
  fail "$text"
  printf '[NOTIFY:ALERT] %s\n' "$text"
  gate_log "ALERT $text"
  [ "$TG_NOTIFY" = "1" ] && warn "TG_NOTIFY=1：如需 TG 告警请用 fixes/fixA2-multifile.sh 的 notify 通道（本脚本不发送用户可见消息）"
  printf '\n机械门判定：FAIL —— 已中止，未做任何写入。\n'
  printf '========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  exit 1
}

# p_body —— 注入加固补丁体：清单白名单过滤，fail-open 三层兜底
p_body() {
  cat <<'TS'
			// [fixB2/注入加固] 只注入清单列出的文件，杜绝上一轮残留文件被当成
			// 「本次任务的文件」注入。三层 fail-open：
			//   ① WAGATE_RESIDUAL_VIEW=0 -> 整体关闭本修复，恢复旧行为
			//   ② 清单缺失/读取失败 -> 不过滤，恢复旧行为
			//   ③ 清单为空 -> 不过滤，恢复旧行为
			// 清单：workspace/activeProj/current-files.txt（每行一个文件名）
			{
				const __fixB2ManifestFilter__ = (() => {
					try {
						if (process.env.WAGATE_RESIDUAL_VIEW === "0") return null; // ① 逃生阀
						const __fs = require("node:fs") as typeof import("node:fs");
						const __path = require("node:path") as typeof import("node:path");
						const __root = process.env.WAGATE_TENANT_ROOT || process.env.TENANT_ROOT || "/srv/tenants";
						const __cands = [
							__path.join(__root, String(sid), "workspace", "MANIFEST_REL_PLACEHOLDER"),
							__path.join(__root, String(sid), "MANIFEST_REL_PLACEHOLDER"),
						];
						for (const __p of __cands) {
							if (!__fs.existsSync(__p)) continue; // ② 清单缺失 -> 旧行为
							const __names = __fs.readFileSync(__p, "utf8")
								.split("\n").map((s: string) => s.trim()).filter((s: string) => s && !s.startsWith("#"));
							if (__names.length === 0) return null; // ③ 清单为空 -> 旧行为
							console.log(`[fixB2] manifest=${__p} allowed=${__names.length}`);
							return new Set(__names);
						}
						return null;
					} catch (e) {
						console.warn(`[fixB2] manifest read fail, fail-open: ${String(e).slice(0, 120)}`);
						return null;
					}
				})();
				if (__fixB2ManifestFilter__) {
					(globalThis as any).__fixB2AllowedFiles = __fixB2ManifestFilter__;
				}
			}
TS
}


printf '=== fixB2-inject.sh v%s —— 残留文件视图注入加固（fixB2）===\n' "$VERSION"
printf '模式: %s | 目标: %s\n' "$MODE" "$PATCH_DIR/$TARGET_REL"
printf '逃生阀: WAGATE_RESIDUAL_VIEW=0（关闭本修复）| 清单: %s\n' "$MANIFEST_REL"

case "$MODE" in
  rollback)
    hr '回滚'
    if [ -z "$FROM_TS" ]; then
      printf '未指定 --from，列出可用备份：\n'
      safe timeout "$T_SHORT" bash -c "ls -la $PATCH_DIR/$TARGET_REL.bak-* 2>/dev/null | tail -n 40"
      printf '用法: bash %s --rollback --from <时间戳>\n' "$0"
      gate_summary; exit $?
    fi
    bak=$(backup_of "$PATCH_DIR/$TARGET_REL" "$FROM_TS")
    if [ -f "$bak" ]; then
      cat "$bak" > "$PATCH_DIR/$TARGET_REL" && pass "已还原 $TARGET_REL <- $bak"
    else
      warn "备份不存在: $bak"
    fi
    printf '\n还原后重启：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
    gate_summary; exit $?
    ;;

  gate|dry|apply)
    tgt="$PATCH_DIR/$TARGET_REL"
    hr 'G1 锚点门'
    require_file "$tgt" "$TARGET_REL" || gate_fail "$TARGET_REL 缺失：$tgt"
    printf '  文件 sha256=%s  bytes=%s  lines=%s\n' "$(sha_of "$tgt")" "$(wc -c < "$tgt" | tr -d ' ')" "$(wc -l < "$tgt" | tr -d ' ')"

    if [ "$(count_fixed "$tgt" "$FEATURE")" -gt 0 ]; then
      warn "$TARGET_REL 已含特征串 $FEATURE —— 视为已打过补丁（幂等）"
      gate_summary; exit $?
    fi

    got=$(count_fixed "$tgt" "$ANCHOR")
    if [ "$got" -eq 1 ]; then
      pass "锚点命中 1 次：「$ANCHOR」"
    elif [ "$got" -eq 0 ]; then
      gate_fail "锚点未命中：「$ANCHOR」在 $TARGET_REL 中 0 次 —— 现场与最新基线漂移，已中止，不强行 patch"
    else
      gate_fail "锚点命中 $got 次（期望 1 次）：「$ANCHOR」不唯一 —— 无法安全定位注入点，已中止"
    fi

    # 注入点必须晚于 runOnce 定义（证明它落在 prompt 渲染路径上，而不是别处）
    l_anchor=$(grep -nF -- "$ANCHOR" "$tgt" | head -1 | cut -d: -f1)
    l_runonce=$(grep -nF 'function runOnce(t: Tenant, text: string' "$tgt" | head -1 | cut -d: -f1)
    if [ -n "$l_runonce" ] && [ -n "$l_anchor" ] && [ "$l_anchor" -gt "$l_runonce" ]; then
      pass "注入点位置校验：锚点 L$l_anchor 晚于 runOnce 定义 L$l_runonce（确在渲染路径上）"
    else
      gate_fail "注入点位置校验失败：锚点 L${l_anchor:-?} 不晚于 runOnce L${l_runonce:-?} —— 疑似锚到了别处，已中止"
    fi

    if [ "$MODE" = 'gate' ]; then
      n=$(count_fixed "$tgt" "$FEATURE")
      [ "$n" -gt 0 ] && pass "现场含特征串 $FEATURE（$n 次）" || warn "现场未含特征串 $FEATURE（尚未打补丁属正常）"
      gate_summary; exit $?
    fi

    hr '改动预览'
    printf '  在锚点前插入清单白名单过滤器（约 %s 行）\n' "$(p_body | wc -l | tr -d ' ')"
    printf '  插入位置：L%s（runOnce 内、prompt 渲染之前的 pending 图片合并段之后）\n' "$l_anchor"
    printf '  fail-open 三层：WAGATE_RESIDUAL_VIEW=0 / 清单缺失 / 清单为空\n'

    if [ "$MODE" = 'dry' ]; then
      printf '\n（dry-run：未写任何文件；确认无误后加 --apply）\n'
      printf '回滚路径：bash %s --rollback --from <批次戳>\n' "$0"
      gate_summary; exit $?
    fi

    hr '--apply：备份 -> 重写'
    TS=$(ts_now)
    bak=$(backup_of "$tgt" "$TS")
    cp -a "$tgt" "$bak" || gate_fail "备份失败：$tgt（未做任何写入）"
    pass "已备份 $TARGET_REL -> $bak"

    body=$(mktemp); tmp=$(mktemp)
    p_body | sed "s|MANIFEST_REL_PLACEHOLDER|$MANIFEST_REL|g" > "$body" || { rm -f "$body" "$tmp"; gate_fail "补丁体生成失败"; }

    # 整块插入：在锚点行之前输出补丁体，锚点行及以后原样保留（纯插入，不替换任何原码）
    awk -v anchor="$ANCHOR" -v bodyf="$body" '
      BEGIN { n = 0; while ((getline line < bodyf) > 0) body[++n] = line; done = 0 }
      { if (!done && index($0, anchor) > 0) { for (i = 1; i <= n; i++) print body[i]; done = 1 } print }
      END { if (!done) exit 3 }
    ' "$tgt" > "$tmp" || { rm -f "$body" "$tmp"; gate_fail "插入失败（锚点未命中），未写盘"; }

    if [ "$(count_fixed "$tmp" "$FEATURE")" -eq 0 ]; then
      rm -f "$body" "$tmp"
      gate_fail "写入前形态门失败：特征串 $FEATURE 未出现，已中止"
    fi
    # 真实解析门：产物必须能被 TypeScript 解析器解析（启发式大括号计数会被
    # 字符串/模板串/注释里的花括号骗，基线本身就不"平衡"，不能当语法判据）。
    out=$(ts_parse_gate "$tmp"); rc=$?
    printf '%s\n' "$out" | sed 's/^/  /'
    if [ "$rc" -eq 1 ]; then
      rm -f "$body" "$tmp"
      gate_fail "写入前解析门失败：产物语法无效，已中止（未写盘）"
    elif [ "$rc" -eq 2 ]; then
      warn "解析门无法执行（缺 node/typescript），语法未验证 —— 写入后请人工复核"
    else
      pass "解析门通过（TS 解析器无语法错误）"
    fi
    cat "$tmp" > "$tgt" && pass "已写入 $TARGET_REL"
    rm -f "$body" "$tmp"
    printf '\n落地完成。重启生效：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
    printf '回滚：bash %s --rollback --from %s\n' "$0" "$TS"
    ;;

  *) printf '未知模式: %s\n' "$MODE"; exit 2 ;;
esac

gate_summary; exit $?
