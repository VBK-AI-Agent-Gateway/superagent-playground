# fixes/fixB-residual.sh — 历史残留文件干扰修复（任务级文件视图 + 机械门）

对应 issue #38（故障修复 B）§2 交付物 2。**本目录只产出脚本，不在 EU 上执行**；
操作员审阅后在 EU 上执行（无生产凭据）。

- 干跑（默认，安全）: `bash fixes/fixB-residual.sh`
- 真正执行: `bash fixes/fixB-residual.sh --apply`
- 只跑机械门: `bash fixes/fixB-residual.sh --gate-only`
- 回退: `bash fixes/fixB-residual.sh --rollback <时间戳> --apply`

回归自证: `bash regr/regrB.sh`（34 条断言，合成用例，一条命令可重跑）

---

## 1. 根因假设（本修复针对的路径）

新任务被"历史任务遗留的文件"干扰，机制是**文件视图与任务边界不一致**：

1. **`/ws` 活跃视图按租户平铺持久**：`/srv/tenants/<sid>/workspace` 与 `uploads`
   长期累积、不随会话轮换归档。新任务的 `/ws` 因此能看到全部旧文件，模型可能
   误把旧文件当成当前任务产物（误用 / 重新交付旧文件）。
2. **uploads 平铺**：所有任务的上传平铺在同一层，无任务子目录，历史上传对新任务
   直接可见。
3. **提示词注入面包含历史文件**：渲染提示词时列出目录内容，未按任务过滤，
   旧文件进入模型上下文。
4. **会话轮换治不了文件视图**：`session-rotate` 只归档会话 jsonl，不清理 `/ws`。

**本修复直接消除 1/2/3**；第 4 项由本修复的"活跃视图断言门"兜底（旧文件一旦
重新出现在活跃视图即告警）。

> 实测与推断的边界：上述 3 与 4 的"实际发生程度"需 EU 上 `02-residual.sh` 的实测
> 输出佐证（见 REPORT.md）。本修复不依赖该佐证即可独立阻断该干扰路径。

## 2. 变更点（做什么）

对每个租户（或 `TENANT=<sid>` 指定的一个）：

| # | 变更 | 说明 |
|---|------|------|
| 1 | **任务级 uploads 子目录** | 新建 `uploads/task-<tid>/`，新任务上传落此，不再平铺 |
| 2 | **旧上传归档** | `uploads/` 顶层 >`STALE_SECONDS`(默认 1h) 的文件 → `<租户>/archives/archive-<ts>/uploads/` |
| 3 | **活跃视图瘦身** | `workspace/` 内 >1h 且非白名单文件 → `<租户>/archives/archive-<ts>/workspace/<原相对路径>` |
| 4 | **当前任务文件清单** | 写 `workspace/activeProj/current-files.txt`，**上游渲染提示词只允许注入清单内文件** |
| 5 | **机械门** | 断言活跃视图无 >1h 旧文件（白名单除外）；违规 ⇒ 告警日志 + Telegram + exit 1 |

**关键设计**：归档目录位于 `<租户>/archives/`，**在 `/ws` 活跃视图之外**。
若归档在 `workspace/` 内部，归档文件本身仍会出现在活跃视图、机械门必然误报——
这是实现期实测发现的坑，已在 `regr/regrB.sh` 用例 2 固化为断言。

**绝不删除用户文件**：只 `mv -n` 移动，不 `rm`。文件名冲突时不覆盖（`-n`）。

## 3. 机械门（fail-closed）

```
bash fixes/fixB-residual.sh --gate-only   # 违规 → exit 1
```

- 阈值 `STALE_SECONDS`（默认 3600 = 1 小时）。
- 白名单 `WHITELIST`（默认 `task.json activeProj/task.json activeProj/* .keep README.md`）：
  系统必需文件即便过期也放行，避免门自己制造告警噪音。
- 违规时：**告警日志**（`ALERT_LOG`，默认 `/var/log/wagate/residual-gate.log`）
  + **Telegram**（`TG_NOTIFY=1`）+ **exit 1**。三者任一可用即可留痕，绝不静默。
- 建议接入：新任务启动前调用 `--gate-only`，非 0 即阻断启动并通知。

## 4. fail-open 逃生门

`WAGATE_RESIDUAL_VIEW=0` ⇒ 跳过归档与清单注入，恢复旧行为（故障时快速止血）。
逃生门开启期间，机械门**仍会**如实报出活跃视图中的旧文件（不掩盖问题），
但不会自行归档。排气后置回 `1` 即可。

## 5. 回滚

```bash
# 1) 找到归档时间戳（脚本每次 --apply 都会打印，也可 ls）
ls -1 /srv/tenants/<sid>/archives/
# 2) 先干跑确认将要还原什么
bash fixes/fixB-residual.sh --rollback 20261106T071931Z          # dry-run
# 3) 真正还原（旧文件回到原相对路径；归档壳清空后移除）
bash fixes/fixB-residual.sh --rollback 20261106T071931Z --apply
# 单租户
TENANT=<sid> bash fixes/fixB-residual.sh --rollback <ts> --apply
```

回滚为 `mv -n` 逆操作，**内容字节一致**（`regr/regrB.sh` 用例 6 用 md5 逐文件断言）。
回滚后可再跑 `--gate-only` 确认现状。

## 6. 验收（一条命令）

```bash
bash regr/regrB.sh          # 期望: 回归结果: 34 通过, 0 失败
```

覆盖断言：
- A 活跃视图无旧文件；B 旧文件归档且内容完好；C 提示词清单无旧文件泄漏；
- D 机械门干净通过 / 注入残留即 fail-closed 且留痕 / 白名单放行；
- E 回退完整还原；F fail-open 逃生门生效。

## 7. 环境变量一览

| 变量 | 默认 | 含义 |
|------|------|------|
| `TENANT_ROOT` | `/srv/tenants` | 租户根 |
| `TENANT` | 空（全部） | 只处理某租户（sid 或绝对路径） |
| `WAGATE_RESIDUAL_VIEW` | `1` | `0` = fail-open 关闭本修复 |
| `STALE_SECONDS` | `3600` | 机械门"旧"阈值 |
| `WHITELIST` | 见 §3 | 门白名单（空格分隔的相对路径 glob） |
| `ALERT_LOG` | `/var/log/wagate/residual-gate.log` | 告警日志（目录须已存在） |
| `TG_NOTIFY` | `1` | 违规时发 Telegram |
| `WAGATE_ENV` | `/etc/wagate.env` | TG 凭据来源（只读，不打印） |
| `PROMPT_MANIFEST` | `activeProj/current-files.txt` | 当前任务清单输出相对路径 |
| `ARCHIVE_PREFIX` | `archive-` | 归档目录名前缀 |

## 8. 安全性说明

- **零 secret 入库**：脚本不含任何凭据；TG token 只从环境或 `WAGATE_ENV` 只读读取，不打印。
- **不做破坏性操作**：不删除用户文件；`--apply` 前默认 dry-run。
- **只写必要位置**：租户 `archives/`、`uploads/task-<tid>/`、`workspace/activeProj/`；
  告警日志**只追加且目录缺失时不建目录**（降级 stderr），避免意外写入。
- **越界不修**：诊断中偶然发现的其他问题只在 REPORT.md 记录，不在本修复中改动。
