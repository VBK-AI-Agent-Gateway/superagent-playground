#!/usr/bin/env bash
# 02-residual.sh — 历史残留文件干扰：只读根因诊断（issue #38 / 故障修复 B）
#
# 用途：操作员在 EU（生产/近生产环境）以只读方式执行，采集"历史残留文件干扰"
#       根因证据。全程零写入、零 secret、防御式 timeout，目标 <90s 完成。
#
# 用法：
#   bash 02-residual.sh                 # 默认：top3 租户，标准项
#   TOPN=5 bash 02-residual.sh          # 覆盖租户数量
#   TENANT_ROOT=/srv/tenants bash 02-residual.sh
#   ACTIVE_TENANT=<sid> bash 02-residual.sh   # 指定 /ws 活跃租户
#   SKIP_LEDGER=1 bash 02-residual.sh         # 跳过 ledger.db（无 bun/sqlite 时）
#
# 安全约束（硬性）：
#   * 本脚本绝不对被测主机做任何写操作：无 >、无 tee、无 mkdir、无 rm、无 touch。
#   * 不读取/不打印任何密钥文件内容；/etc/wagate.env 只做开关名 grep（值不落盘）。
#   * 所有外部命令经 `run()` 包裹 timeout，单点卡死不影响整体。
#   * 探测不到的东西明确打印 "(未探测到)"，不编造结论。
#
# 退出码：0 正常；2 用法/环境错误。诊断发现本身不改变退出码（只读报告）。

set -uo pipefail

# ---- 配置（全部可用环境变量覆盖） -----------------------------------------
TENANT_ROOT="${TENANT_ROOT:-/srv/tenants}"
TOPN="${TOPN:-3}"
ACTIVE_TENANT="${ACTIVE_TENANT:-}"
LEDGER_DB="${LEDGER_DB:-}"
WAGATE_ENV="${WAGATE_ENV:-/etc/wagate.env}"
SESSIONS_DIR="${SESSIONS_DIR:-}"
SESSIONS_BACKUP_DIR="${SESSIONS_BACKUP_DIR:-}"
WS_ROOT="${WS_ROOT:-}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/nginx.conf}"
STALE_SECONDS="${STALE_SECONDS:-3600}"        # >1h 视为"旧文件"
T_FAST="${T_FAST:-5}"                         # 快速只读命令超时
T_MED="${T_MED:-12}"                          # 中等扫描超时
T_SQLITE="${T_SQLITE:-15}"                    # ledger 查询超时
SKIP_LEDGER="${SKIP_LEDGER:-0}"

# 门禁开关（issue #38 §2.5 指定的五个）
GATE_KEYS="FALLBACK_EXCLUDE_UPLOADS|WAGATE_LOCAL_FRESH_OFF|DELIVER_REQUIRE_LOCAL|WAGATE_LOCAL_ONLY|SBX_VERIFY"

now_epoch() { date +%s; }
START_TS="$(now_epoch)"

# ---- 防御式执行 -----------------------------------------------------------
# run <timeout秒> <描述> <命令...>：超时/非零都降级为一行提示，不中断脚本。
run() {
  local t="$1"; shift
  local desc="$1"; shift
  local out rc
  out="$(timeout "$t" "$@" 2>&1)"; rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    printf '  [超时 %ss] %s\n' "$t" "$desc"
  elif [ "$rc" -ne 0 ]; then
    printf '  [失败 rc=%s] %s\n' "$rc" "$desc"
    [ -n "$out" ] && printf '%s\n' "$out" | head -n 5 | sed 's/^/    /'
  else
    printf '%s\n' "$out"
  fi
  return 0
}

hr() { printf '%s\n' "------------------------------------------------------------------------"; }
sec() { printf '\n===== %s =====\n' "$1"; }

# 可读目录判定（不写、不建）
have_dir() { [ -d "$1" ] && [ -r "$1" ]; }

# 目录字节大小（du 只读）
dir_size_h()  { timeout "$T_MED" du -sh "$1" 2>/dev/null | awk '{print $1}'; }
dir_size_b()  { timeout "$T_MED" du -sb "$1" 2>/dev/null | awk '{print $1}'; }

# 单文件 mtime（ISO）+ 大小
file_mtime() { timeout "$T_FAST" date -r "$1" '+%Y-%m-%dT%H:%M:%S%z' 2>/dev/null || echo "?"; }

# 距今天数
age_days() {
  local m; m="$(timeout "$T_FAST" stat -c %Y "$1" 2>/dev/null)" || { echo "?"; return; }
  echo $(( ( $(now_epoch) - m ) / 86400 ))
}

# 顶层文件清单：大小 + mtime + 年龄（天），按 mtime 升序（旧的在前）
list_top() {
  local d="$1" limit="${2:-40}" n=0
  if ! have_dir "$d"; then printf '  (目录不存在/不可读: %s)\n' "$d"; return; fi
  local count
  count="$(timeout "$T_FAST" find "$d" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
  printf '  路径: %s  (顶层条目 %s, 总大小 %s)\n' "$d" "${count:-?}" "$(dir_size_h "$d")"
  # 旧文件优先，便于一眼看到"历史残留"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    n=$((n+1))
    [ "$n" -gt "$limit" ] && { printf '  ... 省略其余（--limit %s）\n' "$limit"; break; }
    local sz mt ad
    sz="$(timeout "$T_FAST" du -h "$f" 2>/dev/null | awk '{print $1}')"
    mt="$(file_mtime "$f")"
    ad="$(age_days "$f")"
    printf '    %-10s %-24s age=%-5s %s\n' "${sz:-?}" "${mt}" "${ad}d" "$(basename "$f")"
  done < <(timeout "$T_MED" find "$d" -mindepth 1 -maxdepth 1 -printf '%T@ %p\n' 2>/dev/null \
             | sort -n | awk '{ $1=""; sub(/^ /,""); print }')
}

# ---- 结论表记分板（各探测项写入，最后统一渲染） ---------------------------
declare -A VERDICT=()
declare -A EVID=()
verdict() { VERDICT["$1"]="$2"; EVID["$1"]="${3:-}"; }

echo "故障修复 B — 历史残留文件干扰 只读诊断"
echo "生成时间: $(date '+%Y-%m-%dT%H:%M:%S%z')  主机: $(timeout "$T_FAST" hostname 2>/dev/null || echo '?')"
echo "租户根: ${TENANT_ROOT}  TOPN=${TOPN}  旧文件阈值: >${STALE_SECONDS}s (${STALE_SECONDS}s)"
echo "本次运行全程只读，未对被测主机做任何写操作。"

# =========================================================================
# 0. 环境与门禁开关核对（对应 issue §2.5）
# =========================================================================
sec "0. 门禁配置核对 (grep -E '${GATE_KEYS}' ${WAGATE_ENV})"
if [ -r "$WAGATE_ENV" ]; then
  # 只输出"开关名 + 是否设置"，不打印值，避免 secret 泄漏
  while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    # 掩码：只显示是否为空/是否 0/1，其余值一律 <nonempty>
    case "$val" in
      "")  shown="<空>" ;;
      0|1) shown="$val" ;;
      *)   shown="<已设置,长度${#val}>" ;;
    esac
    printf '  %-28s = %s\n' "$key" "$shown"
  done < <(timeout "$T_FAST" grep -E "^[[:space:]]*(${GATE_KEYS})[[:space:]]*=" "$WAGATE_ENV" 2>/dev/null)
  n_set="$(timeout "$T_FAST" grep -cE "^[[:space:]]*(${GATE_KEYS})[[:space:]]*=" "$WAGATE_ENV" 2>/dev/null || echo 0)"
  printf '  命中开关数: %s / 5\n' "$n_set"
  case "$n_set" in
    0) verdict "门禁开关(5项)" "无证据" "wagate.env 中未命中任何开关，可能路径不同或未部署" ;;
    *) verdict "门禁开关(5项)" "open" "命中 ${n_set} 项；新鲜度/排除上传是否长期有效需结合 §1 旧文件年龄判断" ;;
  esac
else
  printf '  (不可读: %s)\n' "$WAGATE_ENV"
  verdict "门禁开关(5项)" "无证据" "$WAGATE_ENV 不可读"
fi

# =========================================================================
# 1. 租户 top3（按大小）workspace/uploads/deliveries 清单 + ledger 映射
# =========================================================================
sec "1. 租户 top${TOPN} 目录清单与 ledger 任务→文件映射"
if ! have_dir "$TENANT_ROOT"; then
  printf '  (租户根不可读: %s)\n' "$TENANT_ROOT"
  verdict "uploads 平铺可见" "无证据" "租户根不可读，无法取证"
  verdict "tmpfs 永久记账" "无证据" "租户根不可读，无法取证"
  TOP_TENANTS=""
else
  TOP_TENANTS="$(timeout "$T_MED" du -sb "${TENANT_ROOT}"/* 2>/dev/null \
                    | sort -rn | head -n "$TOPN" | awk '{print $2}')"
  if [ -z "$TOP_TENANTS" ]; then
    printf '  (%s 下没有子目录)\n' "$TENANT_ROOT"
    TOP_TENANTS=""
  fi

  STALE_HITS=0
  for t in $TOP_TENANTS; do
    hr
    printf '租户: %s\n' "$(basename "$t")"
    for sub in workspace uploads deliveries; do
      list_top "$t/$sub" 25
    done
    # 统计该租户活跃视图中 >1h 的文件数（机械门要拦的量）
    old_n="$(timeout "$T_MED" find "$t/workspace" "$t/uploads" -type f -mmin "+$((STALE_SECONDS/60))" 2>/dev/null | wc -l | tr -d ' ')"
    all_n="$(timeout "$T_MED" find "$t/workspace" "$t/uploads" -type f 2>/dev/null | wc -l | tr -d ' ')"
    printf '  >> >%ss 旧文件: %s / 总文件 %s\n' "$STALE_SECONDS" "${old_n:-?}" "${all_n:-?}"
    case "${old_n:-0}" in ''|0) ;; *) STALE_HITS=$((STALE_HITS + 1)) ;; esac
  done

  # 兜底：确认建议的 DB 路径
  if [ -z "$LEDGER_DB" ]; then
    for cand in "$TENANT_ROOT/ledger.db" /srv/wagate/ledger.db /srv/wagate/data/ledger.db; do
      [ -f "$cand" ] && { LEDGER_DB="$cand"; break; }
    done
  fi

  hr
  printf 'ledger.db 只读任务→文件映射 (DB=%s)\n' "${LEDGER_DB:-(未探测到)}"
  if [ -n "$LEDGER_DB" ] && [ -r "$LEDGER_DB" ] && [ "$SKIP_LEDGER" != "1" ]; then
    # 只读打开：file:...?mode=ro&immutable=1 —— 绝不写、不加锁。
    RO_URI="file:${LEDGER_DB}?mode=ro"
    q() { run "$T_SQLITE" "sqlite(只读): $1" bun -e '
      const {Database} = require("bun:sqlite");
      const db = new Database(process.argv[1], {readonly: true});
      try { const rows = db.query(process.argv[2]).all();
            for (const r of rows) console.log(JSON.stringify(r)); }
      finally { db.close(); }
    ' "$RO_URI" "$1"; }

    printf '  -- 表结构 --\n'
    q "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

    printf '  -- 任务时间点→文件→任务 映射（最近 30 任务）--\n'
    q "SELECT id, COALESCE(title,'') AS title, COALESCE(created_at,'') AS created_at,
              COALESCE(updated_at,'') AS updated_at
         FROM tasks ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 30;"

    printf '  -- 文件表（若存在 files 表）--\n'
    q "SELECT * FROM files ORDER BY rowid DESC LIMIT 50;"

    printf '  -- 孤儿文件：files 中 task_id 为空或指向不存在的任务 --\n'
    q "SELECT f.rowid, COALESCE(f.task_id,'') AS task_id, COALESCE(f.path, f.name, '') AS path
         FROM files f LEFT JOIN tasks t ON t.id = f.task_id
        WHERE f.task_id IS NULL OR t.id IS NULL LIMIT 50;"
    verdict "registry 按文件 done" "open" "见上/失败：files 表与 tasks 表映射；孤儿行即无任务主的残留"
  else
    printf '  (跳过：%s)\n' "$([ "$SKIP_LEDGER" = 1 ] && echo 'SKIP_LEDGER=1' || echo 'DB 不可读/未找到，可设 LEDGER_DB=/path/ledger.db')"
    verdict "registry 按文件 done" "无证据" "ledger.db 不可读或未找到"
  fi

  if [ "${STALE_HITS:-0}" -gt 0 ]; then
    verdict "uploads 平铺可见" "open" "${STALE_HITS}/${TOPN} 个 top 租户的 workspace/uploads 含 >${STALE_SECONDS}s 旧文件"
  else
    verdict "uploads 平铺可见" "无证据" "top${TOPN} 租户未见 >${STALE_SECONDS}s 旧文件（或目录不可读）"
  fi
fi

# =========================================================================
# 2. /ws nginx 视图：活跃租户实际可见内容 + WAGATE_WS_GUARD deny 清单
# =========================================================================
sec "2. /ws nginx 视图与 WAGATE_WS_GUARD deny 清单"
GUARD_FILE="${WAGATE_WS_GUARD:-/etc/wagate/ws-guard.deny}"
if [ -r "$GUARD_FILE" ]; then
  printf '  deny 清单: %s\n' "$GUARD_FILE"
  run "$T_FAST" "读取 deny 清单" sed -n '1,80p' "$GUARD_FILE"
  verdict "uploads 平铺可见" "${VERDICT[uploads 平铺可见]:-open}" "deny 清单存在；见 §1 旧文件计数判断是否覆盖 uploads"
else
  printf '  (deny 清单不可读: %s；可设 WAGATE_WS_GUARD=/path)\n' "$GUARD_FILE"
fi

# 从 nginx 配置推断 /ws 的 root/alias
if [ -r "$NGINX_CONF" ]; then
  printf '  -- nginx 中 /ws 相关 location --\n'
  run "$T_FAST" "grep /ws" grep -nE 'location[[:space:]]+[^\{]*/ws|root[[:space:]]+|alias[[:space:]]+' "$NGINX_CONF"
else
  printf '  (nginx 配置不可读: %s；可设 NGINX_CONF=/path)\n' "$NGINX_CONF"
fi

AT="${ACTIVE_TENANT:-$(printf '%s\n' "${TOP_TENANTS:-}" | head -n1 | xargs -r basename)}"
printf '  活跃租户 (ACTIVE_TENANT): %s\n' "${AT:-(未指定)}"
if [ -n "$AT" ]; then
  WS_DIR="${WS_ROOT:-$TENANT_ROOT/$AT/workspace}"
  printf '  /ws 映射目录: %s\n' "$WS_DIR"
  list_top "$WS_DIR" 40
  ws_old="$(timeout "$T_MED" find "$WS_DIR" -type f -mmin "+$((STALE_SECONDS/60))" 2>/dev/null | wc -l | tr -d ' ')"
  printf '  >> /ws 活跃视图内 >%ss 旧文件: %s\n' "$STALE_SECONDS" "${ws_old:-?}"
  if [ "${ws_old:-0}" -gt 0 ]; then
    verdict "uploads 平铺可见" "open" "/ws 活跃视图可见 ${ws_old} 个 >${STALE_SECONDS}s 旧文件（nginx 直接暴露持久平铺目录）"
    printf '  -- 旧文件明细（前 20）--\n'
    run "$T_MED" "列出 /ws 旧文件" bash -c \
      "find '$WS_DIR' -type f -mmin +$((STALE_SECONDS/60)) -printf '%TY-%Tm-%TdT%TH:%TM %s %p\n' 2>/dev/null | sort | head -n 20"
  fi
fi

# =========================================================================
# 3. activeProj / task.json 现状（top3）
# =========================================================================
sec "3. activeProj / task.json 现状"
if [ -n "${TOP_TENANTS:-}" ]; then
  for t in $TOP_TENANTS; do
    sid="$(basename "$t")"
    found=0
    for p in "$t/activeProj/task.json" "$t/workspace/activeProj/task.json" "$t/activeProj.json"; do
      if [ -r "$p" ]; then
        found=1
        printf '  租户 %s: %s\n' "$sid" "$p"
        run "$T_FAST" "读取 task.json" head -c 2000 "$p"
        printf '\n'
        # 提取当前任务 id（字段名容错）
        tid="$(timeout "$T_FAST" grep -oE '"(taskId|task_id|id)"[[:space:]]*:[[:space:]]*"[^"]+"' "$p" 2>/dev/null | head -n1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
        printf '  >> 当前任务 id: %s\n' "${tid:-(未解析出)}"
      fi
    done
    [ "$found" = 0 ] && printf '  租户 %s: (未找到 activeProj/task.json)\n' "$sid"
  done
  verdict "坑#21 旧页重交付" "open" "需人工核对上表：activeProj/task.json 是否指向当前任务；非当前任务/缺失即存在旧页复用风险"
else
  printf '  (无可用租户列表)\n'
  verdict "坑#21 旧页重交付" "无证据" "无租户列表可查"
fi

# =========================================================================
# 4. 会话 jsonl 大小 + sessions-backup 归档清单（上下文污染面）
# =========================================================================
sec "4. 会话 jsonl 与会话归档（上下文污染面）"
if [ -z "$SESSIONS_DIR" ]; then
  for cand in /srv/wagate/sessions /srv/wagate/data/sessions /var/lib/wagate/sessions "$TENANT_ROOT/../sessions"; do
    [ -d "$cand" ] && { SESSIONS_DIR="$cand"; break; }
  done
fi
if [ -n "$SESSIONS_DIR" ] && have_dir "$SESSIONS_DIR"; then
  printf '  会话目录: %s (总大小 %s)\n' "$SESSIONS_DIR" "$(dir_size_h "$SESSIONS_DIR")"
  printf '  -- 最大的 10 个 jsonl --\n'
  run "$T_MED" "列出 jsonl" bash -c \
    "find '$SESSIONS_DIR' -type f -name '*.jsonl' -printf '%s %TY-%Tm-%TdT%TH:%TM %p\n' 2>/dev/null | sort -rn | head -n 10 | awk '{printf \"  %10d B  %s  %s\\n\",\$1,\$2,\$3}'"
  tot="$(timeout "$T_MED" find "$SESSIONS_DIR" -type f -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  printf '  jsonl 文件总数: %s\n' "${tot:-?}"
  # 旧文件引用面：jsonl 中引用到 uploads/ 历史路径的行数（只统计，不打印内容）
  refs="$(timeout "$T_MED" grep -rl 'uploads/' "$SESSIONS_DIR" --include='*.jsonl' 2>/dev/null | wc -l | tr -d ' ')"
  printf '  含 "uploads/" 引用的 jsonl 文件数: %s\n' "${refs:-?}"
  [ "${refs:-0}" -gt 0 ] && verdict "会话历史旧引用" "open" "${refs} 个会话 jsonl 仍引用 uploads/ 历史路径，模型历史上下文可被旧文件污染" \
                         || verdict "会话历史旧引用" "无证据" "会话 jsonl 未见 uploads/ 引用"
else
  printf '  (会话目录不可读: %s；可设 SESSIONS_DIR=/path)\n' "${SESSIONS_DIR:-(未探测到)}"
  verdict "会话历史旧引用" "无证据" "会话目录不可读"
fi

if [ -z "$SESSIONS_BACKUP_DIR" ]; then
  for cand in /srv/wagate/sessions-backup /srv/wagate/data/sessions-backup /var/backups/wagate-sessions; do
    [ -d "$cand" ] && { SESSIONS_BACKUP_DIR="$cand"; break; }
  done
fi
if [ -n "$SESSIONS_BACKUP_DIR" ] && have_dir "$SESSIONS_BACKUP_DIR"; then
  printf '  会话归档目录: %s (总大小 %s)\n' "$SESSIONS_BACKUP_DIR" "$(dir_size_h "$SESSIONS_BACKUP_DIR")"
  run "$T_MED" "列出归档" bash -c \
    "find '$SESSIONS_BACKUP_DIR' -mindepth 1 -maxdepth 1 -printf '%TY-%Tm-%TdT%TH:%TM %p\n' 2>/dev/null | sort | tail -n 20"
  printf '  >> 注：归档只归档会话、不清理 /ws 文件视图 —— 即 session-rotate 治不了本项\n'
else
  printf '  (归档目录不可读: %s)\n' "${SESSIONS_BACKUP_DIR:-(未探测到)}"
fi

# =========================================================================
# 5. tmpfs 永久记账 探测（L3 已知）
# =========================================================================
sec "5. tmpfs / 永久记账 探测"
run "$T_FAST" "mount 中 tmpfs" bash -c "mount 2>/dev/null | grep -E 'tmpfs' | grep -E 'wagate|tenants|work|uploads|sessions' || echo '  (未发现与 wagate 相关的 tmpfs 挂载)'"
for d in "$TENANT_ROOT" /srv/wagate /tmp; do
  [ -d "$d" ] || continue
  fs="$(timeout "$T_FAST" df -PT "$d" 2>/dev/null | awk 'NR==2{print $1" ("$2")"}')"
  printf '  %-22s -> %s\n' "$d" "${fs:-?}"
done
if timeout "$T_FAST" mount 2>/dev/null | grep -qE 'tmpfs.*(wagate|tenants|sessions)'; then
  verdict "tmpfs 永久记账" "open" "关键目录位于 tmpfs：重启即失且被当作永久记账，易产生残留/短命状态混杂"
else
  verdict "tmpfs 永久记账" "无证据" "未发现关键目录挂 tmpfs（磁盘持久）"
fi

# =========================================================================
# 6. 结论表（issue §2.6 逐条）
# =========================================================================
sec "6. 结论表：已知干扰路径 open / fixed / 无证据"
printf '%-24s %-10s %s\n' "干扰路径" "判定" "证据/备注"
printf '%-24s %-10s %s\n' "------------------------" "----------" "------------------------------------------------"
for k in "坑#21 旧页重交付" "registry 按文件 done" "会话历史旧引用" "tmpfs 永久记账" "uploads 平铺可见" "门禁开关(5项)"; do
  printf '%-24s %-10s %s\n' "$k" "${VERDICT[$k]:-无证据}" "${EVID[$k]:-—}"
done
echo
echo "判定口径：open=实测到该路径存在；fixed=实测该路径已被阻断；无证据=本次只读探测未取得可用证据。"

# ---- 收尾 ----------------------------------------------------------------
ELAPSED=$(( $(now_epoch) - START_TS ))
sec "收尾"
printf '耗时: %ss（目标 <90s）%s\n' "$ELAPSED" "$([ "$ELAPSED" -ge 90 ] && echo '  ⚠ 超出目标，可减小 TOPN 或设 SKIP_LEDGER=1')"
printf '写操作: 0（本脚本仅读 stdout）\n'
printf '下一步: 将本输出回传 issue #38 → 确认根因 → 审 fixes/fixB-residual.sh 后 EU 执行\n'
exit 0
