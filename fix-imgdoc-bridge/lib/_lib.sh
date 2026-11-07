# _lib.sh —— fix-imgdoc-bridge 共用件（被 fixes/fix-imgdoc-bridge.sh 与 regr/regr-imgdoc.sh source，不是独立脚本）
#
# 职责：提供锚点门、幂等判定、inode 保留写入、路径常量与 PASS/FAIL 计数。
# 安全契约：
#   * 本文件被 source，自身绝不产生系统改动；
#   * 只操作 TARGET 指向的单个文件（缺省 /srv/wagate/patches/upload-ops.ts），不碰其余任何源码；
#   * 不写任何凭据，不重启服务，不发消息；脚本只产出改动，落地由操作员执行；
#   * 所有路径可被环境变量覆盖（现场路径不同时无需改脚本）。

# ---- 目标机常量（单一事实来源，便于现场核对）--------------------------------
PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"          # 宿主侧补丁目录（容器内对应挂载点）
TARGET="${TARGET:-$PATCH_DIR/upload-ops.ts}"           # 唯一允许改动的宿主文件
CONTAINER="${CONTAINER:-wagate}"                       # 容器名（仅用于提示命令，不自动执行）
CONTAINER_FILE="${CONTAINER_FILE:-/app/extensions/plugins/upload-ops.ts}"  # 容器内对应路径
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
T_SHORT="${T_SHORT:-15}"

PASS_N=0
FAIL_N=0
WARN_N=0

pass() { PASS_N=$((PASS_N + 1)); printf '  [PASS] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '  [WARN] %s\n' "$*"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '  [FAIL] %s\n' "$*"; }
hr()   { printf '\n===== %s =====\n' "$*"; }

# safe <cmd...> —— 外部命令失败只降级为提示，绝不中断脚本
safe() { timeout "$T_SHORT" "$@" 2>&1 || printf '[warn] 命令失败或无输出: %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 门与判定
# ---------------------------------------------------------------------------

# anchor_count <file> <anchor> —— 锚点出现次数（文件不存在时为 0）
anchor_count() {
  local f="$1" a="$2" n
  [ -f "$f" ] || { printf '0'; return 0; }
  n=$(grep -cF -- "$a" "$f" 2>/dev/null || true)
  printf '%s' "${n:-0}"
}

# gate_anchor <file> <anchor> <expect> [失败信息] —— 锚点唯一性门：非期望次数即 fail-closed
gate_anchor() {
  local f="$1" a="$2" exp="$3" msg="${4:-}" n
  if [ ! -f "$f" ]; then
    fail "锚点门：文件不存在 $f"
    return 1
  fi
  n=$(anchor_count "$f" "$a")
  if [ "$n" = "$exp" ]; then
    pass "锚点门($(basename "$f")): '$(printf '%.44s' "$a")…' x$n（== 期望 $exp）"
    return 0
  fi
  fail "锚点门($(basename "$f")): '$(printf '%.44s' "$a")…' x$n（期望 $exp）${msg:+ —— $msg}"
  return 1
}

# has_marker <file> <marker> —— 幂等标记：已打过补丁即跳过
has_marker() { grep -qF -- "$2" "$1" 2>/dev/null; }

# write_keep_inode <file> <新内容临时文件> —— 截断写而非替换（坑#36：宿主 bind 单文件挂载靠 inode）
# 用 python 以 "w" 打开原路径写入：inode 不变，容器侧立即看到新内容（代码重载仍需重启）。
write_keep_inode() {
  local target="$1" src="$2" ino_before ino_after
  ino_before=$(stat -c '%i' "$target" 2>/dev/null || printf '?')
  python3 - "$target" "$src" <<'PY' || return 1
import sys
tgt, src = sys.argv[1], sys.argv[2]
with open(src, "rb") as f:
    data = f.read()
# open(...,"w") 走截断写：保留原 inode，避免宿主 bind-mount 丢挂载（坑#36）
with open(tgt, "wb") as f:
    f.write(data)
PY
  ino_after=$(stat -c '%i' "$target" 2>/dev/null || printf '?')
  if [ "$ino_before" = "$ino_after" ] && [ "$ino_before" != "?" ]; then
    pass "inode 保留：$target ($ino_before)"
  else
    fail "inode 变化：$target 前=$ino_before 后=$ino_after（宿主 bind 挂载会失联，请检查写入方式）"
    return 1
  fi
}

# bak_path <ts> —— 备份文件名：upload-ops.ts.bak.imgbridge.<ts>
bak_path() { printf '%s.bak.imgbridge.%s' "$TARGET" "$1"; }

summary() {
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  [ "$FAIL_N" -eq 0 ] && return 0 || return 1
}

# ---------------------------------------------------------------------------
# 三处改动的锚点与文案（脚本与回归共用，改这里即两边同步）
# ---------------------------------------------------------------------------

# 行内锚点唯一性标记：每次成功应用递增（--apply 写 N->N+1；--revert 写 N->N-1）。
# 与源码内三个特征串合起来构成幂等判据：三个特征串对不上历史 → 拒绝动这个文件（防覆盖未知改动）。
SEQ_PREFIX='seq:'

# (1) 保存点桥接：锚定真实到达证据所在行（保存成功日志）
ANCHOR_SAVE='await writeFileSync(dst, buf);'

# 引用锚点 B：(1) 用到的 copyFileSync 是否已从 node:fs 具名导入。按“代码”（非注释）计数：
#   0 次 -> 需要追加 import（改 import 行，锚点 A）；1 次 -> 跳过；≥2 次 -> 形态异常，fail-closed。
import_count() {
  local f="$1" n
  [ -f "$f" ] || { printf '0'; return 0; }
  n=$(grep -vE '^[[:space:]]*(//|\*|/\*)' "$f" 2>/dev/null | grep -cF -- 'copyFileSync' || true)
  printf '%s' "${n:-0}"
}
ANCHOR_SAVE_LOG='[upload-ops] uploaded file saved'
MARKER_BRIDGE='__imgdocBridge__'
ANCHOR_IMPORT='import { writeFileSync } from "node:fs";'

# (2) 指引修正：文件通道图片分支的旧文案（含恒空的 ev.images 误导）
ANCHOR_GUIDE='用 img-ops 视觉技能 (ev.images) 分析'
MARKER_GUIDE='[imgdoc-bridge]'

# (3) 幽灵引用：upload-ops 里对不存在工具 file_handler 的引用
GHOST_TOKEN='file_handler'

# 桥接代码体（该函数的输出即插入到保存点之后的原文，缩进与原文件一致：3 个 Tab）
bridge_body() {
  cat <<'TS'
			// __imgdocBridge__ 文件通道桥接 (issue #67 缺陷 B)：把刚落盘的图片同步到 img_ops 的源约定
			// workspace/source-latest.jpg(.png)，让"文件(document)上传"通道与"相机(photo)"通道落到同一约定路径
			// （相机通道由 img-ops.ts 抽取内联图片后写 source-latest.*；文件通道原先没有任何代码做这件事，
			// 于是 img_ops execute 永远报"源图片不存在"）。.jpeg 归一为 .jpg；gif/webp 不桥接（img_ops 只认 png/jpg）。
			// 逃生阀：WAGATE_IMG_BRIDGE_OFF=1 时整段跳过（回旧行为，便于定位问题）。
			if (process.env.WAGATE_IMG_BRIDGE_OFF !== "1") {
				try {
					const _imgExt = path.extname(dst).toLowerCase();
					if (_imgExt === ".jpg" || _imgExt === ".jpeg" || _imgExt === ".png") {
						const _srcLatest = path.join(t0.wsDir, _imgExt === ".png" ? "source-latest.png" : "source-latest.jpg");
						copyFileSync(dst, _srcLatest);
						console.log(`[upload-ops] img bridge: ${_srcLatest} synced from ${path.basename(dst)}`);
					}
				} catch (e) { /* fail-open: 桥接失败不影响上传与后续指引 */ console.warn(`[upload-ops] img bridge fail (fail-open): ${String(e).slice(0, 160)}`); }
			}
TS
}

# 指引新文案（图片分支；只出现一次，避免模型两条相互矛盾的指令）
guide_body() {
  # 只替换字符串字面量本身（不含 const/;），逐行用 \n 连接成单行 TS 表达式，
  # 保证落地后仍是合法语句： const guide = "..." + "\n" + ... ;
  cat <<'TS'
"  3) 图片: 已由 __imgdocBridge__ 自动同步到 img_ops 的源约定 workspace/source-latest.jpg(.png)；" +
      "\n      [imgdoc-bridge] 处理图片一律调用 img_ops(op: info|resize|rotate|crop|grayscale|invert)，调用成功即自动把成品直发用户；" +
      "\n      不要在 ev.images 上找图（文件通道的 ev.images 恒为空），不要反复 sbx_find/sbx_read 搜图，不要嵌 HTML 再 deliver；" +
      "\n      需要加文字等复杂编辑: 用 sbx_bash 跑 python PIL，读 workspace/source-latest.jpg(.png) 或原件 ${absPath}。"
TS
}

# 幽灵注释新文案（原注释块中引用 file_handler 的两行；缩进与原文件一致：3 个 Tab）
ghost_body() {
  cat <<'TS'
			// 图片处理走 __imgdocBridge__ 桥接后的 img_ops（源约定 workspace/source-latest.jpg/.png，处理完自动直发）；
			// 需要加文字等复杂编辑走 sbx_bash + python PIL。不要写不存在的工具名——指引提到的工具必须真实存在（本单防再犯清单①）。
TS
}

# 供回归断言⑤使用的“幽灵名”负向判据：新文案不得包含该名字
ghost_free_check() { ! printf '%s' "$1" | grep -qF -- "$GHOST_TOKEN"; }
