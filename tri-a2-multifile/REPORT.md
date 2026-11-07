# [修复A v2] 多文件并发：根因实测坐实，基于最新基线重做修复 + fixB2 注入加固

工单：`tri-a2-multifile-d4d35350cb8b` / issue #48
交付目录：`tri-a2-multifile/`
性质：**补丁/脚本只产出不执行**（本机无 EU 生产凭据）；操作员审后执行。

---

## 0. 一句话结论

Telegram 会把「一条带 N 个附件」的消息拆成 **N 条共享同一 `media_group_id` 的 update**，
每条独立走 `handleUpdate`，而旧代码把文件写进**单槽** `__excelPendingFile` ——
**最后写入者胜**，于是只有最后一个文件被处理。本次修复：

1. 按 `media_group_id` 聚合，一个媒体组产出**一个文件列表事件**，遍历每个文档逐个入队；
2. 用**每任务文件列表**（`__excelPendingFiles` 数组 + 游标）替换单槽，并更新 upload-ops 消费方；
3. 加**机械门控**：入站文件数 vs 已处理文件数不一致 -> 告警 + 通知，**故障开放**，绝不阻塞主路径；
4. 另外加固 `tenant-core.ts` 的注入点（fixB2）：只注入 `current-files.txt` 清单里列出的文件，
   杜绝上一轮残留文件被当成「本次任务的文件」注入。

---

## 1. 根因证据（来自实测数据，`01-multi-file.sh`）

| 观测 | 值 | 含义 |
|---|---|---|
| 单条 TG 消息附件数 | N=2（xlsx） | 用户视角「一次发两个文件」 |
| Telegram 实际投递的 update 数 | 2（各带 1 个 `document`） | **消息被平台拆分**，不是 1 条 |
| 两条 update 的 `media_group_id` | 相同 | 这是「同一条消息」的机械标识 |
| 旧代码落盘文件数 | 1 | **只有最后一个文件被处理** |
| 旧代码把文件写到哪 | 单槽 `__excelPendingFile` | 后写覆盖先写 -> 最后写入者胜 |

关键点：**旧实现里 `media_group_id` 根本没被读过**（在基线快照中 `media_group_id` 命中 0 次）。
所以这不是「偶发竞态」，而是**确定性丢文件**：只要一条消息带 ≥2 个附件，就必然只处理最后一个。
这解释了「多发几个文件，总是少了前面几个」的稳定复现。

---

## 2. 修复点

### 2.1 `telegram.ts` —— 按媒体组聚合成列表事件（整块替换）

- **锚点**：`let file: PlatformMessage["file"];`（基线 L238，**唯一命中 1 次**）
- **替换范围**：L238 声明行 **+** 紧随其后 L239–L255 的 `if (msg.document) { ... }` 块。
  即**整块替换**，不是逐行插入 —— 因为补丁体自己重新声明 `let file`，若把原声明留在原地会重复声明。
  L256 起的 voice 分支**不被触碰**。
- **行为**：
  - 收集本 update 的 document -> 逐个 `getFile` 下载 -> push 进 `__fixA2DocLoop__`；
  - 以 `media_group_id` 为键把文件累积进跨 update 的缓冲区，窗口到期（`MEDIA_GROUP_WINDOW_MS`，默认 1200ms）
    统一投递：写入 `__excelPendingFiles` 列表，并仍设置 `__excelPendingFile`=最后一个（向后兼容）；
  - 日志 `[Telegram] __fixA2DocLoop__ inbound n=<N> names=<...>` —— 这是机械门控的观测点；
  - **逃生阀** `WAGATE_MULTIFILE_VIEW=0` -> 退回旧行为（只取最后一个），便于对比与快速回退；
  - 无 `media_group_id`（单文件）-> 保持旧语义，立即处理，不引入延迟。

### 2.2 `bot.ts` —— 单槽改为每任务文件列表（两处）

- **锚点**：`(globalThis as Record<string, unknown>).__excelPendingFile = file;`（**命中 2 次**：L218 `[inject]` 通路、L277 `[bot]` 通路）
- **替换方式**：**逐行替换**（`--line`），两处都改。
  这两处是**无大括号的单条赋值语句**，不能按块替换（深度扫描会一路吞到下一个 `{`，把整段函数吃掉）。
- **行为**：追加进 `__excelPendingFiles`、把 `__excelPendingCursor` 归零，并**仍然设置**旧单槽
  `__excelPendingFile = file` —— 双写，保证尚未更新的消费者依然工作（渐进、可回退）。

### 2.3 `upload-ops` 消费方

消费者从「读单槽」改为「读列表 + 游标」：按游标取下一个未处理的文件，
每处理完一个前进一格，直到列表耗尽。旧单槽保留为兼容路径。

---

## 3. 机械门控（不靠人眼，一条命令复跑）

- **`regr/regrA2.sh`** —— 合成「一条消息 N 个文档、共享同一 `media_group_id`」，
  断言四条：
  - **A 聚合**：日志出现 `inbound n=N`（一个媒体组 = 一个列表事件）；
  - **B 入队**：`__excelPendingFiles` 长度 ≥ N（没有文件被丢）；
  - **C 落盘**：`workspace/uploads` 下出现 N 个目标文件（真实文件系统证据）；
  - **D 不回归**：单文件（无媒体组）仍走旧语义、立即处理。
  - 少一个文件即 **FAIL**；**缺证据不算绿**。
  - `REGR_MODE=stub` 离线自检：不碰生产，验证断言框架本身（含「少一个必须 FAIL」的负例）。

- **脚本自带语法门**：两个补丁脚本在**写盘前**跑真实 TS 解析器
  （`lib/parsegate.js`，`ts.createSourceFile` + `parseDiagnostics`）。
  产物有语法错误 -> **失败关闭，不写盘**。
  找不到 `typescript` 时降级为**显式 WARN**（绝不静默通过，也绝不误报中止）。

---

## 4. 一行预防

**凡是「一条消息可携带多个同类附件」的平台（Telegram 媒体组、邮件多附件、IM 转发），
都不要用「单槽最后写入者胜」的临时状态传递 —— 用带 `media_group_id` 键的聚合 + 每任务文件列表，
并配一条「入站数 vs 处理数」的机械对账；对账只告警不阻塞（故障开放），
才能让丢文件从「静默」变成「可见」。**

---

## 5. 安全与边界

- **零密钥**：交付物不含任何凭据；脚本只读环境变量，不落盘敏感值。
- **锚点不匹配 -> 中止**：两个脚本都先断言锚点命中次数，不符即 `gate_fail` 退出，
  **绝不强行 patch**（生产自 11-05 拉取后已漂移，见下）。
- **默认 dry-run**：不加 `--apply` 只预览；`--apply` 前先 `cp -a` 落 `.bak-<UTC戳>` 备份。
- **可回滚**：`--rollback --from <批次戳>` 按备份还原；已实测通过。
- **幂等**：重复 `--apply` 检测到特征串即跳过，不会重复打补丁。
- **故障开放**：门控/通知失败只告警不阻塞主路径；绝不因为对账失败而中断用户请求。

### 基线漂移说明（重要）

生产环境自 11-05 拉取快照后已发生漂移（例如 `/srv/wagate/patches/telegram.ts` 时间戳为 11-06 15:09）。
因此脚本**不按行号切片**，而是：
1. 用锚点**文本**定位；
2. **断言命中次数**（`telegram.ts` 期望 1、`bot.ts` 期望 2）；
3. 命中次数不符 -> **中止并报告**，不猜、不强行打补丁。

操作员在真实目标机上先跑 **默认 dry-run** 即可看到锚点命中情况与预览；
若出现「锚点未命中/次数不符」，说明现场已进一步漂移，**请先回报锚点现状再决定**。

---

## 6. 交付物清单

| 文件 | 一句话 |
|---|---|
| `fixes/fixA2-multifile.sh` | D1 主修复补丁脚本（媒体组聚合 + 每任务文件列表 + 机械门控），默认 dry-run，支持 `--apply`/`--rollback`/`--verify-gate` |
| `fixes/fixB2-inject.sh` | D2 注入加固补丁脚本（只注入 `current-files.txt` 清单内文件，三层 fail-open） |
| `regr/regrA2.sh` | D3 机械回归脚本（合成共享 `media_group_id` 的多文档用例 + 四条断言；含离线自检） |
| `REPORT.md` | D4 本报告（根因证据 -> 修复点 -> 机械门控 -> 一行预防） |
| `lib/_lib.sh` | 共享断言/备份/汇总辅助函数（含 `ts_parse_gate`） |
| `lib/parsegate.js` | 与 cwd 无关的 TS 解析门（写盘前语法校验） |
| `lib/replace_block.sh` | 结构化替换原语：整块替换（字符串/注释感知的深度匹配）与逐行替换两种模式 |
| `fixes/README.md` | 操作员手册：先 dry-run、再 `--apply`、重启、回滚流程 |

---

## 7. 本地实测记录（本机，非生产）

在 `/tmp/a2test`（从快照基线复制的副本）上实测：

| 步骤 | 结果 |
|---|---|
| `fixA2-multifile.sh --apply` | `SUMMARY: 8 PASS / 0 FAIL / 0 WARN`，exit 0 |
| telegram.ts 块边界 | `L238..L255`（18 行），解析门 `SYNTAX-OK` |
| bot.ts 逐行替换 | `L218..218` 与 `L277..277` 两处，解析门 `SYNTAX-OK` |
| 重复 `--apply` | 幂等跳过（`已打过补丁`） |
| `--rollback --from <戳>` | 还原成功，sha256 回到基线 |
| `fixB2-inject.sh --apply` | `SUMMARY: 5 PASS / 0 FAIL / 0 WARN`，锚点命中 1 次、位置校验通过 |
| `fixB2` 重复 apply / rollback | 幂等跳过 / 还原到基线 sha |
| `regr/regrA2.sh`（stub） | `6 PASS / 0 FAIL`，含负例（少文件必 FAIL） |

**未验证项（诚实声明）**：
- 真实 Telegram 媒体组链路未在本机跑过（无生产凭据、无 EU 网络），
  需操作员在 EU 上执行 `bash regr/regrA2.sh` 做最终确认；
- `upload-ops` 消费方的具体实现文件不在快照中，脚本按「列表 + 游标」约定更新；
  若现场消费者签名不同，dry-run 的锚点门会先行暴露。
