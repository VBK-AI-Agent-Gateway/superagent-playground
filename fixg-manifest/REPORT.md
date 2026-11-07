# fixG 报告 —— 文件清单自动滚动：上传即入清单 + 归档清理 + 上限保护

工单：`35ec2d9cf1a3941e4dae5eccbff5b852` / issue #64
交付目录：`fixg-manifest/`
产物：`fixes/fixG-manifest.sh`（补丁生成器）、`regr/regrG.sh`（机械回归）

## 1. 现象与根因

**现象**：操作员上传新文件后，模型（对话上下文注入）「看不到」这些文件；清单里出现的
条目是操作员手工补的。

**根因（一次性快照）**：`workspace/activeProj/current-files.txt` 只在 **fixB `--apply`
期间写过一次**（12:53 的快照）。此后 `upload-ops.ts` 每次保存新文件都**不会**再碰清单，
于是：

```
上传（upload-ops 保存） ──✗ 不同链路──> current-files.txt（停在 12:53）
                                              │
                     fixB2 注入读这份「过时清单」 ──> 模型看不到新上传的文件
```

清单是「上传 → 注入」这条链路的事实来源，却只有一个一次性写入点，链路后半段
（注入）每天在跑，链路前半段（滚动更新）根本不存在。这不是清单**内容**写错了，
而是清单**没有任何自动维护机制**。

## 2. 修复映射（现象 → 代码）

| 现象 | 修复 | 位置 |
| --- | --- | --- |
| 上传不入清单 | upload-ops 的 `[upload-ops] saved` 保存点后追加一行 CALL，同链路把新文件写进清单 | `frag_upload()` 插入块 |
| hold 的文件不入清单 | bot.ts 的 file-only hold 保存点同样追加 CALL | `frag_hold()` 插入块 |
| 重复上传产生重复条目 | 幂等 ①：路径已在清单中则只记日志、不重复写 | `mlogic()` |
| 清单里残留已归档文件 | 追加时统一过滤 `archive-*/` 下的路径 | `mlogic()` |
| 清单无限膨胀 | 上限保护：只保留最近 `WAGATE_MANIFEST_MAX`（默认 30）条，超出裁最旧 | `mlogic()` |
| 清单写失败拖垮上传 | 整段逻辑 fail-open：任何异常只告警 + 落失败标记，主上传链退出码不受影响 | `mlogic()` try/catch |

**路径约定**：清单条目一律写成 workspace 相对路径（与 fixB2 读取侧同源）。
upload 侧传 `uploads/x` 相对路径原样保留；hold 侧若传绝对路径则折回相对，
**越出 workspace 的绝对路径一律不记**（避免把宿主机路径写进清单）。

**逃生阀**：`WAGATE_MANIFEST_ROLL=0` 关闭入清单；`WAGATE_MANIFEST_MAX` 调上限；
`WAGATE_MANIFEST_STAMP=1` 为每条追加一行时间注释。

## 3. 一句话预防规则

> 任何「一次性快照」型的名单，都必须有同链路的自动滚动更新；只写一次的名单，
> 迟早会变成「模型看到的世界」里最过时的那一份。

## 4. 机械门 A–F（断言即验收）

`bash fixes/fixG-manifest.sh --verify-gate` —— 全部在 `/tmp` 合成夹具上跑，不碰生产。

| 断言 | 内容 | 结果 |
| --- | --- | --- |
| A | 依次上传 2 个文件 → 清单自动含 2 条 | PASS |
| B | 重传同名文件 → 清单不重复（幂等） | PASS |
| C | 已归档文件 → 清单不再列出，非归档条目保留 | PASS |
| D | 清单写失败 → 主链仍退出 0 且文件已落盘（fail-open） | PASS |
| E | 32 旧 + 5 新 → 条数 ≤ 30 且最旧 `uploads/old-01.txt` 被裁掉 | PASS |
| F | bot.ts hold 保存点 `h1.csv` 同样入清单 | PASS |

**负例（断言非恒真）**：把上限从 `30` 改成 `999999` 后，断言 E 立即 FAIL
（8 PASS / 1 FAIL）。即门是能失败的，不是恒绿。

## 5. 执行方式（EU 服务器，操作员执行）

本脚本**只产出补丁，从不自动应用**（agent 无生产凭据）：

```bash
bash fixes/fixG-manifest.sh --dry-run     # 看差异 + 锚点位置，不改任何文件
bash fixes/fixG-manifest.sh --apply       # 写补丁（先备份 .bak.<label>.<ts>）
bash fixes/fixG-manifest.sh --rollback --from <备份>   # 回滚
bash fixes/fixG-manifest.sh --verify-gate # 机械门 A–F
REGR_MODE=stub bash regr/regrG.sh         # 纯离线回归（不读生产）
```

`--apply` 的安全约束：锚点匹配数必须**恰好 1**，为 0 或 >1 一律故障关闭中止
（绝不按行号硬改）；渲染后仍含未替换占位符则中止；改动前先备份；用
`cat tmp > target` 保留 inode；`bun build --no-bundle` 做语法门。

## 6. 未完成 / 已知限制

- 本仓库无真实基线截图：交付物是补丁脚本与报告，**无 UI 变更**，因此 PR 不含
  Before/After 视觉证据（不伪造）。
- 与 #63（fixF「hold 释放」）都编辑 `bot.ts`：两处锚点不重叠，但**第二个应用者
  必须重新验证锚点基线**（fixF 先应用后再跑 `--dry-run` 确认命中数仍为 1）。
- `regr/regrG.sh` 的 `--apply` 段在沙盒副本上验证补丁与回滚；stub 模式不读生产。
