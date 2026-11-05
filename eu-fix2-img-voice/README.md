# eu-fix2-img-voice — EU 沙箱 图片/视频链入口恢复 (P0)

> 关联 issue: [#21](https://github.com/VBK-AI-Agent-Gateway/superagent-playground/issues/21)
> 交付形态：**只产出脚本，本仓库不执行任何 EU 侧命令**。操作员在 EU 沙箱 (wagate) 审阅后手工执行。
> 前单 e7d323dd 被看门狗误杀（17 分钟零写入），本单以小步落盘节奏重建。

## 交付物清单

| 文件 | 作用 |
| --- | --- |
| `10-prepare.sh` | 备份 + 锚文本断言 + python3 改写（保 inode）+ img-* 复制 md5 + unit 挂载 + bun 语法校验。**不重启** |
| `20-apply.sh` | 硬守卫（ledger state='running'）+ daemon-reload + 单次 restart + 健康门 + CONCLUSION |
| `30-rollback.sh` | 恢复全部 .bak（保 inode）+ 还原 unit + daemon-reload + 守卫重启 |
| `40-admission/INVESTIGATION.md` | 坑#30 admission 长寿会话只读调查（VM 只读，禁 stop/start/restart dsh） |
| `diag-v1.1/` | 诊断脚本 v1.1.0（修 3 类 bug，原版在分支 `agent/eu-diag-voice-img-0c3ba02879fb`） |

## 背景（一行）

wagate 语音链全通；**图片/视频链入口断链**——`telegram.ts` 只处理 `document` + `voice`，
photo/video 消息在 L235 守卫处被直接 `return` 丢弃，永远到不了 `bot.ts` / tenant-core / img-lab。

## 修改面（4 个 host 挂载文件 + 1 个 unit，均保 inode）

- `telegram.ts`：守卫加 `!msg.photo && !msg.video`；新增 photo 分支（→ `message.image`）、video 分支（→ `message.video`）
- `bot.ts`：透传 `videos:` 给 core.handle；video-only hold（`G.__videoPending`）+ 下条文本合并；dedupKey 并入附件长度
- `img-ops.ts` / `img-lab.ts`：**内容零改动**，仅从容器复制到 `/srv/wagate/patches/` 并加 ro 挂载（md5 校验字节一致）
- `wagate` unit：` wagate:3` 前插入两条 read-only 挂载（**禁 mask**，坑#31）

## Runbook

```bash
# 0) 传包到 VM
scp -r eu-fix2-img-voice/ root@<vm>:/root/

# 1) 准备（改盘、不重启；失败不落盘）
bash /root/eu-fix2-img-voice/10-prepare.sh
#    期望输出: 每条锚断言 OK / md5 一致 / bun build rc=0 / PREPARE OK

# 2) 应用（硬守卫 + 重启 + 健康门）
bash /root/eu-fix2-img-voice/20-apply.sh
#    若守卫报 running 工单而你认为安全，需显式: bash 20-apply.sh --force
#    期望末行: CONCLUSION: OK

# 3) 验证（人工，见下）
```

## 回滚手册

```bash
bash /root/eu-fix2-img-voice/30-rollback.sh
#  恢复全部 .bak（cat > 目标，保 inode）+ 还原 unit + daemon-reload + 守卫重启
#  期望末行: ROLLBACK OK
```

任何一步异常都先 `30-rollback.sh`，再排查。备份目录：`/root/eu-fix2-img-voice.bak.<ts>/`。

## 遗留验证项

- [ ] **真实 TG 图片回归**：需真人向 bot 发一张图 + 一句要求（如"把这张图放大两倍"），确认 img-lab 收到 `image`。
- [ ] **真实 TG 视频回归**：发一段短视频 + 要求（如"剪掉前 2 秒"），确认 `G.__videoPending` → `videos:` 合并链路。
- [ ] **裸视频 hold 文案**：仅发视频不加文字时，应回"已收到视频。请说明你的要求…"，且**不得**触发 upload-ops 落盘。
- [ ] `tenants` ledger 在 restart 后 state 正常回到 `running`。

## 已知限制：dedup

`bot.ts` 的 `dedupKey` 原为 `${m.channelId}\u0000${text}`。连续两条裸图/裸视频 `text` 均为空串，
2500ms 内第二条会被去重吞掉。v1 修复把附件长度并入 key（`image?.data.length` / `video?.data.length`），
使不同附件不再互相覆盖；但**同一张图在 2.5s 内连发两次仍会被去重**——这是有意的防重放行为，不视为缺陷。
