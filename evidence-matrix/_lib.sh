#!/usr/bin/env bash
# _lib.sh — 功能证据矩阵取证公共库（被 01-05 全部脚本 source 复用）
#
# 对应 issue #61。本库只读：不修改被检系统的任何文件、配置或进程状态。
# 中间产物只写入 $EM_OUT_DIR（默认 /tmp），由调用方决定是否保留。
#
# 提供能力（issue 交付物表要求）：
#   * PASS / WARN / FAIL / MANUAL 四类判定记录（MANUAL = 需人工回归）
#   * 每条外部命令的 timeout 保护（run_timed / run_capture）
#   * 脱敏函数：token / 密钥 / 手机号 / DeepInfra key（只留前 6 后 4）
#   * markdown 判定表 + JSON 双输出（不依赖 jq / python）
#   * 机器指纹与时间戳、矩阵条目号（1.1 / 2.14 …）与复跑命令记录
#
# 用法：
#   source "$(dirname "$0")/_lib.sh"
#   em_init "01" "G1 入口与多模态取证"
#   em_check "1.1" "TG 文字入口 + 多租户" FAIL "证据原文" "建议/复跑命令"
#   em_manual "1.4" "图片进 vision" "journal 无 photo 轮次，需真实发图回归"
#   em_finish

set -uo pipefail

EM_LIB_VERSION="1.0"

# ---------------------------------------------------------------------------
# 全局默认值
# ---------------------------------------------------------------------------
EM_SCRIPT_ID="${EM_SCRIPT_ID:-00}"
EM_SCRIPT_TITLE="${EM_SCRIPT_TITLE:-未命名取证脚本}"
EM_HOST_ROLE="${EM_HOST_ROLE:-EU}"          # EU | VM，用于报告抬头与条目归属
EM_JSON_MODE="${EM_JSON_MODE:-0}"
EM_TIMEOUT_DEFAULT="${EM_TIMEOUT_DEFAULT:-15}"   # 普通只读命令默认超时（秒）
EM_TIMEOUT_NET="${EM_TIMEOUT_NET:-30}"           # 出网命令默认超时（秒）
EM_TIMEOUT_CALL="${EM_TIMEOUT_CALL:-60}"         # 模型实call 默认超时（秒）
EM_OUT_DIR="${EM_OUT_DIR:-/tmp/evidence-matrix-$(date -u +%Y%m%dT%H%M%SZ)}"
EM_MACHINE_FP=""
EM_STARTED_AT=""
EM_TS=""
EM_HOOKS=()
EM_SELF="${EM_SELF:-$0}"

# 判定计数
EM_N_PASS=0
EM_N_FAIL=0
EM_N_WARN=0
EM_N_MANUAL=0
EM_N_INFO=0

# 结果行缓冲：字段用 US(0x1f) 分隔，避免证据里的竖线/空格破坏解析
EM_SEP=$'\037'
EM_ROWS=()
EM_NOTES=()

# ---------------------------------------------------------------------------
# 颜色：仅 tty 且非 JSON 模式启用
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ "${EM_JSON_MODE}" != "1" ] && [ -z "${NO_COLOR:-}" ]; then
  EM_C_PASS=$'\033[32m'; EM_C_FAIL=$'\033[31m'; EM_C_WARN=$'\033[33m'
  EM_C_MANUAL=$'\033[35m'; EM_C_INFO=$'\033[36m'; EM_C_DIM=$'\033[2m'; EM_C_OFF=$'\033[0m'
else
  EM_C_PASS=''; EM_C_FAIL=''; EM_C_WARN=''; EM_C_MANUAL=''; EM_C_INFO=''; EM_C_DIM=''; EM_C_OFF=''
fi

# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------

# JSON 字符串转义（不依赖 jq）
_em_json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/\\n}
  s=${s//$'\r'/\\r}
  s=${s//$'\t'/\\t}
  printf '%s' "$s"
}

# 去掉控制字符与前后空白，压成单行，供表格单元格使用
_em_cell() {
  local s=$1
  s=$(printf '%s' "$s" | tr -d '\000-\010\013\014\016-\037' | tr '\n\r\t' '   ')
  s=$(printf '%s' "$s" | sed -e 's/  */ /g' -e 's/^ //' -e 's/ $//')
  s=${s//|/\\|}     # markdown 表格里竖线必须转义，否则整行错列
  printf '%s' "$s"
}

_em_verdict_label() {
  case "$1" in
    PASS)   printf 'PASS 通过' ;;
    FAIL)   printf 'FAIL 不通过' ;;
    WARN)   printf 'WARN 警告' ;;
    MANUAL) printf '需人工回归' ;;
    *)      printf 'INFO 信息' ;;
  esac
}

# ---------------------------------------------------------------------------
# 脱敏（issue 铁律 4：token/密钥/手机号一律脱敏，只留前 6 后 4）
# ---------------------------------------------------------------------------

# em_mask <字符串> [前缀长度] [后缀长度] —— 只留前 6 后 4，中间用 **** 占位。
# 长度不足或为空时返回 <redacted>，绝不原样透出。
em_mask() {
  local s=${1:-} pre=${2:-6} suf=${3:-4} n len
  [ -z "$s" ] && { printf '<redacted>'; return 0; }
  n=$(printf '%s' "$s" | wc -c | tr -d ' ')
  len=$((pre + suf))
  if [ "$n" -le "$len" ]; then printf '<redacted:%s>' "$n"; return 0; fi
  printf '%s****%s' "${s:0:pre}" "${s: -$suf}"
}

# em_mask_text <自由文本> —— 对整段文本做脱敏：
#   1) sk-/key=/token=/Bearer/密码 形态的密钥
#   2) 中国大陆手机号 1[3-9]\d{9}
#   3) 常见 key 名（deepinfra_stt 等只读取值）后跟的 32+ 长串
# 位置：命令替换 + sed，无外部依赖（sed 是最小公约数）。
em_mask_text() {
  local s=${1:-}
  [ -z "$s" ] && { printf ''; return 0; }
  s=$(printf '%s' "$s" | sed -E \
    -e 's#(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{6,}#\1****#g' \
    -e 's#(([Tt]oken|[Ss]ecret|[Aa]pi[_-]?[Kk]ey|[Pp]assword|passwd)[[:space:]]*[=:][[:space:]]*)[^[:space:]"'"'"',;]{6,}#\1<redacted>#g' \
    -e 's#(Bearer[[:space:]]+[A-Za-z0-9._-]{4})[A-Za-z0-9._-]{6,}#\1****#g' \
    -e 's#(1[3-9])[0-9]{4}([0-9]{4})#\1****\2#g' \
    -e 's#([A-Za-z0-9_-]*(_key|_token|_secret))(=|:)[[:space:]]*[A-Za-z0-9+/=_-]{16,}#\1\2<redacted>#g' )
  printf '%s' "$s"
}

# em_mask_jsonl <文件> [行数] —— 读取 jsonl 尾部若干行并整体脱敏（审计样本用）
em_mask_jsonl() {
  local f=$1 n=${2:-3}
  [ -r "$f" ] || { printf ''; return 0; }
  em_mask_text "$(run_capture "$EM_TIMEOUT_DEFAULT" tail -n "$n" "$f" 2>/dev/null || true)"
}

# ---------------------------------------------------------------------------
# 机器指纹：hostname + machine-id + 内核 + 首个非 lo MAC
# ---------------------------------------------------------------------------
em_fingerprint() {
  [ -n "${EM_MACHINE_FP}" ] && { printf '%s' "${EM_MACHINE_FP}"; return 0; }
  local host mid kern mac raw
  host=$(run_capture 5 hostname 2>/dev/null || printf 'unknown')
  mid=$(run_capture 5 sh -c 'cat /etc/machine-id 2>/dev/null | head -c 32' 2>/dev/null)
  [ -z "$mid" ] && mid=$(run_capture 5 sh -c 'cat /var/lib/dbus/machine-id 2>/dev/null | head -c 32' 2>/dev/null)
  kern=$(run_capture 5 uname -r 2>/dev/null)
  mac=$(run_capture 5 sh -c "cat /sys/class/net/*/address 2>/dev/null | grep -v '^00:00:00:00:00:00$' | head -1" 2>/dev/null)
  [ -z "$mac" ] && mac="no-mac"
  raw="${host}|${mid}|${kern}|${mac}"
  EM_MACHINE_FP="$(printf '%s' "$raw" | sha256sum | cut -c1-16)"
  printf '%s' "${EM_MACHINE_FP}"
}

em_fingerprint_human() {
  printf 'host=%s machine-id=%s kernel=%s' \
    "$(run_capture 5 hostname 2>/dev/null)" \
    "$(run_capture 5 sh -c 'cat /etc/machine-id 2>/dev/null | head -c 12' 2>/dev/null)" \
    "$(run_capture 5 uname -r 2>/dev/null)"
}

# ---------------------------------------------------------------------------
# 超时保护执行器（所有外部/IO 命令必须走这里）
# ---------------------------------------------------------------------------

# run_timed <秒> <命令...> —— 原样执行，stdout/stderr 直通。超时返回 124。
run_timed() {
  local t=$1; shift
  timeout --signal=TERM --kill-after=3s "$t" "$@" 2>/dev/null
}

# run_capture <秒> <命令...> —— 捕获 stdout（不含 stderr），供赋值使用。
run_capture() {
  local t=$1; shift
  timeout --signal=TERM --kill-after=3s "$t" "$@" 2>/dev/null || true
}

# run_capture_err <秒> <命令...> —— 同时捕获 stderr。
run_capture_err() {
  local t=$1; shift
  timeout --signal=TERM --kill-after=3s "$t" "$@" 2>&1 || true
}

# em_have <命令> —— 依赖探测；缺工具时脚本记 WARN 而非崩
em_have() { command -v "$1" >/dev/null 2>&1; }

# em_docker_exec <秒> <容器> <命令...> —— 只读容器内执行（禁止任何写/重启类命令）
em_docker_exec() {
  local t=$1 c=$2; shift 2
  run_capture "$t" docker exec "$c" "$@" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# 判定记录
# ---------------------------------------------------------------------------

# em_check <条目号> <检查名> <判定> <证据原文> <备注/复跑命令>
#   判定: PASS|FAIL|WARN|INFO   （需人工回归请用 em_manual）
em_check() {
  local item=$1 name=$2 verdict=$3 evidence=${4:-} advice=${5:-}
  case "$verdict" in
    PASS) EM_N_PASS=$((EM_N_PASS+1)) ;;
    FAIL) EM_N_FAIL=$((EM_N_FAIL+1)) ;;
    WARN) EM_N_WARN=$((EM_N_WARN+1)) ;;
    MANUAL) EM_N_MANUAL=$((EM_N_MANUAL+1)) ;;
    *)    verdict=INFO; EM_N_INFO=$((EM_N_INFO+1)) ;;
  esac
  EM_ROWS+=("${item}${EM_SEP}${name}${EM_SEP}${verdict}${EM_SEP}${evidence}${EM_SEP}${advice}")
  if [ "${EM_JSON_MODE}" != "1" ]; then
    local col
    case "$verdict" in
      PASS) col="${EM_C_PASS}" ;; FAIL) col="${EM_C_FAIL}" ;;
      WARN) col="${EM_C_WARN}" ;; MANUAL) col="${EM_C_MANUAL}" ;; *) col="${EM_C_INFO}" ;;
    esac
    printf '  %s[%s]%s %-6s %s | %s\n' "$col" "$item" "$EM_C_OFF" "$verdict" "$name" "$(_em_cell "$evidence")" >&2
    [ -n "$advice" ] && printf '        %s备注:%s %s\n' "$EM_C_DIM" "$EM_C_OFF" "$(_em_cell "$advice")" >&2
  fi
}

# em_manual <条目号> <检查名> <原因> —— 机器无法取证、必须真实 TG 人工回归的项
em_manual() {
  em_check "${1}" "${2}" MANUAL "${3}" "需人工：真实 TG 发一条并回填本行证据"
}

# em_info / em_warn 便捷包装
em_info() { em_check "$1" "$2" INFO "$3" "${4:-}"; }
em_warn() { em_check "$1" "$2" WARN "$3" "${4:-}"; }

# em_raw <秒> <标题> <命令...> —— 打印一段命令的原始输出（已整体脱敏），
# 供回贴时提供"证据原文摘录"。输出到 stdout（markdown 代码块）。
em_raw() {
  local t=$1 title=$2; shift 2
  local out
  out=$(run_capture_err "$t" "$@" 2>/dev/null || true)
  out=$(em_mask_text "$out")
  [ "${EM_JSON_MODE}" = "1" ] && return 0
  printf '```\n$ %s\n%s\n```\n\n' "$title" "${out:-<无输出>}"
}

# em_section <标题> —— markdown 分节（JSON 模式静默）
em_section() {
  [ "${EM_JSON_MODE}" = "1" ] && return 0
  printf '\n### %s\n\n' "$1"
}

# em_cmd <条目号> <复跑命令> —— 记录该条目的单命令复跑方式
em_cmd() { EM_CMDS+=("$1${EM_SEP}$2"); }

# em_note <自由文本> —— 追加到"补充说明"
em_note() { EM_NOTES+=("$1"); }

EM_CMDS=()

# ---------------------------------------------------------------------------
# 生命周期
# ---------------------------------------------------------------------------
em_init() {
  EM_SCRIPT_ID="${1:-$EM_SCRIPT_ID}"
  EM_SCRIPT_TITLE="${2:-$EM_SCRIPT_TITLE}"
  EM_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  EM_TS=$(date -u +%Y%m%dT%H%M%SZ)
  em_fingerprint >/dev/null
}

em_on_exit() { EM_HOOKS+=("$1"); }

_em_run_hooks() {
  local h
  for h in "${EM_HOOKS[@]:-}"; do
    [ -n "$h" ] && eval "$h" >/dev/null 2>&1 || true
  done
}

# ---------------------------------------------------------------------------
# 输出：markdown
# ---------------------------------------------------------------------------
em_render_markdown() {
  local ended dur
  ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  dur=$(( $(date -u +%s) - $(date -u -d "$EM_STARTED_AT" +%s 2>/dev/null || date -u +%s) ))

  printf '## [%s] %s（%s 侧）\n\n' "$EM_SCRIPT_ID" "$EM_SCRIPT_TITLE" "$EM_HOST_ROLE"
  printf -- '- 脚本: `%s`\n' "$(basename "${EM_SELF:-$0}")"
  printf -- '- 机器指纹: `%s`（%s）\n' "$(em_fingerprint)" "$(em_fingerprint_human)"
  printf -- '- 开始(UTC): `%s`　结束(UTC): `%s`　耗时: `%ss`\n' "$EM_STARTED_AT" "$ended" "$dur"
  printf -- '- 汇总: **PASS %d / FAIL %d / WARN %d / 需人工 %d / INFO %d**\n\n' \
    "$EM_N_PASS" "$EM_N_FAIL" "$EM_N_WARN" "$EM_N_MANUAL" "$EM_N_INFO"

  printf '| 条目 | 检查项 | 判定 | 证据原文摘录 | 采集时间(UTC) |\n'
  printf '|---|---|---|---|---|\n'
  local r item name verdict evidence advice
  if [ "${#EM_ROWS[@]}" -gt 0 ]; then
    for r in "${EM_ROWS[@]}"; do
      IFS="$EM_SEP" read -r item name verdict evidence advice <<<"$r"
      printf '| %s | %s | %s | %s | %s |\n' \
        "$item" "$(_em_cell "$name")" "$(_em_verdict_label "$verdict")" \
        "$(_em_cell "$evidence")" "$ended"
    done
    printf '\n'
  else
    printf '| - | _本脚本未产生判定行（可能缺少依赖或目标不存在）_ | - | - | %s |\n\n' "$ended"
  fi

  if [ "${#EM_CMDS[@]}" -gt 0 ]; then
    printf '#### 单条目复跑命令\n\n```bash\n'
    local c
    for c in "${EM_CMDS[@]}"; do
      IFS="$EM_SEP" read -r item name <<<"$c"
      printf '# %s\n%s\n' "$item" "$name"
    done
    printf '```\n\n'
  fi

  if [ "${#EM_NOTES[@]}" -gt 0 ]; then
    printf '#### 补充说明\n\n'
    local n
    for n in "${EM_NOTES[@]}"; do printf -- '- %s\n' "$n"; done
    printf '\n'
  fi

  printf '> 本输出为只读取证结果：未对被检系统做任何写入、重启或配置变更。\n\n'
}

# ---------------------------------------------------------------------------
# 输出：JSON（不依赖 jq）
# ---------------------------------------------------------------------------
_em_overall() {
  if [ "$EM_N_FAIL" -gt 0 ]; then printf 'FAIL'
  elif [ "$EM_N_WARN" -gt 0 ]; then printf 'WARN'
  elif [ "$EM_N_MANUAL" -gt 0 ]; then printf 'MANUAL'
  else printf 'PASS'; fi
}

em_render_json() {
  local ended dur
  ended=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  dur=$(( $(date -u +%s) - $(date -u -d "$EM_STARTED_AT" +%s 2>/dev/null || date -u +%s) ))

  printf '{\n'
  printf '  "script_id": "%s",\n' "$(_em_json_escape "$EM_SCRIPT_ID")"
  printf '  "script_title": "%s",\n' "$(_em_json_escape "$EM_SCRIPT_TITLE")"
  printf '  "script_file": "%s",\n' "$(_em_json_escape "$(basename "${EM_SELF:-$0}")")"
  printf '  "host_role": "%s",\n' "$(_em_json_escape "$EM_HOST_ROLE")"
  printf '  "lib_version": "%s",\n' "$EM_LIB_VERSION"
  printf '  "machine_fingerprint": "%s",\n' "$(_em_json_escape "$(em_fingerprint)")"
  printf '  "hostname": "%s",\n' "$(_em_json_escape "$(run_capture 5 hostname)")"
  printf '  "kernel": "%s",\n' "$(_em_json_escape "$(run_capture 5 uname -r)")"
  printf '  "started_at": "%s",\n' "$EM_STARTED_AT"
  printf '  "ended_at": "%s",\n' "$ended"
  printf '  "duration_seconds": %s,\n' "$dur"
  printf '  "summary": { "pass": %d, "fail": %d, "warn": %d, "manual": %d, "info": %d },\n' \
    "$EM_N_PASS" "$EM_N_FAIL" "$EM_N_WARN" "$EM_N_MANUAL" "$EM_N_INFO"
  printf '  "verdict": "%s",\n' "$(_em_overall)"
  printf '  "checks": [\n'
  local r item name verdict evidence advice first=1
  for r in "${EM_ROWS[@]:-}"; do
    [ -z "$r" ] && continue
    IFS="$EM_SEP" read -r item name verdict evidence advice <<<"$r"
    [ "$first" = "0" ] && printf ',\n'
    first=0
    printf '    { "item": "%s", "name": "%s", "verdict": "%s", "evidence": "%s", "advice": "%s", "collected_at": "%s" }' \
      "$(_em_json_escape "$item")" "$(_em_json_escape "$name")" "$(_em_json_escape "$verdict")" \
      "$(_em_json_escape "$evidence")" "$(_em_json_escape "$advice")" "$ended"
  done
  [ "$first" = "0" ] && printf '\n'
  printf '  ],\n'
  printf '  "notes": [\n'
  local n nfirst=1
  for n in "${EM_NOTES[@]:-}"; do
    [ -z "$n" ] && continue
    [ "$nfirst" = "0" ] && printf ',\n'
    nfirst=0
    printf '    "%s"' "$(_em_json_escape "$n")"
  done
  [ "$nfirst" = "0" ] && printf '\n'
  printf '  ]\n'
  printf '}\n'
}

# em_finish —— 收尾并输出。退出码：FAIL=1 / WARN=2 / MANUAL=3 / PASS=0（便于巡检直接判）
em_finish() {
  if [ "${EM_JSON_MODE}" = "1" ]; then
    em_render_json
  else
    em_render_markdown
  fi
  _em_run_hooks
  case "$(_em_overall)" in
    FAIL) return 1 ;; WARN) return 2 ;; MANUAL) return 3 ;; *) return 0 ;;
  esac
}

# em_parse_args —— 统一解析 --json / --out-dir / --help
EM_EXTRA_ARGS=()
EM_SHOW_HELP=0
em_parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) EM_JSON_MODE=1 ;;
      --out-dir) shift; EM_OUT_DIR="${1:-$EM_OUT_DIR}" ;;
      -h|--help) EM_SHOW_HELP=1 ;;
      *) EM_EXTRA_ARGS+=("$1") ;;
    esac
    shift || true
  done
  mkdir -p "$EM_OUT_DIR" 2>/dev/null || true
}

# em_usage_header <脚本名> <说明> —— 统一 --help（写 stderr，绝不污染 stdout 的 md/JSON）
em_usage_header() {
  printf '%s —— %s\n\n用法: %s [--json] [--out-dir DIR]\n\n' "$1" "$2" "$1" >&2
  printf '  --json        输出机器可读 JSON（默认输出 markdown 判定表）\n' >&2
  printf '  --out-dir DIR 中间产物目录（默认 %s）\n' "$EM_OUT_DIR" >&2
  printf '\n本脚本只读取证：不修改被检系统的任何文件、配置或进程状态；\n' >&2
  printf '出网命令仅 issue #61 允许的两类实call（DeepInfra / 本机 8888 模型池），均带 timeout。\n' >&2
}

# em_tmpfile <后缀> —— 中间产物落盘路径（只写 $EM_OUT_DIR，绝不碰被检系统）
em_tmpfile() {
  mkdir -p "$EM_OUT_DIR" 2>/dev/null || true
  printf '%s/%s-%s-%s' "$EM_OUT_DIR" "$EM_SCRIPT_ID" "$EM_TS" "$1"
}
