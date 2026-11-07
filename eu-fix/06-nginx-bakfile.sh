#!/usr/bin/env bash
# 06-nginx-bakfile.sh — 把 nginx 备份文件移出 sites-enabled
#
# 作用：
#   把误留在 `sites-enabled/` 里的备份文件 `privacy-policy.bak_qr` 移到 `sites-available/`，
#   让它不再被 nginx 当作站点配置加载。流程：
#     ls 确认存在 → （可选）确认 sites-enabled 里只有 /etc/nginx/sites-available/ 的符号链接 →
#     mv 到 sites-available/ → `nginx -t` 必须 OK → `systemctl reload nginx` → 复查文件位置。
#
# 回退方法：
#   `mv /etc/nginx/sites-available/privacy-policy.bak_qr /etc/nginx/sites-enabled/privacy-policy.bak_qr`
#   → `nginx -t && systemctl reload nginx`。
#   （本操作只是改名/移动文件，内容未改动；脚本会打印这条回退命令和实际目标路径。）
#
# 风险：
#   * 若该文件实际是**在用的站点配置**（名字带 .bak_qr 但被 include 生效），移走会让站点 404。
#     因此脚本在移动前打印 `nginx -T` 中引用该文件的位置，并在 `nginx -t` 失败时**不 reload**、
#     直接提示回退。纯备份文件（含语法错误的）移走反而会让 `nginx -t` 由失败转为通过。
#   * 目标文件已存在时不覆盖：脚本会改用 `.bak_qr.<时间戳>` 命名并提示。
#   * 只移动这一个文件，不改 nginx.conf / 其他站点，不碰 asg-harness2-bypass、m3 链路、gstack.v6。

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

parse_args "06-nginx-bakfile.sh" "$@"
require_root_if_apply

SRC="$NGINX_BAK"
BASENAME="$(basename "$SRC")"
DST="$NGINX_AVAILABLE_DIR/$BASENAME"

print_mode_banner "nginx 备份文件移出 sites-enabled"

# ---------------------------------------------------------------------------------
step "第 1 步：确认文件现状"
if [ ! -e "$SRC" ]; then
  warn "文件不存在：$SRC"
  info "可能已经被移走。当前 sites-enabled 内容（前 20 行）："
  ls -la /etc/nginx/sites-enabled 2>/dev/null | head -20 | sed 's/^/    /' || true
  if is_apply; then
    info "无动作需要执行，按“已处理”结束。"
    exit 0
  fi
else
  info "找到目标文件：$SRC"
  if is_apply; then
    ls -la "$SRC" | sed 's/^/    /'
    info "sites-enabled 目录清单："
    ls -la /etc/nginx/sites-enabled | sed 's/^/    /'
    info "nginx 配置中引用该文件的位置（可为空）："
    nginx -T 2>/dev/null | grep -n "$BASENAME" | sed 's/^/    /' || true
  else
    printf '[dry-run] 将执行：ls -la %s; ls -la /etc/nginx/sites-enabled; nginx -T | grep -n %s\n' "$SRC" "$BASENAME"
  fi
fi

# ---------------------------------------------------------------------------------
step "第 2 步：移动前的 nginx 配置自检（记录基线，便于对照）"
run "移动前执行 nginx -t（记录基线）" nginx -t

# ---------------------------------------------------------------------------------
step "第 3 步：移动到 sites-available"
if [ -e "$DST" ]; then
  DST="$NGINX_AVAILABLE_DIR/$BASENAME.$(ts)"
  warn "目标已存在，改用新名字：$DST"
fi
run "移动文件出 sites-enabled" mv "$SRC" "$DST"

# ---------------------------------------------------------------------------------
step "第 4 步：nginx -t 门禁 + reload"
if is_apply; then
  if nginx -t; then
    info "nginx -t 通过。"
  else
    die "nginx -t 失败！未执行 reload。请回退：mv $DST $SRC && nginx -t && systemctl reload nginx"
  fi
  printf '[exec] systemctl reload %s\n' "$NGINX_SERVICE"
  systemctl reload "$NGINX_SERVICE"
  systemctl is-active --quiet "$NGINX_SERVICE" && info "nginx active。" || die "nginx 未处于 active 状态，请检查并回退。"
else
  printf '[dry-run] 将执行：\n'
  printf '          $ mv %s %s\n' "$SRC" "$DST"
  printf '          $ nginx -t            # 必须 OK；失败则不 reload 并回退\n'
  printf '          $ systemctl reload %s\n' "$NGINX_SERVICE"
  printf '          $ systemctl is-active %s    # 期望 active\n' "$NGINX_SERVICE"
  printf '          预期效果：sites-enabled 不再包含 %s，nginx -t 从“可能报错”变为 OK（若它是坏配置）。\n' "$BASENAME"
fi

# ---------------------------------------------------------------------------------
step "第 5 步：复查"
if is_apply; then
  info "sites-enabled（应不再含 $BASENAME）："
  ls -la /etc/nginx/sites-enabled | grep -F "$BASENAME" && warn "仍能看到该名字，请人工确认。" || info "已不在 sites-enabled 中。"
  info "sites-available（应含 $DST）："
  ls -la "$DST" | sed 's/^/    /'
else
  printf '[dry-run] 将复查：ls -la /etc/nginx/sites-enabled | grep %s（期望无输出）；ls -la %s\n' "$BASENAME" "$DST"
fi

step "完成"
info "回退命令：mv $DST $SRC && nginx -t && systemctl reload $NGINX_SERVICE"
if is_apply; then
  info "已移出 sites-enabled。"
else
  info "以上为 dry-run 计划，未移动任何文件。确认无误后执行：sudo $0 --apply"
fi
