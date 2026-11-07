# REPORT —— 修复F：file-only 挂起死锁的「联动 + 释放」路径修复包

对应 issue #63。交付物：`fixes/fixF-hold.sh`（锚定改写 + 备份回滚，默认 dry-run）、`regr/regrF.sh`（A/B/C 一条命令复跑）、本报告。

**本包只产出改动，从不执行。** 无生产凭据，`fixF-hold.sh` 从不重启服务、从不发送消息、从不触碰 `/app/extensions/plugins/`。操作员审阅后自行 `--apply`。

---

## 一、根因

### 1.1 现场形态（`eu-fix-img-voice/context/bot.ts`，511 行，sha256 `5ea76a55…`）

```ts
// L321-331（原文）
	// step8: 文件无 text 默认(FILE_AUTO_ROUTE != "0", on)不自动开跑 — 等用户说要求。
	// 文件留 G.__excelPendingFile(下次发文本 -> upload-ops before_agent_start 落盘+开跑)。
	// 影响面: 仅「文件 + 空 text」路径; 纯文本/图片/带 caption 文件 照旧。
	// flag off(FILE_AUTO_ROUTE=0) = 旧行为(造默认 prompt 立即分析)。
	if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {
		console.log(`[bot] file-only hold: ...`);
		try {
			await adapter.sendMessage(m.channelId, `已收到文件 ${file.fileName}。请说明你的要求(...)`);
		} catch { /* 回复失败仍 hold */ }
		return;                       // <-- 提前返回，永远到不了 L334 的 core.handle
	}
```

### 1.2 死锁闭环（机械性，非概率）

1. 用户只发文件、不发文字 → `file && !text` 命中 → 写 `__excelPendingFile` → 回「请说明要求」→ **return**。
2. `return` 发生在 `core.handle` **之前**，所以这一轮**根本没有 turn**，模型看不到文件，也看不到 pending 槽。
3. 用户以为没收到 → **重新上传** → 又是一条 `file && !text` → 再次 hold → 回到第 1 步。
4. **释放路径失联**：即便用户改发文字，旧代码里 pending 文件也没有被并进那一轮 —— 写入方是 `bot.ts:277`（`onMessage` 每次覆盖单槽），消费方是 `upload-ops` 的 `before_agent_start`；而真正决定「看不见任何附件」的是 `core.handle` 那一轮的上下文。现场日志 03:58:33 用户发「发了」→ 模型答「读不到任何附件」，就是第 4 步的实锤。
5. 沟通文案承诺了「说明要求我就开始」，但这句话在机制上**不可能兑现**（第 1 步已 return，没有任何后续路径会拿那个文件开跑）—— 这是「承诺与机制不一致」，比单纯的功能缺失更糟：它让用户持续等待。

一句话：**扣文件的机制没有自带释放路径，也没有和「当前有活跃任务」联动。**

---

## 二、修复映射

| 编号 | 规格要求 | 落点 | 做法 |
| --- | --- | --- | --- |
| **F1** | 活跃任务联动：file-only 且同租户有活跃任务 → 不挂起 | `bot.ts` 锚点分支改写 | 经 `globalThis.__fixFActiveTask` 钩子（`{platform,userId,channelId}` → bool）探测同租户活跃任务；命中则**不 hold**，注入默认句 `用户为当前任务补充上传的文件：<文件名>` 后落到原有 `core.handle`。**fail-open**：钩子缺失/抛异常 → 视为无活跃任务 → 保持旧 hold。 |
| **F2** | 挂起释放：无活跃任务仍 hold，但**下一条文本消息必须在该轮注入 pending 文件** | 同上分支 + 分支前置的释放段 | hold 时把文件存进**跨 `onMessage` 存活**的 `globalThis.__fixFPendingFiles`（`Map<platform:userId, file>`，纯内存、不落盘、无凭据）；下一轮 `text && !file` 的文本消息取出并**并回该轮** `file` 变量，因此它在同一轮进入 `core.handle`，模型当轮可见。键用**租户键**而非旧单槽，避免跨用户串文件。 |
| **F3** | 扩写 hold 提示，并让承诺成真 | 文案 | 改为「已收到文件 X。文件已保存，回复任意说明（如"用它做PPT"）即开始处理。」——承诺由 F2 兑现。 |
| **F4** | fail-open 单开关 | 分支首行 | `WAGATE_HOLD_RELEASE=0` → F1 不联动、F2 不释放（旧行为完整回归）；文案扩写属于纯增益，保留。 |
| **F0** | （可选一致性）`core.handle` 形参 | 门内检查 | `--apply` 时检查 handle 签名是否已声明 `file`；未声明则**警告不中止**（`tenant-core` 的接收侧不在本包授权范围内，见第四节）。 |

### 2.1 机械门（fail-closed）

与 `fixA/fixB/fixC` 同款三维门，任一 FAIL 即整体中止、**不做部分落地**：

- **G1 锚点门**：`if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {` 必须恰好出现 1 次。**不匹配即中止并报告**，绝不猜测性匹配。
- **G2 形态门**：改写后目标文件必须含特征串 `__fixFHold__`。
- **G2′ 替换唯一性门**：替换后锚文本次数必须 `== 原有 exp - 替换 1 + 补丁体重写数`。少 = 原体被多删；多 = 原体没删干净（重复分支体 → 产物语法错）。两者都 fail-closed。
- 备份：`bot.ts.bak-<UTC戳>`；`--rollback --from <戳>` 按戳还原；写回用 `cat > ` **保留 inode**（宿主单文件 bind-mount，`rm` 重建会丢挂载）。

---

## 三、机械断言 A/B/C（`regr/regrF.sh`）

| 断言 | 合成用例 | 通过判据 |
| --- | --- | --- |
| **A** | 同租户先起任务，再投**纯文件**（无 text） | 日志含 `[fixF] active task linked`（**未** hold）且该轮 prompt 含注入句 `用户为当前任务补充上传的文件：<名>` |
| **B** | 全新用户投**纯文件** → 再投文本「用它做PPT」 | 先 `[fixF] file-only hold` + 文案含「文件已保存，回复任意说明」；文本那轮出现 `[fixF] hold release: pending file merged into this turn` 且 `name=<该文件>` |
| **C** | `FILE_AUTO_ROUTE=0` | 旧路径条件仍在（未被改写掉）+ `WAGATE_HOLD_RELEASE` fail-open 开关存在；该模式下直通 `core.handle`、无 hold/联动 |

脚本支持 `REGR_MODE=stub` 离线自检（CI 友好，不碰生产），退出码 `0` 全绿 / `1` 有 FAIL（缺证据不算绿）/ `2` 缺 `lib/_lib.sh`。

### 3.1 「活跃任务」钩子 `__fixFActiveTask` 的落地边界（**必须读**）

F1 需要一个「同租户是否有活跃任务」的**只读判据**。可用来源已经存在（`tenant-core.ts` 的 `tenants.get(sid)` → `busy`、`session`、`sandboxId`、`suspended`；`task.json` 的 `activeProj`；`locks` 串行表），但**在 `tenant-core.ts` 里挂这个钩子属于改动该插件的接收侧**，超出本修复包「单模块内小改动」的授权范围，故本包：

- **只**在 `bot.ts` 侧按「钩子存在则用、不存在则 fail-open 回旧 hold」的方式接线；
- 钩子未接时，断言 A 会拿到明确判读（日志出现 `file-only hold` 而非 `active task linked`），**不会假装通过**；
- 若操作员决定接钩子（一行：`(globalThis as any).__fixFActiveTask = (m) => { const t = tenants.get(sidOf(m)); return !!t?.busy; }`），本包的其余部分零改动即可生效。

**这是本包唯一一处需要操作员决定的接口，已在第八节列明。**

---

## 四、范围与安全边界

- 只新增 `fixf-hold/` 一个目录；不改 `preview/`、`.github/`、其他应用目录。
- `bot.ts` 是**单文件挂载**（容器内 `/app/bot.ts`），本包**只改这一个文件**，且是**原地重写保留 inode**。
- **新文件严禁挂进 `/app/extensions/plugins/`**（陷阱 #35：扩展目录被扫描，多一个文件即污染加载链）。本包不放任何文件进该目录。
- 仓库零 secret：脚本不含 token / key / 聊天 ID；pending 槽是**纯内存 Map**，不落盘。
- `WAGATE_HOLD_RELEASE=0` 一键回旧版；`--rollback --from <戳>` 字节级还原。
- **本包只产出脚本，从不执行**；`--apply` 与重启由操作员在 EU 上执行。

---

## 五、成本与风险

| 项 | 判读 |
| --- | --- |
| 是否新增 turn | 仅 F1 命中的 file-only 消息会新起一个 turn（这正是规格要求：文件要进当前任务）。F2 不新增 turn，只是把 pending 并进**本已存在**的文本轮。 |
| 误判风险 | F1 探测失败一律 fail-open 回旧 hold（宁可多问一句，不可丢消息）；F2 只在 `text && !file` 时合并，绝不吃掉「文本+新文件」组合消息里的新文件。 |
| 串文件风险 | 用 `platform:userId` 作键，不用旧的进程级单槽。 |
| 回退 | 单开关 + 按戳还原，两条路互不依赖。 |

---

## 六、一行预防说明

**扣文件的机制必须自带释放路径 + 任务联动。** 任何「先扣下、等用户补充」的 hold 分支，都必须同时回答两件事：*谁在什么条件下把它放出来*，以及*当前有没有正在等它的任务*——否则就是一条只有入口、没有出口的死锁边，用户的重试反而是它的燃料。

---

## 七、自检记录

- `bash -n fixF-hold/fixes/fixF-hold.sh`、`bash -n fixf-hold/regr/regrF.sh`：语法通过。
- 合成夹具往返（同形 `bot.ts` 夹具，`--apply` → `--rollback`）：见第七节之二。
- `scripts/smoke.sh fixf-hold`：AGENTS.md 规定的语法门 + 无头加载门。
- **未执行**：`.sh` 从未在生产环境运行；`regrF.sh` 的 live 断言需操作员在 EU 上跑。

---

## 八、待操作员决定的一件事

F1 的「活跃任务」只读钩子 `__fixFActiveTask` 需要 `tenant-core.ts` 侧接一行（见 3.1）。本包**没有**改 `tenant-core.ts`（越权）。请择一：

- **A**：操作员接上该一行 → 断言 A 端到端转绿；
- **B**：暂不接 → 本包 F2/F3/F4 与断言 B/C 完整生效，断言 A 会明确报「钩子未接」，**file-only 死锁的释放路径已被修复**（用户补一句文字即可开跑），但「有活跃任务时不必再补一句」这一层不生效。

两种选择下，旧行为都由 `WAGATE_HOLD_RELEASE=0` 兜底。
