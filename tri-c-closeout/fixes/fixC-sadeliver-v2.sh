#!/bin/sh
# fixC-sadeliver-v2.sh — sa-deliver v2：提取升级 + 收口完整性门（issue #39 D2）
#
# 默认 DRY-RUN：只打印将要做的改动与生成的补丁，绝不写盘。
#   --apply   真正应用改动；先备份为 <file>.bak.<ts>，并生成可回退的 patch/diff。
#   --revert <ts>  用 <file>.bak.<ts> 还原（回滚说明见脚本末尾）。
#
# 改动对象（仅这两个文件，绝不动 preview/、.github/ 或其它应用目录）：
#   1) /home/qt/bin/sa-deliver.sh           —— 未跟踪提取逻辑 + 收口完整性门
#   2) prompts/team/scope.md                —— 追加一条交付目录规则行
#
# 设计依据（issue #39）：
#   1603499d 的失败链：worktree 根有 index.html，子目录 css/ js/ 被当作两个独立交付物
#   => 对 css/、js/ 分别 smoke => 均 "no index.html" => SMOKE FAIL => HOLD；
#   随后每 5 分钟重复 "SKIP only files/dotfiles untracked"，收尾永不完成。
#   v2 必须在【交付物根】只 smoke 一次，并把「已结束工单是否真正收口」变成显式门禁。
#
# 用法：sh fixC-sadeliver-v2.sh [--apply|--revert <ts>] [--bin DIR] [--scope FILE]

set -u

MODE="dry"
REVERT_TS=""
BIN="${SA_BIN:-/home/qt/bin}"
SCOPE="${SCOPE_FILE:-/home/qt/src/dsh-superagent/prompts/team/scope.md}"
STAMP=$(date +%Y%m%d-%H%M%S)

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)  MODE="apply"; shift ;;
    --revert) MODE="revert"; REVERT_TS="${2:?--revert 需要时间戳}"; shift 2 ;;
    --bin)    BIN="$2"; shift 2 ;;
    --scope)  SCOPE="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（见 --help）" >&2; exit 2 ;;
  esac
done

DELIVER="$BIN/sa-deliver.sh"
WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*"; }
act() { [ "$MODE" = "apply" ] && "$@"; }

# ---------------------------------------------------------------- 回滚
if [ "$MODE" = "revert" ]; then
  say "== 回滚 sa-deliver.sh -> $DELIVER.bak.$REVERT_TS"
  for F in "$DELIVER" "$SCOPE"; do
    B="$F.bak.$REVERT_TS"
    if [ -f "$B" ]; then
      cp -p "$B" "$F" && say "  已还原：$F"
    else
      say "  跳过（无备份）：$B"
    fi
  done
  say "回滚完成。"
  exit 0
fi

[ "$MODE" = "dry" ] && say "*** DRY-RUN（不写盘）。加 --apply 才会应用。***"

if [ ! -f "$DELIVER" ]; then
  say "!! 未找到 $DELIVER —— 请用 --bin 指定，或用 SA_BIN 环境变量。"
  exit 1
fi

say ""
say "目标：$DELIVER（$(wc -l < "$DELIVER") 行）"
say "身份：VBK-AI-Agent-Gateway <315771760+VBK-AI-Agent-Gateway@users.noreply.github.com>"
say ""

# ================================================================ 补丁 1：提取升级
# 现状（第 88-89 行）：只取未跟踪的【顶层目录】，根级文件被丢弃；
# 有多个顶层目录时被当成多个独立交付物。
# v2：先判定交付物根（root-is-app 优先），再一次性提交【全部未跟踪项】。
PATCH_EXTRACT="$WORK/p1-extract.py"
cat > "$PATCH_EXTRACT" <<'PYEOF'
"""把 sa-deliver.sh 的未跟踪提取段替换为 v2 提取逻辑（纯文本替换，幂等）。"""
import re, sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

OLD = '''  # dirty top-level untracked dirs only
  DELIV=$(cd "$TDIR" && git status --porcelain 2>/dev/null | grep "^?? " | cut -d" " -f2- | grep "/$" | grep -vE "^(node_modules|.verify)/" | sed "s:/$::")
  [ -n "$DELIV" ] || { echo "$(date -Is) SKIP $TID only files/dotfiles untracked" >> "$LOG"; continue; }
'''

NEW = '''  # --- v2 交付物根判定（issue #39 D2）-------------------------------------
  # 规则优先级：
  #   R1 root-is-app：worktree 根存在 index.html => 整个 worktree 就是一个交付物，
  #      提交【全部】未跟踪项（含根级文件），Pages 名取 issue 规格目录名或 worktree 前缀。
  #   R2 单顶层目录：唯一未跟踪顶层目录即交付物根（嵌套时下钻到最浅含 index.html 的目录）。
  #   R3 多顶层目录：合并为一个交付物，取含 index.html 的最浅目录为根（css/ js/ 场景）；
  #      若无 index.html 则退化为 worktree 根。
  # 绝不把同一交付物的多个子目录当成多个独立交付物分别 smoke。
  DELIV_ROOT=""
  if [ -f "$TDIR/index.html" ]; then
    DELIV_ROOT="$TDIR"                      # R1
  else
    DELIV_ROOT=$(cd "$TDIR" && git status --porcelain 2>/dev/null \\
      | grep "^?? " | cut -d" " -f2- | grep "/$" | grep -vE "^(node_modules|\\.verify)/" \\
      | sed "s:/$::" \\
      | while read -r d; do
          if [ -n "$(find "$TDIR/$d" -maxdepth 2 -name index.html -print -quit 2>/dev/null)" ]; then
            echo "$TDIR/$d"
          fi
        done | head -1)
    [ -n "$DELIV_ROOT" ] || DELIV_ROOT="$TDIR"   # R3 退化
  fi
  # 提交全部未跟踪项（排除 node_modules/.verify/prune 目标），而不是仅目录
  git -C "$TDIR" add -A -- . ':!node_modules' ':!.verify' 2>/dev/null
  # 交付物根相对 worktree 的路径（用于 Pages 目录名与 smoke 目标）
  DELIV_REL=$(cd "$TDIR" && python3 -c "
import os,sys
root=os.path.realpath(sys.argv[1]); wt=os.path.realpath('.')
rel=os.path.relpath(root, wt)
print('' if rel=='.' else rel)
" "$DELIV_ROOT" 2>/dev/null)
  [ -n "$DELIV_REL" ] || DELIV_REL="$DELIV_ROOT"
'''

if NEW.strip() in src:
    print("P1: 已是 v2，跳过"); sys.exit(0)
if OLD not in src:
    print("P1: !! 未找到预期的旧提取段，补丁中止（请人工核对第 87-89 行）", file=sys.stderr)
    sys.exit(3)

src = src.replace(OLD, NEW, 1)
open(path, "w", encoding="utf-8").write(src)
print("P1: 已替换提取段（v2 交付物根判定 + 全量 add）")
PYEOF

# ================================================================ 补丁 2：完整性门
# 现状：smoke 未过 => HOLD（仅日志）；无未跟踪产出 => 静默 SKIP。
# v2：把「已结束工单是否真正收口」做成显式门禁：
#   产物完整性（根有 index.html / smoke PASS / Pages URL 200）三项全绿才记为收口；
#   任一不满足 => 标记该工单交付【不完整】并通知，绝不静默跳过。
PATCH_GATE="$WORK/p2-gate.py"
cat > "$PATCH_GATE" <<'PYEOF'
"""在 sa-deliver.sh 的 smoke/HOLD 段插入收口完整性门（纯文本替换，幂等）。"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

OLD = '''  if [ "$SMOKE_OK" = "0" ]; then
    echo "$(date -Is) HOLD $TID smoke not passed; Pages sync skipped (code is on the agent branch)" >> "$LOG"
  fi
'''

NEW = '''  if [ "$SMOKE_OK" = "0" ]; then
    echo "$(date -Is) HOLD $TID smoke not passed; Pages sync skipped (code is on the agent branch)" >> "$LOG"
  fi
  # --- v2 收口完整性门（issue #39 D2）-------------------------------------
  # 三项机械校验：产物完整性 / smoke 通过 / Pages URL 可达。
  # 任一失败 => 记 INCOMPLETE 并写通知文件；绝不静默 SKIP（S5 缺口）。
  INCOMPLETE_REASON=""
  if [ -z "$DELIV_REL" ] && [ ! -f "$DELIV_ROOT/index.html" ]; then
    INCOMPLETE_REASON="artifact: no index.html at delivery root"
  fi
  [ -z "$INCOMPLETE_REASON" ] && [ "$SMOKE_OK" = "0" ] && INCOMPLETE_REASON="smoke: not passed"
  if [ -z "$INCOMPLETE_REASON" ] && [ "$CHANGED" = "1" ]; then
    VCODE=$(curl -s -o /dev/null -w "%{http_code}" -m 10 \\
      "$PAGES/apps/$(basename "$DELIV_ROOT")/index.html?v=$(date +%s)")
    [ "$VCODE" = "200" ] || INCOMPLETE_REASON="pages: apps/$(basename "$DELIV_ROOT") http=$VCODE"
  fi
  if [ -n "$INCOMPLETE_REASON" ]; then
    echo "$(date -Is) INCOMPLETE $TID reason=$INCOMPLETE_REASON" >> "$LOG"
    echo "$(date -Is) $TID $INCOMPLETE_REASON" >> "/home/qt/.dsh/deliver-incomplete.txt"
    : # v2 通知挂点：可在此调用操作员告警通道（IM/webhook）；默认只落盘
  else
    echo "$(date -Is) COMPLETE $TID root=$DELIV_REL smoke=pass pages=200" >> "$LOG"
  fi
'''

if NEW.strip() in src:
    print("P2: 已是 v2，跳过"); sys.exit(0)
if OLD not in src:
    print("P2: !! 未找到预期的 HOLD 段，补丁中止（请人工核对）", file=sys.stderr)
    sys.exit(3)

src = src.replace(OLD, NEW, 1)
open(path, "w", encoding="utf-8").write(src)
print("P2: 已插入收口完整性门（INCOMPLETE/COMPLETE 显式判定）")
PYEOF

# ================================================================ 补丁 3：身份修正
# 现状第 94 行提交邮箱 41816535+... 与工单交付身份不一致（G1）。
PATCH_IDENT="$WORK/p3-ident.py"
cat > "$PATCH_IDENT" <<'PYEOF'
"""修正 sa-deliver.sh 的提交身份，与工单交付身份一致（幂等）。"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

OLD = 'user.email="41816535+VBK-AI-Agent-Gateway@users.noreply.github.com"'
NEW = 'user.email="315771760+VBK-AI-Agent-Gateway@users.noreply.github.com"'

if OLD not in src:
    if NEW in src:
        print("P3: 身份已是 v2，跳过"); sys.exit(0)
    print("P3: !! 未找到旧提交邮箱，跳过", file=sys.stderr); sys.exit(0)

src = src.replace(OLD, NEW, 1)
open(path, "w", encoding="utf-8").write(src)
print("P3: 提交身份已修正为 315771760+VBK-AI-Agent-Gateway@users.noreply.github.com")
PYEOF

# ================================================================ 执行
say "== 生成补丁 =="
cp "$DELIVER" "$WORK/sa-deliver.sh.new"

for P in "$PATCH_EXTRACT" "$PATCH_GATE" "$PATCH_IDENT"; do
  OUT=$(python3 "$P" "$WORK/sa-deliver.sh.new" 2>&1); RC=$?
  say "  $OUT"
  [ "$RC" = "0" ] || { say "  !! 补丁失败（rc=$RC），未做任何改动。"; exit "$RC"; }
done

say ""
say "== 差异预览（旧 -> 新）=="
if command -v diff >/dev/null 2>&1; then
  diff -u "$DELIVER" "$WORK/sa-deliver.sh.new" | sed 's/^/  /' || true
fi

# scope.md 规则行
SCOPE_LINE='- 交付物放在一个顶层子目录下，目录名按 issue 规格命名（例如 `tri-c-closeout/`）；不要把多个顶层目录（css/、js/）拆成多个交付物。worktree 根即应用（根有 index.html）时由 sa-deliver v2 自动识别，无需额外目录。'
say ""
say "== scope.md 拟追加规则行 =="
say "  文件：$SCOPE"
if [ -f "$SCOPE" ] && grep -qF '交付物放在一个顶层子目录下' "$SCOPE"; then
  say "  （已存在该规则行，跳过）"
  SCOPE_DONE=1
else
  say "  + $SCOPE_LINE"
  SCOPE_DONE=0
fi

if [ "$MODE" = "apply" ]; then
  say ""
  say "== 应用 =="
  cp -p "$DELIVER" "$DELIVER.bak.$STAMP"
  say "  备份：$DELIVER.bak.$STAMP"
  cp "$WORK/sa-deliver.sh.new" "$DELIVER"
  chmod +x "$DELIVER"
  say "  已写入：$DELIVER"
  if [ "$SCOPE_DONE" = "0" ] && [ -f "$SCOPE" ]; then
    cp -p "$SCOPE" "$SCOPE.bak.$STAMP"
    printf '\n%s\n' "$SCOPE_LINE" >> "$SCOPE"
    say "  已追加规则行：$SCOPE（备份 $SCOPE.bak.$STAMP）"
  fi
  say ""
  say "  语法自检："
  sh -n "$DELIVER" && say "    sh -n OK" || say "    !! sh -n 失败 —— 请立即用 --revert $STAMP 回滚"
else
  say ""
  say "（DRY-RUN 结束：未写盘。确认无误后执行：sh $0 --apply）"
fi

say ""
say "== 回滚说明 =="
say "  sh $0 --revert $STAMP          # 用本次生成的 .bak 还原"
say "  手工：cp -p $DELIVER.bak.<ts> $DELIVER"
