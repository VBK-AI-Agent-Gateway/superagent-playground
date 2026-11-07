# EVIDENCE.md —— 29 项全功能证据矩阵（终版，已回填）

> 取证轮次：2026-11-07 04:27-04:35 UTC（01-05 脚本全量）+ 07:0x UTC（图片链修复后 E2E 实录）。
> 执行：EU 5.189.129.216（01-04，root 只读）+ VM 192.168.58.133（05）。取证包 = PR #65（已合并）。
> 甄别规则：脚本误报项保留原始 FAIL 行供审计，判定改为实际状态并标注；用户决策挂起项单列。

## 0. 执行元信息

| 项 | 值 |
| --- | --- |
| 取证轮次 | 2026-11-07 04:27 UTC（v1）+ v2 复跑（守卫/桥接修复后）+ 07:0x 图片 E2E |
| EU 主机 | 5.189.129.216（vmi3595830，指纹 f27b3de3dc02d79f） |
| VM 主机 | 192.168.58.133 |
| 原始输出 | EU /tmp/em-results/（01-05 共 7 份 .out） |
| 总体结论 | **29 项：PASS 24 · 用户决策挂起 3 · 需人工回归 2（相机通道/语音轮次）· 脚本误报甄别 4** |

## 1. G1 — 入口与多模态

| 条目 | 判定 | 证据原文摘录 | 采集时间(UTC) | 备注 |
| --- | --- | --- | --- | --- |
| 1.1 文本入口+多租户 | PASS | `[bot] inbound 19 条(48h)`；telegram.ts 790 行入口分支 L207 | 11-07T04:27 | 租户注册表 3 账号 |
| 1.2 STT（DeepInfra 实call） | PASS | `HTTP 200，{"text":""}`（1s 静音 wav）；密钥 600 权限指纹 tjw0S7****jWXg | 11-07T04:27 | |
| 1.3 TTS（opus→OggS） | PASS | 生产形态 11-05 全绿（200+OggS 魔数）；本轮对照组误用 openai/tts-1 报 404 = **脚本误报**（原始 FAIL 行存 .out） | 11-05 全绿 / 11-07 甄别 | 真实语音轮次回归待用户 |
| 1.4 照片→vision / 文件图→处理 | **PASS（E2E）** | 文件通道实录：`uploaded file saved 龙虾中医馆.jpg 65910B` → `img bridge: source-latest.jpg synced` → `toolcall-fire #0 tool=img_ops` → `execute op=grayscale src=source-latest.jpg`（ffmpeg）→ `[bot] sent image to 8879982767: img-ops-*.png` | **11-07T07:0x** | 相机 photo 通道=用户端上传故障（服务器 24h 零到达）；文件通道为推荐路径 |
| 1.5 视频→img-lab | PASS（代码级） | telegram.ts video 分支 L322-333 + bot.ts `videos:` 透传 L415 + img-lab VIDEO_B64_RE 命中 | 11-07T04:27 | **真实发视频回归待用户** |
| 1.6 文档→file-only hold | PASS | fixA2 多文件队列 L218-223（N进N出）；48h file-only hold 2 条 | 11-07T04:27 | |
| 1.7 dedupKey 媒体维度 | PASS | L272 dedupKey 含 image/video 长度维度；48h 去重命中 4 条 | 11-07T04:27 | |

## 2. G2 — 交付链与模型池

| 条目 | 判定 | 证据原文摘录 | 采集时间(UTC) | 备注 |
| --- | --- | --- | --- | --- |
| 2.1 TG 回复送达 | PASS | sendMessage L491/494/590；48h 出站日志 34 条；今日 `[bot] sent image to 8879982767` | 11-07T07:0x | 首轮 FAIL=脚本 grep 窗口误报 |
| 2.2 长文切分 | PASS | MAX_LEN=4096 循环切片 L103/105/321；48h 切分痕迹 37 条 | 11-07T04:28 | |
| 2.3 图片出站 `[IMG:路径]` | PASS | L436-442 标记解析+路径白名单；今日成品图即经此通道 | 11-07T07:0x | |
| 2.4 语音出站（TTS） | PASS | sendVoice L538-545（multipart opus ogg）；48h TTS/语音日志 54 条 | 11-07T04:28 | |
| 2.5 视频/文件出站 | PASS | sendDocument L515-529 | 11-07T04:28 | |
| 2.6 WhatsApp 通道 | INFO | 适配器在位（md5 e232797d）；48h WA 活动 0 条（WA_SKIP=default 设计禁用） | 11-07T04:28 | 启用=新需求 |
| 2.7 顺序与并发 | PASS | progressRoute 串行路由 L179/244 + fixA2 文件队列保序 | 11-07T04:28 | |
| 2.8 /stop 立即中断 | PASS | stopIntent L131-133 + __abortActive 直断 L208-209 | 11-07T04:28 | 真实中断回归待用户 |
| 2.9 失败可见性 | PASS | 处理失败回诊断文案 L426-428；48h 异常 2 条（今日图片任务即实证：错误如实回用户） | 11-07T04:28 | |
| 2.10 长任务进度回传 | PASS | progressRoute 注册+推送 L254；48h 进度日志 64 条 | 11-07T04:28 | |
| 2.11 模型白名单与路由 | PASS×2 / 用户决策挂起×2 | GLM-5.3-Flash 200/1.5s + GLM-5.3 200/1.26s + m3 200/34s 实call；gemma4+Qwen3.8 = 502（channel 13 双重断点：gemma4 源侧 llama-server 崩溃+隧道域名失效） | 11-07T04:29 | **用户决策暂不修**；401/403 边界 PASS |
| 2.12 tgpush-poll 挂载 | PASS | 挂载 vendor-pi-gateway-src = **坑#35 修正后设计**（非工厂脚本禁入扫描区）；runner 直调实测 `[tgpush] 映射为空` 正常；脚本查 plugins/ 的判定过时 | 11-07T04:29 | |
| 2.13 密钥边界 | PASS | secrets 全部 600（deepinfra_stt/github_pat）；token 不出服务器 | 11-07T04:29 | |
| 2.14 串行模型调用 | PASS（部分） | 串行 5 模型实call完成（无并发压测，遵守单 runner 禁忌）；401/403 边界 PASS | 11-07T04:29 | |

## 3. G3 — 数字 AI 员工

| 条目 | 判定 | 证据原文摘录 | 采集时间(UTC) | 备注 |
| --- | --- | --- | --- | --- |
| 3.1 能力/技能可枚举 | PASS | skill-tools v2 md5 929a36ef 在位；skills 目录 100 包 11 岗位（skill_ls/skill_read 直达 11-03 实测） | 11-03 / 11-07 | 脚本查 EU /root/.pi 路径不适用（技能在 wagate 容器挂载） |
| 3.2 VM 侧收口 | PASS | 05-vm-closeout：watchdog/sa-deliver/deliver-state/redispatch 7 项 PASS | 11-07T04:35 | 看门狗今日实战：3 次 FLAG→STOP→自动重派 |
| 3.3 指令理解与多步执行 | PASS | 今日全程实证：#61/#67 两张工单 issue→admission→worker→交付；图片任务模型 9 次自救后主动停止空转并给用户二选一 | 11-07 | |
| 3.4 模型定价完整性 | 用户决策挂起 | ai-gateway model_configs 缺 m3；沙箱 billing.db 5 白名单模型全无定价；24h 2 条 "no pricing" 报错 | 11-07T04:29 | **用户决策暂不修**（脚本部分路径误报已甄别） |
| 3.5 管理面/暴露面 | PASS（带注） | 19000/3001 本机监听（脚本"无响应"=未带鉴权访问，实际在位）；NetBird 8443 需 HTTPS（脚本用 http=误报）；8888 无 TLS=已知既存 | 11-07T04:29 | TLS=用户决策挂起 |
| 3.6 出站审计 | PASS | aa-outbound-audit 插件在位；今日 tool_call/message_end 事件 emit-ok 200 多条（Inngest 侧实证） | 11-07T07:0x | 脚本候选路径未命中=误报 |

## 4. 汇总

| 汇总项 | 数量 |
| --- | --- |
| PASS（含带注 PASS） | 24 |
| 用户决策挂起（原 FAIL，用户明示不修） | 3（channel13 模型×2 计 1 项 / 定价 / TLS） |
| 需人工回归 | 2（真实发视频 / 真实语音轮次；相机 photo 通道等用户端网络） |
| 脚本误报（已甄别，原始行存档） | 4（TTS 对照名 / sendMessage 位置 / tgpush 查错目录 / 审计路径） |

## 5. 人工回归清单（更新）

1. ~~真实 TG 图片→处理→成品回传~~ ✅ **已完成（11-07：文件图+grayscale+成品送达）**
2. 真实 TG **视频**发送 → img-lab 处理（代码链已核，待实测）
3. 真实 TG **语音**轮次（STT/TTS 11-05 全绿，本轮未重跑）
4. 相机 photo 通道（用户端媒体上传修复后自然验证）

## 6. 已修复项（本轮取证期间的判定变化来源）

| 补丁 | 备份 | 影响矩阵项 |
| --- | --- | --- |
| imgunlock（route-guard 移出 img_ops/img_lab） | aa-dev-route-guard.ts.bak.imgunlock.20261107-044229 | 1.4 / 3.3（死锁解除） |
| imgdoc-bridge（upload-ops 保存点→source-latest） | upload-ops.ts.bak.imgbridge.20261107-061242 | 1.4（文件图可处理） |
| imgdoc-task-guidance（文件任务指引重写，file_handler 幽灵根治） | 同上 bak 内含 | 1.6 / 3.3（文件任务出生即活路） |
