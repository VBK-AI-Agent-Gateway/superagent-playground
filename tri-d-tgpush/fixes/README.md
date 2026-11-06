# fixes/ —— 故障修复 D：工单结果 TG 回传

## 这条修复解决什么

**症状（真实事故）**：用户在 TG 说「开发一套 crm 系统」→ 规划官派单成功 → **之后 90 分钟零回音** → 用户以为卡死，手动停掉工单。

**病根**：`dispatch_dev` 只做了「去程」。它把重活派成 GitHub 工单之后，返回一句「等工单结果回传」就结束了。但**回程根本不存在**：

- `aa-dev-dispatch.ts` 派单成功后只写审计日志，没有任何把结果送回 TG 的代码；
- 工单在 GitHub 上跑完（或失败）时，没有任何组件知道「这张工单对应哪个 TG 会话」；
- 于是「等工单结果回传」这句话在实现上是空头支票 —— 这正是 fast-route Phase 2 的已知缺口。

**修法**：给派单链路补上回程三件套 —— **登记 → 盯梢 → 回传**。

```
用户 TG 消息
   │
   ▼
dispatch_dev 派单 ──► ① 登记 sid→工单 到 /srv/wagate/dispatch-mapping.json
   │                        （chatKey 由 bot.ts 现成的 __sidChat 取得）
   │  "已派单，等结果回传"
   ▼
GitHub 工单跑起来
   ▲
   │  ② 每分钟一次：aa-dev-tgpush-runner.sh → 容器内跑 aa-dev-tgpush-poll.ts
   │     查 issue 状态 / 关联 PR（GitHub 事实，不猜）
   │
   └──► ③ 一旦有终态：发一条 TG（✅ 完成给链接 / ⚠️ 未完成给原因）
             成功才写 pushed=true（幂等：重跑 0 重复推送）
```

## 三个文件

| 文件 | 位置（EU 5.189.129.216） | 作用 |
| --- | --- | --- |
| `fixD-tgpush.sh` | 本目录（仓库） | 一键执行本次修复：备份 → 锚点改写 `aa-dev-dispatch.ts` → 生成 poller/runner → 构建验证 → 受控重启 → 健康门禁。默认 dry-run。 |
| `aa-dev-tgpush-poll.ts` | `/srv/wagate/patches/`（由脚本生成） | 回程主体。轮询工单终态、发 TG、写幂等标记、失败入告警日志。零 npm 依赖。 |
| `aa-dev-tgpush-runner.sh` | `/srv/wagate/patches/`（由脚本生成） | 每分钟跑一次 poller，单实例锁（flock，降级为 mkdir 锁），`timeout 55` 防卡死。 |

被改动的既有文件只有两个位置（共约 60 行）：

1. `aa-dev-dispatch.ts` 的 `node:fs` import 增加 `writeFileSync, renameSync`；
2. `export default` 之前插入「登记与回传地址」工具函数区，并在派单成功的返回之前插入一次 `writeDispatchMapping(...)`。

**不改** `bot.ts`、`tenant-core.ts`、`telegram.ts` —— 回程地址直接复用 `bot.ts` 早已维护的 `globalThis.__sidChat`（`sid → "platform:channelId"`），不需要新增路由注册表。

## 怎么做才算「修好了」

按 issue #40 的三条要求逐条对照：

| 要求 | 本修复怎么满足 |
| --- | --- |
| ① 机械门禁（fail-closed） | 补丁本身 fail-closed：锚点必须**恰好匹配 1 次**（多/少都中止，绝不按行号切分）；改写后校验注入标记在位；`bun build` rc 必须为 0；健康门禁五项（容器 Up、启动日志无 FATAL/ParseError、容器内 bun 冒烟、宿主/容器 md5 一致、TG getMe ok）任一不过 → **自动回滚并退出非 0**。 |
| ② 机械回归（一键重跑） | `regr/regrD.sh` 一条命令跑完：合成工单 → 等回传 ≤2 分钟 → 校验消息含链接 → **再跑一遍验证 0 重复推送** → 打印 PASS/FAIL。 |
| ③ 通知（绝不静默） | 双层。**终态回传**：工单一旦有结论，用户必定收到一条 TG（含状态与链接）。**静默门禁**：派单后 30 分钟仍无终态，poller 主动发一条「已派单 N 分钟，仍在跑」的进度消息 —— 即使工单卡住，用户也不会再经历 90 分钟静默。发送失败不写 `pushed`，下一轮重试；连续失败进 `/srv/wagate/dispatch-alerts.log`。 |

## 使用步骤

```bash
# 0) 先做只读侦察，把锚点核对清楚（输出交给操作员评审）
sudo bash 04-dev-dispatch-struct.sh

# 1) 静态自检（不写任何文件）
sudo bash fixes/fixD-tgpush.sh --selftest      # 期望末行 SELFTEST_OK

# 2) 演练：逐条打印将要做的改动，逐行评审
sudo bash fixes/fixD-tgpush.sh

# 3) 落盘（含构建验证 + 受控重启 + 健康门禁）
sudo bash fixes/fixD-tgpush.sh --apply         # 期望末行 CONCLUSION OK

# 4) 机械回归
sudo bash regr/regrD.sh                        # 期望 REGR_PASS
```

## 回滚

```bash
# 自动：--apply 过程中任何一步失败都会自动回滚到本次备份
# 手工：
sudo bash fixes/fixD-tgpush.sh --rollback                 # 回最近一次备份
sudo bash fixes/fixD-tgpush.sh --rollback 20261106T081500Z
sudo docker restart wagate                                # 使旧版生效
```

`aa-dev-tgpush-poll.ts` / `aa-dev-tgpush-runner.sh` 是两个**新增**文件，回滚 `aa-dev-dispatch.ts` 后它们变成死代码（不再有人写入映射文件，poller 只打印「映射为空」）。确认不需要时手工删除即可，另请删掉 cron 行：

```bash
crontab -l | grep -v aa-dev-tgpush-runner | crontab -
```

## 逃生阀与可观测性

| 开关 | 位置 | 效果 |
| --- | --- | --- |
| `WAGATE_DISPATCH_TG_PUSH=0` | `/etc/wagate.env` | 关掉全部 TG 回传（登记也跳过）。立即止血，无需改代码。 |
| `WAGATE_DISPATCH_SILENT_MIN` | `/etc/wagate.env` | 静默门禁阈值（默认 30 分钟）。 |
| `WAGATE_DISPATCH_DRY=1` | 环境 | poller 只判不发（regrD.sh 用它做无副作用回归）。 |

```bash
# 回程在干什么
journalctl -u wagate -f | grep tgpush
tail -f /srv/wagate/dispatch-alerts.log        # 失败与异常（绝不静默）
cat /srv/wagate/dispatch-mapping.json          # 派单登记表
cat /srv/wagate/dispatch-state.json            # 每张工单的回程状态与 pushed 标记
```

## 已知局限（诚实说明，不掩盖）

1. **回传依赖 cron**。若 EU 主机 cron 未运行（或 crontab 装失败，脚本会打印 `[warn]`），回程不会发生。脚本此时会明确警告，请改用 systemd timer 或手工核对。
2. **只回传终态与 30 分钟静默提醒**，不做分钟级进度流。工单跑 29 分钟时用户仍无消息 —— 这是刻意的（避免把静默换成刷屏），30 分钟门禁是兜底。
3. **不判定「交付质量」**。poller 只读 GitHub 事实（issue 开/关、state_reason、关联 PR），不读 PR 内容、不读 CI 结论。工单被 close 就算完成 —— 若工单被误关，回传会报「已完成」。操作员关单时请用 `not_planned` 表达未完成，poller 会回传「⚠️ 工单被关闭但未完成」。
4. **一次性修复，不是通用通知框架**。只覆盖 `dispatch_dev` 这条派单链路。
5. **本仓库零机密**：脚本只有环境变量名与路径名，不含任何 token / pem 内容；运行时凭证一律从 `/etc/wagate.env` 与 `/srv/secrets/` 读取，绝不落盘到仓库。

## 顺带发现（只记录，本次不修）

- `aa-dev-dispatch.ts` 的 `audit()` 里 `result` 截断到 500 字符，但**没有轮转**（`dispatch-YYYYMMDD.jsonl` 按天分文件，长期会累积）。本次不动。
- `dispatch_dev` 的触发失败分支把 `TRIGGER_COMMENT` 原文交给用户，对操作员有用，但对普通用户偏技术。本次不动。
- `bot.ts` 的 `progressRoute` Map 只增不减（每条入站消息都 `set`），长期运行是内存增长点。本次不动，登记在此。
