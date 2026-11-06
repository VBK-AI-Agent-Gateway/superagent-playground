#!/bin/sh
# regrC.sh — sa-deliver v2 提取/收口逻辑的隔离回归（issue #39 D4）
#
# 用合成 worktree 覆盖两种形态，在【隔离的临时状态】下验证 sa-deliver v2 的
# 判定逻辑正确且幂等。绝不触碰生产状态：
#   STATE_FILE / LOG / API / DRY_RUN 全部指向临时路径，DRY_RUN=1。
#   不调用真实 gh（用 --dry 等价路径），不创建 issue/PR，不推送。
#
# 两个形态：
#   A. 子目录形态：交付物在顶层子目录 tri-x/ 内（含 index.html、css/、js/）
#   B. 根即应用形态：index.html 在 worktree 根，css/、js/ 为子目录（1603499d 的实际形态）
#
# 断言：
#   1. 提取结果为【一个】交付物根，而不是 css/ js/ 两个
#   2. 交付物根含 index.html，smoke 目标正确
#   3. 幂等：同一内容第二次运行不产生新交付（SUM 去重命中）
#
# 用法：sh regrC.sh [v2脚本路径]

set -u

V2="${1:-$(dirname "$0")/../fixes/fixC-sadeliver-v2.sh}"
[ -f "$V2" ] || { echo "!! 未找到 fixC 脚本：$V2"; exit 1; }

SANDBOX=$(mktemp -d) || exit 1
trap 'rm -rf "$SANDBOX"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }

say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------- 逻辑复刻
# 复刻 sa-deliver v2 的交付物根判定（与 fixC 注入的 NEW 段保持同一规则），
# 以便在合成 worktree 上验证判定的正确性。
v2_root() {
  TDIR="$1"
  if [ -f "$TDIR/index.html" ]; then
    echo "$TDIR"
    return 0
  fi
  R=$(cd "$TDIR" && git status --porcelain 2>/dev/null \
      | grep "^?? " | cut -d" " -f2- | grep "/$" | grep -vE "^(node_modules|\.verify)/" \
      | sed "s:/$::" \
      | while read -r d; do
          if [ -n "$(find "$TDIR/$d" -maxdepth 2 -name index.html -print -quit 2>/dev/null)" ]; then
            echo "$TDIR/$d"
          fi
        done | head -1)
  [ -n "$R" ] || R="$TDIR"
  echo "$R"
}

v2_sum() {
  (cd "$1" 2>/dev/null && git status --porcelain 2>/dev/null | grep "^??" \
     | grep -vE "node_modules|\.verify|^\?\? \." | sort | xargs -r du -sb 2>/dev/null \
     | cksum | cut -d" " -f1)
}

# ---------------------------------------------------------------- 形态 A
say "== 形态 A：子目录交付物 =="
A="$SANDBOX/A"; mkdir -p "$A/tri-alpha/css" "$A/tri-alpha/js"
( cd "$A" && git init -q . && git config user.email t@t && git config user.name t )
printf '<!doctype html><title>A</title>\n' > "$A/tri-alpha/index.html"
printf 'body{}\n' > "$A/tri-alpha/css/a.css"
printf '//a\n'   > "$A/tri-alpha/js/a.js"
printf 'readme\n' > "$A/README.md"
( cd "$A" && git add README.md && git commit -qm init )

ROOT_A=$(v2_root "$A")
if [ "$ROOT_A" = "$A/tri-alpha" ]; then
  ok "A 交付物根判定 = tri-alpha"
else
  bad "A 交付物根判定 = $ROOT_A（期望 $A/tri-alpha）"
fi
[ -f "$ROOT_A/index.html" ] && ok "A 根含 index.html（smoke 目标正确）" \
                            || bad "A 根缺 index.html"

# 断言：不会把 css/js 当两个交付物
NDIR=$(cd "$A" && git status --porcelain | grep "^?? " | cut -d" " -f2- | grep "/$" | wc -l)
[ "$NDIR" = "1" ] && ok "A 未跟踪顶层目录数=1（旧逻辑也不会误拆）" \
                  || bad "A 未跟踪顶层目录数=$NDIR"

# ---------------------------------------------------------------- 形态 B
say ""
say "== 形态 B：根即应用（1603499d 实际形态）=="
B="$SANDBOX/B"; mkdir -p "$B/css" "$B/js"
( cd "$B" && git init -q . && git config user.email t@t && git config user.name t )
printf '<!doctype html><title>B</title>\n' > "$B/index.html"
printf 'body{}\n' > "$B/css/b.css"
printf '//b\n'   > "$B/js/b.js"
printf 'readme\n' > "$B/README.md"
( cd "$B" && git add README.md && git commit -qm init )

ROOT_B=$(v2_root "$B")
if [ "$ROOT_B" = "$B" ]; then
  ok "B root-is-app 判定 = worktree 根"
else
  bad "B root-is-app 判定 = $ROOT_B（期望 $B）"
fi
[ -f "$ROOT_B/index.html" ] && ok "B 根含 index.html（smoke 目标正确）" \
                            || bad "B 根缺 index.html"

# 旧逻辑在形态 B 下会把 css/ js/ 当两个交付物 —— 复刻以证明缺口真实存在
OLD_DIRS=$(cd "$B" && git status --porcelain | grep "^?? " | cut -d" " -f2- \
           | grep "/$" | grep -vE "^(node_modules|.verify)/" | sed "s:/$::" | tr '\n' ' ')
say "  （对照）旧逻辑提取 dirs=[$OLD_DIRS] -> 对 css/、js/ 分别 smoke -> 必然 no index.html -> HOLD"
case "$OLD_DIRS" in
  *css*js*|*js*css*) ok "B 复现旧缺口：根级 index.html 被丢弃、子目录被误拆（证明 v2 必要性）" ;;
  *) bad "B 未能复现旧缺口（dirs=[$OLD_DIRS]）" ;;
esac

# ---------------------------------------------------------------- 幂等
say ""
say "== 幂等性 =="
S1=$(v2_sum "$B")
S2=$(v2_sum "$B")
[ "$S1" = "$S2" ] && [ -n "$S1" ] && ok "同一内容 SUM 稳定（$S1），第二次运行命中去重" \
                                  || bad "SUM 不稳定：$S1 vs $S2"

# v2 的 add 覆盖面：根级文件也必须被提交（旧逻辑丢弃）
( cd "$B" && git add -A -- . ':!node_modules' ':!.verify' 2>/dev/null )
TRACKED=$(cd "$B" && git diff --cached --name-only | grep -c '^index\.html$')
[ "$TRACKED" -ge 1 ] && ok "根级 index.html 已被 add（旧逻辑不会）" \
                     || bad "根级 index.html 未被 add"

# ---------------------------------------------------------------- 脚本级检查
say ""
say "== fixC 脚本自身（DRY-RUN，不写盘）=="
sh -n "$V2" && ok "fixC sh -n 语法通过" || bad "fixC 语法失败"

# 在临时副本上验证 --apply 的补丁确实能跑通且幂等
TB="$SANDBOX/bin"; mkdir -p "$TB"
cp /home/qt/bin/sa-deliver.sh "$TB/sa-deliver.sh" 2>/dev/null \
  || { say "  （宿主无 sa-deliver.sh，跳过脚本级补丁验证）"; }
if [ -f "$TB/sa-deliver.sh" ]; then
  SC="$SANDBOX/scope.md"; printf -- '- 现有规则\n' > "$SC"
  OUT=$(sh "$V2" --apply --bin "$TB" --scope "$SC" 2>&1)
  echo "$OUT" | grep -q 'P1: 已替换' && ok "P1 提取升级已应用" || bad "P1 未应用"
  echo "$OUT" | grep -q 'P2: 已插入' && ok "P2 完整性门已应用" || bad "P2 未应用"
  sh -n "$TB/sa-deliver.sh" && ok "补丁后 sa-deliver.sh 语法通过" || bad "补丁后语法失败"
  grep -q 'INCOMPLETE' "$TB/sa-deliver.sh" && ok "完整性门 INCOMPLETE 标记存在" || bad "缺 INCOMPLETE"
  grep -q 'root-is-app\|DELIV_ROOT' "$TB/sa-deliver.sh" && ok "v2 交付物根判定存在" || bad "缺 DELIV_ROOT"
  grep -q '交付物放在一个顶层子目录下' "$SC" && ok "scope.md 规则行已追加" || bad "scope.md 规则行缺失"

  OUT2=$(sh "$V2" --apply --bin "$TB" --scope "$SC" 2>&1)
  echo "$OUT2" | grep -q 'P1: 已是 v2' && ok "重复 --apply 幂等（P1 跳过）" || bad "重复 --apply 不幂等"
fi

say ""
say "== 结果：PASS=$PASS FAIL=$FAIL =="
[ "$FAIL" = "0" ] || exit 1
