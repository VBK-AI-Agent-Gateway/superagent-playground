#!/usr/bin/env bash
# =============================================================================
# eu-fix2-img-voice / 10-prepare.sh  —  issue #21 交付物 ①  (P0)
# EU 沙箱 wagate 图片/视频链入口恢复 —— 准备阶段：改盘，绝不重启。
#
# 结构:
#   [0] 通用: 常量 / 日志 / 断言 / 保 inode 写
#   [1] 前置检查 (root / 目标存在 / 工具存在)
#   [2] 备份 -> /root/eu-fix2-img-voice.bak.<ts>/
#   [3] 锚文本断言 (每锚恰好 1 次; 失败立即退出, 不落盘)
#   [4] python3 改写到临时文件 -> cat tmp > 目标 (保 inode)
#   [5] 容器复制 img-*.ts + md5 校验
#   [6] unit 备份 + 插挂载 + grep 断言 (禁 mask, 坑#31)
#   [7] 容器内 bun build <file> --no-bundle 真 rc 语法校验
# 本脚本绝不 docker restart / systemctl restart。重启在 20-apply.sh。
# =============================================================================
set -euo pipefail

# --- [0] 常量 ---------------------------------------------------------------
SRC_DIR="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BAK_DIR="/root/eu-fix2-img-voice.bak.$(date +%Y%m%d-%H%M%S)"
WORK="/root/eu-fix2-img-voice.work.$$"
UNIT="/etc/systemd/system/wagate.service"
CONTAINER="${CONTAINER:-wagate}"
PATCH_DIR="/srv/wagate/patches"
TG="/srv/wagate/telegram.ts"
BOT="/srv/wagate/bot.ts"

# --- [0] 日志与断言 ---------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf '[FATAL] %s\n' "$*" >&2; exit 1; }

# anchor_count <file> <literal>  -> 打印出现次数
anchor_count() { grep -F -c -- "$2" "$1" || true; }

# assert_anchor <file> <literal> <label>: 恰好 1 次, 否则 die (失败不落盘)
assert_anchor() {
	local f="$1" lit="$2" label="$3" n
	n="$(anchor_count "$f" "$lit")"
	if [ "$n" != "1" ]; then
		die "anchor '$label' expected exactly 1 occurrence in $f, found $n — 现场代码可能已漂移, 停止且未改动任何文件"
	fi
	log "  anchor OK ($label): $f"
}

# write_inplace <target> <tmp>: 保 inode (cat tmp > target), 并校验内容一致
write_inplace() {
	local target="$1" tmp="$2"
	[ -s "$tmp" ] || die "改写真空中: $tmp 为空, 拒绝落盘"
	# 保 inode: 用重定向截断写入, 不 mv/cp
	cat "$tmp" > "$target" || die "写入 $target 失败"
	if ! cmp -s "$tmp" "$target"; then die "$target 写入后内容不一致"; fi
	log "  wrote in-place (inode preserved): $target"
}

# --- [1] 前置检查 -----------------------------------------------------------
log "=== 10-prepare.sh 开始 (SRC_DIR=$SRC_DIR) ==="
[ "$(id -u)" = "0" ] || die "需要 root 执行"
for t in python3 docker grep cmp md5sum bun; do
	command -v "$t" >/dev/null 2>&1 || { [ "$t" = "bun" ] || die "缺少工具: $t"; }
done
for f in "$TG" "$BOT" "$UNIT"; do
	[ -f "$f" ] || die "目标文件不存在: $f"
done
docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1 || die "容器 $CONTAINER 不存在"

mkdir -p "$WORK" "$BAK_DIR" "$PATCH_DIR"

# --- [2] 备份 ---------------------------------------------------------------
log "[2] 备份 -> $BAK_DIR"
cp -a "$TG"  "$BAK_DIR/telegram.ts"
cp -a "$BOT" "$BAK_DIR/bot.ts"
cp -a "$UNIT" "$BAK_DIR/wagate.service"
log "  backup: telegram.ts / bot.ts / wagate.service"
# 记录备份目录供 30-rollback.sh 使用
printf '%s\n' "$BAK_DIR" > /root/eu-fix2-img-voice.LASTBAK

# --- [3] 锚文本断言 (全部通过后才进入 [4]) ---------------------------------
log "[3] 锚文本断言 (telegram.ts)"
assert_anchor "$TG" 'if (!content && !msg.document && !msg.voice) return;' 'tg-guard'
assert_anchor "$TG" 'let voiceFile: any;' 'tg-voicefile'
assert_anchor "$TG" '...(voiceFile ? { file: voiceFile } : { ...(file ? { file } : {}) }),' 'tg-msg-assemble'

log "[3] 锚文本断言 (bot.ts)"
assert_anchor "$BOT" 'const dedupKey = `${m.channelId}\u0000${text}`;' 'bot-dedupkey'
assert_anchor "$BOT" 'if (!text && !image && !file) return;' 'bot-guard'
assert_anchor "$BOT" 'const file = m.file as { data: string; fileName: string; mimeType: string } | undefined;' 'bot-file-decl'
assert_anchor "$BOT" 'if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {' 'bot-file-hold'
assert_anchor "$BOT" 'msgType: unifiedMsg.type, // 统一消息类型' 'bot-corehandle'

log "[3] 锚文本断言 (unit)"
assert_anchor "$UNIT" ' wagate:3' 'unit-order-anchor'

# --- [4] python3 改写 -------------------------------------------------------
log "[4] 改写 telegram.ts / bot.ts"

python3 - "$TG" "$BOT" "$WORK" <<'PYEOF'
import sys, io

tg_path, bot_path, work = sys.argv[1], sys.argv[2], sys.argv[3]

def read(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()

def write(p, s):
    with io.open(p, "w", encoding="utf-8", newline="") as f:
        f.write(s)

def sub1(s, old, new, label):
    n = s.count(old)
    assert n == 1, "patch %s: expected 1 occurrence, found %d" % (label, n)
    return s.replace(old, new, 1)

# ---------------- telegram.ts ----------------
tg = read(tg_path)

# (a) 守卫放行 photo/video
tg = sub1(
    tg,
    'if (!content && !msg.document && !msg.voice) return;',
    'if (!content && !msg.document && !msg.voice && !msg.photo && !msg.video) return;',
    'tg-guard',
)

# (b) video 下载状态: 紧跟 voiceFile 声明之后
tg = sub1(
    tg,
    'let voiceFile: any;\n',
    'let voiceFile: any;\n'
    '\t\t\t// Image/Video 图片 / 视频 -> message.image / message.video (getFile -> 下载 -> base64)\n'
    '\t\t\t// 图片: 交 tenant-core vision (msg.image); 视频: 交 bot.ts G.__videoPending -> core.handle videos\n'
    '\t\t\tlet imageAttachment: { data: string; mimeType: string } | undefined;\n'
    '\t\t\tlet videoAttachment: { data: string; mimeType: string } | undefined;\n'
    '\t\t\tif ((msg.photo && msg.photo.length) || msg.video) {\n'
    '\t\t\t\ttry {\n'
    '\t\t\t\t\t// TG photo 恒 jpeg, 取最大尺寸(数组末位)\n'
    '\t\t\t\t\tconst fileId = msg.photo && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : msg.video.file_id;\n'
    '\t\t\t\t\tconst gRes = await this.apiRequest("/getFile", { method: "POST", body: JSON.stringify({ file_id: fileId }) });\n'
    '\t\t\t\t\tconst g = (await gRes.json()) as { ok: boolean; result?: { file_path: string } };\n'
    '\t\t\t\t\tif (g.ok && g.result?.file_path) {\n'
    '\t\t\t\t\t\tconst dlUrl = "https://api.telegram.org/file/bot" + this.config.token + "/" + g.result.file_path;\n'
    '\t\t\t\t\t\tconst dl = await fetch(dlUrl, { signal: AbortSignal.timeout(30_000) });\n'
    '\t\t\t\t\t\tconst buf = Buffer.from(await dl.arrayBuffer());\n'
    '\t\t\t\t\t\tif (msg.video) {\n'
    '\t\t\t\t\t\t\tvideoAttachment = { data: buf.toString("base64"), mimeType: msg.video.mime_type || "video/mp4" };\n'
    '\t\t\t\t\t\t\tlogger.info(`[Telegram] video downloaded id=${msg.message_id} bytes=${buf.length}`);\n'
    '\t\t\t\t\t\t} else {\n'
    '\t\t\t\t\t\t\timageAttachment = { data: buf.toString("base64"), mimeType: "image/jpeg" };\n'
    '\t\t\t\t\t\t\tlogger.info(`[Telegram] photo downloaded id=${msg.message_id} bytes=${buf.length}`);\n'
    '\t\t\t\t\t\t}\n'
    '\t\t\t\t\t} else {\n'
    '\t\t\t\t\t\tlogger.warn("[Telegram] media getFile failed: " + JSON.stringify(g).slice(0, 120));\n'
    '\t\t\t\t\t}\n'
    '\t\t\t\t} catch (e) {\n'
    '\t\t\t\t\tlogger.warn("[Telegram] media download fail: " + String(e).slice(0, 120));\n'
    '\t\t\t\t}\n'
    '\t\t\t}\n',
    'tg-media-download',
)

# (c) message 组装: 挂 image / video
tg = sub1(
    tg,
    '\t\t\t\t...(voiceFile ? { file: voiceFile } : { ...(file ? { file } : {}) }),\n',
    '\t\t\t\t...(voiceFile ? { file: voiceFile } : { ...(file ? { file } : {}) }),\n'
    '\t\t\t\t...(imageAttachment ? { image: imageAttachment } : {}),\n'
    '\t\t\t\t...(videoAttachment ? { video: videoAttachment } as any : {}),\n',
    'tg-msg-assemble',
)

write(work + "/telegram.ts", tg)

# ---------------- bot.ts ----------------
bt = read(bot_path)

# (d) dedupKey 并入附件长度: 连续裸图/裸视频 text 均为空串会被 2500ms 去重吞掉第二张
bt = sub1(
    bt,
    'const dedupKey = `${m.channelId}\\u0000${text}`;',
    'const dedupKey = `${m.channelId}\\u0000${text}\\u0000${(m.image as any)?.data?.length ?? ""}\\u0000${(m as any).video?.data?.length ?? ""}`;',
    'bot-dedupkey',
)

# (e) 声明 video + 守卫放行
bt = sub1(
    bt,
    'const file = m.file as { data: string; fileName: string; mimeType: string } | undefined; // 多模态: 文档附件 (Excel/CSV)\n',
    'const file = m.file as { data: string; fileName: string; mimeType: string } | undefined; // 多模态: 文档附件 (Excel/CSV)\n'
    '\tconst video = (m as any).video as { data: string; mimeType: string } | undefined; // 多模态: 视频附件(base64), 交 core.handle videos -> img-lab\n',
    'bot-video-decl',
)
bt = sub1(
    bt,
    'if (!text && !image && !file) return; // 纯图片/纯文档(无文字)也放行',
    'if (!text && !image && !file && !video) return; // 纯图片/纯文档/纯视频(无文字)也放行',
    'bot-guard',
)

# (f) core.handle 透传 videos: 合并 __videoPending (镜像 __excelPendingFile 黑板模式)
bt = sub1(
    bt,
    '\t\t\tmsgType: unifiedMsg.type, // 统一消息类型\n',
    '\t\t\tvideos: (() => {\n'
    '\t\t\t\tconst pend = (globalThis as Record<string, unknown>).__videoPending as { data: string; mimeType: string } | undefined;\n'
    '\t\t\t\tif (pend) { delete (globalThis as Record<string, unknown>).__videoPending; return [{ data: pend.data }]; }\n'
    '\t\t\t\treturn video ? [{ data: video.data }] : undefined;\n'
    '\t\t\t})(),\n'
    '\t\t\tmsgType: unifiedMsg.type, // 统一消息类型\n',
    'bot-corehandle',
)

# (g) video-only hold: 紧邻 file-only hold 之前, 走自己的通道(不写 __excelPendingFile)
bt = sub1(
    bt,
    '\tif (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {\n',
    '\t// video-only: 不写 __excelPendingFile(upload-ops 会误吞), 走 G.__videoPending, 下条文本合并为 videos\n'
    '\tif (video && !text) {\n'
    '\t\t(globalThis as Record<string, unknown>).__videoPending = video;\n'
    '\t\tconsole.log(`[bot] video-only hold: bytes=${video.data.length} saved pending, waiting for user instruction`);\n'
    '\t\ttry {\n'
    '\t\t\tawait adapter.sendMessage(m.channelId, "已收到视频。请说明你的要求(如:剪掉前几秒/缩放/静音),我再开始处理。");\n'
    '\t\t} catch { /* 回复失败仍 hold */ }\n'
    '\t\treturn;\n'
    '\t}\n'
    '\tif (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {\n',
    'bot-video-hold',
)

write(work + "/bot.ts", bt)
print("PATCH OK: telegram.ts + bot.ts rewritten in temp")
PYEOF

write_inplace "$TG"  "$WORK/telegram.ts"
write_inplace "$BOT" "$WORK/bot.ts"

# 改写后二次断言: 确认新代码确实落地
log "[4] 复查改写结果"
grep -q 'imageAttachment' "$TG" || die "telegram.ts 改写未生效"
grep -q '__videoPending' "$BOT" || die "bot.ts 改写未生效"
grep -q 'videos: (() => {'  "$BOT" || die "bot.ts videos 透传未生效"

# --- [5] 从容器复制 img-*.ts (内容零改动, md5 校验) -------------------------
log "[5] 从容器复制 img-ops.ts / img-lab.ts -> $PATCH_DIR"
for f in img-ops.ts img-lab.ts; do
	docker cp "$CONTAINER:/srv/wagate/$f" "$PATCH_DIR/$f" || die "docker cp $f 失败"
	c_hash="$(docker exec "$CONTAINER" md5sum "/srv/wagate/$f" | awk '{print $1}')"
	h_hash="$(md5sum "$PATCH_DIR/$f" | awk '{print $1}')"
	[ "$c_hash" = "$h_hash" ] || die "$f md5 不一致: container=$c_hash host=$h_hash"
	log "  $f md5 OK ($h_hash)"
done

# --- [6] unit: 插两条 ro 挂载 (禁 mask) ------------------------------------
log "[6] 改写 $UNIT"
python3 - "$UNIT" "$WORK/wagate.service" "$PATCH_DIR" <<'PYEOF'
import sys, io
unit, out = sys.argv[1], sys.argv[2]
with io.open(unit, encoding="utf-8") as f:
    s = f.read()
anchor = " wagate:3"
assert s.count(anchor) == 1, "unit anchor count != 1: %d" % s.count(anchor)
add = (
    "BindReadOnlyPaths=/srv/wagate/patches/img-ops.ts:/srv/wagate/img-ops.ts\n"
    "BindReadOnlyPaths=/srv/wagate/patches/img-lab.ts:/srv/wagate/img-lab.ts\n"
)
s = s.replace(anchor, add + anchor, 1)
with io.open(out, "w", encoding="utf-8", newline="") as f:
    f.write(s)
print("UNIT PATCH OK")
PYEOF

# unit 断言: 两条挂载各 1 次, 且未写入 mask 类指令
[ "$(grep -c 'BindReadOnlyPaths=/srv/wagate/patches/img-ops.ts' "$WORK/wagate.service")" = "1" ] || die "unit 挂载 img-ops 断言失败"
[ "$(grep -c 'BindReadOnlyPaths=/srv/wagate/patches/img-lab.ts' "$WORK/wagate.service")" = "1" ] || die "unit 挂载 img-lab 断言失败"
if grep -qE '^\s*(Mask|InaccessiblePaths|BindReadOnlyPaths=/srv/wagate/(telegram|bot)\.ts)' "$WORK/wagate.service"; then
	die "unit 出现 mask/异常挂载(坑#31), 拒绝落盘"
fi
write_inplace "$UNIT" "$WORK/wagate.service"
# systemd 语法自检(不 daemon-reload)
if command -v systemd-analyze >/dev/null 2>&1; then
	systemd-analyze verify "$UNIT" >/dev/null 2>&1 || log "  WARN: systemd-analyze verify 未通过(非致命, 20-apply 前请人工确认)"
fi

# --- [7] bun 语法校验 (真 rc; 禁 `| tail; echo $?`) -------------------------
log "[7] 容器内 bun build --no-bundle 语法校验"
check_js() {
	local host="$1" name="$2" rc
	docker exec "$CONTAINER" bun build "/srv/wagate/$name" --no-bundle > /tmp/b.log 2>&1
	rc=$?
	if [ "$rc" != "0" ]; then
		docker cp /tmp/b.log "$CONTAINER:/tmp/b.log" >/dev/null 2>&1 || true
		printf '%s\n' "--- bun build FAIL rc=$rc for $name ---" >&2
		sed -n '1,40p' /tmp/b.log >&2
		die "bun 语法校验失败: $name (rc=$rc)"
	fi
	log "  bun OK: $name (rc=0)"
}
check_js "$TG"  "telegram.ts"
check_js "$BOT" "bot.ts"

# 复制到容器可见的 host 路径校验也过一遍(host 侧 bun 若存在)
if command -v bun >/dev/null 2>&1; then
	bun build "$TG"  --no-bundle > /tmp/bh.log 2>&1 || { sed -n '1,40p' /tmp/bh.log >&2; die "host bun 校验失败 telegram.ts"; }
	bun build "$BOT" --no-bundle > /tmp/bh.log 2>&1 || { sed -n '1,40p' /tmp/bh.log >&2; die "host bun 校验失败 bot.ts"; }
	log "  host bun OK (telegram.ts / bot.ts)"
fi

# --- 收尾 -------------------------------------------------------------------
rm -rf "$WORK"
log "=== PREPARE OK ==="
log "备份: $BAK_DIR  (30-rollback.sh 会读 /root/eu-fix2-img-voice.LASTBAK)"
log "下一步: bash 20-apply.sh   (本脚本未重启任何服务)"
