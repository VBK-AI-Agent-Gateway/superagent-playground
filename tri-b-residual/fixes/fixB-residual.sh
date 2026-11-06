#!/usr/bin/env bash
# fixB-residual.sh — 历史残留文件干扰修复：任务级文件视图 + 机械门（issue #38 / 故障修复 B）
#
# 目标（对应 issue §1 嫌疑点）：
#   新任务只见本任务文件，历史任务旧文件不再出现在 /ws 活跃视图，也不再注入提示词。
#   旧文件"归档不删"（<租户>/archives/archive-<ts>/，位于 /ws 视图之外），可回退、可审计。
#
# 默认 dry-run：只打印将要做什么，绝不改动。确认后用 --apply 才真正执行。
#
# 用法：
#   bash fixB-residual.sh                      # dry-run（默认，安全）
#   bash fixB-residual.sh --apply              # 真正执行
#   bash fixB-residual.sh --apply --gate       # 执行后立刻跑一次机械门
#   bash fixB-residual.sh --gate-only          # 只跑机械门（fail-closed 断言）
#   bash fixB-residual.sh --rollback <ts>      # 按归档时间戳回退（把 archive-<ts>/ 还原）
#   TENANT=/srv/tenants/acme bash fixB-residual.sh --apply
#
# 环境变量：
#   TENANT_ROOT=/srv/tenants     租户根
#   TENANT=<sid|路径>            只处理某一个租户（默认全部）
#   WAGATE_RESIDUAL_VIEW=0       fail-open 开关：0=关闭本修复，恢复旧行为（见 README）
#   WHITELIST="..."              机械门白名单（相对路径 glob，空格分隔）
#   STALE_SECONDS=3600           机械门阈值：活跃视图内 >1h 的旧文件即违规
#   ALERT_LOG=/var/log/wagate/residual-gate.log   告警日志
#   TG_NOTIFY=1                 违规时发 Telegram（凭据只从环境/WAGATE_ENV 读，不落盘）
#
# 硬约束：零 secret 入库；本脚本自身不写任何凭据；不删除任何用户文件（只移动归档）。
#
# 退出码：0 成功；1 机械门违规(fail-closed)；2 用法/前置条件错误。

set -euo pipefail

# ---- 参数 -----------------------------------------------------------------
MODE="dryrun"
DO_GATE=0
GATE_ONLY=0
ROLLBACK_TS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply|-a)   MODE="apply" ;;
    --dry-run|-n) MODE="dryrun" ;;
    --gate|-g)    DO_GATE=1 ;;
    --gate-only)  GATE_ONLY=1 ;;
    --rollback)   shift; ROLLBACK_TS="${1:-}" ;;
    -h|--help)    sed -n '2,30p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 查看用法）\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---- 配置 -----------------------------------------------------------------
TENANT_ROOT="${TENANT_ROOT:-/srv/tenants}"
TENANT="${TENANT:-}"
WAGATE_RESIDUAL_VIEW="${WAGATE_RESIDUAL_VIEW:-1}"
STALE_SECONDS="${STALE_SECONDS:-3600}"
ALERT_LOG="${ALERT_LOG:-/var/log/wagate/residual-gate.log}"
ARCHIVE_PREFIX="${ARCHIVE_PREFIX:-archive-}"
# 白名单：这些相对路径即便 >1h 也允许留在活跃视图（系统必需文件）
WHITELIST="${WHITELIST:-task.json activeProj/task.json activeProj/* .keep README.md}"
TG_NOTIFY="${TG_NOTIFY:-1}"
WAGATE_ENV="${WAGATE_ENV:-/etc/wagate.env}"
# 提示词清单输出位置（供上游读取；dry-run 下只打印）
PROMPT_MANIFEST="${PROMPT_MANIFEST:-activeProj/current-files.txt}"

TS="$(date -u '+%Y%m%dT%H%M%SZ')"
ARCHIVE_NAME="${ARCHIVE_PREFIX}${TS}"

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
act()  { if [ "$MODE" = "apply" ]; then "$@"; else printf '  [dry-run] 将执行: %s\n' "$*"; fi; }
hr()   { printf '%s\n' "------------------------------------------------------------------------"; }
die()  { printf '错误: %s\n' "$1" >&2; exit 2; }

# =========================================================================
# 机械门：fail-closed 断言活跃视图无 >1h 旧文件（白名单除外）
# 返回：0 通过；1 违规
# =========================================================================
in_whitelist() {
  local rel="$1" w
  for w in $WHITELIST; do
    # shellcheck disable=SC2254
    case "$rel" in $w) return 0 ;; esac
  done
  return 1
}

send_tg() {
  local msg="$1"
  [ "$TG_NOTIFY" = "1" ] || return 0
  local token chat
  # 凭据优先取环境；其次从 WAGATE_ENV 读取（只读，不打印）
  token="${TG_BOT_TOKEN:-}"; chat="${TG_CHAT_ID:-}"
  if [ -z "$token" ] && [ -r "$WAGATE_ENV" ]; then
    token="$(grep -E '^[[:space:]]*TG_BOT_TOKEN[[:space:]]*=' "$WAGATE_ENV" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"'"'"' ')"
  fi
  if [ -z "$chat" ] && [ -r "$WAGATE_ENV" ]; then
    chat="$(grep -E '^[[:space:]]*TG_CHAT_ID[[:space:]]*=' "$WAGATE_ENV" 2>/dev/null | head -n1 | cut -d= -f2- | tr -d '"'"'"' ')"
  fi
  if [ -z "$token" ] || [ -z "$chat" ]; then
    log "TG 未发送（凭据缺失，仅写告警日志）"
    return 0
  fi
  # 只发文本摘要，不含文件内容/凭据
  timeout 10 curl -sS -o /dev/null -w '%{http_code}' \
    "https://api.telegram.org/bot${token}/sendMessage" \
    -d "chat_id=${chat}" --data-urlencode "text=${msg}" >/dev/null 2>&1 \
    && log "TG 已发送" || log "TG 发送失败（网络/凭据）"
}

alert() {
  local msg="$1"
  # 告警必须留痕（issue §0①：失败绝不静默）。门禁告警与 MODE 无关：
  # 只有目录已存在才追加，避免脚本意外的建目录写入；否则降级为 stderr。
  if [ -d "$(dirname "$ALERT_LOG")" ]; then
    printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$msg" >> "$ALERT_LOG" 2>/dev/null \
      || printf 'ALERT(log写入失败) %s\n' "$msg" >&2
  else
    printf 'ALERT(日志目录缺失 %s) %s\n' "$(dirname "$ALERT_LOG")" "$msg" >&2
  fi
  printf 'ALERT %s\n' "$msg" >&2
  send_tg "[wagate 残留门] ${msg}"
}

run_gate() {
  local failed=0 total=0
  hr
  log "机械门：断言活跃视图无 >${STALE_SECONDS}s 旧文件（白名单: ${WHITELIST}）"
  [ -d "$TENANT_ROOT" ] || { log "租户根不存在，门通过（无对象）"; return 0; }

  local tenants
  if [ -n "$TENANT" ]; then
    case "$TENANT" in /*) tenants="$TENANT" ;; *) tenants="$TENANT_ROOT/$TENANT" ;; esac
  else
    tenants="$(find "$TENANT_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)"
  fi

  local t
  for t in $tenants; do
    [ -d "$t" ] || continue
    local sid; sid="$(basename "$t")"
    local actdir="$t/workspace"
    [ -d "$actdir" ] || continue
    # 活跃视图中的 >1h 文件
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      total=$((total + 1))
      local rel="${f#"$actdir"/}"
      if in_whitelist "$rel"; then
        log "  白名单放行: ${sid}/${rel}"
        continue
      fi
      failed=$((failed + 1))
      alert "租户 ${sid}: 活跃视图存在旧文件 ${rel}（>${STALE_SECONDS}s）"
    done < <(find "$actdir" -type f -mmin "+$((STALE_SECONDS / 60))" 2>/dev/null)
  done

  if [ "$failed" -gt 0 ]; then
    log "机械门 FAIL（fail-closed）：${failed} 个违规旧文件仍在活跃视图"
    return 1
  fi
  log "机械门 PASS：活跃视图无 >${STALE_SECONDS}s 旧文件（扫描 ${total} 项，全部合规/白名单）"
  return 0
}

# =========================================================================
# 回退：把 archive-<ts>/ 内容还原回活跃视图
# =========================================================================
do_rollback() {
  [ -n "$ROLLBACK_TS" ] || die "--rollback 需要归档时间戳，例如 --rollback $ARCHIVE_NAME"
  log "回退模式：还原 ${ARCHIVE_PREFIX}${ROLLBACK_TS}（dry-run 需显式 --apply 才动文件）"

  local tenants
  if [ -n "$TENANT" ]; then
    case "$TENANT" in /*) tenants="$TENANT" ;; *) tenants="$TENANT_ROOT/$TENANT" ;; esac
  else
    tenants="$(find "$TENANT_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)"
  fi

  local found=0 t arch
  for t in $tenants; do
    [ -d "$t" ] || continue
    arch="$t/archives/${ARCHIVE_PREFIX}${ROLLBACK_TS}"
    [ -d "$arch" ] || continue
    found=1
    log "租户 $(basename "$t")：归档 $arch"
    # 归档结构: <arch>/uploads/*  与  <arch>/workspace/<rel>
    local src dest_root
    for sub in uploads workspace; do
      [ -d "$arch/$sub" ] || continue
      dest_root="$t/$sub"
      act mkdir -p "$dest_root"
      while IFS= read -r src; do
        [ -z "$src" ] && continue
        local rel="${src#"$arch/$sub"/}"
        act mkdir -p "$dest_root/$(dirname "$rel")"
        act mv -n "$src" "$dest_root/$rel"
      done < <(find "$arch/$sub" -type f 2>/dev/null)
    done
    # 归档目录清空后移除（只删归档壳，绝不删用户文件）
    if [ "$MODE" = "apply" ]; then
      find "$arch" -type d -empty -delete 2>/dev/null || true
      [ -d "$arch" ] && log "  提示：归档目录非空（有未还原项），保留 $arch" || log "  归档目录已清空并移除"
    else
      printf '  [dry-run] 将移除已清空的归档目录 %s\n' "$arch"
    fi
  done
  [ "$found" = 1 ] || die "找不到归档目录: <租户>/archives/${ARCHIVE_PREFIX}${ROLLBACK_TS}（可用 TENANT=<sid> 指定租户）"
  log "回退完成（${MODE}）"
}

# =========================================================================
# 主修复：任务级文件视图
# =========================================================================
do_fix() {
  hr
  log "修复模式: ${MODE}  （--apply 才真正改动；默认 dry-run）"
  log "fail-open 开关 WAGATE_RESIDUAL_VIEW=${WAGATE_RESIDUAL_VIEW}（0=关闭本修复，恢复旧行为）"

  if [ "$WAGATE_RESIDUAL_VIEW" = "0" ]; then
    log "WAGATE_RESIDUAL_VIEW=0 → 若已应用则回退到旧行为；跳过归档与清单注入"
    printf '  → 更新上游环境：WAGATE_RESIDUAL_VIEW=0 时渲染层不过滤历史文件（fail-open 逃生门）\n'
    return 0
  fi

  [ -d "$TENANT_ROOT" ] || die "租户根不存在: $TENANT_ROOT"

  local tenants
  if [ -n "$TENANT" ]; then
    case "$TENANT" in /*) tenants="$TENANT" ;; *) tenants="$TENANT_ROOT/$TENANT" ;; esac
  else
    tenants="$(find "$TENANT_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)"
  fi

  local t
  for t in $tenants; do
    [ -d "$t" ] || continue
    local sid; sid="$(basename "$t")"
    local actdir="$t/workspace"
    local updir="$t/uploads"
    [ -d "$actdir" ] || { log "跳过租户 ${sid}：无 workspace/"; continue; }

    hr
    log "租户 ${sid}"

    # 当前任务 id（用于决定"哪些文件属于当前任务"）
    local tid=""
    for p in "$t/activeProj/task.json" "$actdir/task.json"; do
      if [ -r "$p" ]; then
        tid="$(grep -oE '"(taskId|task_id|id)"[[:space:]]*:[[:space:]]*"[^"]+"' "$p" 2>/dev/null \
               | head -n1 | sed 's/.*:[[:space:]]*"//;s/"$//')"
        [ -n "$tid" ] && break
      fi
    done
    log "当前任务 id: ${tid:-(未解析到；将仅按新鲜度归档)}"

    # 归档目录必须在 /ws 活跃视图之外（租户根下的 archives/），
    # 否则归档文件本身仍会出现在活跃视图里，机械门必然违规。
    local archdir="$t/archives/${ARCHIVE_NAME}"
    local moved=0 kept=0

    # -- 策略 1：uploads 按任务子目录（新任务只挂本任务子目录）--
    if [ -d "$updir" ]; then
      local old_flat
      old_flat="$(find "$updir" -mindepth 1 -maxdepth 1 -type f -mmin "+$((STALE_SECONDS / 60))" 2>/dev/null | wc -l | tr -d ' ')"
      log "uploads 顶层旧文件(>${STALE_SECONDS}s): ${old_flat}"
      if [ "${old_flat:-0}" -gt 0 ]; then
        act mkdir -p "$archdir/uploads"
        while IFS= read -r f; do
          [ -z "$f" ] && continue
          act mv -n "$f" "$archdir/uploads/"
          moved=$((moved + 1))
        done < <(find "$updir" -mindepth 1 -maxdepth 1 -type f -mmin "+$((STALE_SECONDS / 60))" 2>/dev/null)
      fi
      # 建本任务子目录（新任务上传落此，避免再次平铺）
      if [ -n "$tid" ]; then
        act mkdir -p "$updir/task-$tid"
      fi
    fi

    # -- 策略 2：workspace 内非白名单旧文件 → archive-<ts>/（移动不删）--
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      local rel="${f#"$actdir"/}"
      if in_whitelist "$rel"; then kept=$((kept + 1)); continue; fi
      act mkdir -p "$archdir/workspace/$(dirname "$rel")"
      act mv -n "$f" "$archdir/workspace/$rel"
      moved=$((moved + 1))
    done < <(find "$actdir" -type f -mmin "+$((STALE_SECONDS / 60))" 2>/dev/null)

    log "归档: ${moved} 个旧文件 → ${ARCHIVE_NAME}（不删除）  白名单保留: ${kept}"

    # -- 提示词只注入当前任务文件清单 --
    local manifest="$actdir/$PROMPT_MANIFEST"
    act mkdir -p "$(dirname "$manifest")"
    if [ "$MODE" = "apply" ]; then
      {
        printf '# 当前任务文件清单（任务 %s，生成 %s）\n' "${tid:-unknown}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        printf '# 上游渲染提示词时只允许注入本清单内文件；历史文件在 %s/\n' "$ARCHIVE_NAME"
        if [ -n "$tid" ] && [ -d "$updir/task-$tid" ]; then
          find "$updir/task-$tid" -type f -printf '%p\n' 2>/dev/null
        fi
        find "$actdir" -type f -mmin "-$((STALE_SECONDS / 60))" \
          -not -path "*/${ARCHIVE_PREFIX}[^/]*/*" -printf '%p\n' 2>/dev/null
      } > "$manifest"
      log "已写当前任务文件清单: ${manifest}"
    else
      printf '  [dry-run] 将写当前任务文件清单: %s（只含 task-%s/ 与近 ${STALE_SECONDS}s 内文件）\n' "$manifest" "${tid:-unknown}"
    fi
  done

  hr
  log "修复应用完成（${MODE}）。回退: bash $0 --rollback ${TS} --apply"
}

# =========================================================================
# 入口
# =========================================================================
if [ "$GATE_ONLY" = "1" ]; then
  run_gate || exit 1
  exit 0
fi

if [ -n "$ROLLBACK_TS" ]; then
  do_rollback
  exit 0
fi

do_fix
if [ "$DO_GATE" = "1" ] || [ "$MODE" = "apply" ]; then
  # fail-closed：即使 dry-run 也报出门的状态，但只有 apply 才据此失败
  if ! run_gate; then
    if [ "$MODE" = "apply" ]; then
      log "机械门未通过 → 退出码 1（fail-closed，已告警）"
      exit 1
    fi
  fi
fi
exit 0
