#!/usr/bin/env bash
# =============================================================================
# fixes/fix-imgdoc-bridge.sh —— 「图片文件通道桥接 + 指引修正 + 幽灵工具清理」
#   目标文件（唯一允许改动）: /srv/wagate/patches/upload-ops.ts
#   依据: GitHub issue #67（图片文件通道修复：上传图片到 img_ops 的桥接与幽灵工具清理）
#
# 背景（三条现场缺陷，均出自同一文件）:
#   缺陷 A 指引矛盾: upload-ops 注入的图片分支指引让模型"用 img-ops 视觉技能 (ev.images) 分析"；
#           ev.images 是"相机(photo)通道"才有的字段，文件(document)通道下恒为空 → 模型拿到死路，
#           于是开始 sbx_find/sbx_read 空转搜图、或嵌 HTML 再 deliver（结论一条都送不出去）。
#   缺陷 B 缺桥接: 相机通道由 img-ops.ts 从 ev.images 抽 base64 写 workspace/source-latest.jpg|.png，
#           而文件通道把文件落盘到 workspace/uploads/ 后没有任何代码同步到该源约定 →
#           img_ops execute 永远 error "源图片不存在(用户这条消息没带图片?)"，即便图片明明中转了。
#           本补丁在保存成功点后补一段桥接（.jpg/.jpeg/.png；.jpeg 归一为 .jpg），与相机通道同约定。
#   缺陷 C 幽灵工具: 指引/注释里出现工具名 file_handler —— /app 下并不存在该工具，
#           模型照着调 → tool not found。本补丁改成真实机制描述，并在 README 的防再犯清单①里加了机械断言。
#
# 本脚本只"产出改动"，从不自行落地到生产：默认 dry-run 只判定门，--apply 才写文件，
# 写前自动备份，写后不做语法编译之外的任何动作（重启服务、跑 E2E 一律由操作员按 README 顺序执行）。
#
# 用法:
#   bash fixes/fix-imgdoc-bridge.sh                 # dry-run（默认）：跑门 + 预览将写入的内容，不碰任何文件
#   bash fixes/fix-imgdoc-bridge.sh --verify-gate   # 同 dry-run，但门 FAIL 时以退出码 1 结束（CI/巡检用）
#   bash fixes/fix-imgdoc-bridge.sh --apply         # 备份 + 原地写入（保留 inode；python 截断写，绝不 sed -i）
#   bash fixes/fix-imgdoc-bridge.sh --revert <ts>   # 从 .bak.imgbridge.<ts> 还原（不传 <ts> 则列出可用备份）
#   bash fixes/fix-imgdoc-bridge.sh --list-backups
#
# 退出码: 0 = 门全过 / 正常结束；1 = 门 FAIL；2 = 用法错误
# 环境变量覆盖（现场路径不同时无需改脚本）: PATCH_DIR TARGET CONTAINER CONTAINER_FILE WAGATE_UNIT T_SHORT
# =============================================================================
set -uo pipefail

VERSION="1.0.0"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$(cd "$SELF_DIR/.." && pwd)/lib/_lib.sh"
[ -f "$LIB" ] || { printf '致命: 找不到共用件 %s\n' "$LIB" >&2; exit 2; }
# shellcheck source=../lib/_lib.sh
. "$LIB"

MODE="dryrun"
FROM_TS=""
usage() {
  cat <<USAGE
fix-imgdoc-bridge v$VERSION —— 图片文件通道桥接补丁器（issue #67）

用法: bash fixes/fix-imgdoc-bridge.sh [--apply | --dry-run | --verify-gate | --revert <时间戳> | --list-backups]
  (无参数)         dry-run：只判定三道门 + 预览改动，不写任何文件
  --dry-run        同上，显式写法
  --verify-gate    只判定门，FAIL 时退出码 1
  --apply          通过门后 备份 + 原地写入（保留 inode）
  --revert <ts>    从 $TARGET.bak.imgbridge.<ts> 还原
  --list-backups   列出可用备份戳
  -h|--help        本帮助

目标文件: $TARGET（仅此一个文件；容器内 $CONTAINER_FILE）
覆盖变量: PATCH_DIR TARGET CONTAINER CONTAINER_FILE WAGATE_UNIT T_SHORT
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --dry-run|--dryrun) MODE="dryrun" ;;
    --verify-gate|--gate) MODE="gate" ;;
    --revert) MODE="revert"; shift; FROM_TS="${1:-}" ;;
    --list-backups) MODE="list" ;;
    -h|--help) usage; exit 0 ;;
    *) printf '用法错误: 未知参数 %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
# --revert 必须带一个合法时间戳（形如 20261107-044500）：
#   漏传、以 '-' 开头、或形态不对 → 一律用法错误退出 2（绝不猜测要回退到哪一份备份）。
if [ "$MODE" = "revert" ]; then
  case "$FROM_TS" in
    "") printf '用法错误: --revert 需要时间戳，例如 20261107-044500\n' >&2; exit 2 ;;
    -*) printf '用法错误: --revert 需要时间戳，例如 20261107-044500\n' >&2; exit 2 ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]) : ;;
    *) printf '用法错误: 时间戳形态应为 YYYYMMDD-HHMMSS，收到: %s\n' "$FROM_TS" >&2; exit 2 ;;
  esac
fi

printf '=== fix-imgdoc-bridge v%s | 模式=%s | 目标=%s ===\n' "$VERSION" "$MODE" "$TARGET"

# ---------------------------------------------------------------------------
# 阶段零：前置事实（只读）
# ---------------------------------------------------------------------------
hr "0. 前置事实"
pass "共用件 $LIB"
if [ -f "$TARGET" ]; then
  pass "目标存在 $TARGET（inode=$(stat -c '%i' "$TARGET" 2>/dev/null || printf '?') 行数=$(wc -l < "$TARGET" 2>/dev/null | tr -d ' ')）"
else
  fail "目标不存在 $TARGET（用 TARGET= 指定宿主路径；容器内路径是 $CONTAINER_FILE）"
fi

# 三个特征串 + 序号标记 = 幂等判据。
MARK_N=0
mark_line=""
if [ -f "$TARGET" ]; then
  mark_line=$(grep -oE "$SEQ_PREFIX[0-9]+" "$TARGET" 2>/dev/null | head -n1 || true)
  MARK_N=$(printf '%s' "$mark_line" | tr -dc '0-9')
  MARK_N="${MARK_N:-0}"
fi
BRIDGE_PRESENT=0; GUIDE_PRESENT=0; GHOST_PRESENT=0
if [ -f "$TARGET" ]; then
  has_marker "$TARGET" "$MARKER_BRIDGE" && BRIDGE_PRESENT=1
  has_marker "$TARGET" "$MARKER_GUIDE"  && GUIDE_PRESENT=1
  grep -qF -- "$GHOST_TOKEN" "$TARGET" 2>/dev/null && GHOST_PRESENT=1
fi
printf '  特征串: 桥接=%s 指引=%s 幽灵引用=%s | 标记: %s\n' \
  "$BRIDGE_PRESENT" "$GUIDE_PRESENT" "$GHOST_PRESENT" "${mark_line:-无}"
if [ "$MARK_N" -gt 0 ]; then
  if [ "$BRIDGE_PRESENT" = 1 ] && [ "$GUIDE_PRESENT" = 1 ] && [ "$GHOST_PRESENT" = 0 ]; then
    pass "幂等判据一致：seq:$MARK_N 且三特征串与历史一致 → 本补丁已应用 $MARK_N 次"
  else
    fail "幂等判据不一致：seq:$MARK_N 但特征串(桥接=$BRIDGE_PRESENT 指引=$GUIDE_PRESENT 幽灵=$GHOST_PRESENT)对不上历史 —— 现场文件被手工改过，拒绝自动覆盖（请人工核对后再 --revert 或重新评估）"
  fi
fi

show_backups() { printf '  可用备份 (%s.bak.imgbridge.*):\n' "$TARGET"; safe bash -c "ls -1t $TARGET.bak.imgbridge.* 2>/dev/null | head -n 20" || true; }
if [ "$MODE" = "list" ]; then show_backups; summary; exit $?; fi

# ---------------------------------------------------------------------------
# 阶段一：三道门（锚点唯一性；任一不过 → 整批中止，绝不部分落地）
# ---------------------------------------------------------------------------
hr "1. 门（锚点唯一性 + 形态）"
GATE_OK=1
if [ ! -f "$TARGET" ]; then
  GATE_OK=0
else
  # G0: 保存点锚
  gate_anchor "$TARGET" "$ANCHOR_SAVE" 1 "现场保存点已变，本补丁废止（请贴最新保存点段落再评估）" || GATE_OK=0
  # G0b: 保存成功日志（真实到达证据）。桥接块自带的是 '[upload-ops] img bridge:' 另一条日志，
  #      不会增加本串计数 —— 无论应用前后，本串都应恰好出现 1 次。
  log_n=$(anchor_count "$TARGET" "$ANCHOR_SAVE_LOG")
  if [ "$log_n" = 1 ]; then
    pass "门(保存日志): x1（保存点到达证据唯一）"
  else
    fail "门(保存日志): x$log_n（期望 1；该串标定保存点位置与到达证据，重复或缺失都说明现场已变）"
    GATE_OK=0
  fi
  # G1/G3: 指引锚与逃生阀是"应用前"的形状门 —— 已应用的文件上它们必然不成立
  #      （指引锚被替换掉了；逃生阀在注释+代码里出现 2 次）。已应用时改为校验"应用后形状"，
  #      这样重复 --apply 是一个干净的无害 no-op（幂等），而不是一堵 FAIL 墙。
  if [ "$BRIDGE_PRESENT" = 0 ]; then
    # G1: 指引锚（应用前必须存在）
    gate_anchor "$TARGET" "$ANCHOR_GUIDE" 1 "图片分支指引已被改过，请先贴最新指引段" || GATE_OK=0
    # G3: 逃生阀（应用前应为 0）
    esc_n=$(anchor_count "$TARGET" 'WAGATE_IMG_BRIDGE_OFF')
    if [ "$esc_n" = 0 ]; then pass "门(逃生阀): 应用前 x0（尚未注入）"; else fail "门(逃生阀): 应用前已有 x$esc_n —— 半截状态，请人工核对"; GATE_OK=0; fi
  else
    # 已应用：指引锚应已消失、新指引标记应存在、逃生阀代码应恰好 1 处
    g_n=$(anchor_count "$TARGET" "$ANCHOR_GUIDE")
    if [ "$g_n" = 0 ]; then pass "门(指引锚): 旧锚点已消失（本补丁已应用）"; else fail "门(指引锚): 旧锚点仍有 x$g_n —— 半截状态，请人工核对"; GATE_OK=0; fi
    gate_anchor "$TARGET" "$MARKER_GUIDE" 1 "已应用但找不到新指引标记 —— 现场被改过" || GATE_OK=0
    esc_n=$(grep -vE "^[[:space:]]*(//|\*|/\*)" "$TARGET" | grep -cF -- 'WAGATE_IMG_BRIDGE_OFF' || true)
    if [ "${esc_n:-0}" = 1 ]; then pass "门(逃生阀): 应用后代码 x1（注释里的说明不计）"; else fail "门(逃生阀): 应用后代码 x${esc_n:-0}（期望 1）"; GATE_OK=0; fi
  fi
  # G2: 幽灵引用计数（应用前必须存在；应用后必须为 0）
  ghost_n=$(anchor_count "$TARGET" "$GHOST_TOKEN")
  if [ "$BRIDGE_PRESENT" = 0 ]; then
    if [ "$ghost_n" -ge 1 ]; then pass "门(幽灵引用): '$GHOST_TOKEN' x$ghost_n（应用前应存在，将被清掉）"; else fail "门(幽灵引用): 未找到 '$GHOST_TOKEN' —— 现场可能已清理，请贴最新片段再评估"; GATE_OK=0; fi
  else
    if [ "$ghost_n" = 0 ]; then pass "门(幽灵引用): 已为 0（应用后应清零）"; else fail "门(幽灵引用): seq>0 但仍有 x$ghost_n 残留 —— 半截状态，请人工核对"; GATE_OK=0; fi
  fi
  # G4: copyFileSync 引用形态（0=需追加 import；1=已就绪；≥2=形态异常）
  ic=$(import_count "$TARGET")
  case "$ic" in
    0) pass "门(引用): 代码中无 copyFileSync → apply 时在 $ANCHOR_IMPORT 前追加 node:fs 具名导入" ;;
    1) pass "门(引用): copyFileSync 已就绪（跳过 import 追加）" ;;
    *) fail "门(引用): copyFileSync 出现 $ic 次（期望 0 或 1）—— 现场文件形态异常，请人工核对"; GATE_OK=0 ;;
  esac
fi
printf '\n判读: 门全 PASS 才可 --apply；任一 FAIL 说明现场代码已变 → 停手，贴最新锚点段再评估（不做部分落地）。\n'
if [ "$MODE" = "gate" ] && [ "$GATE_OK" != 1 ]; then
  summary || true
  exit 1
fi
if [ "$GATE_OK" != 1 ] && [ "$MODE" = "apply" ]; then
  fail "apply 中止：门未全过（不做任何写入）"
  summary || true
  exit 1
fi

# ---------------------------------------------------------------------------
# 阶段二：预览 / 落地
# ---------------------------------------------------------------------------
# 落地管线（每处改动都走同一条：片段 → awk 生成新文件 → 锚文本复核 → inode 保留写 → 形态门）
apply_edit_log_bridge() {
  # (1) 保存点之后插入桥接块
  local tgt="$1" tmp body out
  tmp=$(mktemp) || return 1
  body=$(mktemp) || return 1
  bridge_body > "$body"
  awk -v a="$ANCHOR_SAVE" -v bf="$body" '
    { print }
    !done && index($0, a) > 0 { while ((getline line < bf) > 0) print line; close(bf); done = 1 }
  ' "$tgt" > "$tmp" || { rm -f "$tmp" "$body"; return 1; }
  # 复核：锚文本行数不变（只插入，不替换）
  local n_before n_after
  n_before=$(anchor_count "$tgt" "$ANCHOR_SAVE"); n_after=$(anchor_count "$tmp" "$ANCHOR_SAVE")
  if [ "$n_before" != "$n_after" ]; then
    rm -f "$tmp" "$body"; fail "(1) 复核失败：锚文本行数 $n_before -> $n_after（应为插入而非替换）"; return 1
  fi
  # 复核：桥接块恰出现一次，且位于保存点之后
  local m_n; m_n=$(anchor_count "$tmp" "$MARKER_BRIDGE")
  if [ "$m_n" != 1 ]; then rm -f "$tmp" "$body"; fail "(1) 复核失败：桥接块出现 $m_n 次（期望 1）"; return 1; fi
  python3 - "$tmp" "$tgt" <<'PY' || { rm -f "$tmp" "$body"; fail "(1) 复核失败：桥接块不在保存点之后"; return 1; }
import sys
new = open(sys.argv[1], encoding="utf-8").read().splitlines()
old = open(sys.argv[2], encoding="utf-8").read().splitlines()
anchor = next(i for i, l in enumerate(old) if "await writeFileSync(dst, buf);" in l)
marker = next(i for i, l in enumerate(new) if "__imgdocBridge__" in l and "//" in l)
sys.exit(0 if marker > anchor else 1)
PY
  out="$tmp"; shift 2>/dev/null || true
  printf '%s' "$out"
  rm -f "$body"
  return 0
}

apply_edit_guide() {
  # (2) 指引修正：只替换该行里被引号包住的字符串字面量，保留 const guide = ...; 语句骨架。
  #     旧行:      const guide = "  3) 图片: 用 img-ops 视觉技能 (ev.images) 分析；";
  #     替换后:    const guide = "  3) 图片: ...新文案..." + "\n      [imgdoc-bridge] ..." ;
  #     做法: 取锚点前的 `const guide = ` 前缀，拼上新字面量，再补上原行尾的分号。
  local tgt="$1" tmp body out
  tmp=$(mktemp) || return 1
  body=$(mktemp) || return 1
  guide_body > "$body"
  awk -v a="$ANCHOR_GUIDE" -v bf="$body" '
    !done && index($0, a) > 0 {
      # 锚点前的前缀（含 const guide = 与开引号之前的全部内容）
      p = index($0, a); prefix = substr($0, 1, p - 1)
      # 前缀形如:  const guide = "  3) 图片: 
      # 需要砍到「开引号（含）之前」，让新字面量自带完整内容；
      # 即删除最后一个双引号及其后的所有前缀残留。
      if (match(prefix, /"[^"]*$/)) prefix = substr(prefix, 1, RSTART - 1);
      line = prefix
      while ((getline l < bf) > 0) line = line l
      close(bf)
      print line ";"
      done = 1; next
    }
    { print }
  ' "$tgt" > "$tmp" || { rm -f "$tmp" "$body"; return 1; }
  local n_before n_after
  n_before=$(anchor_count "$tgt" "$ANCHOR_GUIDE"); n_after=$(anchor_count "$tmp" "$ANCHOR_GUIDE")
  if [ "$n_after" != 0 ]; then rm -f "$tmp" "$body"; fail "(2) 复核失败：旧指引锚残留 $n_after 次"; return 1; fi
  local g_n; g_n=$(anchor_count "$tmp" "$MARKER_GUIDE")
  if [ "$g_n" != 1 ]; then rm -f "$tmp" "$body"; fail "(2) 复核失败：新指引标记出现 $g_n 次（期望 1）"; return 1; fi
  printf '%s' "$tmp"; rm -f "$body"; return 0
}

apply_edit_ghost() {
  # (3) 幽灵引用清理：把含 file_handler 的注释行成对替换为真实机制描述
  local tgt="$1" tmp body out
  tmp=$(mktemp) || return 1
  body=$(mktemp) || return 1
  ghost_body > "$body"
  awk -v tok="$GHOST_TOKEN" -v bf="$body" '
    !done && index($0, tok) > 0 {
      while ((getline line < bf) > 0) print line
      close(bf); done = 1; swallowed = 1; next
    }
    swallowed && index($0, "//") > 0 { swallowed = 0; next }
    { print }
  ' "$tgt" > "$tmp" || { rm -f "$tmp" "$body"; return 1; }
  local g_n; g_n=$(anchor_count "$tmp" "$GHOST_TOKEN")
  if [ "$g_n" != 0 ]; then rm -f "$tmp" "$body"; fail "(3) 复核失败：'$GHOST_TOKEN' 仍残留 $g_n 次"; return 1; fi
  printf '%s' "$tmp"; rm -f "$body"; return 0
}

apply_edit_import() {
  # (4) 引用补齐（仅在门判定"代码中无 copyFileSync"时执行）：改写完在锚点 import 之后追加一行同名导入
  local tgt="$1" tmp
  tmp=$(mktemp) || return 1
  awk -v a="$ANCHOR_IMPORT" '
    { print }
    !done && $0 == a { print "import { copyFileSync } from \"node:fs\";"; done = 1 }
  ' "$tgt" > "$tmp" || { rm -f "$tmp"; return 1; }
  if [ "$(anchor_count "$tmp" 'import { copyFileSync } from "node:fs";')" != 1 ]; then
    rm -f "$tmp"; fail "(4) 复核失败：copyFileSync 导入追加异常"; return 1
  fi
  printf '%s' "$tmp"; return 0
}

if [ "$MODE" = "dryrun" ] || [ "$MODE" = "apply" ]; then
  if [ "$BRIDGE_PRESENT" = 1 ]; then
    hr "2. 改动预览"
    warn "本补丁已应用（$mark_line）—— 幂等跳过，无改动。需要回退用: --revert <ts>"
  else
    hr "2. 改动预览（dry-run，不写文件）"
    printf '\n--- (1) 保存点之后插入桥接块（锚点: %s）---\n' "$ANCHOR_SAVE"
    bridge_body
    printf '\n--- (2) 图片分支指引（旧锚点: %s）替换为 ---\n' "$ANCHOR_GUIDE"
    guide_body
    printf '\n--- (3) 幽灵引用 "$GHOST_TOKEN" 注释行替换为（缩进继承原行）---\n'
    ghost_body
    printf '\n--- (4) 引用补齐：代码中 copyFileSync 计数=%s ---\n' "$(import_count "$TARGET")"
  fi
fi

if [ "$MODE" = "apply" ]; then
  hr "3. 落地（备份 → 原地写入，保留 inode）"
  if [ "$BRIDGE_PRESENT" = 1 ]; then
    warn "已应用，无操作（幂等）。"
  else
    TS_NOW=$(date -u '+%Y%m%d-%H%M%S')
    BAK=$(bak_path "$TS_NOW")
    if cp -a "$TARGET" "$BAK"; then pass "已备份 $BAK"; else fail "备份失败 $BAK —— 中止，不写入"; summary || true; exit 1; fi
    CUR="$TARGET"
    STAGE_FAIL=0
    # (1)
    if NEW=$(apply_edit_log_bridge "$CUR"); then
      if write_keep_inode "$CUR" "$NEW"; then pass "(1) 桥接块已插入（保存点之后）"; else fail "(1) 写入失败"; STAGE_FAIL=1; fi
      rm -f "$NEW"
    else STAGE_FAIL=1; fi
    # (2)
    if [ "$STAGE_FAIL" = 0 ]; then
      if NEW=$(apply_edit_guide "$CUR"); then
        if write_keep_inode "$CUR" "$NEW"; then pass "(2) 指引已修正（ev.images 误导 → img_ops 源约定）"; else fail "(2) 写入失败"; STAGE_FAIL=1; fi
        rm -f "$NEW"
      else STAGE_FAIL=1; fi
    fi
    # (3)
    if [ "$STAGE_FAIL" = 0 ]; then
      if NEW=$(apply_edit_ghost "$CUR"); then
        if write_keep_inode "$CUR" "$NEW"; then pass "(3) 幽灵引用已清理（$GHOST_TOKEN → 0）"; else fail "(3) 写入失败"; STAGE_FAIL=1; fi
        rm -f "$NEW"
      else STAGE_FAIL=1; fi
    fi
    # (4)
    if [ "$STAGE_FAIL" = 0 ]; then
      if [ "$(import_count "$CUR")" = 1 ]; then
        pass "(4) copyFileSync 引用已就绪，跳过 import 追加"
      elif NEW=$(apply_edit_import "$CUR"); then
        if write_keep_inode "$CUR" "$NEW"; then pass "(4) 已追加 import { copyFileSync } from \"node:fs\""; else fail "(4) 写入失败"; STAGE_FAIL=1; fi
        rm -f "$NEW"
      else STAGE_FAIL=1; fi
    fi
    # 标记递增（最后写，作为"整批成功"的落款）
    if [ "$STAGE_FAIL" = 0 ]; then
      NEXT_N=$((MARK_N + 1))
      TMPM=$(mktemp)
      if [ "$MARK_N" -eq 0 ]; then
        { printf '// fix-imgdoc-bridge %s | issue #67 | 应用时间(UTC) %s\n' "$SEQ_PREFIX$NEXT_N" "$TS_NOW"; cat "$CUR"; } > "$TMPM"
      else
        sed "s/${SEQ_PREFIX}${MARK_N}/${SEQ_PREFIX}${NEXT_N}/" "$CUR" > "$TMPM"
      fi
      write_keep_inode "$CUR" "$TMPM" && pass "标记递增: $SEQ_PREFIX$NEXT_N（备份戳 $TS_NOW）"
      rm -f "$TMPM"
    fi
    # 形态门（写后自检）
    # 注意：标记词会同时出现在"注释说明"和"可执行代码"里，计数必须只数语义位置，
    #       否则桥接块自己的注释会把 __imgdocBridge__ 数成 3、把逃生阀数成 2，产生假 FAIL。
    hr "4. 写后形态门"
    # (a) 桥接块标记：标记词是"语义标签"，会同时出现在桥接块头部与幽灵注释新文案的正文里；
    #     因此这里数的是"桥接块自己的那行标记注释"（带 issue #67 缺陷 B 特征），恰好 1 行。
    #     另有 (a2) 单独确认标记词在全文件"至少出现 1 次"，保证幂等判据 has_marker 仍然成立。
    n=$(grep -cE "^[[:space:]]*//.*$MARKER_BRIDGE.*issue #67" "$CUR" || true)
    if [ "${n:-0}" = 1 ]; then pass "形态(桥接块标记注释) '$MARKER_BRIDGE ... issue #67' x$n"; else fail "形态(桥接块标记注释) x${n:-0}（期望 1）"; fi
    n=$(anchor_count "$CUR" "$MARKER_BRIDGE")
    if [ "$n" -ge 1 ]; then pass "形态(标记词存在) '$MARKER_BRIDGE' x$n（幂等判据可用）"; else fail "形态(标记词存在) '$MARKER_BRIDGE' x0（幂等判据失效）"; fi
    # (b) 逃生阀：恰好 1 处"可执行判断"（排除注释里的说明文字）
    n=$(grep -vE "^[[:space:]]*(//|\*|/\*)" "$CUR" | grep -cF -- 'WAGATE_IMG_BRIDGE_OFF' || true)
    if [ "${n:-0}" = 1 ]; then pass "形态(逃生阀代码) 'WAGATE_IMG_BRIDGE_OFF' x$n"; else fail "形态(逃生阀代码) 'WAGATE_IMG_BRIDGE_OFF' x${n:-0}（期望 1）"; fi
    # (c) 指引标记与源约定路径：在"非注释"文本里各恰好 1 处
    for pair in "$MARKER_GUIDE:1" 'source-latest.png:1'; do
      s="${pair%:*}"; e="${pair##*:}"
      n=$(grep -vE "^[[:space:]]*(//|\*|/\*)" "$CUR" | grep -cF -- "$s" || true)
      if [ "${n:-0}" = "$e" ]; then pass "形态 '$s' x$n"; else fail "形态 '$s' x${n:-0}（期望 $e）"; fi
    done
    # (d) 幽灵名：全文件 0（注释与代码都不许再有）
    n=$(anchor_count "$CUR" "$GHOST_TOKEN")
    if [ "$n" = 0 ]; then pass "形态 '$GHOST_TOKEN' x0"; else fail "形态 '$GHOST_TOKEN' x$n（期望 0）"; fi
    # (e) 桥接块确实插在保存点之后（顺序断言，防"插错位置也能过计数门"）
    if python3 - "$CUR" "$MARKER_BRIDGE" <<'PY'
import io, sys
p, mark = sys.argv[1], sys.argv[2]
lines = io.open(p, encoding="utf-8").read().splitlines()
try:
    save = next(i for i, l in enumerate(lines) if "await writeFileSync(dst, buf);" in l)
    br = next(i for i, l in enumerate(lines) if mark in l and l.lstrip().startswith("//"))
    raise SystemExit(0 if br > save else 1)
except StopIteration:
    raise SystemExit(1)
PY
    then pass "形态(顺序): 桥接块位于 writeFileSync 保存点之后"; else fail "形态(顺序): 桥接块未出现在保存点之后（插错位置）"; fi
    # (f) 真实 TS 解析门：上面全是"文本计数门"，无法发现"文本对但语句坏了"（例如把
    #     const guide = "..."; 整行换成裸文本 → 语句骨架被打断，插件加载即崩）。
    #     实测坑：node --experimental-strip-types --check 在本机 node v22.22 上会**静默放过**
    #     语法错误（连 `const a = = = ;` 都 RC=0），因此**不能**用它当门。
    #     改用动态 import 做真正的 parse+link（不执行业务逻辑，只做模块实例化）。
    if command -v node >/dev/null 2>&1; then
      _tserr=$(node --experimental-strip-types --no-warnings -e \
        'import(process.argv[1]).then(()=>process.exit(0)).catch(e=>{console.error(String(e.message||e));process.exit(1)})' \
        "$CUR" 2>&1) && _tsrc=0 || _tsrc=$?
      if [ "$_tsrc" = 0 ]; then
        pass "形态(TS 解析): 动态 import 解析+链接通过（语句骨架合法）"
      else
        fail "形态(TS 解析): 落地后文件不是合法 TypeScript —— $(printf '%s' "$_tserr" | head -n1)"
      fi
    else
      warn "本机无 node，跳过 TS 解析门（请在操作机或容器内跑 bun build 复核）"
    fi

    if [ "$FAIL_N" -gt 0 ]; then
      printf '\n有形态门 FAIL → 已自动回滚到本次备份 %s\n' "$BAK"
      cat "$BAK" > "$CUR" && pass "已回滚 $CUR <- $BAK"
    fi
    printf '\n下一步（操作员按 README 执行；本脚本不重启服务、不跑生产）:\n'
    printf '  1) 容器内语法编译检查（只读，exit 0 才继续）: docker exec %s bun build --no-bundle %s\n' "$CONTAINER" "$CONTAINER_FILE"
    printf '  2) 宿主/容器 md5 双端一致: md5sum %s ; docker exec %s md5sum %s\n' "$CUR" "$CONTAINER" "$CONTAINER_FILE"
    printf '  3) 冒烟: docker exec %s bun -e '\''await import("%s");console.log("SMOKE_OK")'\''\n' "$CONTAINER" "$CONTAINER_FILE"
    printf '  4) 重启: systemctl restart %s（跑前先确认无并行部署窗口）\n' "$WAGATE_UNIT"
    printf '  5) E2E: 用户以文件形式发图 + "把图片转成黑白" → 看日志链 img bridge → img-ops execute → sendPhoto\n'
    printf '  回退: bash %s --revert %s\n' "$0" "$TS_NOW"
  fi
fi

if [ "$MODE" = "revert" ]; then
  hr "5. 回退"
  BAK=$(bak_path "$FROM_TS")
  if [ -f "$BAK" ]; then
    if write_keep_inode "$TARGET" "$BAK"; then pass "已还原 $TARGET <- $BAK"; else fail "还原写入失败"; fi
    printf '\n还原后需重启才生效: systemctl restart %s（操作员执行）\n' "$WAGATE_UNIT"
  else
    fail "备份不存在: $BAK"
    show_backups
  fi
fi

summary || true
if [ "$FAIL_N" -gt 0 ] && [ "$MODE" = "gate" ]; then exit 1; fi
[ "$FAIL_N" -eq 0 ] && exit 0 || exit 1
