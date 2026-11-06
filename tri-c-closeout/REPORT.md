# 故障修复 C 交付报告：CRM 交付收口失败

- **工单**：`tri-c-closeout-5ea81f1b1e62`（Issue #39）
- **授权范围**：仅产出补丁/脚本产物，**不执行**；操作员审查后在 VM 上运行（无生产凭据）。
- **交付目录**：`tri-c-closeout/`
- **交付身份**：`VBK-AI-Agent-Gateway <315771760+VBK-AI-Agent-Gateway@users.noreply.github.com>`

---

## 1. 故障时间线（实测）

数据源：会话账本、`/home/qt/logs/sa-deliver.log`、`/home/qt/logs/sa-watchdog.log`。
原始证据由 `03-crm-vm.sh` 一次性抽取（A/B/C/D 四段，见 `03-crm-vm-out/`）。

| 时刻（UTC） | 事件 | 证据 |
| --- | --- | --- |
| 00:51:10 | 工单 `1603499d…` 开始运行 | 账本 `turn/start` |
| — | 106 步 / 119 次工具调用；其中压缩 139 次 | 账本 A2 |
| — | 耗时构成：编码 357.0s (6.7%) / 自检探查 247.5s (4.6%) / **步间间隙 4699.0s (88.1%)** | 账本 A2 |
| 02:20:02 | 会话终止 `{"kind":"aborted","reason":{"kind":"user"}}` | 账本 `turn/end` |
| — | watchdog `FLAG … idle=626s` → `FLAG … idle=705s` → **`STOP … idle=1005s resp={"stopped": true}`** | `sa-watchdog.log` 480/490/491 |
| — | sa-deliver `ENDED 1603499d3430 dir=crm-sales-app-1603499d3430 -> deliver queue` | `sa-deliver.log` 1790 |
| — | **`DELIVER … dirs=[css js ]`** ← 缺陷触发点 | `sa-deliver.log` 1800 |
| — | `SMOKE … css: SMOKE FAIL: no index.html under …/crm-sales-app-1603499d3430/css`（`js` 同） | `sa-deliver.log` 1803–1804 |
| — | `HOLD … smoke not passed; Pages sync skipped` | `sa-deliver.log` 1805 |
| — | 约 40 次重复 `SKIP … only files/dotfiles untracked`（收尾永不完成） | `sa-deliver.log` 1816→2113 |
| — | 工单 `a6d02b40…`：`WARN … directory missing` → `STOP … idle=1189s` | `sa-watchdog.log` 516/520 |

## 2. 根因（区分实测与推断）

**实测根因（代码可证）**

1. **R1 提取缺陷**：`sa-deliver.sh` 第 88 行只提取**顶层未跟踪目录**，丢弃根级未跟踪文件；
   第 89 行在无顶层目录时**静默** `SKIP`。
   该工单的应用位于 worktree **根目录**（`index.html` 在根，`css/`、`js/` 是子目录），
   于是被错误拆成 `css/` 与 `js/` 两个"交付物"。
2. **R2 门禁错位**：第 104–107 行对每个 `DELIV` 子目录**分别** smoke。子目录里没有
   `index.html`，必然 `SMOKE FAIL` → `HOLD`。**门禁方向正确，作用对象错误。**
3. **R3 静默收尾**：`HOLD` 只写日志、不改状态；下轮又因"无新内容"走 `SKIP`，
   工单停在半收口状态且**无任何升级信号**。
4. **R4 看门狗无重派**：`sa-watchdog.sh` 在 900s 空闲后 `POST /stop` 即结束，
   **没有重派/升级路径** —— 工单被"停死"，只能靠人工发现。
5. **R5 身份不一致**：`sa-deliver.sh` 第 94 行提交邮箱硬编码为
   `41816535+…`，与工单交付身份不一致。

**推断（有证据支持，非直接实测）**

6. **压缩抖动**：106 步触发 139 次 `compaction/start`，而实际写入近零
   （mtime 空闲 626s → 705s → STOP 1005s）。推断为"压缩→上下文重建"循环空转，
   与 88.1% 的步间间隙一致；**未在本机复现**，故仅列为观察项，不单独出补丁。

## 3. 修复映射

| 根因 | 修复 | 产物 | 默认行为 |
| --- | --- | --- | --- |
| R1 提取缺陷 | v2 交付物根判定：`root-is-app`（根有 `index.html` ⇒ 根即应用）／单顶层目录／多目录合并；提交**全部**未跟踪项（含根级文件） | `fixes/fixC-sadeliver-v2.sh`（P1） | dry-run |
| R2+R3 门禁与静默 | 收口完整性门：产物完整性 / smoke / Pages URL **三项全绿**才算收口；否则记 `INCOMPLETE` 并写 `deliver-incomplete.txt`，**绝不静默 SKIP** | `fixes/fixC-sadeliver-v2.sh`（P2） | dry-run |
| R4 无重派 | STOP 后自动重派一次（建 `retry-of=<原工单>` issue，由 `auto-trigger.yml` 重派），**上限 1**，超出写 `watchdog-escalate.txt` 升级人工 | `fixes/fixE-watchdog-redispatch.sh` | dry-run |
| R5 身份 | 提交邮箱修正为 `315771760+…` | `fixes/fixC-sadeliver-v2.sh`（P3） | dry-run |
| 约定缺失（C 段实测无此规则） | `prompts/team/scope.md` 追加交付目录规则行 | `fixes/fixC-sadeliver-v2.sh` | dry-run |
| R6 压缩抖动 | **未出补丁**（仅观察项，未复现） | — | — |

两个 fix 脚本均：默认 dry-run；`--apply` 前先备份 `.bak.<ts>`；`--revert <ts>` 一键回滚；
只改自己那一两个文件，**绝不动** `preview/`、`.github/` 或其它应用目录。

## 4. 文件清单

| 文件 | 一句话 |
| --- | --- |
| `03-crm-vm.sh` | 只读 VM 自检：抽取会话账本、sa-deliver 缺陷行、scope 措辞候选与两条日志的关键证据。 |
| `fixes/fixC-sadeliver-v2.sh` | 给 sa-deliver 打三处补丁：交付物根判定、收口完整性门、提交身份修正，并追加 scope 规则行。 |
| `fixes/fixE-watchdog-redispatch.sh` | 给 sa-watchdog 注入 STOP 后一次性自动重派与超限升级。 |
| `regr/regrC.sh` | 隔离回归：两种 worktree 形态下 v2 判定正确、缺口可复现、补丁幂等（16 项断言）。 |
| `regr/regrE.sh` | 隔离回归：首次 STOP 重派一次、二次升级、工单互不影响、dry-run 不建 issue（22 项断言）。 |
| `REPORT.md` | 本报告。 |

## 5. 验证记录（本地，仅脚本产物层）

- `sh -n`：`03-crm-vm.sh`、两个 fix、两个 regr 全部通过。
- `sh 03-crm-vm.sh --no-write`：退出码 0，A/B/C/D 四段证据完整。
- `sh regr/regrC.sh`：**PASS=16 FAIL=0**。
- `sh regr/regrE.sh`：**PASS=22 FAIL=0**；并断言重派段落在 STOP 分支（`mark=95 > ERROR stop=93`），
  **不在** active 分支（`mark > FLAG_S=79`），active 分支内无重派逻辑。
- `sh fixes/fixC-sadeliver-v2.sh` / `fixE-…sh`（无 `--apply`）：仅打印差异，**未写盘**。
- `scripts/smoke.sh tri-c-closeout`：见 PR 描述。

**未验证项（诚实声明）**：补丁未在真实 VM 上执行（工单要求只产出不执行）；
R6 压缩抖动未复现；`--apply` 后的端到端收口需操作员在 VM 上验证。

## 6. 回归预防检查清单（两行）

1. 新增交付物一律放**一个**顶层目录并按 issue 规格命名；`sa-deliver v2` 对"根即应用"形态自动识别，勿再拆 `css/`、`js/`。
2. 收口必须三项全绿（产物/smoke/URL）；看门狗停单后仅自动重派**一次**，第二次即升级人工 —— 任何静默 `SKIP` 都视为缺陷。

## 7. 操作员执行顺序（VM 上，审查后）

```sh
sh fixes/fixC-sadeliver-v2.sh                  # 先看 diff
sh fixes/fixC-sadeliver-v2.sh --apply          # 备份 + 应用
sh fixes/fixE-watchdog-redispatch.sh --apply
sh regr/regrC.sh && sh regr/regrE.sh           # 回归
# 如需回滚：sh fixes/fixC-sadeliver-v2.sh --revert <ts>
```
