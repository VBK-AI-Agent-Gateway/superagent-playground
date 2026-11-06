# WIP —— 多文件并发失败修复（issue #37）

状态：**产物已完成并通过本环境全部机械验证**，等操作员在 EU 上执行阶段二。

## 已完成

- [x] `lib/_lib.sh` 共享断言 + 只读安全契约
- [x] `01-multi-file.sh` 只读取证（6 节，`bash -n` 通过，本机空跑优雅降级）
- [x] `fixes/fixA-multi-file.sh` 队列化修复 + 四道机械门（G1 / G2' / G2 / G3）
- [x] `fixes/README.md` 根因假设 / 变更点 / 回滚 / 验收
- [x] `regr/regrA.sh` 机械回归（一条消息 2 个 xlsx → N 进 N 出断言）
- [x] `REPORT.md` 时间线 / 实测 vs 推断 / 修复映射 / 复发预防表

## 关键修复（自审发现）

补丁体最初被**前置**到锚点行之前，原函数体保留 → 产物重复函数体（语法错）。
改为 `awk` 整函数体替换 + fail-closed 计数门：替换后锚文本次数必须
`== exp - 1 + 补丁体重写数`，少=多删、多=残留，两者都中止。

## 验证记录（本环境实测）

| 检查 | 结果 |
| --- | --- |
| `bash -n` 全部 4 个脚本 | OK |
| 合成夹具 `--apply` | `15 PASS / 0 FAIL / 0 WARN` |
| 合成夹具 `--rollback` | `3 PASS / 0 FAIL`，字节级还原 |
| 负例（锚点次数不符） | `0 PASS / 2 FAIL`，**零写入**，门确实拦得住 |
| `regrA.sh` stub 自检 | `4 PASS / 0 FAIL / 2 WARN` |
| 本机空跑（无生产路径） | 优雅降级报「文件不存在」，非崩溃 |

## 待办（阶段二，需操作员）

- [ ] 操作员在 EU 跑 `bash 01-multi-file.sh`，回传输出确认根因
- [ ] 按现场输出核对 P3（`ws-sync-queue.ts`）的锚点与变量名
- [ ] `--verify-gate` 全 PASS → `--apply` → 重启 → `bash regr/regrA.sh` 全绿

## 未验证项

生产链路上「2 个 xlsx 都进沙箱」需 EU 凭据，本环境不存在；TG 真实投递同。
