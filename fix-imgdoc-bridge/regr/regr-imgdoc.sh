#!/usr/bin/env bash
# =============================================================================
# regr/regr-imgdoc.sh —— fix-imgdoc-bridge 六条合成断言（一条命令全量重跑）
#
# 设计原则:
#   * 全程只在 mktemp -d 的临时目录里造合成数据；**绝不触碰 /srv/wagate、不重启服务、不发消息**；
#   * 不依赖 bun/playwright/network；只用 shell + python3 + node（node 用于把桥接块的语义真跑一遍）；
#   * 断言的对象就是补丁真正要解决的三个缺陷：桥接产生源约定文件、.jpeg 归一到 .jpg、
#     指引提到真实工具名（img_ops）且不再有内联图片字段误导与幽灵工具名、逃生阀可整段跳过；
#   * 与补丁共用 lib/_lib.sh：桥接源码与指引文案在那里，改一处两边同步，回归不会被脚本自己骗过。
#
# 用法: bash regr/regr-imgdoc.sh        # 退出码 0 = 六条全 PASS
# =============================================================================
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$(cd "$SELF_DIR/.." && pwd)/lib/_lib.sh"
[ -f "$LIB" ] || { printf '致命: 找不到共用件 %s\n' "$LIB" >&2; exit 2; }
# shellcheck source=../lib/_lib.sh
. "$LIB"

VERSION="1.0.0"
printf '=== regr-imgdoc v%s | 六条合成断言（不触碰生产）===\n' "$VERSION"

# 断言用的合成 upload-ops 保存块（形状对齐现场：writeFileSync(dst, buf) + 保存日志）
synth_save_block() {
  cat <<'TS'
			const dst = path.join(t0.wsDir, "uploads", safeName);
			await writeFileSync(dst, buf);
			console.log(`[upload-ops] uploaded file saved ${dst} bytes=${buf.length} mime=${mime}`);
TS
}

# 桥接块的 JS 语义执行器（把 lib 里的 bridge_body 原样取出，用 node 真跑一遍）
BRIDGE_SRC="$(bridge_body)"
GUIDE_SRC="$(guide_body)"

hr "A. 合成夹具自检（桥接/指引源码非空且形态正确）"
if [ -n "$BRIDGE_SRC" ] && printf '%s' "$BRIDGE_SRC" | grep -qF 'WAGATE_IMG_BRIDGE_OFF'; then
  pass "bridge_body 非空且含逃生阀"
else
  fail "bridge_body 缺失或未含逃生阀 —— 回归自身不可信"
fi
if [ -n "$GUIDE_SRC" ] && printf '%s' "$GUIDE_SRC" | grep -qF 'img_ops'; then
  pass "guide_body 非空且指向 img_ops"
else
  fail "guide_body 缺失或未指向 img_ops —— 回归自身不可信"
fi

WORK=$(mktemp -d /tmp/regr-imgdoc.XXXXXX)
trap 'rm -rf "$WORK"' EXIT
pass "临时工作区 $WORK（脚本结束即删；不写任何生产路径）"

# 用 node 把一个合成上传文件喂给桥接块，返回产出文件名 + 逃生阀行为
run_bridge() {
  # $1 = 上传文件名（决定扩展名）; $2 = 开关（"" 或不空表示置 WAGATE_IMG_BRIDGE_OFF=1）
  # 产出：stdout = 探针输出 + 末行 "WS=<workspace 绝对路径>"（调用方用 tail -n1 取工作区，勿自行拼名字）
  local fname="$1" off="$2"
  local ws="$WORK/ws_$(printf '%s' "${fname}${off}" | tr -c 'A-Za-z0-9' '_')"
  rm -rf "$ws"; mkdir -p "$ws/uploads"
  printf 'SYNTHETIC-BYTES-%s' "$fname" > "$ws/uploads/$fname"
  cat > "$WORK/bridge_probe.mjs" <<'MJS'
import { readdirSync, copyFileSync } from "node:fs";
import path from "node:path";
const wsDir = process.env.PROBE_WS;
const fname = process.env.PROBE_FNAME;
const t0 = { wsDir: wsDir, name: "synthetic" };
const dst = path.join(wsDir, "uploads", fname);
// ---- 以下为 lib/_lib.sh:bridge_body() 的原文（由回归脚本注入）----
__BRIDGE__
// ------------------------------------------------------------------
console.log("PROBE_DONE " + readdirSync(wsDir).sort().join(","));
MJS
  PROBE_BRIDGE="$BRIDGE_SRC" python3 - "$WORK/bridge_probe.mjs" <<'PY'
import io, sys, os
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
io.open(p, "w", encoding="utf-8").write(s.replace("__BRIDGE__", os.environ["PROBE_BRIDGE"]))
PY
  # 逃生阀用 env 前缀真传进 node 进程（${off:+...} 在赋值+命令的复合语境里不可靠）
  if [ -n "$off" ]; then
    ( cd "$WORK" && PROBE_WS="$ws" PROBE_FNAME="$fname" env WAGATE_IMG_BRIDGE_OFF=1 node bridge_probe.mjs 2>&1 )
  else
    ( cd "$WORK" && PROBE_WS="$ws" PROBE_FNAME="$fname" node bridge_probe.mjs 2>&1 )
  fi
  printf 'WS=%s\n' "$ws"
}

# 从 run_bridge 的输出里取工作区路径（末行）
ws_of() { printf '%s' "$1" | tail -n1 | sed 's/^WS=//'; }

hr "B. 六条合成断言"

# ---------------------------------------------------------------- 断言①
# node 可用性前置（不可用时直接失败，而不是假装通过）
if command -v node >/dev/null 2>&1; then
  pass "运行时可用: $(node -v)"
else
  fail "node 不可用 —— 桥接语义无法真跑，本回归不成立"
fi

OUT1=$(PROBE_BRIDGE="$BRIDGE_SRC" run_bridge "photo.jpg" "")
W1=$(ws_of "$OUT1")
if [ -n "$W1" ] && [ -f "$W1/source-latest.jpg" ] && cmp -s "$W1/uploads/photo.jpg" "$W1/source-latest.jpg"; then
  pass "① 文件通道 jpg → source-latest.jpg 且字节完全一致（cmp 通过）"
else
  fail "① jpg 未桥接到 source-latest.jpg 或字节不一致（workspace: $W1；探针输出: $(printf '%s' "$OUT1" | head -n2 | tr '\n' ' ')）"
fi

# ---------------------------------------------------------------- 断言②
OUT2=$(PROBE_BRIDGE="$BRIDGE_SRC" run_bridge "shot.png" "")
W2=$(ws_of "$OUT2")
if [ -n "$W2" ] && [ -f "$W2/source-latest.png" ] && cmp -s "$W2/uploads/shot.png" "$W2/source-latest.png"; then
  pass "② png → source-latest.png（img_ops 读取的第一个候选路径）"
else
  fail "② png 未桥接到 source-latest.png（workspace: $W2）"
fi

# ---------------------------------------------------------------- 断言③
OUT3=$(PROBE_BRIDGE="$BRIDGE_SRC" run_bridge "camera.jpeg" "")
W3=$(ws_of "$OUT3")
if [ -n "$W3" ] && [ -f "$W3/source-latest.jpg" ] && cmp -s "$W3/uploads/camera.jpeg" "$W3/source-latest.jpg"; then
  if [ -f "$W3/source-latest.jpeg" ]; then
    fail "③ .jpeg 归一为 .jpg —— 却同时产出了 source-latest.jpeg（应是唯一约定文件名）"
  else
    pass "③ .jpeg 归一为 source-latest.jpg（不产生 source-latest.jpeg，规避 img_ops 只认 jpg/png）"
  fi
else
  fail "③ .jpeg 未归一为 source-latest.jpg（workspace: $W3）"
fi

# ---------------------------------------------------------------- 断言④
# 4a: 指引提到 img_ops、给出源约定路径，且不再有内联图片字段(ev.images)误导。
#     注意：被检对象只能是"新指引文案"本身 —— 不能用整个 lib/本脚本（注释里提到旧字段是文档，不是缺陷）。
# 判据：把新指引里所有的 ev.images 出现都去掉后，剩余文本不得再出现该字段
#      —— 即新指引对 ev.images 只允许有"不要去找它"这类否定句；不允许把它当成取图来源。
G_OK=1
printf '%s' "$GUIDE_SRC" | grep -qF 'img_ops' || { fail "④a 指引未提到 img_ops（模型没有可调工具）"; G_OK=0; }
printf '%s' "$GUIDE_SRC" | grep -qF 'source-latest' || { fail "④a 指引未给出源约定路径 source-latest.*"; G_OK=0; }
# 拿掉全部否定句（含"不要/不要用/恒为空/找图"等否定语的行）后，若 ev.images 仍出现在指引里 → 真误导
POSITIVE_PART=$(printf '%s' "$GUIDE_SRC" | grep -vE '不要|别|禁止|恒为空' )
if printf '%s' "$POSITIVE_PART" | grep -qF 'ev.images'; then
  fail "④a 指引把 ev.images 当作正向取图来源（文件通道恒为空，正是缺陷 A）"
  G_OK=0
fi
# 反向核对：确实存在一句显式警告，避免"悄悄删掉 ev.images 却不说清"
printf '%s' "$GUIDE_SRC" | grep -qE '不要在 ev\.images 上找图' || { warn "④a 指引未显式提示 '不要在 ev.images 上找图'（建议保留，防止模型重走死路）"; }
[ "$G_OK" = 1 ] && pass "④a 指引: 有 img_ops + 有 source-latest 约定 + ev.images 只作为被否定的错误路径出现"
# 4b: 机械门「指引引用的工具必须真实存在」——把指引里出现的工具名逐个在目标树上查证
#     目标树默认取现场 /srv/wagate/patches；不存在时退化为本票内已知工具清单（img_ops 由 img-ops.ts 注册）
TOOLS_IN_GUIDE=$(printf '%s' "$GUIDE_SRC" | grep -oE '(img_ops|file_handler|img_lab|sbx_bash|sbx_read|sbx_find|deliver)' | sort -u)
if [ -z "$TOOLS_IN_GUIDE" ]; then
  fail "④b 指引中未识别出任何工具名（机械门失效）"
else
  TREE="${TOOLS_TREE:-}"
  if [ -z "$TREE" ]; then
    if [ -d /srv/wagate/patches ]; then TREE=/srv/wagate/patches; else TREE="$SELF_DIR/.."; fi
  fi
  MISSING=""
  for t in $TOOLS_IN_GUIDE; do
    case "$t" in
      sbx_bash|sbx_read|sbx_find|deliver) continue ;;   # 沙箱/框架内建工具，不在补丁目录定义
    esac
    # 真实存在的判据：目标树里能搜到它的注册/调用点（≥2 次出现：定义 + 使用）
    n=$(grep -rlF -- "$t" "$TREE" 2>/dev/null | wc -l | tr -d ' ')
    if [ "${n:-0}" -ge 1 ]; then
      pass "④b 机械门: 指引工具 '$t' 在 $TREE 下有定义/引用（命中 $n 文件）"
    else
      MISSING="$MISSING $t"
    fi
  done
  if [ -n "$MISSING" ]; then
    fail "④b 机械门失败: 指引引用了目标树中不存在的工具:$MISSING（幽灵工具名教训）"
  fi
fi

# ---------------------------------------------------------------- 断言⑤
# 幽灵工具名必须从"指引文案"与"幽灵注释新文案"里彻底消失（这两个是注入给模型的文本）
if printf '%s' "$GUIDE_SRC" | grep -qF "$GHOST_TOKEN"; then
  fail "⑤ 指引仍含幽灵工具 '$GHOST_TOKEN'"
else
  pass "⑤ 指引不含幽灵工具 '$GHOST_TOKEN'"
fi
GHOST_SRC="$(ghost_body)"
if ghost_free_check "$GHOST_SRC"; then
  pass "⑤ 幽灵注释新文案不含 '$GHOST_TOKEN'（改指向真实机制 img_ops + PIL）"
else
  fail "⑤ 幽灵注释新文案仍含 '$GHOST_TOKEN'"
fi
# 若现场树可读，再查一遍幽灵名是否确实无定义（证明它真是幽灵）
if [ -d /srv/wagate/patches ]; then
  gn=$(grep -rlF -- "$GHOST_TOKEN" /srv/wagate/patches 2>/dev/null | grep -v 'upload-ops.ts' | wc -l | tr -d ' ')
  if [ "${gn:-0}" = 0 ]; then pass "⑤b 现场树确认 '$GHOST_TOKEN' 无任何定义点（确为幽灵名）"; else warn "⑤b 现场树其它文件仍有 '$GHOST_TOKEN' 引用（$gn 个），请人工确认是否另一处缺陷"; fi
else
  warn "⑤b 现场树 /srv/wagate/patches 不可读，跳过幽灵名交叉验证（本机非生产机，正常）"
fi

# ---------------------------------------------------------------- 断言⑥
OUT6=$(PROBE_BRIDGE="$BRIDGE_SRC" run_bridge "escape.jpg" "off")
W6=$(ws_of "$OUT6")
if [ -n "$W6" ] && [ ! -f "$W6/source-latest.jpg" ] && [ -f "$W6/uploads/escape.jpg" ]; then
  pass "⑥ 逃生阀 WAGATE_IMG_BRIDGE_OFF=1: 桥接整段跳过，上传原件原样保留（可快速回旧行为定位问题）"
else
  fail "⑥ 逃生阀失效: 仍产出了 source-latest.jpg（workspace: $W6；探针输出: $(printf '%s' "$OUT6" | head -n2 | tr '\n' ' ')）"
fi

hr "C. 脚本自身的静态门（脚本只产出、不落地）"
FIX_SRC="$SELF_DIR/../fixes/fix-imgdoc-bridge.sh"
if bash -n "$FIX_SRC" 2>/dev/null; then pass "补丁脚本 bash -n 通过"; else fail "补丁脚本 bash -n 失败"; fi
# sed -i 会换 inode，单文件 bind 挂载的容器会与宿主失联（坑#36）。
# 判据只看"真正会执行的行"：跳过注释行与 printf 提示串所在行，再找 sed -i / sed --in-place。
SED_I_HITS=$(grep -vE '^[[:space:]]*#' "$FIX_SRC" | grep -vE 'printf|echo ' | grep -cE 'sed([[:space:]]+-[a-zA-Z]*)?[[:space:]]+(-i|--in-place)' || true)
if [ "${SED_I_HITS:-0}" != 0 ]; then
  fail "补丁脚本在可执行行里使用了 sed -i ($SED_I_HITS 处)（坑#36: 换 inode 会让 bind 挂载失联）"
else
  pass "补丁脚本可执行行未使用 sed -i（一律 python 截断写保留 inode）"
fi
if grep -qE 'docker[[:space:]]+(exec|restart|stop)|systemctl[[:space:]]+(restart|start|stop)' "$FIX_SRC"; then
  warn "补丁脚本文本中出现 docker/systemctl 字样：请确认只在 printf 提示里，不实际执行"
else
  pass "补丁脚本不含任何实际的服务/容器操作命令"
fi
# 生产路径写入守卫：只看可执行行（排除注释与 printf 提示），避免把"提示文本"误判成写操作
SANITIZED=$(grep -vE '^[[:space:]]*#' "$FIX_SRC" | grep -vE 'printf|echo ')
PROD_WRITE=0
for d in /srv/wagate /srv/tenants; do
  if printf '%s\n' "$SANITIZED" | grep -qE "(>|>>|cp|mv|rm|tee)[^|]*[[:space:]]$d"; then
    fail "补丁脚本可执行行疑似对生产路径 $d 有写操作"
    PROD_WRITE=1
  fi
done
[ "$PROD_WRITE" = 0 ] && pass "补丁脚本可执行行对生产路径无写操作（唯一写目标是 \$TARGET，且仅在 --apply 下、写前先备份）"

summary || true
