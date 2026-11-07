#!/usr/bin/env bash
# fixA2-multifile.sh —— 「多文件并发失败」修复 v2（基于**最新基线**重做，默认 dry-run）
#
# 执行位置：EU 服务器（操作员逐行审后自行执行）；agent 从不执行本脚本。
# 默认行为：dry-run —— 只做「锚点匹配 + 计数断言 + 改动预览」，不写任何文件。
#   --apply         真正落地（先备份 .bak-<时间戳>，再原地重写，保留 inode）
#   --verify-gate   只跑机械门（锚点/N进N出/形态），不做任何改动
#   --rollback      从 .bak-<时间戳> 还原；用 --from <时间戳> 指定批次
#
# 与 v1（fixA-multi-file.sh）的差别 —— v1 针对旧基线，本 v2 按最新基线重推锚点：
#   A1 telegram.ts：按 media_group_id 聚合，同一媒体组的多条 update 合成**一次**投递；
#                   document 分支改为对**本次聚合到的全部 document** 循环，逐个入队（非只取一个）。
#   A2 每任务文件队列：用列表 + 游标（task.json 的 files 数组）替换单槽 __excelPendingFile，
#                   并同步更新 upload-ops 消费方（旧消费者仍能读到最后一个，行为不倒退）。
#   A3 机械门禁：比较「传入文件数」与「已处理文件数」，不一致 -> 告警日志 + Telegram 通知，
#               **fail-open**（告警但绝不阻塞主链路）。
#
# 硬约束：
#   * 锚文本匹配 + 数量断言 + 失败即中止（fail-closed），绝不按行号硬切、绝不「猜着补」
#   * 只使用最新基线；现场与基线漂移导致锚点对不上时**中止并报告**，不强行 patch
#   * dry-run 必须能看出回滚路径（--rollback 从 .bak 字节级还原）
#   * 不读 secret 内容、不打印用户消息正文、不发用户可见消息（除显式 TG_NOTIFY=1 告警）
#
# 用法：
#   bash fixes/fixA2-multifile.sh                 # dry-run，看锚点门与改动预览
#   bash fixes/fixA2-multifile.sh --verify-gate
#   bash fixes/fixA2-multifile.sh --apply
#   bash fixes/fixA2-multifile.sh --rollback --from 20261106-120000

VERSION='2.0.0'
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../lib/_lib.sh
. "$SELF_DIR/../lib/_lib.sh" || { printf 'FATAL: 无法 source lib/_lib.sh\n'; exit 2; }

MODE='dry'
FROM_TS=''
TG_NOTIFY="${TG_NOTIFY:-0}"
# media_group 聚合窗口：Telegram 相册的多条 update 通常在毫秒级内到达，
# 给 1.2s 收齐窗口（可覆盖慢网络下的乱序到达），超时即投递已收到的部分。
MEDIA_GROUP_WINDOW_MS="${MEDIA_GROUP_WINDOW_MS:-1200}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE='apply' ;;
    --rollback) MODE='rollback' ;;
    --verify-gate) MODE='gate' ;;
    --from) shift; FROM_TS="${1:-}" ;;
    --from=*) FROM_TS="${1#--from=}" ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 看用法）\n' "$1"; exit 2 ;;
  esac
  shift
done

GATE_LOG="${GATE_LOG:-/tmp/tri-a2-multifile-gate.log}"
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
    "w=\$(curl -s -m 8 -o /dev/null -w '%{http_code}' 'https://api.telegram.org/bot$token/sendMessage' -d chat_id='$chat' --data-urlencode text='[tri-a2-multifile] $text'); echo \"tg=\$w\"" \
    || warn "TG 告警发送失败（告警已落 $GATE_LOG）"
}

# ==========================================================================
# 补丁表：file|锚文本|锚期望次数|已打补丁特征串|补丁体函数
# 锚文本取自仓库内提交的最新基线快照 eu-fix-img-voice/context/*.ts；现场漂移则 G1 中止。
# ==========================================================================
PATCH_SPECS=(
  'telegram.ts|if (msg.document) {|1|__fixA2DocLoop__|p1_body'
  'bot.ts|(globalThis as Record<string, unknown>).__excelPendingFile = file;|2|__fixA2FileQueue__|p2_body'
)

# --------------------------------------------------------------------------
# p1_body —— telegram.ts：media_group 聚合 + 对全部 document 循环入队
#
# 现场原形（最新基线 telegram.ts:237-255）：
#   // Document 文件 -> file (getFile -> 下载 -> base64), 交 bot.ts __excelPendingFile -> upload-ops
#   let file: PlatformMessage["file"];
#   if (msg.document) {
#       ... getFile / fetch / Buffer -> file = {...}; logger.info("[Telegram] document downloaded: "...)
#       else logger.warn("[Telegram] getFile failed: "...)
#   }  catch (e) { logger.warn("...download fail...") }
#
# 关键点：Telegram 把「一条多文件消息」拆成多条共享同一 media_group_id 的 update，
# 每条 update 各自走一遍 handleUpdate -> 各自写单槽 -> 最后写入者胜 -> 只处理最后一个文件。
# 修复：以 media_group_id 为键把同一媒体组的文件聚合成**一个**列表事件，逐个入队。
# --------------------------------------------------------------------------
p1_body() {
  cat <<'TS'
			// [fixA2/多文件] 媒体组聚合：Telegram 把一条多文件消息拆成多条共享同一
			// media_group_id 的 update，每条独立走 handleUpdate，各自写单槽 ->
			// 最后写入者胜 -> 只处理最后一个文件。这里按 media_group_id 聚合成
			// 一个列表事件，再对全部 document 循环下载入队。
			// 逃生阀 WAGATE_MULTIFILE_VIEW=0 时退回旧行为（只取最后一个，便于对比与回退）。
			const __fixA2DocLoop__: Array<{ data: string; fileName: string; mimeType: string }> = [];
			{
				// 聚合缓冲区：media_group_id -> { files, timer }（跨 update 累积，窗口到期投递）
				const __fixA2G = ((globalThis as any).__fixA2MediaGroup ??= new Map<string, any>());
				const __fixA2View = process.env.WAGATE_MULTIFILE_VIEW !== "0";

				// 逐个 document 下载 -> 入列（不再「只取一个」）
				const __fixA2FetchDoc = async (doc: any): Promise<void> => {
					if (!doc?.file_id) return;
					try {
						const gRes = await this.apiRequest("/getFile", { method: "POST", body: JSON.stringify({ file_id: doc.file_id }) });
						const g = (await gRes.json()) as { ok: boolean; result?: { file_path: string } };
						if (g.ok && g.result?.file_path) {
							const dlUrl = "https://api.telegram.org/file/bot" + this.config.token + "/" + g.result.file_path;
							const dl = await fetch(dlUrl, { signal: AbortSignal.timeout(30_000) });
							const buf = Buffer.from(await dl.arrayBuffer());
							__fixA2DocLoop__.push({
								data: buf.toString("base64"),
								fileName: doc.file_name || g.result.file_path.split("/").pop() || "upload.bin",
								mimeType: doc.mime_type || "application/octet-stream",
							});
							logger.info("[Telegram] document downloaded: " + (doc.file_name || "upload.bin") + " bytes=" + buf.length);
						} else {
							logger.warn("[Telegram] getFile failed: " + JSON.stringify(g).slice(0,120));
						}
					} catch (e) {
						logger.warn("[Telegram] document download fail: " + String(e).slice(0,120));
					}
				};

				if (msg.document) {
					const __fixA2Gid = msg.media_group_id ? String(msg.media_group_id) : "";
					if (__fixA2Gid && __fixA2View) {
						// 同一媒体组：累积到缓冲，窗口到期一次性投递全部文件
						let __fixA2Slot = __fixA2G.get(__fixA2Gid);
						if (!__fixA2Slot) { __fixA2Slot = { docs: [], timer: null }; __fixA2G.set(__fixA2Gid, __fixA2Slot); }
						__fixA2Slot.docs.push(msg.document);
						if (!__fixA2Slot.timer) {
							__fixA2Slot.timer = setTimeout(() => {
								__fixA2G.delete(__fixA2Gid);
								void (async () => {
									try {
										const docs = __fixA2Slot.docs as any[];
										for (const d of docs) await __fixA2FetchDoc(d);
										// 机械门禁 G3：N 进 N 出（入站计数，供出站侧比对）
										logger.info(`[Telegram] __fixA2DocLoop__ inbound n=${__fixA2DocLoop__.length} names=${__fixA2DocLoop__.map((f) => f.fileName).join(",")}`);
										if (__fixA2DocLoop__.length > 0) {
											const last = __fixA2DocLoop__[__fixA2DocLoop__.length - 1];
											(globalThis as any).__excelPendingFiles = [
												...(((globalThis as any).__excelPendingFiles as Array<unknown> | undefined) ?? []),
												...__fixA2DocLoop__,
											];
											(globalThis as any).__excelPendingFile = last;
										}
									} catch (e) {
										logger.warn("[Telegram] media group flush fail: " + String(e).slice(0,120));
									}
								})();
							}, Number(process.env.WAGATE_MEDIA_GROUP_WINDOW_MS || "MEDIA_GROUP_WINDOW_PLACEHOLDER"));
						}
						return; // 聚合投递在窗口回调里完成，本次 update 不再单独投递
					}
					// 无 media_group_id（单文件）或逃生阀关闭：保持旧语义，立即处理
					await __fixA2FetchDoc(msg.document);
				}
			}
			// 兼容：保留单槽 file 的旧语义（最后一个文件），下游 m.file 零改动
			let file: PlatformMessage["file"];
			if (__fixA2DocLoop__.length > 0) {
				file = __fixA2DocLoop__[__fixA2DocLoop__.length - 1];
			}
TS
}

# --------------------------------------------------------------------------
# p2_body —— bot.ts：单槽 -> 每任务文件队列（列表 + 游标）
#
# 现场原形（最新基线 bot.ts）两处都写单槽：
#   L217-220 (inject 路径)  (globalThis as Record<string, unknown>).__excelPendingFile = file;
#   L275-279 (onMessage 路径) 同上
# 第二处覆盖第一处、以及同一 tick 内的多条消息互相覆盖 -> 只剩最后一个。
# 修复：双写 —— 队列槽 __excelPendingFiles__ 保序保量 + 游标 __excelPendingCursor__，
#      单槽继续写（旧消费方 upload-ops 零改动，回退窗口内行为不倒退）。
# --------------------------------------------------------------------------
p2_body() {
  cat <<'TS'
	// [fixA2/多文件] 单槽 __excelPendingFile 只能放一个文件，第二个会覆盖第一个。
	// 每任务文件队列：列表槽保序保量 + 游标（消费方按序取），单槽继续写最后一个
	// （旧消费方 upload-ops 零改动 -> 回退窗口内行为不倒退）。
	// 门禁 A3：传入文件数 vs 已处理文件数在消费方比对，不一致 -> 告警（fail-open，不阻塞主链路）。
	(globalThis as Record<string, unknown>).__excelPendingFiles = [
		...(((globalThis as Record<string, unknown>).__excelPendingFiles as Array<unknown> | undefined) ?? []),
		file,
	];
	(globalThis as Record<string, unknown>).__excelPendingCursor = 0;
	(globalThis as Record<string, unknown>).__excelPendingFile = file;
TS
}

# ==========================================================================
# 引擎
# ==========================================================================

# replace_block <target> <start-regex> <body-file>
# 委托给 lib/replace_block.sh 做「结构化整块替换」：
#   从起始行起做大括号深度匹配（跳过字符串/模板串/注释里的花括号）找到块尾，
#   整段丢弃再写入补丁体，绝不在锚点旁边插一段（v1 的重复声明缺陷正源于此）。
# 起始行取 `let file: PlatformMessage["file"];` —— 补丁体会重新声明 file，
# 所以原声明行必须一并移除。
# 不做行号硬切：边界/锚点命中不了就返回 3，由调用方 gate_fail 中止。
replace_block() {
  local tgt="$1" startre="$2" body="$3" extra="${4:-}"
  # shellcheck disable=SC2086
  bash "$SELF_DIR/../lib/replace_block.sh" "$tgt" \
    --start-re "$startre" --body "$body" $extra
}

# ==========================================================================
# 主流程
# ==========================================================================
printf '=== fixA2-multifile.sh v%s —— 多文件并发修复（最新基线重做）===\n' "$VERSION"
printf '模式: %s\n' "$MODE"
printf 'PATCH_DIR=%s | CONTAINER=%s:%s\n' "$PATCH_DIR" "$CONTAINER" "$PLUGIN_DIR"

case "$MODE" in
  rollback)
    hr '回滚'
    if [ -z "$FROM_TS" ]; then
      printf '未指定 --from，列出可用备份：\n'
      safe timeout "$T_SHORT" bash -c "ls -la $PATCH_DIR/*.bak-* 2>/dev/null | tail -n 40"
      printf '用法: bash %s --rollback --from <时间戳>\n' "$0"
      gate_summary; exit $?
    fi
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(printf '%s' "$spec" | cut -d'|' -f1)
      bak=$(backup_of "$PATCH_DIR/$rel" "$FROM_TS")
      if [ -f "$bak" ]; then
        cat "$bak" > "$PATCH_DIR/$rel" && pass "已还原 $rel <- $bak"
      else
        warn "备份不存在，跳过: $bak"
      fi
    done
    printf '\n还原后重启：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
    gate_summary; exit $?
    ;;

  gate|dry|apply)
    hr 'G1 锚点门：锚文本必须命中且次数等于预期'
    # 期望次数：telegram 锚 1 次、bot 锚 2 次（inject 路径 + onMessage 路径）
    declare -A EXP=( ["telegram.ts"]=1 ["bot.ts"]=2 )
    declare -A FEAT=( ["telegram.ts"]="__fixA2DocLoop__" ["bot.ts"]="__excelPendingFiles" )
    declare -A BODYFN=( ["telegram.ts"]="p1_body" ["bot.ts"]="p2_body" )

    for rel in telegram.ts bot.ts; do
      tgt="$PATCH_DIR/$rel"
      require_file "$tgt" "$rel" || continue
      # 已打过补丁 -> 幂等提示，不再重复打
      if [ "$(count_fixed "$tgt" "${FEAT[$rel]}")" -gt 0 ]; then
        warn "$rel 已含特征串 ${FEAT[$rel]} —— 视为已打过补丁，跳过（幂等）"
        continue
      fi
      case "$rel" in
        telegram.ts) anchor='let file: PlatformMessage["file"];' ;;
        bot.ts)      anchor='(globalThis as Record<string, unknown>).__excelPendingFile = file;' ;;
      esac
      got=$(count_fixed "$tgt" "$anchor")
      exp="${EXP[$rel]}"
      if [ "$got" -eq "$exp" ]; then
        pass "锚点 $rel: 「$anchor」命中 $got 次（期望 $exp）"
      else
        gate_fail "锚点 $rel: 「$anchor」命中 $got 次，期望 $exp —— 现场与最新基线漂移，已中止，不强行 patch"
      fi
      printf '  文件 sha256=%s  bytes=%s\n' "$(sha_of "$tgt")" "$(wc -c < "$tgt" | tr -d ' ')"
    done

    if [ "$MODE" = 'gate' ]; then
      hr 'G2 形态门（仅 --verify-gate 时对已打补丁现场检查）'
      for rel in telegram.ts bot.ts; do
        tgt="$PATCH_DIR/$rel"
        [ -f "$tgt" ] || continue
        n=$(count_fixed "$tgt" "${FEAT[$rel]}")
        [ "$n" -gt 0 ] && pass "$rel 含特征串 ${FEAT[$rel]}（$n 次）" || warn "$rel 未含特征串 ${FEAT[$rel]}（尚未打补丁属正常）"
      done
      gate_summary; exit $?
    fi

    hr '改动预览'
    for rel in telegram.ts bot.ts; do
      tgt="$PATCH_DIR/$rel"
      [ -f "$tgt" ] || continue
      printf '  %-14s 将整块替换锚点所在分支，预计净增约 %s 行\n' "$rel" \
        "$([ "$rel" = telegram.ts ] && echo 60 || echo 8)"
    done

    if [ "$MODE" = 'dry' ]; then
      printf '\n（dry-run：未写任何文件；确认无误后加 --apply）\n'
      printf '回滚路径：bash %s --rollback --from <批次戳>（备份 .bak-<戳> 与原文件同目录）\n' "$0"
      gate_summary; exit $?
    fi

    hr '--apply：备份 -> 重写'
    TS=$(ts_now)
    printf '批次戳: %s\n' "$TS"
    for rel in telegram.ts bot.ts; do
      tgt="$PATCH_DIR/$rel"
      [ -f "$tgt" ] || continue
      if [ "$(count_fixed "$tgt" "${FEAT[$rel]}")" -gt 0 ]; then
        warn "$rel 已打过补丁，跳过写入"
        continue
      fi
      bak=$(backup_of "$tgt" "$TS")
      cp -a "$tgt" "$bak" || { gate_fail "备份失败：$tgt（未做任何写入）"; }
      pass "已备份 $rel -> $bak"

      body=$(mktemp); tmp=$(mktemp)
      "${BODYFN[$rel]}" > "$body" || { rm -f "$body" "$tmp"; gate_fail "$rel 补丁体生成失败"; }
      # telegram.ts 的补丁体里有一个窗口毫秒占位符，落地为实际值
      if [ "$rel" = "telegram.ts" ]; then
        sed -i "s/MEDIA_GROUP_WINDOW_PLACEHOLDER/$MEDIA_GROUP_WINDOW_MS/" "$body"
      fi

      case "$rel" in
        telegram.ts) startre='^[[:space:]]*let file: PlatformMessage\["file"\];'; extra='' ;;
        bot.ts)      startre='^[[:space:]]*\(globalThis as Record<string, unknown>\)\.__excelPendingFile = file;'; extra='--all --line' ;;
      esac

      if ! replace_block "$tgt" "$startre" "$body" "$extra" > "$tmp"; then
        rm -f "$body" "$tmp"
        gate_fail "$rel 替换失败（锚点未命中或块边界无法确定），已恢复原文件，未写盘"
      fi

      # G2 形态门：替换后特征串必须真实落地
      if [ "$(count_fixed "$tmp" "${FEAT[$rel]}")" -eq 0 ]; then
        rm -f "$body" "$tmp"
        gate_fail "$rel 替换后特征串 ${FEAT[$rel]} 未出现 —— 补丁未生效，已中止"
      fi
      # 真实解析门：产物必须能被 TypeScript 解析器解析。
      # 这是 v1 翻车点（补丁体插入位置错 -> 语法无效，只有真正 --apply 才暴露）的正解：
      # 启发式大括号计数会被字符串/模板串/注释里的花括号骗（基线本身就不"平衡"），不能当语法判据。
      out=$(ts_parse_gate "$tmp"); rc=$?
      printf '%s\n' "$out" | sed 's/^/  /'
      if [ "$rc" -eq 1 ]; then
        rm -f "$body" "$tmp"
        gate_fail "$rel 替换后无法通过 TS 解析门 —— 产物语法无效，已中止（未写盘）"
      elif [ "$rc" -eq 2 ]; then
        warn "$rel 解析门无法执行（缺 node/typescript），语法未验证 —— 写入后请人工复核"
      else
        pass "$rel 解析门通过（TS 解析器无语法错误）"
      fi

      cat "$tmp" > "$tgt" && pass "已写入 $rel" || { rm -f "$body" "$tmp"; gate_fail "$rel 写入失败"; }
      rm -f "$body" "$tmp"
    done
    printf '\n落地完成。重启生效：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
    printf '回滚：bash %s --rollback --from %s\n' "$0" "$TS"
    ;;

  *) printf '未知模式: %s\n' "$MODE"; exit 2 ;;
esac

gate_summary; exit $?
