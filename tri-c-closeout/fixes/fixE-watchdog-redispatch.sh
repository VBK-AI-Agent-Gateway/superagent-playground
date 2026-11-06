#!/bin/sh
# fixE-watchdog-redispatch.sh — sa-watchdog STOP 后自动重派一次（issue #39 D3）
#
# 现状（问题）：sa-watchdog.sh 在工单空闲 900s 时 POST /stop 就结束了，
# 没有任何重派/升级路径 —— 工单被「停死」，需要人工发现并重新派发。
#
# v2 行为：
#   STOP 成功后，为该工单自动创建一份「重试」issue（正文含 retry-of=<原工单>），
#   由 .github/workflows/auto-trigger.yml 重新派发；状态文件把重试次数上限设为 1，
#   超过上限则升级给人类（写 escalate 记录），不再无限重试。
#
# 默认 DRY-RUN：只打印将要创建的 issue 正文，绝不调用 gh。
#   --apply   真正应用：先备份 sa-watchdog.sh 为 .bak.<ts>，再注入自动重派段。
#   --revert <ts>  用 .bak.<ts> 还原。
#
# 只改 /home/qt/bin/sa-watchdog.sh 一个文件；绝不动 preview/、.github/ 或其它应用目录。
#
# 用法：sh fixE-watchdog-redispatch.sh [--apply|--revert <ts>] [--bin DIR]

set -u

MODE="dry"
REVERT_TS=""
BIN="${SA_BIN:-/home/qt/bin}"
STAMP=$(date +%Y%m%d-%H%M%S)
REPO="${SA_REPO:-VBK-AI-Agent-Gateway/superagent-playground}"
GH="${GH:-/home/qt/.local/bin/gh-agent}"

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)  MODE="apply"; shift ;;
    --revert) MODE="revert"; REVERT_TS="${2:?--revert 需要时间戳}"; shift 2 ;;
    --bin)    BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（见 --help）" >&2; exit 2 ;;
  esac
done

WD="$BIN/sa-watchdog.sh"
WORK=$(mktemp -d) || exit 1
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*"; }

if [ "$MODE" = "revert" ]; then
  say "== 回滚 sa-watchdog.sh -> $WD.bak.$REVERT_TS"
  if [ -f "$WD.bak.$REVERT_TS" ]; then
    cp -p "$WD.bak.$REVERT_TS" "$WD" && say "  已还原：$WD"
  else
    say "  !! 无备份：$WD.bak.$REVERT_TS"; exit 1
  fi
  exit 0
fi

[ "$MODE" = "dry" ] && say "*** DRY-RUN（不调用 gh、不写盘）。加 --apply 才会应用。***"
[ -f "$WD" ] || { say "!! 未找到 $WD"; exit 1; }

say ""
say "目标：$WD（$(wc -l < "$WD") 行）"
say "重派仓库：$REPO   gh：$GH"
say "上限：每个工单最多自动重派 1 次，超出后升级给人类。"
say ""

# 注入的自动重派段：紧跟 STOP POST 之后。
# 原脚本相关结构（只读确认）：
#   TAG = "DRY-RUN STOP" if dry else "STOP"
#   ... POST api + "/tickets/" + tid + "/stop" ...
#   line("%s %s idle=%.0fs resp=%s" % (TAG, tid, idle, resp))
#   state.pop(tid, None)
# v2 在 state.pop 之后追加：读重试状态 -> 未超限则建 retry issue -> 否则升级。
PATCH="$WORK/p-redispatch.py"
cat > "$PATCH" <<'PYEOF'
"""在 sa-watchdog.sh 的 STOP 处理之后注入自动重派逻辑（幂等文本替换）。"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()

MARK = "# --- v2 自动重派（issue #39 D3）"

# 锚点必须唯一且落在 STOP 分支：用 STOP 专属上下文（ERROR stop 行 + 其后的
# state.pop）而不是裸 state.pop（裸锚点会被 active 分支的同名行抢先命中）。
OLD = '''    except Exception as e:
        line("ERROR stop %s failed: %s" % (tid[:12], e)); continue
    state.pop(tid, None)'''

NEW = '''    except Exception as e:
        line("ERROR stop %s failed: %s" % (tid[:12], e)); continue
    state.pop(tid, None)
    # --- v2 自动重派（issue #39 D3）-----------------------------------
    # STOP 后不留死工单：建一份 retry-of issue 触发一次重派；
    # 重试次数上限 1，超出写 escalate 并升级给人类。
    rfile = os.environ.get("REDISPATCH_STATE", "/home/qt/.dsh/watchdog-redispatch")
    try:
        rstate = json.load(open(rfile))
    except Exception:
        rstate = {}
    n = int(rstate.get(tid, 0))
    if n >= 1:
        line("ESCALATE %s retries=%d (>=1) -> human attention required" % (tid[:12], n))
        with open("/home/qt/.dsh/watchdog-escalate.txt", "a") as fh:
            fh.write("%s %s retries=%d\\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), tid, n))
    else:
        title = "retry: %s (watchdog redispatch)" % tid
        body = ("retry-of=%s\\n\\n" % tid) + \\
               ("watchdog stopped this ticket after 900s idle; auto-redispatch once.\\n"
                "Re-dispatch is capped at one attempt; further stops escalate to a human.\\n")
        gh = os.environ.get("GH_BIN", "/home/qt/.local/bin/gh-agent")
        repo = os.environ.get("REPO", "VBK-AI-Agent-Gateway/superagent-playground")
        tag = "DRY-RUN REDISPATCH" if dry else "REDISPATCH"
        if dry:
            line("%s %s would create issue in %s:\\n%s" % (tag, tid, repo, body))
        else:
            cmd = [gh, "issue", "create", "--repo", repo, "--title", title,
                   "--body", body]
            rc = subprocess.call(cmd, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
            line("%s %s rc=%d title=%s" % (tag, tid, rc, title))
            if rc == 0:
                rstate[tid] = n + 1
                json.dump(rstate, open(rfile, "w"))'''

if MARK in src:
    print("已注入自动重派段，跳过"); sys.exit(0)
# 锚点必须恰好出现一次，否则中止（防止注入到 active 分支）
cnt = src.count(OLD)
if cnt != 1:
    print("!! STOP 分支锚点出现 %d 次（期望 1），补丁中止（请人工核对）" % cnt,
          file=sys.stderr)
    sys.exit(3)

src = src.replace(OLD, NEW, 1)

# 确保 heredoc 内可用 json/subprocess/os/env（原脚本多半已 import；缺则补 import）
head_marker = "import json"
if "import subprocess" not in src:
    src = src.replace(head_marker, "import subprocess\nimport os\n" + head_marker, 1)
elif "import os" not in src:
    src = src.replace(head_marker, "import os\n" + head_marker, 1)

open(path, "w", encoding="utf-8").write(src)
print("已注入自动重派段（STOP -> retry issue -> 上限 1 -> 升级）")
PYEOF

cp "$WD" "$WORK/sa-watchdog.sh.new"
OUT=$(python3 "$PATCH" "$WORK/sa-watchdog.sh.new" 2>&1); RC=$?
say "== 补丁 =="
say "  $OUT"
[ "$RC" = "0" ] || { say "  !! 失败（rc=$RC），未做任何改动。"; exit "$RC"; }

say ""
say "== 差异预览 =="
diff -u "$WD" "$WORK/sa-watchdog.sh.new" | sed 's/^/  /' || true

say ""
say "== 重派 issue 正文模板（DRY-RUN 展示，不创建）=="
say "  title: retry: <ticket-id> (watchdog redispatch)"
say "  body : retry-of=<ticket-id>"
say "         watchdog stopped this ticket after 900s idle; auto-redispatch once."
say "         Re-dispatch is capped at one attempt; further stops escalate to a human."
say ""
say "== 状态文件 =="
say "  重试计数：/home/qt/.dsh/watchdog-redispatch   （{ticket: n}，n 上限 1）"
say "  升级记录：/home/qt/.dsh/watchdog-escalate.txt"
say "  原状态 ：/home/qt/.dsh/watchdog-state         （{first: ts}，不做重派去重）"

if [ "$MODE" = "apply" ]; then
  say ""
  say "== 应用 =="
  cp -p "$WD" "$WD.bak.$STAMP"
  say "  备份：$WD.bak.$STAMP"
  cp "$WORK/sa-watchdog.sh.new" "$WD"
  chmod +x "$WD"
  say "  已写入：$WD"
  sh -n "$WD" && say "  sh -n OK" || say "  !! sh -n 失败 —— 请用 --revert $STAMP 回滚"
else
  say ""
  say "（DRY-RUN 结束：未写盘。确认无误后执行：sh $0 --apply）"
fi

say ""
say "== 回滚说明 =="
say "  sh $0 --revert $STAMP"
say "  手工：cp -p $WD.bak.<ts> $WD"
