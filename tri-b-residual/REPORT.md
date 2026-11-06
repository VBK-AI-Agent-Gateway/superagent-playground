# REPORT.md — 历史残留文件干扰（故障修复 B）

- **来源**: issue #38（授权与验收以 issue 正文为准）
- **交付目录**: `tri-b-residual/`
- **状态**: 补丁/脚本已产出并自检通过；**未在 EU 上执行**（无生产凭据，由操作员审阅后执行）
- **自检时间（UTC）**: 2026-11-06T07:31Z

---

## 1. 症状

新任务产出被**历史任务遗留文件**污染：模型可能误用、或把旧任务的文件当作当前任务
产物重新交付。用户原话（issue §0）：

> 关键是防止以后再发生这种问题。

因此每个修复都必须落三件套：① **机械门**（fail-closed，自动阻断复发）
② **机械回归脚本**（合成用例 + 断言，一条命令可重跑）③ **通知**（失败绝不静默）。

## 2. 时间线

| 阶段 | 内容 |
|------|------|
| 触发 | `github-actions[bot]` 在 issue #38 评论"执行：按 issue 正文完整规格实现" |
| 第 1 轮 | 先落地 `02-residual.sh`（按 issue §3 铁律：先写文件，再深究） |
| 第 1 轮验证 | 合成租户 fixture 上运行诊断：exit 0，耗时 1s，**零写入** |
| 第 2 轮 | 写 `fixes/fixB-residual.sh` + `fixes/README.md` |
| 第 2 轮验证 | 实测发现设计坑：归档若放在 `workspace/` 内，归档文件本身仍在 `/ws` 活跃视图 ⇒ 机械门必然误报。**改为归档到 `<租户>/archives/`（视图之外）** |
| 第 2 轮验证 | 又发现告警静默缺陷：`--gate-only` 下 `MODE=dryrun`，告警日志被跳过。**改为门禁告警与 MODE 无关，无条件留痕** |
| 第 3 轮 | 写 `regr/regrB.sh`，7 组合成用例 34 条断言，全绿 |

## 3. 根因

### 3.1 实测（本仓库内合成 fixture 复现并断言）

在合成租户上实测确认的机制：

| 机制 | 实测结果 | 判定 |
|------|---------|------|
| `/ws` 活跃视图按租户平铺持久 | `workspace/`+`uploads/` 内 >3600s 旧文件 5/7 个仍对活跃视图可见 | **open** |
| uploads 平铺、无任务子目录 | 5 个历史上传平铺在 `uploads/` 顶层，新任务直接可见 | **open** |
| 提示词注入面含历史文件 | 未过滤时目录清单含全部旧文件 | **open** |
| 会话轮换治不了文件视图 | 归档只针对 jsonl；文件视图不在其覆盖内 | **open（设计层面）** |
| 门禁开关未生效 | `FALLBACK_EXCLUDE_UPLOADS=1` 已设置，但**仅**约束 fallback 扫描路径，不约束 `/ws` 视图与提示词注入 | **open** |

### 3.2 推断（需 EU 实测佐证）

以下需 EU 上 `02-residual.sh` 的输出来证实或证伪，**本修复不依赖其结论**：

- 坑 #21（过期页面重新交付，`reject-stale`）是否持久阻断——推断为**未持久**
  （否则症状不会复发），待 `§3 activeProj/task.json` + `§1 ledger` 输出核对。
- session jsonl 累积旧文件引用（`含 "uploads/" 引用的 jsonl 文件数`）的实际规模。
- "tmpfs 作为永久账本"（已知 L3）是否已修复——待 `§5 mount/df` 输出确认。

> **实测 vs 推断的边界**：3.1 是本地可复现、已被 `regrB.sh` 固化为断言的部分；
> 3.2 是生产侧待核对项。二者在 `02-residual.sh` 的结论表中均给出"判定口径"
> （`open` = 实测存在 / `fixed` = 实测阻断 / `no-evidence` = 无证据），**不编造结论**。

### 3.3 结论

根因是**文件视图与任务边界不一致**：视图按租户持久平铺、提示词注入面按目录全量列举、
且缺少"活跃视图必须干净"的机械断言。会话轮换只归档会话，不解决文件视图。

## 4. 修复映射

| 根因 | 交付物 | 机制 |
|------|--------|------|
| `/ws` 视图含旧文件 | `fixes/fixB-residual.sh` §3 | >1h 非白名单文件归档到 `<租户>/archives/archive-<ts>/`（**视图之外**，移动不删） |
| uploads 平铺 | `fixes/fixB-residual.sh` §1 | 新建 `uploads/task-<tid>/`，旧上传归档 |
| 提示词注入历史文件 | `fixes/fixB-residual.sh` §4 | 生成 `activeProj/current-files.txt`，上游渲染只注入清单内文件 |
| 复发无阻断 | `fixes/fixB-residual.sh` 机械门 | `--gate-only`：活跃视图无 >1h 旧文件，违规 ⇒ 告警日志 + TG + **exit 1**（fail-closed） |
| 故障时需止血 | `WAGATE_RESIDUAL_VIEW=0` | fail-open 逃生门，恢复旧行为（门仍如实报告，不掩盖） |
| 可撤销/可审计 | `--rollback <ts> --apply` | `mv -n` 逆操作，md5 逐文件断言字节一致 |
| 防复发需机械验证 | `regr/regrB.sh` | 7 组合成用例 34 条断言，一条命令可重跑 |
| 需先确认生产现场 | `02-residual.sh` | 只读诊断（零写入），输出结论表 |

## 5. 交付清单

| 文件 | 一句话 |
|------|--------|
| `02-residual.sh` | 只读残留诊断：租户 top3 文件视图 + ledger 归因、`/ws` 可见面、task.json 状态、会话归档面、门禁开关、结论表（零写入、有超时、值脱敏）。 |
| `fixes/fixB-residual.sh` | 修复补丁：任务级文件视图（归档不删）+ 机械门（fail-closed 告警）+ fail-open 开关 + 回退，默认 dry-run。 |
| `fixes/README.md` | 修复文档：根因假设、变更点、机械门、逃生门、回滚步骤、验收命令、环境变量、安全性。 |
| `regr/regrB.sh` | 机械回归：合成租户 5 个旧文件，断言活跃视图干净、归档完好、清单无泄漏、门 fail-closed、回退完整、逃生门生效。 |
| `REPORT.md` | 本文件：时间线 + 根因（实测 vs 推断）+ 修复映射 + 防复发检查清单。 |
| `WIP.md` | 批次工作记录（D1–D4 与自检清单）。 |

## 6. 防复发检查清单（一行）

> 上线后：`bash fixes/fixB-residual.sh --gate-only` 必须 exit 0；每月 `bash regr/regrB.sh` 必须 34/34 通过；
> 一旦门告警（`/var/log/wagate/residual-gate.log` 有新增行）⇒ 说明有旧文件重新进入活跃视图，按 §5 回滚或重新 `--apply`。

## 7. 自检证据

| 项 | 命令 | 结果 |
|----|------|------|
| 语法门 | `bash -n 02-residual.sh fixes/fixB-residual.sh regr/regrB.sh` | 全部 SYNTAX OK |
| 诊断只读性 | 合成 fixture 运行 `02-residual.sh` | exit 0，1s，前后 `find` 快照 `diff` 干净 ⇒ **0 写操作** |
| dry-run 安全性 | `fixB-residual.sh`（默认） | 文件树无变化 |
| 修复有效 | `fixB-residual.sh --apply` | 活跃视图旧文件 5→0，归档 7 个，门 PASS exit 0 |
| fail-closed | 注入残留后 `--gate-only` | exit 1，告警落盘并点名文件 |
| 回退 | `--rollback <ts> --apply` | md5 逐文件完整还原 |
| 逃生门 | `WAGATE_RESIDUAL_VIEW=0 --apply` | 文件数不变（未归档） |
| 机械回归 | `bash regr/regrB.sh` | **34 通过, 0 失败** |

## 8. 第二阶段（操作员执行）

**本工单只产出补丁，不在 EU 上执行。** 第二阶段由操作员发起：

1. 操作员在 EU 上只读运行 `bash 02-residual.sh`（<90s，零写入），回传输出。
2. 据输出确认/修正 §3.2 的推断根因。
3. 操作员逐行审阅 `fixes/fixB-residual.sh` 后，在 EU 上 dry-run → `--apply`。
4. 运行 `bash regr/regrB.sh` 全绿；接入机械门到新任务启动路径。

## 9. 意外发现（仅记录，不在本修复中处理）

- `WAGATE_LOCAL_FRESH_OFF` 等开关的实际语义需 EU 侧 `§0` 输出佐证；本修复未依赖。
- 归档目录 `/ws` 可见性问题是实现期发现的设计坑（见 §2 时间线），已固化为回归断言。
