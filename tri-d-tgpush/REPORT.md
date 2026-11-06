# 故障修复 D：90 分钟无回音根治 —— TG 结果回传（fast-route Phase 2）

> 本目录是自包含交付物：只读侦察脚本 + 一键修复脚本 + 机械回归脚本 + 本报告。
> **全部脚本只产出、不执行**（本机无生产凭据）。操作员在 EU 5.189.129.216 上逐行审核后执行。

## 一、事故经过（用户视角）

| 时间 | 事件 |
| --- | --- |
| 2026-11-06 约 00:50Z | 用户在 TG 说「开发一套 crm 系统」。规划官判定为重型工作 → `dispatch_dev` 派单成功，返回「规格已交给快速通道执行通道，请停止本地自建，等工单结果回传。」 |
| 00:50Z – 02:20Z | **90 分钟，用户一条消息都没收到。**工单侧实际在跑（GitHub 上有活动），但 TG 侧全静默。 |
| 约 02:20Z | 用户认为任务卡死，**手动停止工单**。 |

用户原话：**「关键是防止以后再发生这种问题。」**

## 二、根因

`dispatch_dev` 是**单程**的。它把工作派出去，然后说「等结果回传」—— 但**回程从来没有被实现**。

具体到代码（`aa-dev-dispatch.ts`，线上 11-06 修订，529 行）：

1. **派单成功后没有任何回传逻辑**。`issues` 创建成功 → 触发 workflow → 写审计 → 返回文案，链路到此结束（L496-L505）。返回的「等工单结果回传」是一张没有兑付方的空头支票。
2. **不存在「工单 ↔ TG 会话」的映射**。派单时明知 `sid`，也知道用户在哪（`bot.ts` 一直在维护 `globalThis.__sidChat`），但这个对应关系从未落盘。任何后续组件都不知道该把结果发给谁。
3. **工单终态没有任何监听者**。工单开着、跑完、失败、被关，TG 侧一律无感。这是 fast-route Phase 2 的已知缺口。
4. **失败也没有出口**。即使工单侧出错，也没有任何路径把「出错了」告诉用户 —— 静默是双向的。

一句话：**去程有，回程无。** 用户看到的 90 分钟静默不是超时，是设计里就没有回音。

## 三、修复映射

| 根因 | 修复 | 落地位置 |
| --- | --- | --- |
| ① 派单后无回传逻辑 | 派单成功时登记一行映射（sid / chatKey / issue / url / title / 时间） | `fixD-tgpush.sh` P2+P3 注入到 `aa-dev-dispatch.ts` |
| ② 无「工单 ↔ 会话」映射 | 新增 `/srv/wagate/dispatch-mapping.json`；chatKey 直接复用 `bot.ts` 已有的 `__sidChat`，**不改 bot.ts** | 注入块的 `writeDispatchMapping()` / `currentChatKey()` |
| ③ 终态无监听者 | 新增 poller：每分钟查一次 issue 状态与关联 PR，判终态后发 TG | `aa-dev-tgpush-poll.ts` + `aa-dev-tgpush-runner.sh`（cron 每分钟） |
| ④ 失败无出口 | 发送失败 / 令牌失败 / 非 telegram 会话 / 单行异常，全部写 stdout + `dispatch-alerts.log`，**绝不静默** | poller 的 `alert()` |

### 三条硬要求逐条对照

| 要求 | 满足方式 |
| --- | --- |
| **① 机械门禁（fail-closed）** | 锚点必须**恰好匹配 1 次**才动手（多/少都中止，绝不按行号切分 —— 本次开发中真的挡住了两次错锚点）；改写后校验注入标记；`bun build` rc 必须 0；健康门禁五项（容器 Up / 无 FATAL·ParseError / 容器内 bun 冒烟 / 宿主容器 md5 一致 / TG getMe ok）任一不过 → **自动回滚 + 非 0 退出**。 |
| **② 机械回归（一键重跑）** | `regr/regrD.sh` 一条命令五个用例：终态必回传、重跑 0 重复、逃生阀静默、静默门禁必触发、异常必留痕。末行打印 `REGR_PASS` / `REGR_FAIL`。 |
| **③ 通知（绝不静默）** | **终态回传**（完成给链接 / 未完成给原因）+ **30 分钟静默门禁**（仍在跑就主动报进度）。即使工单彻底卡住，用户也不会再经历 90 分钟静默。 |

## 四、交付物清单

```
tri-d-tgpush/
├── 04-dev-dispatch-struct.sh      只读侦察：核对锚点、环境开关、TG 发送面、审计文件（不改任何东西）
├── fixes/
│   ├── fixD-tgpush.sh             一键修复：dry-run 默认 / --selftest / --apply / --rollback
│   └── README.md                  修复说明、使用步骤、回滚、逃生阀、已知局限
├── regr/
│   └── regrD.sh                   机械回归：五个用例，末行 REGR_PASS / REGR_FAIL
└── REPORT.md                      本报告
```

**改动面**：`aa-dev-dispatch.ts` 两处（`node:fs` import 加两个名字；`export default` 前插约 60 行、派单成功分支插一次调用）+ 两个新文件（poller、runner）+ `/etc/wagate.env` 两行开关 + 一条 cron。
**明确不改**：`bot.ts`、`tenant-core.ts`、`telegram.ts`、`aa-dev-route-guard.ts`。

## 五、执行顺序（操作员）

```bash
# 1) 只读侦察，核对锚点与运行环境（把输出留档）
sudo bash 04-dev-dispatch-struct.sh

# 2) 自检 + 演练（都不写盘）
sudo bash fixes/fixD-tgpush.sh --selftest     # 期望 SELFTEST_OK
sudo bash fixes/fixD-tgpush.sh                # 逐行打印计划，逐行评审

# 3) 落盘（含构建验证 + 受控重启 + 健康门禁）
sudo bash fixes/fixD-tgpush.sh --apply        # 期望 CONCLUSION OK

# 4) 机械回归
sudo bash regr/regrD.sh                       # 期望 REGR_PASS
```

失败即自动回滚；手工回滚见 `fixes/README.md`。

## 六、一行防复发清单

> **派单成功 ≠ 交付完成：必须有回程（终态回传）+ 兜底（30 分钟静默门禁）；发送失败必须留痕，绝不静默。**

具体到可勾选的动作：

- [ ] 任何「派出去、等结果」的链路，**派单那一刻**就要登记「结果回哪里」；
- [ ] 结果必须有且仅有一条终态通知（幂等标记保证重跑不刷屏）；
- [ ] 超过阈值仍无终态 → **主动说话**，不赌用户会等；
- [ ] 通知发不出去要进告警日志，绝不因为「只是通知」就吞掉；
- [ ] 有逃生阀（`WAGATE_DISPATCH_TG_PUSH=0`），止血不需要改代码。

## 七、验证记录（本次交付实际跑过的）

本机（开发侧，无生产凭据、未接触 EU）跑过的：

1. `bash -n` 全部脚本 —— 通过。
2. `fixD-tgpush.sh --selftest` 对真实 `aa-dev-dispatch.ts`（529 行，md5 `353f8661107c4dc4e3d90d39dd29b8c6` 副本）—— 6 个锚点全部唯一。
3. dry-run 全流程 —— 只打印、零写入。
4. **`--apply` 全流程演练**（用 docker 打桩，未触碰任何生产容器/文件）：锚点改写 17449 → 19727 字节、`bun build` rc=0、健康门禁五项、末行 `CONCLUSION OK`。失败分支也真跑过：门禁不过时**确实自动回滚**并按预期非 0 退出。
5. 修正过的锚点缺陷：`result: "ok",` 与 `return out(` 都曾因为**不是唯一锚点**被 fail-closed 挡住 —— 门禁按设计工作。

**未在 EU 上验证**（诚实说明）：真实容器重启后的行为、真实 TG 送达、cron 实际拉起 poller。这三项必须在 EU 上由步骤 3+4 现场确认，本机无凭据、不接触生产。

## 八、已知局限

1. **依赖 cron**。cron 没跑回程就不发生；脚本装 cron 失败会打印 `[warn]`，请改用 systemd timer。
2. **只回终态 + 30 分钟静默提醒**，不做分钟级进度流（刻意：不把静默换成刷屏）。
3. **不判交付质量**。poller 只读 GitHub 事实（issue 开/关、`state_reason`、关联 PR），不读 PR 正文、不读 CI 结论。操作员关单时用 `not_planned` 表达未完成，poller 会报「⚠️ 工单被关闭但未完成」。
4. **一次性修复**，不是通用通知框架，只覆盖 `dispatch_dev` 这条派单链。
5. **`--apply` 会重启 wagate 容器**。脚本已加 running 任务检查（有 `state='running'` 的工单则跳过重启并明确标注「已落盘待重启」），可用 `FORCE_RESTART=1` 覆盖。

## 九、顺带发现（只记录，本次不修）

- `audit()` 的 `dispatch-YYYYMMDD.jsonl` 按天分文件但**无轮转**，长期累积。
- `dispatch_dev` 触发失败分支把 `TRIGGER_COMMENT` 原文抛给普通用户，偏技术。
- `bot.ts` 的 `progressRoute` Map 只增不减（每条入站消息 `set`），是长期内存增长点。

以上均属其他模块或需产品决策，本次不扩大范围。
