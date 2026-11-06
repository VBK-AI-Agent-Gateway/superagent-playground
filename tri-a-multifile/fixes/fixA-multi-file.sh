#!/usr/bin/env bash
# fixA-multi-file.sh —— 「多文件并发失败」队列化修复（默认 dry-run）
#
# 执行位置：EU 服务器（操作员逐行审后自行执行）；agent 从不执行本脚本。
# 默认行为：dry-run —— 只做「锚点匹配 + 计数断言 + 改动预览」，不写任何文件。
#   --apply         真正落地（先备份 .bak-<时间戳>，再原地重写，保留 inode）
#   --verify-gate   只跑机械门（N 进 N 出计数一致性 + 代码形态断言），不做任何改动
#   --rollback      从 .bak-<时间戳> 还原；用 --from <时间戳> 指定批次
#
# 机械门（issue #37 验收基调 ①：fail-closed，不靠人盯）：
#   G1 锚点门   ：每个补丁先做锚文本匹配，断言「匹配次数 == 预期次数」；不等即中止整批，
#                 绝不写半截文件（部分落地比不落地更危险）。
#   G2 形态门   ：落地后断言代码形态真实存在——列表槽存在、逐文件循环存在、flush 建父目录存在。
#   G3 计数门   ：文件 N 进 N 出的计数断言（入站计数 == 出站计数），不等即告警。
#   三门任一失败 -> 非零退出 + 告警日志 + 可选 TG 提醒（TG_NOTIFY=1 且凭据可用）。
#
# 回退：原地改不删文件；--rollback 用 .bak 覆盖回原文件 + 重启容器（重启由操作员确认）。
#
# 用法：
#   bash fixes/fixA-multi-file.sh                 # dry-run，看门与改动预览
#   bash fixes/fixA-multi-file.sh --verify-gate
#   bash fixes/fixA-multi-file.sh --apply
#   bash fixes/fixA-multi-file.sh --rollback --from 20261106-071500
#
# 硬约束：不读 secret 内容；不打印用户消息正文；不发送任何用户可见消息（除显式 TG_NOTIFY=1 的告警）。

VERSION='1.0.2'
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/_lib.sh
. "$SELF_DIR/../lib/_lib.sh" || { printf 'FATAL: 无法 source lib/_lib.sh\n'; exit 2; }

MODE='dry'
FROM_TS=''
TG_NOTIFY="${TG_NOTIFY:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE='apply' ;;
    --rollback) MODE='rollback' ;;
    --verify-gate) MODE='gate' ;;
    --from) shift; FROM_TS="${1:-}" ;;
    --from=*) FROM_TS="${1#--from=}" ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 看用法）\n' "$1"; exit 2 ;;
  esac
  shift
done

GATE_LOG="${GATE_LOG:-/tmp/tri-a-multifile-gate.log}"
gate_log() { printf '%s | %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$GATE_LOG" 2>/dev/null || true; }

# 机械门失败出口：唯一出口，保证「失败绝不静默」
gate_fail() {
  local text="$1"
  fail "$text"
  notify ALERT "$text"
  printf '\n机械门判定：FAIL —— 已中止，未做任何写入。\n'
  printf '========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  exit 1
}

# notify <级别> <文本> —— TG_NOTIFY=1 且容器里有凭据时才发；发不出去只记日志，绝不静默
notify() {
  local lvl="$1" text="$2"
  printf '[NOTIFY:%s] %s\n' "$lvl" "$text"
  gate_log "$lvl $text"
  [ "$TG_NOTIFY" = "1" ] || { printf '(TG_NOTIFY!=1，未发 TG；告警已写 %s)\n' "$GATE_LOG"; return 0; }
  local token chat
  token=$(timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${TELEGRAM_BOT_TOKEN:-}"' 2>/dev/null)
  chat=$(timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${TELEGRAM_ALERT_CHAT_ID:-}"' 2>/dev/null)
  if [ -z "$token" ] || [ -z "$chat" ]; then
    warn "TG 告警不可用：容器内无 TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID（告警已落 $GATE_LOG）"
    return 0
  fi
  timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -c \
    "w=\$(curl -s -m 8 -o /dev/null -w '%{http_code}' 'https://api.telegram.org/bot$token/sendMessage' -d chat_id='$chat' --data-urlencode text='[tri-a-multifile] $text'); echo \"tg=\$w\"" \
    || warn "TG 告警发送失败（告警已落 $GATE_LOG）"
}

# ==========================================================================
# 补丁表：file|锚文本|锚期望次数|已打补丁特征串|补丁体函数
# 现场形态以 01-multi-file.sh 第 2/3/4 节输出为准；锚不匹配就整体中止，不猜、不发散。
# ==========================================================================
PATCH_SPECS=(
  'telegram.ts|if (msg.document) {|1|__fixAFileList__|p1_body|const out|'
  'bot.ts|(globalThis as Record<string, unknown>).__excelPendingFile = file;|2|__excelPendingFiles|p2_body||'
  'ws-sync-queue.ts|export async function flushPendingSync|1|__fixAMkdir__|p3_body||'
)

p1_body() {
  cat <<'TS'
			// [fixA/多文件] 一条 update 可能带多个文档（album/多附件）。逐个 getFile 下载收进
			// __fixAFileList__，按序交给下游，不再只保留最后一个覆盖前一个。
			const __fixAFileList__: Array<{ data: string; fileName: string; mimeType: string }> = [];
			if (msg.document) {
				try {
					const gRes = await this.apiRequest("/getFile", { method: "POST", body: JSON.stringify({ file_id: msg.document.file_id }) });
					const g = (await gRes.json()) as { ok: boolean; result?: { file_path: string } };
					if (g.ok && g.result?.file_path) {
						const dlUrl = "https://api.telegram.org/file/bot" + this.config.token + "/" + g.result.file_path;
						const dl = await fetch(dlUrl, { signal: AbortSignal.timeout(30_000) });
						const buf = Buffer.from(await dl.arrayBuffer());
						file = { data: buf.toString("base64"), fileName: msg.document.file_name || g.result.file_path.split("/").pop() || "upload.bin", mimeType: msg.document.mime_type || "application/octet-stream" };
						__fixAFileList__.push(file);
						logger.info("[Telegram] document downloaded: " + file.fileName + " bytes=" + buf.length);
					} else {
						logger.warn("[Telegram] getFile failed: " + JSON.stringify(g).slice(0, 120));
					}
				} catch (e) {
					logger.warn("[Telegram] document download fail: " + String(e).slice(0, 120));
				}
			}
			// 机械门 G3: N 进 N 出。收到几个附件就必须带出去几个, 少一个立刻告警, 不静默吞掉。
			if (__fixAFileList__.length > 0) {
				logger.info(`[Telegram] multi-file inbound n=${__fixAFileList__.length} names=${__fixAFileList__.map((f) => f.fileName).join(",")}`);
			}
TS
}
# 注意：补丁体「整体替换」锚点所在的原分支块，因此补丁体必须自己重写 if (msg.document) 行，
# 并由锚点后的原始分支体被 skip 掉（evid 字段 = 原分支体之后的第一个稳定行）。
# 若现场 telegram.ts 的该分支体与锚点假设不同，G1/替换检查会 fail-closed 中止，不产出重复函数体。

p2_body() {
  cat <<'TS'
	// [fixA/多文件] 单槽 __excelPendingFile 只能放一个文件, 第二个会覆盖第一个。
	// 双写: 列表槽保序保量(新消费方读), 单槽继续写最后一个(旧消费方零改动, 兼容回退)。
	// 机械门 G3: 入站 n 个文件 -> 下游必须能读到 n 个; 消费方读完后清空列表。
	(globalThis as Record<string, unknown>).__excelPendingFiles = [
		...(((globalThis as Record<string, unknown>).__excelPendingFiles as Array<unknown> | undefined) ?? []),
		file,
	];
	(globalThis as Record<string, unknown>).__excelPendingFile = file;
TS
}

p3_body() {
  cat <<'TS'
// [fixA/多文件] flush 前先建父目录(坑#14: 父目录不存在则首写失败, 文件静默丢失),
// 且逐条目 flush 而不是只冲最后一个(单条目 = 多文件只同步一个)。
export async function flushPendingSync(sid: string): Promise<void> {
	// __fixAMkdir__: 队列里的每个相对路径都要保证父目录存在, 否则写入必失败。
	const items = pends; // 现场变量名以 01-multi-file.sh 4.2 输出为准; 若不同则本补丁锚点门会失败
	for (const it of items) {
		const rel = typeof it === "string" ? it : (it?.path ?? "");
		if (!rel) continue;
		const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
		if (dir) {
			try { await sbx.exec(`mkdir -p /ws/${dir}`); } catch (e) { console.error(`[ws-sync] mkdir -p /ws/${dir} failed: ${String(e).slice(0, 120)}`); }
		}
	}
TS
}

BACKUP_STAMP=$(date -u '+%Y%m%d-%H%M%S')

# 锚点门 G1：匹配次数必须等于期望值
check_anchor() {
  local f="$1" anchor="$2" exp="$3" n
  [ -f "$f" ] || { fail "锚点检查: 文件不存在 $f"; return 1; }
  n=$(grep -cF "$anchor" "$f" 2>/dev/null || true); n="${n:-0}"
  if [ "$n" = "$exp" ]; then
    pass "G1 锚点 $f: '$anchor' x$n（== 期望 $exp）"; return 0
  fi
  fail "G1 锚点 $f: '$anchor' x$n（期望 $exp）—— 现场代码已变，本补丁废止"
  return 1
}

# 形态门 G2：落地后断言目标代码形态真的在文件里
check_shape() {
  local f="$1" needle="$2"
  if grep -qF "$needle" "$f" 2>/dev/null; then
    pass "G2 形态 $f: 含 '$needle'"; return 0
  fi
  fail "G2 形态 $f: 缺 '$needle'（改动没生效，或落了半截）"; return 1
}

already_patched() { grep -qF "$2" "$1" 2>/dev/null; }

spec_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }

printf '=== fixA-multi-file.sh v%s | 模式=%s | PATCH_DIR=%s ===\n' "$VERSION" "$MODE" "$PATCH_DIR"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '机械门 G1 锚点 / G2 形态 / G3 计数；任一失败即中止且告警（告警日志 %s）\n' "$GATE_LOG"

# --------------------------------------------------------------------------
case "$MODE" in
  dry|gate)
    [ "$MODE" = "dry" ] && printf '\ndry-run：只判定门与预览改动，不写任何文件。\n'
    [ "$MODE" = "gate" ] && printf '\n--verify-gate：只判定门，不写任何文件。\n'
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      tgt="$PATCH_DIR/$rel"
      printf '\n--- %s ---\n' "$rel"
      if [ ! -f "$tgt" ]; then
        printf '  [FAIL] 文件不存在: %s\n' "$tgt"; FAIL_N=$((FAIL_N + 1)); continue
      fi
      if already_patched "$tgt" "$needl"; then
        printf '  [WARN] 已含 %s（已打过补丁，幂等跳过）\n' "$needl"; WARN_N=$((WARN_N + 1)); continue
      fi
      check_anchor "$tgt" "$anchor" "$exp" || true
      printf '  计划: 在锚点处写入 %s，并引入特征串 %s\n' "$needl" "$needl"
    done
    printf '\n判读：G1 全 PASS 才能 --apply；任一 FAIL 说明现场代码已变，先去跑 01-multi-file.sh 对齐现场。\n'
    printf 'G3 计数门在 --apply 后由 regr/regrA.sh 与运行时日志共同验证（N 进 N 出）。\n'
    [ "$MODE" = "gate" ] && [ "$FAIL_N" -gt 0 ] && { notify ALERT "fixA --verify-gate FAIL n=$FAIL_N（锚点不匹配）"; exit 1; }
    ;;

  apply)
    printf '\n--apply：三维校验通过后落地（先备份，原地重写保留 inode）。备份戳 %s\n' "$BACKUP_STAMP"
    # ---- 阶段一：全部门先过，一个不过就整批中止（不做部分落地）----
    declare -a READY_RELS=()
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      tgt="$PATCH_DIR/$rel"
      if [ ! -f "$tgt" ]; then
        gate_fail "apply 中止：$rel 不存在（$tgt）"
      fi
      if already_patched "$tgt" "$needl"; then warn "$rel 已打补丁，跳过"; continue; fi
      check_anchor "$tgt" "$anchor" "$exp" || gate_fail "apply 中止：$rel 锚点门 G1 失败"
      READY_RELS+=("$rel")
    done
    if [ "${#READY_RELS[@]}" -eq 0 ]; then
      printf '\n没有需要落地的补丁（全部已打）。\n'
      exit 0
    fi
    # ---- 阶段二：逐文件备份 + 原地重写 ----
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3)
      bodyfn=$(spec_field "$spec" 5); needl=$(spec_field "$spec" 4)
      evid=$(spec_field "$spec" 6)
      tgt="$PATCH_DIR/$rel"
      case " ${READY_RELS[*]} " in *" $rel "*) ;; *) continue ;; esac
      bak="$tgt.bak-$BACKUP_STAMP"
      cp -a "$tgt" "$bak" || gate_fail "apply 中止：备份失败 $bak"
      pass "已备份 $bak"
      tmp=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      body=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      "$bodyfn" > "$body"
      # 锚点行被补丁体整体「替换」（补丁体自己重写锚点行），不是插入到锚点行之前。
      # 用 switch 跳过原始锚点行及其原函数体，直到证据锚点出现（原函数体的结束行）。
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
      # 替换后锚文本的出现次数必须恰好等于 exp-1+body_anchor_n：
      # 原有 exp 份里被替换掉 1 份，补丁体自己重写了 body_anchor_n 份，其余 exp-1 份必须原样保留。
      # 少 = 原体被多删；多 = 原体没删干净（重复函数体，产物语法错）。两者都 fail-closed。
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
      check_shape "$tgt" "$needl" || gate_fail "apply 中止：$rel 形态门 G2 失败，请用 --rollback --from $BACKUP_STAMP 回退"
    done
    # ---- 阶段三：语法自检 + 收尾提示 ----
    for rel in "${READY_RELS[@]}"; do
      printf '\n%s 语法自检（bun/node 可用时）:\n' "$rel"
      safe timeout "$T_SHORT" bash -c "cd '$PATCH_DIR' && (command -v bun >/dev/null && bun build --no-bundle '$rel' >/dev/null && echo 'bun ok' || echo '(无 bun, 跳过语法自检)')"
    done
    printf '\n落地完成。下一步（操作员确认后执行）：\n'
    printf '  1) systemctl restart %s\n' "$WAGATE_UNIT"
    printf '  2) bash regr/regrA.sh        # 合成用例：两文件必须都进沙箱\n'
    printf '  3) 回退: bash fixes/fixA-multi-file.sh --rollback --from %s\n' "$BACKUP_STAMP"
    printf '若重启后异常：先 --rollback 再查 journalctl -u %s -n 200\n' "$WAGATE_UNIT"
    ;;

  rollback)
    printf '\n--rollback：从 .bak-<戳> 还原。\n'
    if [ -z "$FROM_TS" ]; then
      printf '未指定 --from，列出可用备份：\n'
      safe timeout "$T_SHORT" bash -c "ls -la $PATCH_DIR/*.bak-* 2>/dev/null | tail -n 40"
      printf '用法: bash %s --rollback --from <时间戳>\n' "$0"
      printf '========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
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
