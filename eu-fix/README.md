# eu-fix — EU 服务器（5.189.129.216）收尾修复脚本包

本目录是**供人工操作员在 EU 服务器上审阅并执行**的修复脚本包。6 个脚本各自独立、按编号顺序执行，
全部**默认 dry-run（只打印将执行的命令，不做任何改动）**，只有显式加 `--apply` 才真正生效。

> **本包从未在 EU 服务器上执行过。** 编写与自检都在开发机上完成；执行由操作员负责。

## 目录

| 文件 | 用途 | 是否改文件 |
| --- | --- | --- |
| `lib/common.sh` | 公共库：参数解析、模式横幅、日志、`run` 包装、root 门禁、备份后缀、站点常量 | 否 |
| `01-clean-orphan-sbx.sh` | 清理 201 个孤儿沙箱进程（`v2_agent.sh sbx-*`），工作目录归档不删除 | 归档 `ws/sbx-*` |
| `02-a01-incremental.sh` | A01 增量备份到 `/srv/backup/A01.<日期>/`，生成自排除 `MANIFEST.sha256` + `RESTORE.md` | 只写备份目录 |
| `03-channel13-whitelist.sh` | 把 token `sk-user03-m3-…` 加入 ai-gateway 白名单并加 `Qwen3.8-27B`，重启 + PID 断言 + curl 验证 | `/opt/ai-gateway/data/core.db` |
| `04-docpack-logfix.sh` | 删掉 `doc-pack.ts` 第 327 行 `ANCHOR-DIAG` 杂散日志，保 inode 写回 + 容器内 md5 + bun build + 重启 | `/srv/wagate/patches/doc-pack.ts` |
| `05-billingsync-interval.sh` | `claw-billing-sync.timer` 改为 5 分钟间隔 | timer unit |
| `06-nginx-bakfile.sh` | 把 `sites-enabled/privacy-policy.bak_qr` 移到 `sites-available/` | nginx 配置文件名 |

不做的事：不触碰 `asg-harness2-bypass`、m3 链路、`gstack.v6`，不改 `preview/` 与其他既有目录。

## 执行顺序

严格按编号执行，每步确认无误再做下一步：

```bash
cd eu-fix

# 0) 先全部 dry-run 看计划（不需要 root，不会改动任何东西）
./01-clean-orphan-sbx.sh
./02-a01-incremental.sh
./03-channel13-whitelist.sh
./04-docpack-logfix.sh
./05-billingsync-interval.sh
./06-nginx-bakfile.sh

# 1) 备份优先：先做 02，保证后续改动前有可回滚的基线
sudo ./02-a01-incremental.sh --apply

# 2) 清理孤儿沙箱（有 delivered 日志会自动拒绝）
sudo ./01-clean-orphan-sbx.sh --apply

# 3) 白名单（会重启 ai-gateway）
sudo ./03-channel13-whitelist.sh --apply

# 4) doc-pack 日志行（会重启 wagate）
sudo ./04-docpack-logfix.sh --apply

# 5) 计费定时器（只改 timer 频率）
sudo ./05-billingsync-interval.sh --apply

# 6) nginx 备份文件归位（nginx -t 通过才 reload）
sudo ./06-nginx-bakfile.sh --apply
```

`--apply` 需要 root；非 root 运行 `--apply` 会直接拒绝。所有脚本支持 `-h/--help`。

## 每个脚本的用途 / 回滚方法 / 风险

### 01-clean-orphan-sbx.sh
- **用途**：枚举命令行匹配 `bash /home/qt/claw-exp/scripts/v2_agent.sh sbx-` 的进程，先 SIGTERM、10 秒后仍在则 SIGKILL；再把 `/home/qt/claw-exp/ws/sbx-<id>` **改名归档**到 `/home/qt/claw-exp/ws/.trash-sbx/<id>.<ts>`（是 `mv` 不是 `rm`）。
- **回滚**：进程已被清理无法“恢复”；工作目录仍在 `.trash-sbx/` 下，需要时 `mv` 回 `ws/`。确认无用后手动 `rm -rf /home/qt/claw-exp/ws/.trash-sbx`。
- **风险**：误杀正在跑的沙箱任务。脚本第 1 步是故障关闭门禁——`docker logs wagate --since 5m 2>&1 | grep -q delivered` 一旦命中就打印警告并**拒绝执行（退出码 1）**。请勿绕过该检查。
- 自检替身可用 `EUFIX_PROC_ROOT=<dir>` 改变枚举目录（默认 `/proc`）；正式执行时不要设置。

### 02-a01-incremental.sh
- **用途**：把 `/srv/wagate/patches/**.ts`（排除 `*.bak.*`）+ 保护清单 6 项（`/srv/wagate/HANDOFF.md`、`/etc/wagate.env`、`/etc/systemd/system/wagate.service`、`/etc/nginx/sites-enabled/workspace-static`、`/usr/local/bin/session-rotate.sh`、`/etc/cron.d/session-rotate`）复制到 `/srv/backup/A01.<YYYYMMDD>/`，保持原绝对路径结构，生成 `MANIFEST.sha256`（**排除自身**）与 `RESTORE.md`。
- **参数**：`--dest <dir>` 覆盖目标；`--force` 允许写入已存在的目标目录（默认拒绝）。
- **回滚**：本脚本不修改任何现有文件，回退即 `rm -rf /srv/backup/A01.<日期>`。
- **风险**：`core.db` 不在本备份范围内（`RESTORE.md` 已注明）；空间不足会中途失败，脚本会先打印 `df -Pm`。`EUFIX_FAKE_ROOT=<dir>` 仅用于开发机演练。

### 03-channel13-whitelist.sh
- **用途**：探测 `/opt/ai-gateway/data/core.db` 的 tokens 白名单字段 schema → 备份 `core.db.bak.ch13_<ts>` → 把 `Qwen3.8-27B` 追加进 `sk-user03-m3-e34bfe06a71ead8e` 的白名单 → `systemctl restart ai-gateway` → 断言 MainPID 变化且 `is-active` → 用该 token 请求该模型，期望 HTTP 200。
- **回滚**：`cp -a /opt/ai-gateway/data/core.db.bak.ch13_<ts> /opt/ai-gateway/data/core.db && systemctl restart ai-gateway`（脚本结尾会原样打印实际备份路径）。
- **风险**：会**重启 ai-gateway**（短暂中断）；写错字段会破坏 token 配置，因此正式写入前脚本先做幂等检查、写入后仍缺失即 `die`。白名单字段名可用 `AIGW_WHITELIST_COL` 覆盖（默认 `models`）。

### 04-docpack-logfix.sh
- **用途**：`/srv/wagate/patches/doc-pack.ts` 第 327 行的 `console.log(...ANCHOR-DIAG...)` 整行删除。流程：备份 `.bak.diagfix.<ts>` → `grep -v ANCHOR-DIAG` 生成新文件到临时路径 → **`cat temp > doc-pack.ts`（保 inode）** → 容器内 `md5sum` 与宿主一致 → 容器内 `bun build` 退出码为 0 → `docker restart wagate` → 运行时 `await import(...)` 冒烟要求输出 `SMOKE_OK`。
- **回滚**：`cat /srv/wagate/patches/doc-pack.ts.bak.diagfix.<ts> > /srv/wagate/patches/doc-pack.ts && docker restart wagate`。
- **风险**：哪个文件是 bind-mount 的单文件，**不能用 `sed -i`/`mv`**（会换 inode，容器仍看旧文件）——脚本用 `cat >` 并断言前后 inode 相同。`bun build` 的退出码**不能进管道**（会被吞掉），脚本直接取 `$?`。会重启 `wagate`（短暂中断）。第 327 行必须恰好命中 1 次，否则拒绝执行。

### 05-billingsync-interval.sh
- **用途**：备份 `/etc/systemd/system/claw-billing-sync.timer` 为 `.bak.bill5m.<ts>`，把 `[Timer]` 段替换成 `OnCalendar=` + `OnUnitActiveSec=5min` + `Persistent=true`（保留 `[Unit]`/`[Install]`），然后 `daemon-reload` → `restart` → `is-active` 门禁 → `systemctl list-timers` 确认 `NEXT` 约 5 分钟内。
- **回滚**：`cp -a /etc/systemd/system/claw-billing-sync.timer.bak.bill5m.<ts> /etc/systemd/system/claw-billing-sync.timer && systemctl daemon-reload && systemctl restart claw-billing-sync.timer`。
- **风险**：unit 写坏会让计费同步停止，因此写入后有 `is-active` 门禁。频率提高意味着同步跑得更勤：请确认 `claw-billing-sync.service` 幂等、上游 API 能承受；如必须用日历表达式，脚本会打印可选方案 `OnCalendar=*:0/5`。

### 06-nginx-bakfile.sh
- **用途**：`/etc/nginx/sites-enabled/privacy-policy.bak_qr` → `/etc/nginx/sites-available/`（同名，重名时加时间戳）；移动后 `nginx -t` 必须通过，然后 `systemctl reload nginx` 并复查。
- **回滚**：`mv /etc/nginx/sites-available/privacy-policy.bak_qr /etc/nginx/sites-enabled/privacy-policy.bak_qr && nginx -t && systemctl reload nginx`（脚本打印实际目标路径）。
- **风险**：若该文件其实**在被使用**（名字带 `.bak_qr` 但仍被 include），移走会导致站点 404；脚本移动前用 `nginx -T | grep` 打印引用位置，`nginx -t` 失败时**不 reload** 并给出回退命令。纯备份文件移走后 `nginx -t` 反而会由失败变为通过。

## 自检证据（开发机，非 EU 服务器）

所有脚本都通过了 `sh -n` 与 `bash -n` 语法门禁：

```
$ for f in eu-fix/*.sh eu-fix/lib/common.sh; do sh -n "$f" && echo "$f OK"; done
01-clean-orphan-sbx.sh         OK
02-a01-incremental.sh          OK
03-channel13-whitelist.sh      OK
04-docpack-logfix.sh           OK
05-billingsync-interval.sh     OK
06-nginx-bakfile.sh            OK
lib/common.sh                  OK
```

### 01 dry-run（替身进程表）

开发机上没有现场 201 个孤儿进程，因此用替身：`setsid` 起两个命令行与现场一致的假沙箱进程
（`bash /home/qt/claw-exp/scripts/v2_agent.sh sbx-aaa ...`、`sbx-bbb`）外加一个不匹配的
`sleep 600`，把它们的 `/proc/<pid>/{cmdline,stat}` 复制成一份替身进程表，再用
`EUFIX_PROC_ROOT` 让脚本读它。摘要：

```
===== 第 2 步：枚举孤儿沙箱进程 =====
[info] 匹配进程数：2
    136901	136892	bash /home/qt/claw-exp/scripts/v2_agent.sh sbx-aaa /home/qt/claw-exp/ws/sbx-aaa
    136902	136892	bash /home/qt/claw-exp/scripts/v2_agent.sh sbx-bbb /home/qt/claw-exp/ws/sbx-bbb

===== 第 3 步：清理计划（先 SIGTERM，10 秒后仍在则 SIGKILL） =====
[dry-run] 向 2 个孤儿沙箱 PID 发送 SIGTERM
          $ sh -c printf '%s\n' "$1" | cut -f1 | xargs -r kill -TERM _ 136901 …
[dry-run] 等待 10s 让进程自然退出
          $ sleep 10
[dry-run] 对仍未退出的 PID 发送 SIGKILL

===== 第 4 步：整理沙箱工作目录 =====
    待归档目录: sbx-aaa
    待归档目录: sbx-bbb
[dry-run] 将执行：$ mv /home/qt/claw-exp/ws/sbx-aaa /home/qt/claw-exp/ws/.trash-sbx/<sbx-id>.<ts>

[info] 以上为 dry-run 计划，未做任何改动。
```

干扰进程 `sleep 600` 未被匹配（进程数 2 而非 3）。**故障关闭门禁也验证过**：把替身 `docker logs`
改成输出含 `delivered` 的日志后，脚本拒绝执行并以退出码 1 结束：

```
[warn] 检测到 wagate 最近 5 分钟内有 delivered 日志，判定有任务正在跑 → 拒绝清理。
[error] 本次不执行任何清理动作。等任务跑完（或 5 分钟无 delivered）后再运行。
```

### 02 dry-run / apply 演练（替身文件树）

用一份假文件树（`patches/doc-pack.ts`、`patches/other.ts`、`patches/doc-pack.ts.bak.20261001`
以及 6 个保护清单文件）配合 `EUFIX_FAKE_ROOT` 演练。dry-run 打印的计划（目标 `/srv/backup/A01.<日期>`）：

```
[dry-run] 将执行（示意前 5 条）：
          $ mkdir -p /srv/backup/A01.20261104/srv/wagate/patches
          $ cp -a /srv/wagate/patches/doc-pack.ts /srv/backup/A01.20261104/srv/wagate/patches/doc-pack.ts
          …
          $ cd /srv/backup/A01.20261104 && find . -type f ! -name 'MANIFEST.sha256' -print0 | sort -z | xargs -0 -r sha256sum > MANIFEST.sha256
          $ wc -l MANIFEST.sha256        # 期望 8 行（等于备份文件数，不含 MANIFEST 自身）
```

`--apply` 演练（写入 `/tmp/eu-fix-selftest/out`）实测结果：

- 备份文件数 8 = live `*.ts` 2 个 + 保护清单 6 项；`doc-pack.ts.bak.20261001` 被正确排除。
- `MANIFEST.sha256` 行数 8，**不含自身条目**（历史陷阱已规避）。
- `sha256sum -c MANIFEST.sha256` 全部 `OK`。
- `RESTORE.md` 生成，并注明 `core.db` 不在本备份范围内。
- 在非 root 下直接 `--apply` 被拒绝；`sudo` 下正常执行。

### 03 / 04 / 05 / 06 dry-run 会打印什么

本机没有 `core.db`、`wagate` 容器、`claw-billing-sync.timer` 和 `/etc/nginx` 现场，因此这四个脚本
**只能做语法与逻辑自检**，未做端到端演练。dry-run 时它们分别打印：

- **03**：第 1 步检查 `sqlite3` 与 `$AIGW_DB` 是否存在；第 2 步打印 `.tables`、`tokens`/`channels`/`model_configs`
  的 DDL、目标 token 当前行、候选白名单列（`pragma_table_info('tokens')` 中匹配 model/allow/group 的列）；
  第 3 步打印 `cp -a core.db core.db.bak.ch13_<ts>`；第 4 步打印将执行的 `UPDATE tokens SET <列>=…` 与写入前后值；
  第 5 步打印 `systemctl restart ai-gateway` 与 PID 断言命令；第 6 步打印 curl 验证命令（期望 200）与回滚命令。
- **04**：第 1 步打印 `grep -c ANCHOR-DIAG doc-pack.ts`（期望 1）和第 327 行预览；第 2 步打印
  `cp -a doc-pack.ts doc-pack.ts.bak.diagfix.<ts>` 与 `grep -v ANCHOR-DIAG … > 临时文件`；第 3 步打印保 inode 的
  `cat 临时文件 > doc-pack.ts` 及 inode 相等断言；第 4 步打印宿主/容器 `md5sum` 对比命令；第 5 步打印
  `docker exec wagate sh -c "cd /app && bun build ./extensions/plugins/doc-pack.ts --target=bun > /tmp/…log 2>&1"`
  （无管道，直接取退出码）；第 6 步打印 `docker restart wagate`、运行时 `import` 冒烟（期望 `SMOKE_OK`）与回滚命令。
- **05**：第 1 步 `systemctl cat` + `list-timers` 并打印当前 `[Timer]` 段；第 2 步打印
  `cp -a <unit> <unit>.bak.bill5m.<ts>`；第 3 步打印新的 `[Timer]` 段（`OnCalendar=`、`OnUnitActiveSec=5min`、
  `Persistent=true`）与可选的 `OnCalendar=*:0/5` 方案；第 4 步打印 `systemctl daemon-reload` 与 `restart`；
  第 5 步打印 `is-active`（期望 active）与 `list-timers`（期望 `NEXT` 约 5 分钟内）。
- **06**：第 1 步打印 `ls -la` 目标文件与 `sites-enabled` 清单、`nginx -T | grep privacy-policy.bak_qr`；
  第 2 步打印移动前的 `nginx -t`（基线）；第 3 步打印 `mv …/sites-enabled/privacy-policy.bak_qr …/sites-available/`；
  第 4 步打印 `nginx -t`（失败则不 reload 并回退）与 `systemctl reload nginx`；第 5 步打印复查命令。

**未验证项**：03–06 的端到端行为（真实 SQLite 写入、容器重启、systemd timer 生效、nginx reload）
只能在 EU 服务器上由操作员执行时验证。请先跑 dry-run 核对命令，再逐个 `--apply`。

## 关于 `scripts/smoke.sh`

仓库的 `scripts/smoke.sh <dir>` 要求交付目录内有 `index.html` 才能做无头浏览器加载
（否则报 `SMOKE FAIL: no index.html under <dir>`）。本包是纯 shell 脚本，
按 issue 要求**不创建 `index.html`**，因此该门禁不适用于本交付；本包以
`sh -n`/`bash -n` 语法门禁 + 上述 dry-run 演练作为验证证据。
