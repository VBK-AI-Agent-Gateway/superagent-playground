# WIP — 故障修复 B（issue #38）进度

- [x] 读 issue #38 正文规格 + 仓库 AGENTS.md
- [x] D1 `02-residual.sh`（EU 只读诊断，六项，<90s）— fixture 实测 exit 0 / 1s / 零写入
- [x] D2 `fixes/fixB-residual.sh` + `fixes/README.md`（dry-run/--apply/机械门/回退）— 归档移至 archives/（视图外）+ 告警无条件留痕
- [x] D3 `regr/regrB.sh`（合成用例 + 断言）— 实跑 34 通过 / 0 失败
- [x] D4 `REPORT.md` — 时间线/根因(实测vs推断)/修复映射/防复发清单
- [x] 自检：bash -n 全部脚本、regrB 实跑 34/34、02 零写入核查、fixture 已清理
- [ ] commit + push + PR + 工单回复摘要

约定：
- 所有脚本 `bash -n` 通过；`set -euo pipefail`；外部命令一律 `timeout`。
- 只读脚本绝不写目标机任何路径（诊断结果只打 stdout）。
- 仓库内零 secret、零真实凭据；示例值为占位符。
- 中文注释与输出。
