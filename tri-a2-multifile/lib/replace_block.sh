#!/usr/bin/env bash
# replace_block.sh —— 结构化「整块替换」原语（被 fixes/*.sh 调用，不是独立交付物）
#
# 为什么需要它：v1 的翻车点是补丁体被插到锚点**之前**，原函数体没被移除 ->
# 重复声明 / 语法无效，而只有真正 --apply 才暴露。所以替换必须「结构性」：
# 定位块起止后**整段丢弃再写入**，而不是在锚点旁边插一段。
#
# 判定块边界的正确方法：从起始行开始做**大括号深度**匹配
#   * 起始行 = 锚点行，或调用方指定的 `--start-re` 匹配行
#   * 丢弃字符串/模板串/注释里的花括号（否则 `${...}`、"{...}" 会骗过深度计数）
#   * 深度回到 0 的那一行即块尾（含）
# 不做行号硬切：匹配不到就退出 3，由调用方 fail-closed 中止。
#
# 用法:
#   replace_block.sh <target> --start-re <regex> [--start-anchor <literal>] \
#                            --body <file> [--expect-count N]
#   stdout = 替换后的完整文件；同时 stderr 打印边界信息
#   退出码: 0 成功 / 1 参数错 / 2 文件问题 / 3 锚点或边界未命中（调用方须中止）

set -uo pipefail

TGT=''; START_RE=''; START_ANCHOR=''; BODY=''; EXPECT=''; ALL=0; LINE_MODE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --start-re) shift; START_RE="${1:-}" ;;
    --start-anchor) shift; START_ANCHOR="${1:-}" ;;
    --body) shift; BODY="${1:-}" ;;
    --expect-count) shift; EXPECT="${1:-}" ;;
    --all) ALL=1 ;;
    --line) LINE_MODE=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) [ -z "$TGT" ] && TGT="$1" || { printf '多余参数: %s\n' "$1" >&2; exit 1; } ;;
  esac
  shift
done

[ -n "$TGT" ] || { printf 'FATAL: 缺 target\n' >&2; exit 1; }
[ -n "$BODY" ] || { printf 'FATAL: 缺 --body\n' >&2; exit 1; }
[ -n "$START_RE$START_ANCHOR" ] || { printf 'FATAL: 缺 --start-re/--start-anchor\n' >&2; exit 1; }
[ -f "$TGT" ] || { printf 'FATAL: 目标不存在: %s\n' "$TGT" >&2; exit 2; }
[ -f "$BODY" ] || { printf 'FATAL: 补丁体不存在: %s\n' "$BODY" >&2; exit 2; }

# 锚点计数（若给了 --start-anchor 则按其固定串计数；给了 --expect-count 才校验）
if [ -n "$START_ANCHOR" ]; then
  cnt=$(grep -cF -e "$START_ANCHOR" "$TGT" 2>/dev/null || printf '0')
  if [ -n "$EXPECT" ] && [ "$cnt" != "$EXPECT" ]; then
    printf 'BOUNDARY: 锚点命中 %s 次，期望 %s —— 中止\n' "$cnt" "$EXPECT" >&2
    exit 3
  fi
fi

# 定位起始行号：--start-re（ERE）优先，其次 --start-anchor 首个命中。
# --all 时收集所有匹配行，逐个替换（用于 bot.ts：同一赋值出现在两条文件通路）。
if [ -n "$START_RE" ]; then
  L0S=$(grep -nE -e "$START_RE" "$TGT" 2>/dev/null | cut -d: -f1)
else
  L0S=$(grep -nF -e "$START_ANCHOR" "$TGT" 2>/dev/null | cut -d: -f1)
fi
[ -n "$L0S" ] || { printf 'BOUNDARY: 找不到块起始行 —— 中止\n' >&2; exit 3; }

if [ "$ALL" -eq 0 ]; then
  L0S=$(printf '%s\n' "$L0S" | head -1)
fi

# 对每个起始行做大括号深度匹配，收集 L0:L1 区段
# 模式选择：
#   --line  起始行是**无大括号的单条语句**（如 `__excelPendingFile = file;`），
#           直接替换该行，不做深度扫描（否则会一路吞到下一个 `{`，把整段函数吃掉）。
#   默认    起始行起是**块**（`if (...) { ... }` / `let x; if (...) {...}`），
#           做深度匹配定位块尾。
if [ "$LINE_MODE" -eq 1 ]; then
  SEGS=''
  while IFS= read -r L0; do
    [ -n "$L0" ] || continue
    SEGS="${SEGS}${L0}:${L0}
"
  done <<EOF
$L0S
EOF
else
SEGS=''
while IFS= read -r L0; do
  [ -n "$L0" ] || continue
  L1=$(awk -v start="$L0" '
    BEGIN { depth = 0; started = 0; in_s = 0; in_d = 0; in_t = 0; in_bc = 0; esc = 0 }
    NR < start { next }
    {
      line = $0
      n = length(line)
      i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        nxt = (i < n) ? substr(line, i+1, 1) : ""
        if (in_bc) { if (c == "*" && nxt == "/") { in_bc = 0; i += 2 } else i++; continue }
        if (!in_s && !in_d && !in_t && c == "/" && nxt == "/") break        # 行注释：本行余下忽略
        if (!in_s && !in_d && !in_t && c == "/" && nxt == "*") { in_bc = 1; i += 2; continue }
        if (in_s)  { if (esc) esc = 0; else if (c == "\\") esc = 1; else if (c == "'"'"'") in_s = 0; i++; continue }
        if (in_d)  { if (esc) esc = 0; else if (c == "\\") esc = 1; else if (c == "\"") in_d = 0; i++; continue }
        if (in_t)  { if (esc) esc = 0; else if (c == "\\") esc = 1; else if (c == "`") in_t = 0; i++; continue }
        if (c == "'"'"'") { in_s = 1; i++; continue }
        if (c == "\"") { in_d = 1; i++; continue }
        if (c == "`")  { in_t = 1; i++; continue }
        if (c == "{") { depth++; started = 1; i++; continue }
        if (c == "}") { depth--; if (started && depth == 0) { print NR; exit } i++; continue }
        i++
      }
    }
  ' "$TGT")
  [ -n "${L1:-}" ] || { printf 'BOUNDARY: 起始行 L%s 起大括号未闭合 —— 中止\n' "$L0" >&2; exit 3; }
  SEGS="${SEGS}${L0}:${L1}
"
done <<EOF
$L0S
EOF
fi

[ -n "$SEGS" ] || { printf 'BOUNDARY: 未解析出任何块 —— 中止\n' >&2; exit 3; }
printf 'BOUNDARY: 替换 %s 个块 ->\n%s' "$(printf '%s' "$SEGS" | grep -c .)" "$(printf '%s' "$SEGS" | sed 's/^/  L/;s/:/../')" >&2

# 替换：跳过所有 L0..L1 区段，在每个 L0 处写入补丁体，其余原样。
# 区段以 L0 升序、互不重叠（同一起始串的匹配行按行号排列）。
awk -v segs="$SEGS" -v bodyf="$BODY" '
  BEGIN {
    nseg = 0
    m = split(segs, lines, "\n")
    for (i = 1; i <= m; i++) {
      if (lines[i] == "") continue
      split(lines[i], p, ":")
      nseg++; s[nseg] = p[1] + 0; e[nseg] = p[2] + 0
    }
    nb = 0; while ((getline line < bodyf) > 0) body[++nb] = line
  }
  {
    for (k = 1; k <= nseg; k++) {
      if (NR == s[k]) { for (i = 1; i <= nb; i++) print body[i]; skipTo = e[k]; next }
    }
    if (skipTo != "" && NR <= skipTo) next
    print
  }
' "$TGT"
