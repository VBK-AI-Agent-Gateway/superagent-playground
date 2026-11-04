#!/usr/bin/env bash
# 04-docpack-logfix.sh — 删除 doc-pack.ts 第 327 行 ANCHOR-DIAG 噪音日志（保持 inode）
#
# 作用：
#   删除 /srv/wagate/patches/doc-pack.ts 中整行 `console.log(`[doc-pack] ANCHOR-DIAG ...`)`
#   （bash 风格 $var 写进 JS 模板串，纯噪音，且会污染 journal）。流程：
#     cp 备份 → grep -v 生成临时文件 → md5 抽查（确认只少了一行）→
#     **cat 临时文件 > doc-pack.ts（保持 inode；sed -i 会换 inode，容器单文件 bind mount 看不到更新）**
#     → 比对宿主与容器内 md5（必须一致）→ 容器内 bun build 校验（严禁管道吃退出码）→
#     docker restart wagate → 运行时 SMOKE import 断言 → 检查 journal 无新错误。
#
# 回退方法：
#   备份保留为同目录的 doc-pack.ts.bak.diagfix.<时间戳>，且**用 cat > 覆盖而不是 mv**，
#   所以原 inode 不变。回退：
#     cat /srv/wagate/patches/doc-pack.ts.bak.diagfix.<ts> > /srv/wagate/patches/doc-pack.ts
#     docker restart wagate
#   （不要用 mv 覆盖回去——mv 同样会换 inode，可能导致容器内挂载点失效。脚本会把这条命令打印出来。）
#
# 风险：
#   * 改的是**正在被容器挂载**的 .ts：写坏会导致 wagate 启动或插件加载失败。脚本因此把
#     “临时文件 + 原子覆盖 + 容器内 md5 一致 + bun build 成功 + SMOKE import 成功”设为硬门禁，
#     任一步失败即中止并打印回退命令。
#   * `docker restart wagate` 会中断正在跑的任务，请在低峰执行。
#   * `grep -v ANCHOR-DIAG` 会删除**所有**含该标记的行：脚本先统计命中行数，若 ≠1 则中止，
#     避免误删（只有当命中恰好 1 行时才继续）。
#   * 只动这一个文件的这一行，不改 01~06 之外的东西，不碰 asg-harness2-bypass、m3 链路、gstack.v6。

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

parse_args "04-docpack-logfix.sh" "$@"
require_root_if_apply

CONTAINER="$WAGATE_CONTAINER"
BAK="$DOCPACK.bak.diagfix.$(ts)"
TMP_NEW="$(dirname "$DOCPACK")/.doc-pack.ts.new.$$"
TMP_LOG="/tmp/eu-fix-04-bun-build.$$.log"

print_mode_banner "doc-pack.ts ANCHOR-DIAG 日志行删除（保 inode）"

# ---------------------------------------------------------------------------------
step "第 1 步：前置检查"
if ! command -v docker >/dev/null 2>&1; then
  die "找不到 docker 命令，无法做容器内校验，拒绝执行。"
fi
[ -f "$DOCPACK" ] || die "补丁文件不存在：$DOCPACK"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "容器不存在或不可访问：$CONTAINER"

info "目标文件：$DOCPACK"
info "命中行数：$(grep -c "$DOCPACK_TAG" "$DOCPACK" || true)（期望恰好 1）"
info "第 327 行内容预览："
if is_apply; then sed -n '327p' "$DOCPACK" | cut -c1-200 | sed 's/^/    | /'; else printf '    [dry-run] sed -n 327p %s\n' "$DOCPACK"; fi

# ---------------------------------------------------------------------------------
step "第 2 步：备份 + 生成临时新文件（grep -v，只减行不增行）"
HITS="$(grep -c "$DOCPACK_TAG" "$DOCPACK" || true)"
[ "$HITS" -eq 1 ] || die "含 '$DOCPACK_TAG' 的行数为 $HITS（期望 1），为避免误删，拒绝继续。"

run "备份原文件" cp -a "$DOCPACK" "$BAK"
run "生成临时文件（删除含 $DOCPACK_TAG 的整行）" sh -c "grep -v '$DOCPACK_TAG' '$DOCPACK' > '$TMP_NEW'"

if is_apply; then
  OLD_LINES="$(wc -l < "$DOCPACK")"
  NEW_LINES="$(wc -l < "$TMP_NEW")"
  info "行数：$OLD_LINES -> $NEW_LINES（应恰好 -1）"
  [ "$NEW_LINES" -eq "$((OLD_LINES - 1))" ] || die "行数变化不是 -1，中止（未覆盖原文件）。"
  info "残留 ANCHOR-DIAG 行数：$(grep -c "$DOCPACK_TAG" "$TMP_NEW" || true)（期望 0）"
fi

# ---------------------------------------------------------------------------------
step "第 3 步：保 inode 覆盖（cat > 而不是 sed -i / mv）"
if is_apply; then
  OLD_INODE="$(stat -c %i "$DOCPACK")"
  printf '[exec] cat %s > %s   （保持 inode）\n' "$TMP_NEW" "$DOCPACK"
  cat "$TMP_NEW" > "$DOCPACK"
  NEW_INODE="$(stat -c %i "$DOCPACK")"
  info "inode：$OLD_INODE -> $NEW_INODE（必须相同）"
  [ "$OLD_INODE" = "$NEW_INODE" ] || die "inode 变了！说明覆盖方式不对，请立刻用备份恢复。"
  rm -f -- "$TMP_NEW"
  info "inode 保持不变，覆盖成功。"
  printf '[info] 不要使用 sed -i / mv 修改本文件：它们会换 inode，容器内 bind mount 将看不到更新。\n'
else
  printf '[dry-run] 将执行：\n'
  printf '          $ old_inode=$(stat -c %%i %s)\n' "$DOCPACK"
  printf '          $ cat %s > %s      # 保持 inode，严禁 sed -i / mv\n' "$TMP_NEW" "$DOCPACK"
  printf '          $ new_inode=$(stat -c %%i %s); [ "$old_inode" = "$new_inode" ]\n' "$DOCPACK"
fi

# ---------------------------------------------------------------------------------
step "第 4 步：宿主与容器内 md5 一致性"
if is_apply; then
  HOST_MD5="$(md5sum "$DOCPACK" | awk '{print $1}')"
  CMD_MD5="$(docker exec "$CONTAINER" md5sum "$DOCPACK_CONTAINER_FILE" 2>/dev/null | awk '{print $1}' || true)"
  info "宿主 md5：$HOST_MD5"
  info "容器 md5：$CMD_MD5"
  [ -n "$CMD_MD5" ] || die "无法读取容器内文件 md5（容器路径 $DOCPACK_CONTAINER_FILE 是否正确？）"
  [ "$HOST_MD5" = "$CMD_MD5" ] || die "宿主与容器内 md5 不一致 → 容器挂载未生效，请检查挂载方式后重试。"
  info "md5 一致。"
else
  printf '[dry-run] 将执行：\n'
  printf '          $ md5sum %s\n' "$DOCPACK"
  printf '          $ docker exec %s md5sum %s     # 两者必须一致\n' "$CONTAINER" "$DOCPACK_CONTAINER_FILE"
fi

# ---------------------------------------------------------------------------------
step "第 5 步：容器内 bun build 校验（退出码单独捕获，严禁管道吃退出码）"
if is_apply; then
  set +e
  docker exec "$CONTAINER" sh -c "cd /app && bun build ./extensions/plugins/doc-pack.ts --target=bun > $TMP_LOG 2>&1"
  RC=$?
  set -e
  info "bun build 退出码：$RC"
  tail -n 20 "$TMP_LOG" 2>/dev/null | sed 's/^/    | /' || true
  [ "$RC" -eq 0 ] || die "bun build 失败（RC=$RC）。请用备份恢复后排查，未重启容器。"
  info "构建校验通过。"
else
  printf '[dry-run] 将执行（注意：RC 必须单独捕获）：\n'
  printf '          $ docker exec %s sh -c "cd /app && bun build ./extensions/plugins/doc-pack.ts --target=bun > %s 2>&1"; RC=$?\n' "$CONTAINER" "$TMP_LOG"
  printf '          $ [ "$RC" -eq 0 ] || 中止     # 严禁写成 ... | tail 这类管道，管道会吃掉退出码\n'
fi

# ---------------------------------------------------------------------------------
step "第 6 步：重启 wagate 并做运行时 SMOKE"
if is_apply; then
  printf '[exec] docker restart %s\n' "$CONTAINER"
  docker restart "$CONTAINER" >/dev/null
  sleep 3
  SMOKE_OUT="$(docker exec "$CONTAINER" bun -e 'await import("/app/extensions/plugins/doc-pack.ts"); console.log("SMOKE_OK")' 2>&1 || true)"
  printf '%s\n' "$SMOKE_OUT" | sed 's/^/    | /'
  printf '%s\n' "$SMOKE_OUT" | grep -q 'SMOKE_OK' || die "运行时 SMOKE 未输出 SMOKE_OK → 插件加载失败，请立即回滚。"
  info "SMOKE_OK：插件可正常导入。"
  info "journal 最近 20 行（检查有无新错误）："
  docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    | /' || true
else
  printf '[dry-run] 将执行：\n'
  printf '          $ docker restart %s && sleep 3\n' "$CONTAINER"
  printf '          $ docker exec %s bun -e '\''await import("/app/extensions/plugins/doc-pack.ts"); console.log("SMOKE_OK")'\''\n' "$CONTAINER"
  printf '          $ docker logs --tail 20 %s        # 期望无新的 error/plugin 加载失败\n' "$CONTAINER"
fi

step "完成"
info "回退命令（务必用 cat，不要用 mv / sed -i）："
info "    cat $BAK > $DOCPACK && docker restart $CONTAINER"
if is_apply; then
  info "备份文件：$BAK"
else
  info "以上为 dry-run 计划，未改动文件、未重启容器。确认无误后执行：sudo $0 --apply"
fi
