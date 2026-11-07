# fixes/ —— 操作员手册（fixA2 多文件并发 + fixB2 注入加固）

> **本目录的脚本只产出补丁，绝不自动执行生产变更。**
> 执行位置：EU 服务器。执行人：操作员（agent 无生产凭据）。
> **默认就是 dry-run**：不加 `--apply` 时只打印锚点命中情况与改动预览，不写任何文件。

---

## 0. 30 秒速览

```bash
# 1) 先看锚点命中与预览（不写盘，安全）
bash fixes/fixA2-multifile.sh
bash fixes/fixB2-inject.sh

# 2) 锚点全部命中且预览符合预期后，才落地
bash fixes/fixA2-multifile.sh --apply
bash fixes/fixB2-inject.sh   --apply

# 3) 重启生效
systemctl restart wagate.service

# 4) 机械回归（一条命令，不靠人眼）
bash regr/regrA2.sh
```

**任何一步出现「锚点未命中 / 命中次数不符」—— 停，不要继续。**
那说明现场已与快照基线漂移；先回报锚点现状，不要强行打补丁。

---

## 1. 前置条件

| 项 | 说明 |
|---|---|
| 目标文件 | `telegram.ts`、`bot.ts`（fixA2）；`tenant-core.ts`（fixB2） |
| 默认路径 | `/srv/wagate/patches`（可用 `PATCH_DIR=` 覆盖） |
| 容器 | `wagate`（可用 `CONTAINER=` 覆盖） |
| 依赖 | `bash`；可选 `node` + `typescript`（用于写盘前的 TS 语法门） |
| 备份 | `--apply` 前自动 `cp -a` 到同目录 `.bak-<UTC时间戳>` |

`node`/`typescript` 缺失时，语法门降级为**显式 WARN**（不会假装通过，也不会误报中止）。
补上 `typescript` 最稳妥的方式是 `TS_MODULE_DIR=/path/to/node_modules`。

---

## 2. fixA2-multifile.sh —— 多文件并发修复

**根因**：Telegram 把一条带 N 个附件的消息拆成 N 条共享同一 `media_group_id` 的 update，
旧代码用**单槽** `__excelPendingFile` 接文件 -> 最后写入者胜 -> 只处理最后一个。

| 参数 | 作用 |
|---|---|
| （无） | **dry-run**：只校验锚点 + 打印预览 |
| `--apply` | 备份后真正写入，并跑写盘前语法门 |
| `--verify-gate` | 只做形态检查（现场是否已含补丁特征串） |
| `--rollback --from <戳>` | 按该批次备份还原 |
| `-h` / `--help` | 帮助 |

**可调环境变量**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PATCH_DIR` | `/srv/wagate/patches` | 目标文件所在目录 |
| `MEDIA_GROUP_WINDOW_MS` | `1200` | 媒体组聚合窗口（毫秒）；网络慢可适当调大 |
| `GATE_LOG` | `/tmp/tri-a2-multifile-gate.log` | 门控日志路径 |
| `TG_NOTIFY` | `0` | 设为 `1` 时，门控失败额外发 Telegram 告警（需容器内已有 bot token 环境变量） |
| `NODE_PATH` / `TS_MODULE_DIR` | 空 | 指定 `typescript` 模块位置，启用写盘前语法门 |

**逃生阀（运行时）**：`WAGATE_MULTIFILE_VIEW=0` -> 在插件进程里退回旧行为（只取最后一个文件）。
用于线上快速对比与应急回退，**不需要重新打补丁**。

---

## 3. fixB2-inject.sh —— 残留文件视图注入加固

**目的**：只把清单 `activeProj/current-files.txt` 里列出的文件注入给模型，
避免上一轮任务的残留文件被当成「本次任务的文件」。

**三层 fail-open（任一层触发就退回旧行为，绝不阻塞）**：
1. `WAGATE_RESIDUAL_VIEW=0` -> 整体关闭本修复；
2. 清单文件缺失/读不到 -> 不过滤；
3. 清单为空 -> 不过滤。

| 参数 | 作用 |
|---|---|
| （无） | **dry-run**：只校验锚点 + 位置 + 打印预览 |
| `--apply` | 备份后真正写入 |
| `--rollback --from <戳>` | 按该批次备份还原 |

**可调环境变量**

| 变量 | 默认 | 说明 |
|---|---|---|
| `PATCH_DIR` | `/srv/wagate/patches` | 目标文件所在目录 |
| `MANIFEST_REL` | `activeProj/current-files.txt` | 清单相对路径 |
| `TG_NOTIFY` | `0` | 同上 |

**锚点**：`const wasBusy = t.busy;`（在 `runOnce` 内、prompt 渲染路径上）。
脚本会额外做**位置校验**：锚点行号必须**晚于** `function runOnce(...)` 定义行，
确保插入点确实在渲染路径上；不满足即中止。

---

## 4. 回滚

```bash
# 列出可用批次戳（备份文件名里就是）
ls -1 /srv/wagate/patches/*.bak-*

# 按戳还原
bash fixes/fixA2-multifile.sh --rollback --from 20261106-172405
bash fixes/fixB2-inject.sh    --rollback --from 20261106-173639
systemctl restart wagate.service
```

---

## 5. 常见问题

**Q: dry-run 报「锚点未命中」，但我知道文件就在那。**
A: 现场已漂移。脚本按**锚点文本**定位并断言命中次数，不按行号切片。
请把 `grep -nF -e '<锚点>' <文件>` 的实际输出回报，据此更新锚点后再执行 —— **不要绕过该门**。

**Q: 提示「已打过补丁，跳过」。**
A: 幂等设计。特征串已存在即不再重复写入。需要重打请先 `--rollback`。

**Q: 语法门显示 `[SYNTAX-SKIP]`。**
A: 环境缺 `node` 或 `typescript` 模块，语法未校验（已显式 WARN）。
建议装上后重跑，或落地后人工 `node --experimental-strip-types` 复核。

**Q: 写盘前语法门报 FAIL。**
A: **不会写盘**（失败关闭）。说明锚点块边界识别有误或现场结构已变 —— 回报后处理，不要手工绕过。
