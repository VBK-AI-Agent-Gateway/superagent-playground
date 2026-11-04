#!/usr/bin/env bash
# 03-channel13-whitelist.sh — 给 channel13 token 的模型白名单加 Qwen3.8-27B
#
# 作用：
#   在 ai-gateway 的 SQLite（New-API 风格：channels / tokens / model_configs）中，把
#   token `sk-user03-m3-e34bfe06a71ead8e` 的模型白名单**追加** `Qwen3.8-27B`
#   （现状白名单：m3, zai-org/GLM-5.3, zai-org/GLM-5.3-Flash, gemma4:12b）。
#   流程：探查表结构定位白名单字段 → 备份 core.db → sqlite3 只改该 token 那一行 →
#   重启 ai-gateway → PID 断言 → 用该 token 请求 Qwen3.8-27B 期望 HTTP 200。
#
# 回退方法：
#   1) 首选：`cp /opt/ai-gateway/data/core.db.bak.ch13_<时间戳> /opt/ai-gateway/data/core.db`
#      然后 `systemctl restart ai-gateway`（备份由本脚本在改动前生成，路径会打印出来）。
#   2) 也可用本脚本自带的反向操作（把模型名从白名单里再删掉，见第 6 步打印的 SQL）。
#   注意：数据库改动不可“部分回退”，整库回滚会把该时间点之后的其他写入一起退回，
#   所以建议在改动前后各看一眼是否只有本 token 受影响（脚本会打印 before/after）。
#
# 风险：
#   * 重启 ai-gateway 会中断正在进行的推理请求（秒级）。
#   * 白名单字段若是 JSON 数组/逗号分隔串，写坏会导致该 token 全部模型不可用；脚本强制要求
#     改动前备份，并在重启后用 curl 做 200 验证；验证失败会提示立刻回滚（不自动回滚，避免
#     掩盖真实原因，回滚命令在第 6 步打印）。
#   * 只改这一个 token 的行，不做全表 UPDATE；不碰 channels 表以外的配置，不动 m3 链路、
#     asg-harness2-bypass、gstack.v6。
#   * sqlite3 必须是本机已装命令；缺失时脚本拒绝执行（不 pip/apt 安装）。

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

parse_args "03-channel13-whitelist.sh" "$@"
require_root_if_apply

BACKUP="$AIGW_DB.bak.ch13_$(ts)"
AIGW_SERVICE="ai-gateway"

print_mode_banner "ai-gateway channel13 白名单（+$AIGW_ADD_MODEL）"

# ---------------------------------------------------------------------------------
step "第 1 步：前置检查"
if ! command -v sqlite3 >/dev/null 2>&1; then
  die "找不到 sqlite3，拒绝执行（请先在 EU 服务器上安装 sqlite3 CLI）。"
fi
[ -f "$AIGW_DB" ] || die "数据库不存在：$AIGW_DB"
info "数据库：$AIGW_DB"
info "目标 token：$AIGW_TOKEN"
info "要追加的模型：$AIGW_ADD_MODEL"
info "现状白名单（现场信息）：$AIGW_EXPECT_MODELS"

# ---------------------------------------------------------------------------------
step "第 2 步：探查表结构，定位白名单字段"
if is_apply; then
  TABLES="$(sqlite3 "$AIGW_DB" ".tables")"
  info "表：$TABLES"
  printf '\n-- tokens 表结构 --\n'
  sqlite3 "$AIGW_DB" ".schema tokens"
  printf '\n-- channels 表结构（如存在）--\n'
  sqlite3 "$AIGW_DB" "SELECT sql FROM sqlite_master WHERE type='table' AND name='channels';" || true
  printf '\n-- model_configs 表结构（如存在）--\n'
  sqlite3 "$AIGW_DB" "SELECT sql FROM sqlite_master WHERE type='table' AND name='model_configs';" || true
  printf '\n-- 该 token 当前行（截断显示）--\n'
  sqlite3 -line "$AIGW_DB" "SELECT * FROM tokens WHERE key='$AIGW_TOKEN';" | cut -c1-400
  printf '\n-- 候选白名单列（名字含 model/allow/group 的列）--\n'
  sqlite3 "$AIGW_DB" "SELECT m.name FROM pragma_table_info('tokens') m WHERE lower(m.name) LIKE '%model%' OR lower(m.name) LIKE '%allow%' OR lower(m.name) LIKE '%group%';"
  info "把上面选中的列名填到脚本变量 AIGW_WHITELIST_COL（默认 models）后重跑 --apply。"
else
  printf '[dry-run] 将执行：\n'
  printf '          $ sqlite3 %s ".tables"\n' "$AIGW_DB"
  printf '          $ sqlite3 %s ".schema tokens"\n' "$AIGW_DB"
  printf '          $ sqlite3 -line %s "SELECT * FROM tokens WHERE key=%s;"\n' "$AIGW_DB" "'$AIGW_TOKEN'"
  printf '          （并列出名字含 model/allow/group 的候选列，供人工确认白名单字段）\n'
fi

AIGW_WHITELIST_COL="${AIGW_WHITELIST_COL:-models}"

# ---------------------------------------------------------------------------------
step "第 3 步：备份数据库（$BACKUP）"
run "备份 core.db（改动前唯一保险）" cp -a "$AIGW_DB" "$BACKUP"
info "回滚命令：cp -a $BACKUP $AIGW_DB && systemctl restart $AIGW_SERVICE"

# ---------------------------------------------------------------------------------
step "第 4 步：写入白名单（只改目标 token 一行）"
# 说明：New-API 的 tokens.models 为逗号分隔字符串；若你的实例是 JSON 数组，脚本会按 JSON 处理。
WHITELIST_SQL_COMMON="key='$AIGW_TOKEN'"
DRY_SQL="SELECT id, key, $AIGW_WHITELIST_COL FROM tokens WHERE $WHITELIST_SQL_COMMON;"

if is_apply; then
  CURRENT="$(sqlite3 "$AIGW_DB" "SELECT $AIGW_WHITELIST_COL FROM tokens WHERE $WHITELIST_SQL_COMMON;")"
  [ -n "$CURRENT" ] || die "没有查到该 token 的 $AIGW_WHITELIST_COL 值，列名可能不对（先做第 2 步探查）。"
  info "改动前：$CURRENT"
  case "$CURRENT" in
    *"$AIGW_ADD_MODEL"*) info "白名单中已包含 $AIGW_ADD_MODEL，无需改动（幂等）。";;
    \[*\]*)
      NEW="$(printf '%s' "$CURRENT" | sed "s/\]/,\"$AIGW_ADD_MODEL\"]/")"
      sqlite3 "$AIGW_DB" "UPDATE tokens SET $AIGW_WHITELIST_COL='$NEW' WHERE $WHITELIST_SQL_COMMON;"
      ;;
    *)
      sqlite3 "$AIGW_DB" "UPDATE tokens SET $AIGW_WHITELIST_COL='$CURRENT,$AIGW_ADD_MODEL' WHERE $WHITELIST_SQL_COMMON;"
      ;;
  esac
  AFTER="$(sqlite3 "$AIGW_DB" "SELECT $AIGW_WHITELIST_COL FROM tokens WHERE $WHITELIST_SQL_COMMON;")"
  info "改动后：$AFTER"
  case "$AFTER" in
    *"$AIGW_ADD_MODEL"*) info "写入成功。";;
    *) die "写入后仍未包含 $AIGW_ADD_MODEL，请立即回滚：cp -a $BACKUP $AIGW_DB";;
  esac
else
  printf '[dry-run] 将执行（以逗号分隔白名单为例）：\n'
  printf '          $ sqlite3 %s "%s"\n' "$AIGW_DB" "$DRY_SQL"
  printf "          \$ sqlite3 %s \"UPDATE tokens SET %s='<原值>,$AIGW_ADD_MODEL' WHERE %s;\"\n" "$AIGW_DB" "$AIGW_WHITELIST_COL" "$WHITELIST_SQL_COMMON"
  printf '          （若白名单是 JSON 数组，则改成在数组末尾追加 "%s"；幂等：已含则跳过）\n' "$AIGW_ADD_MODEL"
fi

# ---------------------------------------------------------------------------------
step "第 5 步：重启 ai-gateway 并做 PID 断言"
if is_apply; then
  OLD_PID="$(systemctl show -p MainPID --value "$AIGW_SERVICE" 2>/dev/null || echo 0)"
  info "重启前 MainPID=$OLD_PID"
  systemctl restart "$AIGW_SERVICE"
  sleep 2
  NEW_PID="$(systemctl show -p MainPID --value "$AIGW_SERVICE" 2>/dev/null || echo 0)"
  info "重启后 MainPID=$NEW_PID"
  [ -n "$NEW_PID" ] && [ "$NEW_PID" != "0" ] || die "ai-gateway 未起来（MainPID=0），请查看 journalctl -u $AIGW_SERVICE -n 50"
  [ "$NEW_PID" != "$OLD_PID" ] || warn "MainPID 未变化（可能 unit 是 Type=oneshot 或未真正重启），请人工确认。"
  systemctl is-active --quiet "$AIGW_SERVICE" || die "ai-gateway 状态不是 active，请立即回滚。"
  info "服务 active，PID 断言通过。"
else
  printf '[dry-run] 将执行：\n'
  printf '          $ systemctl show -p MainPID --value %s      # 记录旧 PID\n' "$AIGW_SERVICE"
  printf '          $ systemctl restart %s && sleep 2\n' "$AIGW_SERVICE"
  printf '          $ systemctl show -p MainPID --value %s      # 新 PID 必须非 0 且变化\n' "$AIGW_SERVICE"
  printf '          $ systemctl is-active %s                    # 期望 active\n' "$AIGW_SERVICE"
fi

# ---------------------------------------------------------------------------------
step "第 6 步：验证（curl 带该 token 请求 $AIGW_ADD_MODEL，期望 200）"
CURL_CMD="curl -sS -o /tmp/ch13-verify.json -w '%{http_code}' -X POST http://127.0.0.1:3000/v1/chat/completions -H 'Authorization: Bearer $AIGW_TOKEN' -H 'Content-Type: application/json' -d '{\"model\":\"$AIGW_ADD_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}'"
if is_apply; then
  info "请求：$AIGW_ADD_MODEL"
  CODE="$(sh -c "$CURL_CMD" || echo '000')"
  info "HTTP 状态码：$CODE"
  case "$CODE" in
    200) info "验证通过：白名单已生效。";;
    401|403) warn "返回 $CODE：白名单已加，但 token 鉴权/权限另有问题，请人工确认 channels 侧是否已启用该模型。";;
    *) warn "返回 $CODE：白名单可能未生效。响应体：$(head -c 300 /tmp/ch13-verify.json 2>/dev/null || true)";;
  esac
  info "回滚（如需）：cp -a $BACKUP $AIGW_DB && systemctl restart $AIGW_SERVICE"
  info "反向删除该模型（如需，仅为示例）：sqlite3 $AIGW_DB \"SELECT id,$AIGW_WHITELIST_COL FROM tokens WHERE key='$AIGW_TOKEN';\" 后手工改回。"
else
  printf '[dry-run] 将执行：\n          $ %s\n' "$CURL_CMD"
  printf '          期望 200；401/403 表示 token 本身权限问题；5xx 表示 ai-gateway 侧异常。\n'
fi

step "完成"
if is_apply; then
  info "已完成。备份文件：$BACKUP"
else
  info "以上为 dry-run 计划，未读取也未改动数据库。确认无误后执行：sudo $0 --apply"
fi
