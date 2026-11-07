#!/usr/bin/env bash
# fixF-hold.sh — file-only 挂起死锁修复：活跃任务联动 + 挂起释放路径（issue #63 / 修复F）
#
# 根因（操作员实锤，bot.ts L325-331）：
#   file && !text && FILE_AUTO_ROUTE!="0"  ->  保存 __excelPendingFile + 回「请说明要求」+ return
#   文件被扣在黑板里，永不进 core.handle -> 模型看不到文件 -> 反复要用户重传 -> 重传又 hold。
#   且释放路径失联：下一轮带文字的消息虽写入新槽位，但 pending 文件没有被合并进该轮上下文
#   （03:58:33 用户发「发了」，模型答「读不到任何附件」）。
#
# 本脚本做四件事（全部锚定改写，锚点不匹配即整体中止，不猜、不发散）：
#   F1 活跃任务联动：file-only 且同租户有活跃任务 -> 不 hold，注入「用户为当前任务补充上传的文件：<名>」
#      后直接走 core.handle，文件并入当前任务（fail-open：判不出来就保持旧行为）。
#   F2 挂起释放路径：真的 hold 了，则把文件存进持久 pending 槽（__fixFPendingFiles，跨 onMessage 存活）；
#      用户下一轮带文字的消息把它取出、并入该轮 msg.file -> 文件当轮可见。
#   F3 hold 文案扩写：明确承诺「回复任意说明即开始处理」，且该承诺由 F2 兑现。
#   F4 fail-open：WAGATE_HOLD_RELEASE=0 一键回旧版（F1 不联动、F2 不释放，仅保留 F3 文案之外的全部旧行为）。
#
# 机械门：A（file-only+活跃任务 -> 不 hold 且含注入句）/ B（file-only 无任务 -> hold -> 下一轮带文字 -> 文件进上下文）
#        / C（FILE_AUTO_ROUTE=0 旧行为不回归）。A/B/C 合成用例见 regr/regrF.sh。
#
# 默认 dry-run：只判定门 + 预览，绝不改动。确认后加 --apply 才真正改写。
#
# 用法：
#   bash fixF-hold.sh                        # dry-run（默认，安全）
#   bash fixF-hold.sh --apply                # 真正改写（先备份 .bak-<UTC戳>，原地保留 inode）
#   bash fixF-hold.sh --verify-gate          # 只判定锚点门，不写任何文件
#   bash fixF-hold.sh --rollback --from <戳> # 按备份戳还原
#   TARGET=/app/bot.ts bash fixF-hold.sh --apply
#
# 环境变量：
#   TARGET=/app/bot.ts       容器内 bot.ts 的宿主路径（unit 单文件挂载；默认见下）
#   WAGATE_HOLD_RELEASE=0     fail-open 开关：0=关闭本修复（F1 不联动 / F2 不释放），恢复旧行为
#   WAGATE_UNIT=wagate.service  重启提示里的 unit 名
#
# 硬约束：容器路径铁律 bot.ts=/app/bot.ts；新文件严禁挂进 /app/extensions/plugins/（坑#35，扩展扫描污染加载链）。
#         仓库零 secret；脚本自身不写任何凭据。本脚本只产出改动，从不重启服务、从不执行补丁。
#
# 退出码：0 成功 / 门全过；1 机械门 FAIL（含锚点不匹配，fail-closed）；2 用法或前置条件错误。

set -uo pipefail

VERSION='1.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ---- 参数 -----------------------------------------------------------------
MODE="dryrun"
FROM_TS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply|-a)     MODE="apply" ;;
    --dry-run|-n)   MODE="dryrun" ;;
    --verify-gate)  MODE="gate" ;;
    --rollback)     MODE="rollback" ;;
    --from)         shift; FROM_TS="${1:-}" ;;
    -h|--help)      sed -n '2,45p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 查看用法）\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---- 配置 -----------------------------------------------------------------
TARGET="${TARGET:-/app/bot.ts}"
WAGATE_HOLD_RELEASE="${WAGATE_HOLD_RELEASE:-1}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
PATCH_DIR="${PATCH_DIR:-$(dirname "$TARGET")}"
T_SHORT="${T_SHORT:-15}"

PASS_N=0; FAIL_N=0; WARN_N=0
pass() { PASS_N=$((PASS_N+1)); printf '  [PASS] %s\n' "$1"; }
fail() { FAIL_N=$((FAIL_N+1)); printf '  [FAIL] %s\n' "$1"; }
warn() { WARN_N=$((WARN_N+1)); printf '  [WARN] %s\n' "$1"; }

# safe <cmd...> —— 任何一条外部命令超时/失败都不带塌整个脚本（只读诊断用）
safe() { timeout "$T_SHORT" "$@" 2>&1 || true; }

printf '=== fixF-hold.sh v%s | 模式=%s | 目标=%s ===\n' "$VERSION" "$MODE" "$TARGET"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '机械门 G1 锚点 / G2 形态 / G2'"'"' 替换唯一性；任一 FAIL 即中止（不部分落地）\n'

# ==========================================================================
# 补丁表：file|锚文本|锚期望次数|已打补丁特征串|补丁体函数|证据锚点(原体结束后第一行)
# 现场形态以 issue #63 指定的 bot.ts（sha256=174cc876… 的后继版本，操作员会贴最新锚点段）为准；
# 锚不匹配就整体中止报告，绝不猜测性匹配、绝不做部分替换。
# ==========================================================================
PATCH_SPECS=(
  'bot.ts|if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {|1|__fixFHold__|p1_body|	let outs;|'
)

add_src() {
  # F0：给 core.handle 的类型签名补 file 字段。签名里已有 file 时自动跳过（幂等）。
  cat <<'TS'
	/** __fixFHold__ 挂起文件释放：把上一轮被 hold 的文件并回本轮（见 handle 的 file 形参）。 */
TS
}

p1_body() {
  cat <<'TS'
	// __fixFHold__ ===== file-only 挂起：活跃任务联动 + 挂起释放路径 =====
	// 根因（issue #63）：旧代码 file-only 一律 hold+return，文件进了黑板却永不进 core.handle；
	// 且下一轮带文字的消息没有把 pending 文件合并进上下文 -> 模型永远看不见 -> 机械死锁。
	// F4 fail-open：WAGATE_HOLD_RELEASE=0 一键回旧版（F1 不联动、F2 不释放）。
	const __fixFEnabled__ = process.env.WAGATE_HOLD_RELEASE !== "0";
	// F2 释放路径：跨 onMessage 存活的持久槽（globalThis 上的模块级 Map，纯内存，不落盘、无凭据）。
	// 用「租户键」而不是原 __excelPendingFile 的隐式单槽，避免跨用户串文件。
	const __fixFKey__ = `${adapter.platform}:${m.userId}`;
	const __fixFStore__ = ((globalThis as Record<string, unknown>).__fixFPendingFiles ??= new Map<string, unknown>()) as Map<string, unknown>;
	if (__fixFEnabled__ && text && !file) {
		// 用户补发了文字：把上一轮 hold 的文件并回本轮，文件当轮可见。
		const __fp__ = __fixFStore__.get(__fixFKey__);
		if (__fp__) {
			file = __fp__ as typeof file;
			__fixFStore__.delete(__fixFKey__);
			console.log(`[bot][fixF] hold release: pending file merged into this turn name=${file?.fileName}`);
		}
	}
	// F1 活跃任务联动：文件-only 且同租户有活跃任务 -> 不 hold，直接并入当前任务。
	// fail-open：判不出来（无钩子/无任务记录）就保持旧行为 hold，绝不因本修复把消息弄丢。
	let __fixFActiveTask__ = false;
	if (__fixFEnabled__ && file && !text && process.env.FILE_AUTO_ROUTE !== "0") {
		try {
			const __fk__ = (globalThis as Record<string, unknown>).__fixFActiveTask as ((s: { platform: string; userId: string; channelId: string }) => boolean) | undefined;
			if (typeof __fk__ === "function") __fixFActiveTask__ = !!__fk__({ platform: adapter.platform, userId: m.userId, channelId: m.channelId });
		} catch (e) {
			console.warn(`[bot][fixF] active-task probe failed (fail-open -> hold): ${String(e).slice(0, 120)}`);
			__fixFActiveTask__ = false;
		}
	}
	if (file && !text && process.env.FILE_AUTO_ROUTE !== "0" && !__fixFActiveTask__) {
		if (__fixFEnabled__) __fixFStore__.set(__fixFKey__, file);
		console.log(`[bot][fixF] file-only hold: ${file.fileName} saved pending (release=${__fixFEnabled__ ? "on" : "off(WAGATE_HOLD_RELEASE=0)"}), waiting for user instruction (FILE_AUTO_ROUTE=${process.env.FILE_AUTO_ROUTE || "on"})`);
		try {
			await adapter.sendMessage(m.channelId, `已收到文件 ${file.fileName}。文件已保存，回复任意说明（如"用它做PPT"）即开始处理。`);
		} catch { /* 回复失败仍 hold */ }
		return;
	}
	if (file && !text && __fixFActiveTask__) {
		// F1 命中：活跃任务在等文件，直接 handle，不扣文件。
		console.log(`[bot][fixF] active task linked: ${file.fileName} injected into current task (hold skipped)`);
		text = `用户为当前任务补充上传的文件：${file.fileName}`;
	}
TS
}

BACKUP_STAMP=$(date -u '+%Y%m%d-%H%M%S')

# ---- 门 -------------------------------------------------------------------
check_anchor() {
  local f="$1" anchor="$2" exp="$3" n
  [ -f "$f" ] || { fail "锚点检查: 文件不存在 $f"; return 1; }
  n=$(grep -cF "$anchor" "$f" 2>/dev/null || true); n="${n:-0}"
  if [ "$n" = "$exp" ]; then
    pass "G1 锚点 $f: '$anchor' x$n（== 期望 $exp）"; return 0
  fi
  fail "G1 锚点 $f: '$anchor' x$n（期望 $exp）—— 现场代码已变，本补丁废止（请贴最新锚点段再评估）"
  return 1
}

check_shape() {
  local f="$1" needle="$2"
  if grep -qF "$needle" "$f" 2>/dev/null; then
    pass "G2 形态 $f: 含 '$needle'"; return 0
  fi
  fail "G2 形态 $f: 缺 '$needle'（改动没生效，或落了半截）"; return 1
}

already_patched() { grep -qF "$2" "$1" 2>/dev/null; }
spec_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }
gate_fail() { fail "$1"; printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"; exit 1; }

# --------------------------------------------------------------------------
case "$MODE" in
  dry|gate)
    [ "$MODE" = "dry" ] && printf '\ndry-run：只判定门与预览改动，不写任何文件。\n'
    [ "$MODE" = "gate" ] && printf '\n--verify-gate：只判定门，不写任何文件。\n'
    # F0/F1 可落地的前置条件：core.handle 是否已接收 file 字段（决定要不要补签名）
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      tgt="$PATCH_DIR/$rel"
      printf '\n--- %s ---\n' "$rel"
      if [ ! -f "$tgt" ]; then
        fail "文件不存在: $tgt（容器内 bot.ts 的宿主路径请用 TARGET= 指定）"; continue
      fi
      if already_patched "$tgt" "$needl"; then
        warn "已含 $needl（已打过补丁，幂等跳过）"; continue
      fi
      check_anchor "$tgt" "$anchor" "$exp" || true
      printf '  计划：改写锚点所在分支为「联动 + 释放 + 扩写文案」，并引入特征串 %s\n' "$needl"
    done
    printf '\n判读：G1 全 PASS 才能 --apply；任一 FAIL 说明现场代码已变，先贴最新锚点段再评估。\n'
    printf 'A/B/C 机械断言在 --apply 后由 regr/regrF.sh 复跑。\n'
    [ "$MODE" = "gate" ] && [ "$FAIL_N" -gt 0 ] && gate_fail "fixF --verify-gate FAIL n=$FAIL_N（锚点不匹配）"
    ;;

  apply)
    printf '\n--apply：门全过后落地（先备份，原地重写保留 inode）。备份戳 %s\n' "$BACKUP_STAMP"
    # ---- 阶段一：全部门先过，一个不过就整批中止（不做部分落地）----
    declare -a READY_RELS=()
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      tgt="$PATCH_DIR/$rel"
      [ -f "$tgt" ] || gate_fail "apply 中止：$rel 不存在（$tgt）"
      if already_patched "$tgt" "$needl"; then warn "$rel 已打补丁，跳过"; continue; fi
      check_anchor "$tgt" "$anchor" "$exp" || gate_fail "apply 中止：$rel 锚点门 G1 失败"
      READY_RELS+=("$rel")
    done
    if [ "${#READY_RELS[@]}" -eq 0 ]; then
      printf '\n没有需要落地的补丁（全部已打）。\n'
      printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
      exit 0
    fi
    # F0（可选）：core.handle 的类型签名若未声明 file，补上（幂等；找不到签名则只警告不中止）
    for rel in "${READY_RELS[@]}"; do
      tgt="$PATCH_DIR/$rel"
      if grep -qE 'file\??:\s*\{' "$tgt" 2>/dev/null; then
        pass "F0 跳过：$rel 的 handle 签名已声明 file"
      else
        warn "F0：$rel 的 handle 签名未见 file 字段——请确认 tenant-core 是否已接 file（未接则 F1 的合并需人工确认）"
      fi
    done
    # ---- 阶段二：逐文件备份 + 原地重写 ----
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      bodyfn=$(spec_field "$spec" 5); evid=$(spec_field "$spec" 6)
      tgt="$PATCH_DIR/$rel"
      case " ${READY_RELS[*]} " in *" $rel "*) ;; *) continue ;; esac
      bak="$tgt.bak-$BACKUP_STAMP"
      cp -a "$tgt" "$bak" || gate_fail "apply 中止：备份失败 $bak"
      pass "已备份 $bak"
      tmp=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      body=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      "$bodyfn" > "$body"
      # 锚点行被补丁体整体「替换」（补丁体自己重写了该分支的判定），不是插入到锚点行之前。
      # 用 awk 跳过原始分支体，直到证据锚点出现（原分支体之后的第一个稳定行）。
      awk -v anchor="$anchor" -v bodyf="$body" -v evid="$evid" '
        BEGIN { done = 0; skipping = 0 }
        !done && !skipping && index($0, anchor) > 0 {
          while ((getline line < bodyf) > 0) print line
          close(bodyf)
          done = 1; skipping = 1; next
        }
        skipping && index($0, evid) > 0 { skipping = 0; print; next }
        skipping { next }
        { print }
      ' "$tgt" > "$tmp" || { rm -f "$tmp" "$body"; gate_fail "apply 中止：awk 生成失败 $rel"; }
      # 替换后锚文本出现次数必须 == 原有 exp - 替换 1 + 补丁体重写数。
      # 少 = 原体被多删；多 = 原体没删干净（重复分支体，产物语法错）。两者都 fail-closed。
      body_anchor_n=$(grep -cF "$anchor" "$body" 2>/dev/null || true); body_anchor_n="${body_anchor_n:-0}"
      tmp_anchor_n=$(grep -cF "$anchor" "$tmp" 2>/dev/null || true); tmp_anchor_n="${tmp_anchor_n:-0}"
      anchor_expect=$((exp - 1 + body_anchor_n))
      if [ "$tmp_anchor_n" != "$anchor_expect" ]; then
        rm -f "$tmp" "$body"
        gate_fail "apply 中止：$rel 替换后锚文本 $tmp_anchor_n 次（应 $anchor_expect = 原有 $exp - 替换 1 + 补丁体重写 $body_anchor_n）—— 原体多删或残留重复体"
      fi
      pass "G2' 替换唯一性 $rel: 锚文本 $tmp_anchor_n 次（== $anchor_expect，无残留重复体）"
      # 保留 inode（不 rm 重建），避免宿主 bind-mount 丢挂载
      cat "$tmp" > "$tgt" || { rm -f "$tmp" "$body"; gate_fail "apply 中止：写入失败 $rel"; }
      rm -f "$tmp" "$body"
      pass "已原地重写 $rel（inode 保留）"
      check_shape "$tgt" "$needl" || gate_fail "apply 中止：$rel 形态门 G2 失败，请 --rollback --from $BACKUP_STAMP 回退"
    done
    # ---- 阶段三：语法自检 + 收尾提示 ----
    for rel in "${READY_RELS[@]}"; do
      printf '\n%s 语法自检（bun/node 可用时）:\n' "$rel"
      safe bash -c "cd '$PATCH_DIR' && (command -v bun >/dev/null && bun build --no-bundle '$rel' >/dev/null && echo 'bun ok' || echo '(无 bun, 跳过语法自检)')"
    done
    printf '\n落地完成。下一步（操作员确认后执行，本脚本从不重启服务）：\n'
    printf '  1) systemctl restart %s\n' "$WAGATE_UNIT"
    printf '  2) bash regr/regrF.sh          # A/B/C 合成断言\n'
    printf '  3) 回退: TARGET=%s bash fixes/fixF-hold.sh --rollback --from %s\n' "$TARGET" "$BACKUP_STAMP"
    printf '若重启后异常：先 --rollback 再查 journalctl -u %s -n 200\n' "$WAGATE_UNIT"
    ;;

  rollback)
    printf '\n--rollback：从 .bak-<戳> 还原。\n'
    if [ -z "$FROM_TS" ]; then
      printf '未指定 --from，列出可用备份：\n'
      safe bash -c "ls -la $PATCH_DIR/bot.ts.bak-* 2>/dev/null | tail -n 40"
      printf '用法: bash %s --rollback --from <时间戳>\n' "$0"
      printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
      exit 0
    fi
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1)
      bak="$PATCH_DIR/$rel.bak-$FROM_TS"
      if [ -f "$bak" ]; then
        cat "$bak" > "$PATCH_DIR/$rel" && pass "已还原 $rel <- $bak"
      else
        warn "备份不存在，跳过: $bak"
      fi
    done
    printf '\n还原后重启：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
    ;;
esac

printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
exit $([ "$FAIL_N" -eq 0 ] && echo 0 || echo 1)
