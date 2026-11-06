#!/bin/sh
# 03-crm-vm.sh — VM 侧只读自审（issue #39 D1）
#
# 用途：在部署机（VM）上收集 issue #39 判定所需的客观证据，全部只读，不修改
# 任何文件、不调用任何写接口、不产生任何副作用。操作员逐行审阅本脚本后执行。
#
# 覆盖：
#   A. 工单 1603499d 的 89 分钟账本（轮数/时长拆分为 编码/自检/上游等待）
#   B. sa-deliver.sh 未跟踪提取逻辑的完整源码审计 + 场景缺口清单
#   C. scope.md 交付目录措辞现状
#   D. 1603499d / a6d02b40 在 sa-watchdog.log 与 sa-deliver.log 中的行
#
# 用法：sh 03-crm-vm.sh [输出目录]
#   默认输出到当前目录下的 03-crm-vm-out/（唯一写入位置，仅本脚本自建）。
#   加 --no-write 则完全不落盘，全部打印到 stdout。
#
# 约定：零敏感信息；不读取 token/凭据；不执行修复。

set -u

OUT="${1:-./03-crm-vm-out}"
NO_WRITE=0
[ "${1:-}" = "--no-write" ] && { OUT=""; NO_WRITE=1; }

BIN="${SA_BIN:-/home/qt/bin}"
DSH_HOME="${DSH_HOME:-/home/qt/.dsh}"
LOGS="${SA_LOGS:-/home/qt/logs}"
PLAYGROUND="${SA_PLAYGROUND:-/home/qt/src/superagent-playground}"

# scope.md 候选：dsh-superagent 为在跑团队提示词，dsh-sa-git 为旧副本。
SCOPE_CANDIDATES="${SCOPE_CANDIDATES:-/home/qt/src/dsh-superagent/prompts/team/scope.md /home/qt/src/dsh-sa-git/prompts/team/scope.md}"

say() { printf '%s\n' "$*"; }
hdr() { say ""; say "================================================================"; say "== $*"; say "================================================================"; }

# emit <文件名> —— 若启用落盘则同时 tee 到 $OUT/<文件名>
emit() {
  _f="$1"; shift
  if [ "$NO_WRITE" = "1" ]; then
    "$@"
  else
    mkdir -p "$OUT"
    "$@" | tee "$OUT/$_f"
  fi
}

# ---------------------------------------------------------------- 环境自述
hdr "0. 环境自述（只读）"
say "host=$(hostname 2>/dev/null) date=$(date -Is)"
say "sa-bin=$BIN  dsh-home=$DSH_HOME  logs=$LOGS"
say "playground=$PLAYGROUND"
say "输出目录=$([ "$NO_WRITE" = 1 ] && echo '（不落盘 --no-write）' || echo "$OUT")"

# ---------------------------------------------------------------- A. 账本
hdr "A. 工单 1603499d 的 89 分钟账本"

audit_ledger() {
  SESS_ROOT="$DSH_HOME/sessions"
  say "[A1] 会话目录：$SESS_ROOT"
  if [ ! -d "$SESS_ROOT" ]; then
    say "  !! 目录不存在，无法审计账本"
    return 0
  fi

  # 定位 worker-1603499d* 会话载荷。布局有两种：
  #   sessions/<slug>/worker-<tid>/session.v4.jsonl[.zstd]   （v4，目录形式）
  #   sessions/<slug>/worker-<tid>.jsonl[.zstd]              （扁平形式）
  FILES=$(find "$SESS_ROOT" -maxdepth 4 \
            \( -name 'worker-1603499d*.jsonl' -o -name 'worker-1603499d*.jsonl.zstd' \) 2>/dev/null | sort)
  if [ -z "$FILES" ]; then
    FILES=$(find "$SESS_ROOT" -maxdepth 4 -type d -name 'worker-1603499d*' 2>/dev/null \
              -exec find {} -maxdepth 1 -type f \( -name '*.jsonl' -o -name '*.jsonl.zstd' \) \; | sort)
  fi
  if [ -z "$FILES" ]; then
    say "  !! 未找到 worker-1603499d* 会话载荷；现有 worker 目录："
    find "$SESS_ROOT" -maxdepth 3 -type d -name 'worker-*' 2>/dev/null | head -20 | sed 's/^/     /'
    return 0
  fi
  say "  找到会话文件："
  printf '%s\n' "$FILES" | sed 's/^/     /'

  for F in $FILES; do
    say ""
    say "[A2] 解析 $F"
    case "$F" in
      *.zstd)
        if command -v zstd >/dev/null 2>&1; then
          READER="zstd -dc -- $F"
        else
          say "  !! 文件是 .zstd 但未安装 zstd，跳过（请安装 zstd 后重跑）"
          continue
        fi
        ;;
      *) READER="cat -- $F" ;;
    esac

    # 交给 python 做纯统计：轮数、每轮时长、工具分布、编码/自检/上游等待三分。
    eval "$READER" | python3 -c '
import json, sys, time

recs = []
for ln in sys.stdin:
    ln = ln.strip()
    if not ln:
        continue
    try:
        recs.append(json.loads(ln))
    except Exception:
        pass

def ts(ms):
    return time.strftime("%H:%M:%S", time.gmtime(ms / 1000.0))

steps = []          # 每个 step 一条
turn_start = None
turn_end = None
compactions = 0
stop_reason = None
tool_calls = []

for r in recs:
    t = r.get("type"); d = r.get("data", {}) or {}
    if t == "turn/start":
        turn_start = r["time"]
    elif t == "turn/end":
        turn_end = r["time"]; stop_reason = d.get("reason")
    elif t == "compaction/start":
        compactions += 1
    elif t == "step/start":
        steps.append({"turn": d.get("turn"), "step": d.get("step"),
                      "start": r["time"], "end": None, "tools": [], "text": 0})
    elif t == "step/end" and steps:
        steps[-1]["end"] = r["time"]
    elif t == "tool/call" and steps:
        nm = d.get("name") or d.get("toolName") or d.get("tool") or "?"
        steps[-1]["tools"].append(str(nm))
        tool_calls.append(str(nm))
    elif t == "assistant/message" and steps:
        msg = d.get("message", d)
        c = msg.get("content")
        if isinstance(c, list):
            for part in c:
                if part.get("type") == "text":
                    steps[-1]["text"] += len(part.get("text", ""))

def dur(s):
    return ((s["end"] or s["start"]) - s["start"]) / 1000.0

total = sum(dur(s) for s in steps)

# 三分归类：
#   编码  = 写类工具（write/edit/todo_write）
#   自检  = 验证类工具（bash 跑 smoke/test/node/curl，read 读代码复核）
#   上游等待 = 步骤间隙（上一步结束到本步开始），代表模型/上游服务等待
code_tools = {"write", "edit", "todo_write"}
verify_tools = {"read", "grep", "glob"}

def classify(s):
    names = set(s["tools"])
    if names & {"write", "edit"}:
        return "code"
    if "bash" in names:
        return "check"      # bash 既可能是自检也可能是探查，统一计入自检侧
    if names and names <= verify_tools:
        return "check"
    if not names:
        return "think"
    return "check"

buckets = {"code": 0.0, "check": 0.0, "think": 0.0}
for s in steps:
    buckets[classify(s)] += dur(s)

gaps = 0.0
for i in range(1, len(steps)):
    g = (steps[i]["start"] - (steps[i - 1]["end"] or steps[i - 1]["start"])) / 1000.0
    if g > 0:
        gaps += g

wall = ((turn_end or (steps[-1]["end"] or steps[-1]["start"])) - (turn_start or steps[0]["start"])) / 1000.0 if steps else 0

print("  轮/turn 数        : %d" % (len({s["turn"] for s in steps}) or 0))
print("  步/step 数        : %d" % len(steps))
print("  工具调用次数      : %d" % len(tool_calls))
print("  压缩次数(compaction): %d" % compactions)
print("  起止              : %s -> %s（墙钟 %.1f 分钟）" % (
    ts(turn_start or 0), ts(turn_end or 0), wall / 60.0))
print("  终止原因          : %s" % json.dumps(stop_reason, ensure_ascii=False))
print("")
print("  三分时长（步内累计 + 步间间隙）:")
print("    编码(写入代码)   : %7.1f s  (%4.1f%%)" % (buckets["code"], 100.0 * buckets["code"] / wall if wall else 0))
print("    自检/探查(bash/read): %7.1f s  (%4.1f%%)" % (buckets["check"], 100.0 * buckets["check"] / wall if wall else 0))
print("    纯思考(无工具步) : %7.1f s  (%4.1f%%)" % (buckets["think"], 100.0 * buckets["think"] / wall if wall else 0))
print("    步间间隙(上游等待): %7.1f s  (%4.1f%%)" % (gaps, 100.0 * gaps / wall if wall else 0))
print("")
print("  工具分布 top:")
from collections import Counter
for nm, n in Counter(tool_calls).most_common(12):
    print("    %-18s %d" % (nm, n))
print("")
print("  逐步骤明细（前 40 / 共 %d）:" % len(steps))
print("    step  turn  开始     时长s  工具")
for i, s in enumerate(steps[:40]):
    print("    %4d  %4s  %s %7.1f  %s" % (
        i + 1, s["turn"], ts(s["start"]), dur(s), ",".join(s["tools"])[:60]))
'
  done

  say ""
  say "[A3] 结论口径："
  say "  - 「编码」= write/edit 步骤；「自检」= bash/read/grep 步骤（code 审计与验证混合）；"
  say "  - 「上游等待」= 相邻步骤间隙（模型推理 + 服务往返），不含工具执行时间；"
  say "  - 工单 1603499d 于 02:20:01Z 被 sa-watchdog STOP（见 D 节），turn/end 原因应为 aborted/user。"
}

emit "A-ledger.txt" audit_ledger

# ---------------------------------------------------------------- B. sa-deliver 审计
hdr "B. sa-deliver.sh 未跟踪提取逻辑审计"

audit_deliver() {
  F="$BIN/sa-deliver.sh"
  say "[B1] 目标脚本：$F"
  if [ ! -f "$F" ]; then
    say "  !! 不存在"; return 0
  fi
  say "  行数=$(wc -l < "$F")  大小=$(wc -c < "$F")  mtime=$(date -Is -r "$F" 2>/dev/null)"
  say ""
  say "[B2] 提取逻辑相关行（源码原文，只读）："
  grep -n -E 'porcelain|grep|DELIV|untracked|top-level|sed|du -sb|cksum' "$F" | sed 's/^/  /'
  say ""
  say "[B3] 提取函数逐行摘录（第 75-100 行，含逐行编号）："
  sed -n '75,100p' "$F" | cat -n | sed 's/^/  /'
  say ""
  say "[B4] 场景缺口清单（对当前提取逻辑 \`git status --porcelain | grep '^?? ' | ... | grep \"/\\$\" | sed 's:/\\$::'\` 的判定）："
  cat <<'EOF'
  场景                         现逻辑行为                     期望行为（v2）
  ---------------------------- ------------------------------ ------------------------------
  S1 顶层文件（如 index.html）  被 grep "/$" 丢弃            => commit 该文件
     （ticket 1603499d 实际命中）
  S2 多个顶层目录（css/ js/）   被当作多个独立交付物          => 合并为「一个交付物」整体提交，
                                 分别 smoke => css/js 均      只在交付物根 smoke 一次
                                 "no index.html" => SMOKE FAIL
  S3 嵌套目录（a/b/index.html） 只取顶层目录 a/，smoke 传入   => 交付根=含 index.html 的
                                 a/ => 若无 index.html 失败     最浅目录，Pages 名取该目录
  S4 根即应用（index.html 就在  index.html 被丢弃；仅 css/js  => 判定 root-is-app：
     worktree 根）              作为交付物 => 全 FAIL          提交全部未跟踪项（含文件），
                                                                 Pages 名 = issue 规格目录名
                                                                 或 worktree 前缀
  S5 无未跟踪产出              SKIP（仅日志）                 => 收口完整性门：标记交付不完整
                                                                 并通知，绝不静默 SKIP
  S6 smoke 未过                 HOLD + 跳过 Pages（有日志）    => 保留 HOLD，但同时标记
                                                                 工单交付不完整并通知
  其它已知缺口：
   G1 提交邮箱为 41816535+... 与工单交付身份 315771760+VBK-AI-Agent-Gateway@... 不一致
   G2 交付目录名 = basename(目录)，未回退到 issue 规格目录名
   G3 state 去重键 SUM 基于 du -sb 汇总，新增/删除同尺寸文件可能碰撞（弱）
   G4 无「URL 可达」复验失败后的补救，仅 3 次重试后记 http 码
EOF
  say ""
  say "[B5] 现存备份（供操作员比对/回退）："
  ls -la "$BIN"/sa-deliver.sh* 2>/dev/null | sed 's/^/  /'
  say ""
  say "[B6] 定时/触发入口（只读）："
  (crontab -l 2>/dev/null | grep -n sa-deliver || echo "  crontab: 未发现 sa-deliver 条目")
  (systemctl list-timers 2>/dev/null | grep -i sa-deliver || echo "  systemd timers: 未发现 sa-deliver")
}

emit "B-sadeliver-audit.txt" audit_deliver

# ---------------------------------------------------------------- C. scope.md
hdr "C. scope.md 交付目录措辞现状"

audit_scope() {
  for P in $SCOPE_CANDIDATES; do
    say "[C] 候选：$P"
    if [ ! -f "$P" ]; then
      say "  （不存在）"; continue
    fi
    say "  行数=$(wc -l < "$P")  mtime=$(date -Is -r "$P" 2>/dev/null)"
    say "  交付目录/目录相关行："
    grep -n -iE 'director|目录|deliver|交付目录|顶层|subdir' "$P" | sed 's/^/    /' \
      || say "    （无匹配 —— 说明当前 scope.md 未规定交付目录形态，v2 需补一条规则行）"
    say ""
  done
  say "[C-结论] 判定哪个是操作点：在跑团队 = dsh-superagent/prompts/team/scope.md；"
  say "         dsh-sa-git 若存在则为旧副本（仅当两者都被加载时才需同步）。"
  say "         操作员据 mtime 与部署引用关系确认。"
}

emit "C-scope-wording.txt" audit_scope

# ---------------------------------------------------------------- D. 日志
hdr "D. 日志中的 1603499d / a6d02b40 行"

audit_logs() {
  for L in "$LOGS/sa-watchdog.log" "$LOGS/sa-deliver.log"; do
    say "[D] $L"
    if [ ! -f "$L" ]; then
      say "  （不存在）"; say ""; continue
    fi
    say "  总行数=$(wc -l < "$L")  mtime=$(date -Is -r "$L" 2>/dev/null)"
    say ""
    say "  --- 匹配 1603499d / a6d02b40 的行 ---"
    grep -nE '1603499d|a6d02b40' "$L" | sed 's/^/  /' || say "  （无匹配）"
    say ""
    say "  --- 关键事件摘要 ---"
    grep -nE '1603499d|a6d02b40' "$L" \
      | grep -E 'STOP|FLAG|ENDED|DELIVER|SMOKE|HOLD|SKIP|VERIFY|SYNC' \
      | sed 's/^/  /' || say "  （无关键事件）"
    say ""
  done
  say "[D-提示] sa-deliver.log 中 1603499d 的 SKIP 行自 02:27 起每 5 分钟重复 —— "
  say "         即 S5 缺口：无未跟踪产出时静默 SKIP，未标记交付不完整。"
}

emit "D-logs.txt" audit_logs

hdr "审计完成（只读，无副作用）"
say "输出：$([ "$NO_WRITE" = 1 ] && echo 'stdout' || echo "$OUT")"
