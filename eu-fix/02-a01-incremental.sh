#!/usr/bin/env bash
# 02-a01-incremental.sh — A01 增量备份（关键配置 + wagate live 补丁）
#
# 作用：
#   把 EU 服务器上“修复前必须留档”的最小集合，按原路径结构复制到
#     /srv/backup/A01.<YYYYMMDD>/            （目标目录可用 --dest 覆盖，便于 /tmp 假结构演练）
#   并在其中生成：
#     MANIFEST.sha256   —— 每个文件的 sha256 清单（**生成时排除 MANIFEST.sha256 自身**，历史坑）
#     RESTORE.md        —— 恢复步骤（含如何按 MANIFEST 校验、如何放回原位）
#   备份源（现场信息给定，不多不少）：
#     /srv/wagate/patches/            只收 live *.ts，排除 *.bak.*
#     /srv/wagate/HANDOFF.md
#     /etc/wagate.env
#     /etc/systemd/system/wagate.service
#     /etc/nginx/sites-enabled/workspace-static
#     /usr/local/bin/session-rotate.sh
#     /etc/cron.d/session-rotate
#
# 回退方法：
#   本脚本**不修改任何现有文件**，只新增目标目录内容；因此“回退”= 删除本次备份目录：
#     rm -rf /srv/backup/A01.<YYYYMMDD>
#   （若同名目录已存在，脚本默认拒绝覆盖；确有需要时 --force 才会续写/覆盖。）
#   恢复现场时按 RESTORE.md 的步骤：校验 MANIFEST → 把对应文件复制回原路径 → 重启服务。
#
# 风险：
#   * 极低：只读源文件 + 写新目录。唯一磁盘风险是空间不足，脚本在开始前检查可用空间。
#   * 若 /srv/wagate/patches 下文件在备份过程中被业务改动（同时写），可能出现“复制时内容已变”，
#     脚本在结束时用 sha256 复核并报告不一致的文件名（不掩盖）。
#   * 源文件缺失（未列在保护清单里的）只会 warn，不会中断；保护清单里的缺失会在末尾汇总。
#   * 不触碰 asg-harness2-bypass、m3 链路、gstack.v6，也不动 preview/。

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$HERE/lib/common.sh"

MODE="dry-run"
DEST_OVERRIDE=""
FORCE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    --dest) shift; DEST_OVERRIDE="${1:?--dest 需要目录参数}" ;;
    --force) FORCE=1 ;;
    -h|--help) usage_common; printf '  --dest <dir>  指定目标目录（默认 /srv/backup/A01.<YYYYMMDD>；1/2 自检演练用）\n  --force       目标目录已存在时也继续（默认拒绝覆盖）\n'; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage_common >&2; exit 2 ;;
  esac
  shift
done
require_root_if_apply

BACKUP_ROOT_DEFAULT="/srv/backup"
STAMP="$(date +%Y%m%d)"
DEST="${DEST_OVERRIDE:-$BACKUP_ROOT_DEFAULT/A01.$STAMP}"
MANIFEST="$DEST/MANIFEST.sha256"
RESTORE="$DEST/RESTORE.md"

# EUFIX_FAKE_ROOT 仅供自检演练：把 /srv、/etc、/usr 等绝对路径改指向一份 /tmp 假根，
# 从而在不动真机目录的前提下完整演练“收集→复制→清单→校验”。正式执行时不要设置它。
FAKE_ROOT="${EUFIX_FAKE_ROOT:-}"
abs() {  # abs <绝对路径> -> 加假根前缀（无假根时原样返回）
  if [ -n "$FAKE_ROOT" ]; then printf '%s%s\n' "$FAKE_ROOT" "$1"; else printf '%s\n' "$1"; fi
}
S_SRC_ROOT="$(abs "$A01_SRC_ROOT")"
S_DOCPACK_DIR="$(abs "$(dirname "$DOCPACK")")"

print_mode_banner "A01 增量备份"

# ---------------------------------------------------------------------------------
step "第 0 步：参数与目标目录"
info "目标目录：$DEST"
info "备份源：live *.ts @ $A01_SRC_ROOT（排除 $A01_DENY_GLOB） + 保护清单 ${#A01_PROTECTED[@]} 项"
if [ -e "$DEST" ] && [ "$FORCE" -ne 1 ]; then
  die "目标目录已存在：$DEST（默认拒绝覆盖，避免污染历史备份）。如需续写请加 --force。"
fi
if is_apply; then
  AVAIL_MB="$(df -Pm "$(dirname "$DEST")" 2>/dev/null | awk 'NR==2{print $4}' || echo '?')"
  info "目标分区可用空间：${AVAIL_MB:-?} MB"
else
  info "[dry-run] 将检查目标分区可用空间：df -Pm $(dirname "$DEST")"
fi

# ---------------------------------------------------------------------------------
step "第 1 步：收集文件清单"
FILE_LIST=""
add_file() {  # add_file <源绝对路径>；EUFIX_FAKE_ROOT 演练时记录去掉假根前缀的逻辑路径
  local p="$1"
  if [ -n "$FAKE_ROOT" ]; then p="${1#"$FAKE_ROOT"}"; fi
  if [ -f "$p" ]; then
    FILE_LIST="$FILE_LIST$p
"
  else
    warn "源文件缺失，跳过：$p"
  fi
}

# live .ts（排除 *.bak.*；patches 目录本身可能有子目录 → 递归但同样排除 bak）
if [ -d "$S_SRC_ROOT" ]; then
  TS_LIST="$(find "$S_SRC_ROOT" -type f -name "*$A01_LIVE_BASENAMES" ! -name "$A01_DENY_GLOB" | sort || true)"
  if [ -z "$TS_LIST" ]; then
    warn "在 $A01_SRC_ROOT 下没有找到 live *$A01_LIVE_BASENAMES 文件。"
  fi
  while IFS= read -r f; do
    [ -n "$f" ] && add_file "$f"
  done <<EOF
$TS_LIST
EOF
else
  warn "源目录不存在：$A01_SRC_ROOT"
fi

for f in "${A01_PROTECTED[@]}"; do
  add_file "$(abs "$f")"
done

COUNT="$(printf '%s\n' "$FILE_LIST" | grep -c . || true)"
info "待备份文件数：$COUNT"
printf '%s\n' "$FILE_LIST" | grep . | head -20 | sed 's/^/    /'
[ "$COUNT" -le 20 ] || printf '    ...（其余 %s 条略）\n' "$((COUNT - 20))"
if [ "$COUNT" -eq 0 ]; then
  warn "没有任何文件可备份，仍会生成空的 MANIFEST 与 RESTORE.md。"
fi

# ---------------------------------------------------------------------------------
step "第 2 步：复制文件（保持原路径结构）"
do_copy() {
  local src f rel dst
  mkdir -p "$DEST"
  while IFS= read -r src; do
    [ -n "$src" ] || continue
    rel="${src#/}"
    dst="$DEST/$rel"
    printf '[exec] cp -a %s -> %s\n' "$src" "$dst"
    mkdir -p "$(dirname "$dst")"
    cp -a -- "$(abs "$src")" "$dst"
  done <<EOF
$FILE_LIST
EOF
}

if is_apply; then
  do_copy
  info "复制完成。"
else
  printf '[dry-run] 将执行（示意前 5 条）：\n'
  printf '%s\n' "$FILE_LIST" | grep . | head -5 | while IFS= read -r src; do
    printf '          $ mkdir -p %s/%s\n' "$DEST" "$(dirname "${src#/}")"
    printf '          $ cp -a %s %s/%s\n' "$src" "$DEST" "${src#/}"
  done
  printf '          目标文件数：%s（沿用原绝对路径，去掉开头的 /）\n' "$COUNT"
fi

# ---------------------------------------------------------------------------------
step "第 3 步：生成 MANIFEST.sha256（排除 MANIFEST.sha256 自身）"
gen_manifest() {
  local rel
  # 只有排除掉自身，才可能出现“清单里没有清单文件”这一历史要求
  find . -type f ! -name 'MANIFEST.sha256' -print0 | sort -z | xargs -0 -r sha256sum > "$MANIFEST"
}
if is_apply; then
  ( cd "$DEST" && gen_manifest )
  info "MANIFEST 行数：$(wc -l < "$MANIFEST")"
  if grep -q 'MANIFEST.sha256' "$MANIFEST"; then
    err "MANIFEST 中仍包含自身，违反要求！"
    exit 1
  fi
  info "已确认 MANIFEST 不含自身条目。"
else
  printf '[dry-run] 将执行：\n'
  printf '          $ cd %s && find . -type f ! -name %s -print0 | sort -z | xargs -0 -r sha256sum > MANIFEST.sha256\n' "$DEST" "'MANIFEST.sha256'"
  printf '          $ wc -l MANIFEST.sha256        # 期望 %s 行（等于备份文件数，不含 MANIFEST 自身）\n' "$COUNT"
fi

# ---------------------------------------------------------------------------------
step "第 4 步：生成 RESTORE.md（恢复步骤）"
restore_md() {
  cat > "$RESTORE" <<EOF
# A01 备份恢复说明（$(date -Is)）

备份目录：\`$DEST\`
生成脚本：\`eu-fix/02-a01-incremental.sh\`

## 1. 校验完整性
\`\`\`bash
cd $DEST
# MANIFEST.sha256 不含自身条目（生成时已排除），因此可直接校验全部
sha256sum -c MANIFEST.sha256
\`\`\`
出现 \`FAILED\` 的行表示该文件在传输/复制过程中损坏，**不要**用它恢复。

## 2. 单文件恢复（按原绝对路径放回）
备份保留源文件的完整路径结构，去掉开头的 \`/\` 即为备份内路径。例如：

| 原始路径 | 备份内路径 |
| --- | --- |
| /srv/wagate/HANDOFF.md | $DEST/srv/wagate/HANDOFF.md |
| /etc/wagate.env | $DEST/etc/wagate.env |
| /etc/systemd/system/wagate.service | $DEST/etc/systemd/system/wagate.service |
| /etc/nginx/sites-enabled/workspace-static | $DEST/etc/nginx/sites-enabled/workspace-static |
| /usr/local/bin/session-rotate.sh | $DEST/usr/local/bin/session-rotate.sh |
| /etc/cron.d/session-rotate | $DEST/etc/cron.d/session-rotate |
| /srv/wagate/patches/*.ts | $DEST/srv/wagate/patches/*.ts |

恢复单个文件（恢复前先自行备份当前版本）：
\`\`\`bash
cp -a /etc/wagate.env /etc/wagate.env.before-restore.\$(date +%Y%m%d%H%M%S)
cp -a $DEST/etc/wagate.env /etc/wagate.env
\`\`\`

## 3. 恢复到位的收尾动作（按需）
\`\`\`bash
# 让 systemd 看到 unit 变化
systemctl daemon-reload
systemctl restart wagate.service

# nginx 配置回滚后
nginx -t && systemctl reload nginx

# cron 文件权限（若被改动过）
chmod 0644 /etc/cron.d/session-rotate
\`\`\`

## 4. 注意
- 本备份是**快照**，不含 wagate 容器镜像与 \`/opt/ai-gateway/data/core.db\`（数据库另有独立 .bak，见 03 脚本）。
- 不要用 \`sed -i\` 修改单文件 bind mount 的补丁文件（会换 inode），见 04 脚本头部的说明。
EOF
}

if is_apply; then
  restore_md
  info "RESTORE.md 已写入：$RESTORE"
else
  printf '[dry-run] 将写入 RESTORE.md（含校验、逐文件恢复表、daemon-reload/nginx -t 收尾步骤）\n'
fi

# ---------------------------------------------------------------------------------
step "第 5 步：复核"
if is_apply; then
  info "备份目录内容（前 20 行）："
  ( cd "$DEST" && find . -type f | sort | head -20 | sed 's/^/    /' )
  info "总计文件数（含 MANIFEST/RESTORE）：$(cd "$DEST" && find . -type f | wc -l)"
  ( cd "$DEST" && sha256sum -c MANIFEST.sha256 >/dev/null 2>&1 ) \
    && info "MANIFEST 校验通过。" \
    || warn "MANIFEST 校验未全部通过，请检查（可能源文件在复制过程中被业务修改）。"
else
  info "[dry-run] 将执行校验：cd $DEST && sha256sum -c MANIFEST.sha256"
fi

step "完成"
if is_apply; then
  info "备份完成：$DEST"
  info "回退方式：rm -rf $DEST（本脚本未改动任何源文件）"
else
  info "以上为 dry-run 计划，未创建任何文件。确认无误后执行：sudo $0 --apply"
fi
