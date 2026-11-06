# fixA —— 「多文件并发失败」队列化修复

> 执行位置：**EU 服务器**。本目录下的脚本 agent 从不执行，操作员逐行审后自行执行。
> 默认 dry-run，只有显式 `--apply` 才写文件。

## 一、根因假设

一条 Telegram update 里的附件位是**单槽**的，多附件互相覆盖，最后只剩一个：

| 位置 | 槽位 | 行为 |
| --- | --- | --- |
| `telegram.ts` | 局部 `let file` | 每个 `update.message` 只保留一个 `file`，循环里后一个覆盖前一个 |
| `bot.ts:218` | `globalThis.__excelPendingFile` | 直接赋值，第二个文件覆盖第一个 |
| `tenant-core.ts:1224` | `__pendingImage` / `__pendingImageSid` | 最后一张图胜出；仅以 sid 为键，且提前 return |
| `ws-sync-queue.ts` | 未建父目录 / 只冲最后一个 | 首写失败静默丢文件（坑 #14） |

叠加 `telegram.ts:171` 的 fire-and-forget `handleUpdate(update)`：多附件在无并发保护的槽位上
竞争，表现为「两个 xlsx 只进去一个」。**实测与推断已在 `../REPORT.md` 分别标注。**

## 二、变更点

`fixA-multi-file.sh` 对三个文件做锚点定位的原地替换：

| 补丁 | 文件 | 锚文本 | 期望次数 | 特征串 |
| --- | --- | --- | --- | --- |
| P1 | `telegram.ts` | `if (msg.document) {` | 1 | `__fixAFileList__` |
| P2 | `bot.ts` | `(globalThis as Record<string, unknown>).__excelPendingFile = file;` | 2 | `__excelPendingFiles` |
| P3 | `ws-sync-queue.ts` | `export async function flushPendingSync` | 1 | `__fixAMkdir__` |

改法要点：

- **P1**：单槽 `file` 之外增加保序列表 `__fixAFileList__`，逐附件下载后入列；出口打印
  `multi-file inbound n=…` 作为 N 进 N 出的运行时证据。
- **P2**：**双写**——列表槽 `__excelPendingFiles` 保序保量（新消费方读），单槽
  `__excelPendingFile` 继续写最后一个（旧消费方零改动）。这样回退时旧链路完全不受影响。
- **P3**：flush 前先 `mkdir -p` 父目录，且逐条目 flush，而不是只冲最后一个。

> `ws-sync-queue.ts` 的变量名（`pends` / `sbx` / 条目形态）**以 `01-multi-file.sh` 第 4 节在
> 现场打印的为准**。锚点门 G1 会对不上就整体中止，不会猜、不会写半截。

## 三、机械门（issue #37 验收基调 ①：fail-closed，不靠人盯）

| 门 | 作用 | 失败后果 |
| --- | --- | --- |
| **G1 锚点门** | 每个补丁先断言「锚文本匹配次数 == 期望次数」 | 不等 → 整批中止，**不做部分落地** |
| **G2' 替换唯一性门** | 断言替换后锚文本次数 == `原有 - 1 + 补丁体重写数` | 少 = 原体多删；多 = 残留重复函数体 → 中止 |
| **G2 形态门** | 落地后断言特征串真实存在 | 缺 → 中止并提示 `--rollback` |
| **G3 计数门** | 文件 N 进 N 出（入站计数 == 出站计数） | 不等 → 告警日志 +（可选）TG 通知 |

三门任一失败：**非零退出 + 写告警日志 `/tmp/tri-a-multifile-gate.log` + 可选 TG**。
TG 发送需 `TG_NOTIFY=1` 且容器内有 `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID`；
发不出去时**只记日志、绝不静默**。

## 四、回滚

改动**原地替换、不删文件**，因此回滚就是把 `.bak-<戳>` 覆盖回去：

```bash
bash fixes/fixA-multi-file.sh --rollback                       # 列出可用备份
bash fixes/fixA-multi-file.sh --rollback --from 20261106-075449
systemctl restart wagate.service        # 操作员确认后执行
```

回滚是**字节级还原**（`cat bak > target`，保留 inode），已在合成夹具上验证：
apply → 15 PASS，rollback → 三个文件全部还原为原始内容（特征串计数归零）。

## 五、验收

```bash
# 0) 先对齐现场（只读）
bash 01-multi-file.sh

# 1) 只看门，不写文件
bash fixes/fixA-multi-file.sh --verify-gate     # 必须 0 FAIL 才能进下一步
bash fixes/fixA-multi-file.sh                   # dry-run，看改动预览

# 2) 落地 + 重启（操作员确认后）
bash fixes/fixA-multi-file.sh --apply
systemctl restart wagate.service

# 3) 机械回归：一条命令复跑
bash regr/regrA.sh                              # 合成用例：两文件必须都进沙箱
```

`--verify-gate` 全 PASS 是 `--apply` 的前置条件；`regrA.sh` 全绿是「修复生效」的机械证据。

## 六、已知边界

- P3 的现场变量名以 `01-multi-file.sh` 第 4 节输出为准；若形态不同，G1 会 fail-closed 中止，
  需要人工按现场改 `PATCH_SPECS` 里 P3 的锚文本与 `p3_body`。
- G3 计数门依赖运行时日志/台账证据，`regrA.sh` 负责断言；无证据时 `regrA.sh` 会明确报
  「证据缺失」而不是假绿。
- 本目录脚本 agent 不执行；所有落地动作由操作员在 EU 上完成。
