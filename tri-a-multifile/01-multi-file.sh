#!/usr/bin/env bash
# 01-multi-file.sh —— 「一条消息多个文件只处理第一个」只读取证（EU 现场）
#
# 执行位置：EU 服务器（操作员 SSH 上去跑）；agent 从不执行本脚本。
# 预期时长：< 90s（每段外部命令都带 timeout 兜底）
# 输出：stdout（建议 `| tee /tmp/tri-a-multifile-out/01.txt`）
#
# 只读声明（铁律）：
#   * 不修改 EU 上任何文件/服务/DB/容器状态；不重启容器；不写任何 EU 路径
#   * 不发送任何 Telegram 消息；不外呼任何 API
#   * 不读取 secret 内容（不 cat token/key 文件；本脚本不出现 /srv/secrets 路径）
#   * 唯一写入是 tee 到本机 /tmp（由操作员自己决定，不在脚本内）
#
# 用法：
#   bash 01-multi-file.sh            # 全量取证
#   EU_TG_LOG_DAYS=14 bash 01-multi-file.sh
# 路径与其他变量见 _lib.sh 顶部表格；现场路径不同时用环境变量覆盖，不改脚本。

VERSION='1.0.0'

set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/_lib.sh
. "$SELF_DIR/lib/_lib.sh" || { printf 'FATAL: 无法 source %s/lib/_lib.sh\n' "$SELF_DIR"; exit 2; }

printf '=== 01-multi-file.sh —— 多文件并发失败只读取证 v%s ===\n' "$VERSION"
printf '采集时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo unknown)"
printf '主机: %s\n' "$(hostname 2>/dev/null || echo unknown)"
printf '模式: 纯只读 | PATCH_DIR=%s | CONTAINER=%s:%s\n\n' "$PATCH_DIR" "$CONTAINER" "$PLUGIN_DIR"
printf '说明：以下每段先打印原始输出，再打印判读。\n'
printf '      判读是脚本猜的，可能与现场不符；以原始输出为准，不要只看 PASS/WARN/FAIL。\n'

# ==========================================================================
hr "1. 现场文件定位：live telegram.ts / bot.ts 到底在哪、加载的是不是它"
# 先看服务挂载行，再比对宿主/容器 md5 —— 定位错了后面对不上就是白跑。
printf '\n--- 1.1 wagate.service ExecStart 与 Mount/Volume 行 ---\n'
safe timeout "$T_SHORT" systemctl cat "$WAGATE_UNIT"
printf '\n--- 1.2 磁盘上所有同名插件的候选路径 ---\n'
for n in telegram.ts bot.ts tenant-core.ts ws-sync-queue.ts upload-ops.ts; do
  printf '## %s\n' "$n"
  safe timeout "$T_SHORT" bash -c "ls -la --time-style=long-iso '$PATCH_DIR/$n' 2>&1"
  safe timeout "$T_SHORT" bash -c "find /srv /opt /root /app -maxdepth 6 -name '$n' -not -path '*/node_modules/*' 2>/dev/null | head -n 10"
done
printf '\n--- 1.3 宿主 vs 容器 md5 比对（不一致 = 容器跑的不是你改的那份）---\n'
for n in telegram.ts bot.ts tenant-core.ts; do
  md5_pair "$n" "$PATCH_DIR/$n" "$PLUGIN_DIR/$n"
done

# ==========================================================================
hr "2. live telegram.ts 的多文件处理路径（根因嫌疑点 2）"
# 判读要点：本段有没有根据「一次 update 里的文件数量」循环？还是只处理 msg.document 一个字段？
if [ ! -f "$PATCH_DIR/telegram.ts" ]; then
  fail "telegram.ts 缺失：$PATCH_DIR/telegram.ts（用 1.2 的候选路径改 PATCH_DIR 后重跑）"
else
  printf '\n--- 2.1 计数（先证明锚点存在）---\n'
  for pat in 'msg\.document' 'msg\.voice' '\.photo' '\.video' 'media_group_id' 'getFile' 'editMessageMedia' 'for (const' 'emitMessage'; do
    grep_count "$PATCH_DIR/telegram.ts" "$pat"
  done
  printf '\n--- 2.2 document / voice / photo / video / media_group 命中行（带行号）---\n'
  grep -nE "msg\.(document|voice|photo|video)\b|media_group_id|sendMediaGroup|/getFile|getFile\b" "$PATCH_DIR/telegram.ts" || true
  printf '\n--- 2.3 每次 getFile 的上下文（-A 12：看它下完文件后把结果赋给谁）---\n'
  grep -n -A 12 "getFile" "$PATCH_DIR/telegram.ts" || true
  printf '\n--- 2.4 构造 PlatformMessage / emitMessage 前后（-B 3 -A 18）---\n'
  grep -n -B 3 -A 18 "emitMessage\|PlatformMessage = {" "$PATCH_DIR/telegram.ts" || true
  printf '\n--- 2.5 单条 update 处理入口（handleUpdate / getUpdates 循环，-A 25）---\n'
  grep -n -A 25 "handleUpdate\|data\.result" "$PATCH_DIR/telegram.ts" || true
fi

# ==========================================================================
hr "3. 单槽黑板清点（根因嫌疑点 1：__excelPendingFile 等 globalThis 裸槽）"
printf '判读：同一个槽名只要被「写」两处以上且没有配套的清空/所有权判定，第二个文件就会覆盖第一个。\n'
printf '本段只列事实，不判定对错。\n'
printf '\n--- 3.1 宿主 patch 目录全量清点 ---\n'
grep_glob "$PATCH_DIR" "__excelPendingFile|__[A-Za-z0-9_]*Pending(File|Image|Video|FileList)|__pendingImage(Sid)?|__imgTask|__uploadTask|__imgLabCalled|globalThis\.__" '*.ts' || \
  warn "未命中任何 globalThis 槽：请确认 PATCH_DIR 是否是 live 插件目录"
printf '\n--- 3.2 容器内同一批关键字（容器版本可能比宿主更新/更旧）---\n'
safe timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -c \
  "grep -nE '__excelPendingFile|__[A-Za-z0-9_]*Pending|__pendingImage|__imgTask|__uploadTask|globalThis\.__' $PLUGIN_DIR/*.ts 2>&1 | head -n 200"
printf '\n--- 3.3 __excelPendingFile 的每一处出现（-B 4 -A 10）：写方、读方、清空方各是哪些 ---\n'
grep_glob "$PATCH_DIR" "__excelPendingFile" '*.ts' -B 4 -A 10 || true
printf '\n--- 3.4 谁在消费这个槽（upload-ops 是否只取一个文件）---\n'
if [ -f "$PATCH_DIR/upload-ops.ts" ]; then
  grep -n -B 4 -A 14 "__excelPendingFile\|uploads" "$PATCH_DIR/upload-ops.ts" || true
else
  warn "未找到 $PATCH_DIR/upload-ops.ts —— 插件文件名可能与假设不同，用 1.2 的清单修正"
fi

# ==========================================================================
hr "4. ws-sync flush 队列结构与坑#14（父目录）"
# 判读要点：队列是「一个变量存一个对象」还是「数组」？flush 写文件前建没建父目录？registry 是不是按文件记 done？
printf '\n--- 4.1 ws-sync-queue.ts 定位 ---\n'
WSS_HOST="$PATCH_DIR/ws-sync-queue.ts"
if [ -f "$WSS_HOST" ]; then
  printf '找到: %s\n' "$WSS_HOST"
else
  warn "未找到 $WSS_HOST；用下面 find 的结果修正 PATCH_DIR"
  safe timeout "$T_SHORT" find /srv /app -maxdepth 6 -name 'ws-sync-queue.ts' -not -path '*/node_modules/*'
fi
printf '\n--- 4.2 队列数据结构与出队逻辑（-A 12）---\n'
grep_glob "$PATCH_DIR" "flushPendingSync|onSandboxCreated|lastFlushedSbxId|enqueue|flushed|pendingSync|registry|doneFiles|doneSet" '*.ts' -A 12 || \
  warn "未命中 ws-sync 队列关键字：队列实现可能在别处（把 4.1 的 find 结果贴回来）"
printf '\n--- 4.3 落盘处是否建父目录（坑#14：无 mkdir -p 则首写失败）---\n'
grep_glob "$PATCH_DIR" "mkdir -p|mkdir -p |mkdirSync|ensureDir|writeFileSync|writeFile\(" '*.ts' -B 3 -A 6 || true
printf '\n--- 4.4 容器内同名文件的对应实现 ---\n'
safe timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -c \
  "ls -la $PLUGIN_DIR/ws-sync-queue.ts 2>&1; grep -nE 'flushPendingSync|registry|mkdir|writeFile' $PLUGIN_DIR/ws-sync-queue.ts 2>&1 | head -n 80"

# ==========================================================================
hr "5. 最近真实多文件流量取证（journalctl）"
printf '目的：判断近期是否真有「一条消息多个文件」的流量；没有就改用合成用例（见 regr/regrA.sh）。\n'
printf '不打印任何消息正文，只打印计数与插件自身打的日志行。\n\n'
printf -- '--- 5.1 发送方痕迹：一个 caption 下多个 attach（%s 天内）---\n' "$EU_TG_LOG_DAYS"
safe timeout "$T_LONG" journalctl -u "$WAGATE_UNIT" --since "$EU_TG_LOG_DAYS days ago" --no-pager 2>/dev/null \
  | grep -aE "attach|media_group|album|multiple (files|documents)|getFile" | tail -n 40
printf '\n--- 5.2 插件侧关键字行数统计（近 %s 天）---\n' "$EU_TG_LOG_DAYS"
for pat in 'document' 'attachment name=' 'uploads' 'flush' 'ws-sync'; do
  n=$(timeout "$T_LONG" journalctl -u "$WAGATE_UNIT" --since "$EU_TG_LOG_DAYS days ago" --no-pager 2>/dev/null | grep -acF "$pat" || true)
  printf '  %-16s %s\n' "$pat" "$n"
done
printf '\n--- 5.3 最相关的 40 行原始日志（近 %s 天）---\n' "$EU_TG_LOG_DAYS"
safe timeout "$T_LONG" journalctl -u "$WAGATE_UNIT" --since "$EU_TG_LOG_DAYS days ago" --no-pager 2>/dev/null \
  | grep -aE "\[Telegram\].*(document|voice|getFile)|\[bot\].*(file|dedup)|\[inject\] file|excelPendingFile|uploads|ws-sync" | tail -n 40
printf '\n--- 5.4 若 5.1~5.3 全空 ---\n'
printf '结论：近 %s 天没有可用的真实多文件样本，Phase 1 的根因确认必须依赖 regr/regrA.sh 的合成用例，\n' "$EU_TG_LOG_DAYS"
printf '      不要用「日志里没看到」反推「问题不存在」。\n'

# ==========================================================================
hr "6. 各租户 uploads 现状（文件数 + mtime 分布）"
printf '目的：多文件消息之后，uploads 里到底落了几个文件。只列数量与时间，不打印文件内容。\n\n'
printf -- '--- 6.1 /srv/tenants 下 workspace/uploads 计数 ---\n'
if [ -d "$TENANTS_DIR" ]; then
  safe timeout "$T_LONG" find "$TENANTS_DIR" -maxdepth 5 -type d -name uploads 2>/dev/null | head -n 50
  printf '\n每个 uploads 目录：文件数 + 最新 3 个文件的 mtime\n'
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    c=$(timeout "$T_SHORT" find "$d" -maxdepth 1 -type f 2>/dev/null | wc -l)
    printf '%-70s files=%s\n' "$d" "$c"
    timeout "$T_SHORT" ls -la --time-style=long-iso "$d" 2>/dev/null | tail -n 4
  done <<< "$(timeout "$T_LONG" find "$TENANTS_DIR" -maxdepth 5 -type d -name uploads 2>/dev/null | head -n 50)"
else
  warn "$TENANTS_DIR 不存在或不可读（脚本不会去猜别的路径）"
fi
printf '\n--- 6.2 容器内对应 uploads（如宿主路径不同）---\n'
safe timeout "$T_SHORT" "$DOCKER" exec "$CONTAINER" sh -c "ls -la /root/workspace/uploads 2>&1 | head -n 30"
printf '\n--- 6.3 库内 uploads 目录位置（宿主 docker，不扫容器根）---\n'
safe timeout "$T_LONG" "$DOCKER" ps --filter "name=$CONTAINER" --format '{{.Names}}\t{{.Status}}\t{{.Mounts}}'
safe timeout "$T_LONG" find /srv /opt /root -maxdepth 6 -type d -name uploads -not -path '*/node_modules/*' 2>/dev/null

# ==========================================================================
printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
printf '回执方式：整段 stdout（或 /tmp 里的 tee 文件）贴回 issue #37。\n'
printf 'Phase 1 的产物：确认根因假设是否成立；不成立也要贴原始输出说明哪一条不成立。\n'
if [ "$FAIL_N" -eq 0 ]; then exit 0; else exit 1; fi
