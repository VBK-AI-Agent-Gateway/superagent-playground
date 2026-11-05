#!/usr/bin/env bash
# =============================================================================
# eu-fix2-img-voice / 20-apply.sh   —  issue #21 交付物 ①
# EU 沙箱 wagate 图片/视频链入口恢复
#
# 结构（最终形态）:
#   [0] 通用: 常量 / 日志 / 断言 / 保 inode 写
#   [1] 前置检查 (root / 目标存在 / 工具存在)
#   [2] 备份 -> /root/eu-fix2-img-voice.bak.<ts>/
#   [3] 锚文本断言 (每锚恰好 1 次; 失败立即退出, 不落盘)
#   [4] python3 改写到临时文件 -> cat tmp > 目标 (保 inode)
#   [5] [仅 prepare] 容器复制 img-*.ts + md5 校验
#   [6] [仅 prepare] unit 备份 + 插挂载 + grep 断言
#   [7] [仅 prepare] bun build <file> --no-bundle 真 rc 语法校验
#   [8] [仅 apply] 硬守卫: ledger.db state='running'
#   [9] [仅 apply] daemon-reload + docker restart wagate + 健康门
# 铁律: 不 mask unit(坑#31); tenant-core/upload-ops/aa-voice/aa-tts 禁改
# =============================================================================
set -euo pipefail

# --- 常量 -------------------------------------------------------------------
PATCH_DIR="/srv/wagate/patches"
SRC_DIR="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
BAK_DIR="/root/eu-fix2-img-voice.bak.$(date +%Y%m%d-%H%M%S)"
UNIT="/etc/systemd/system/wagate.service"
HOST_FILES=(/srv/wagate/telegram.ts /srv/wagate/bot.ts)
CONT_FILES=(img-ops.ts img-lab.ts)

# --- 日志 -------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf '[FATAL] %s\n' "$*" >&2; exit 1; }
