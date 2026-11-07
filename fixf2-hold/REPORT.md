# fixF2-hold —— file-only 挂起死锁修复 v2（回炉版）

- 关联：issue #66（本回炉单） / issue #63（原修复单） / PR #66（v1 包 `fixf-hold/`）
- 交付目录：`fixf2-hold/`
- 基线：`fixf-hold/`（v1）为**强制基础**，本包在其旁新建，不改写 v1
- 版本：v2.0.0 ｜ 生成时间：2026-11-07（UTC）
- 性质：**只产出补丁与脚本，绝不执行**。无生产凭据，落地由操作员审后执行。

---

## 1. v1 为什么把容器打崩（根因）

v1 的修复**意图正确**（file-only 要能进当轮、挂起的文件要能释放），但补丁体里做了两处
**对既有 `const` 的裸赋值**：

```
bot.ts:260   const text = rawText.trim();      <-- 既有 const
bot.ts:273   const file = m.file as {...};      <-- 既有 const

v1 补丁体（fixf-hold/fixes/fixF-hold.sh）:
  第 44 行   text = `用户为当前任务补充上传的文件：${file.fileName}`;   <-- 裸赋值到 const text
  第 12 行   file = __fp__ as typeof file;                              <-- 裸赋值到 const file
```

在 bun 里，对 `const` 的赋值不是「运行时抛错」，而是**加载/编译期即判定非法**：

```
error: Cannot assign to 'text' because it is a constant.
```

后果是：产物一被加载，进程立刻退出 —— 不是偶发，是**必然**。表现出来就是
「apply 完一重启，容器反复退出，服务起不来」。

**为什么 v1 的门没拦住？** v1 有 G1（锚点 ×1）、G2（特征串形态）、G2′（替换唯一性），
三道全是「**机械**」门：它们只看文本在不在、出现几次，**没有任何一道门看语义合法性**
（赋值的左边是不是个 const）。门全绿 + 产物必崩 = 门的设计缺了「语义」这一维。

> v2 补的正是这一维：**G3 静态门** + **产物真编译**。

---

## 2. v2 修复映射（对应 issue #66 的五条规格）

| 规格 | 问题 | v2 做法 | 落点 |
|---|---|---|---|
| **v2-1** 新 const 注入 | v1 裸赋值到 `const text`（还有 `const file`）→ 加载期崩 | **新建** `const __fixF2Text__ = __fixF2Injected__ ? \`用户为当前任务补充上传的文件：${file.fileName}\` : text;`，并把下游 `core.handle` 的 `text:` 实参改指它；释放路径的文件用**新 `let __fixF2File__`** 承载，不写 `file` | `fixes/fixF2-hold.sh` 的 `p1_body()` |
| **v2-2** G3 静态门 | 门里没有「语义合法性」这一维 | 从目标文件提取全部既有 `const <name> =` 名（本包在 bot.ts 快照上提取到 **70** 个）；补丁体里若出现裸赋值 `<name> =` → **FAIL 并中止整批**。在 **mktemp/备份之前**跑，绝不写出会崩的产物（fail-closed） | `gate_g3_const()` |
| **v2-3** 参数一致性 | `--dry-run` 置的是 `MODE="dryrun"`，而分支是 `case "$MODE" in dry\|gate)` → **落不进任何分支，静默 exit 0**（假绿，最危险）；默认 `TARGET=/app/bot.ts` 是**容器内**路径，在宿主上跑必然「文件不存在」 | `--dry-run` 置 `MODE="dry"` 对齐分支；默认 `TARGET=/srv/wagate/patches/bot.ts`（**宿主**路径） | 参数解析 + 配置段 |
| **v2-4** regrF 升级 | 只断言日志，不验证产物能不能被加载 | **先**跑容器内 `bun build /app/bot.ts`，构建不过 = 整轮 FAIL 且**不再跑 A/B/C**；用例 A 必须经真实容器加载验证（看 `active task linked` + 注入句进当轮） | `regr/regrF2.sh` 门禁 0 |
| **v2-5** 操作员铁律 | v1 的操作顺序是「apply → 重启」，崩了才发现 | 写死顺序：**apply → `docker exec wagate bun build /app/bot.ts` 验证 → 仅在通过后 `systemctl restart wagate`** | 脚本 `--apply` 末尾 + 本报告 §5 |

### 2.1 v2-3 那条「假绿」值得单独强调

`MODE="dryrun"` 落不进 `dry|gate` 分支，于是 `case` 走完什么都不做，
脚本以 **exit 0** 结束 —— 操作员看到「成功」，实际**一条门都没判**。
这比崩容器更隐蔽：崩容器至少看得出来。

v2 用 `--check-body` 暴露这类问题（下方 §4 就是拿它自检的），
并让 `--dry-run` 真正走 `dry` 分支。

### 2.2 关于 `file` 的落地边界（与 v1 一致，未扩范围）

`core.handle` 的 **file 形参**不在本包授权范围内（`tenant-core.ts` 接收侧改动属于 v1 §3.1 已
标注的「超出范围、操作员决定」项）。因此释放出的文件通过
①回写既有 `globalThis.__excelPendingFile` 黑板槽（upload-ops 的 `before_agent_start` 读的就是它）
②注入句进当轮文本，两条既有链路进入当轮上下文，**不新增** `handle` 的 file 传参。

---

## 3. 唯一一条预防规则

> **补丁体里出现目标文件既有 `const` 名的裸赋值 = 门禁 FAIL。**

就这一条。它直接对应本次事故，且可机械判定 —— 已经落在 `gate_g3_const()` 里，
既可以随 `--apply` 跑，也可以单独 `--check-body` 跑（CI 友好）。

---

## 4. 验证证据（本包只做静态自检，未执行任何落地）

> 硬约束：无生产凭据，**绝不执行** `fixes/fixF2-hold.sh` 与 `regr/regrF2.sh` 的落地路径。
> 本节全部为静态/离线检查。

### 4.1 语法

```
bash -n fixf2-hold/fixes/fixF2-hold.sh   -> OK
bash -n fixf2-hold/regr/regrF2.sh        -> OK
```

### 4.2 G3 门禁四向验证（关键证据）

| 输入 | 期望 | 实测 |
|---|---|---|
| **真实 v1 补丁体**（从 `fixf-hold/fixes/fixF-hold.sh` 原样抽出） | FAIL | ✅ 命中 2 处：`file`（第 14 行）、`text`（第 42 行） |
| 正例集（裸赋值 `text =` / `file =`） | FAIL | ✅ 两处均命中 |
| 反例集（`===` `==` `!=` `!==` `=>` `.length` `obj.text=` `text2=` `mytext=`、`// text = ...` 注释、同名 `const/let/var` 声明） | PASS | ✅ 无一条误报 |
| **v2 补丁体本身** | PASS | ✅ 静态合法 |

**G3 对真实 v1 补丁体命中 file+text**，是本包最直接的「如果 v1 有这道门，事故就不会发生」证据。

### 4.3 编译器级验证（替代 `bun build`）

本机无 `bun`（`--check-body` 会 WARN 并跳过 bun 自检，G3 独立成立）。改用本机 TypeScript
5.6.3 对**补丁体 + 同形前置**做 `--noEmit` 编译，TypeScript 报的正是 bun 会报的那类错：

| 产物 | 编译结果 |
|---|---|
| **v1 补丁体** | `TS2588: Cannot assign to 'file' because it is a constant.`（第 21 行）<br>`TS2588: Cannot assign to 'text' because it is a constant.`（第 49 行） → **复现事故** |
| **v2 补丁体**（包在真实 `async onMessage(m, adapter)` 签名内，前置 `const text` / `const file` 与 bot.ts 同形） | **0 error，exit 0** |

这直接证明 v2-1 的「新 const + 下游重定向」确实消除了加载期崩溃。

### 4.4 独立复核（不信任脚本自身）

用一段**不复用脚本函数**的独立命令重算 bot.ts 的 70 个既有 const 名，再在 v2 补丁体里搜裸赋值：
唯一命中是**注释行**（描述 v1 缺陷的那句中文注释），代码部分零命中 —— 与 G3 的 `comment` 剔除逻辑一致。

### 4.5 未覆盖 / 已知薄弱项

- **bun 未在本机验证**：`bun build` 与容器内加载行为只能在操作员环境跑。
  §4.3 的 tsc 验证是同语义的替代证据，但**不等于** bun 实测。
- **A/B/C 只有判读口径（stub），无真实验证**：`regr/regrF2.sh --stub` 已跑通并打印口径；
  live 需要容器在跑且有真实消息通道，属操作员执行范围。
- **G3 是文本级静态分析，不是 AST**：理论上可被规避（如把赋值拆到别的行、用 `eval`）。
  对本事故这一族（直白的裸赋值）足够；不宣称是完备的类型检查。
- **锚点尚未在真实宿主文件上验证**：`/srv/wagate/patches/bot.ts` 本环境不可见，
  G1 的「锚点 ×1」需操作员首次 `--dry-run` 时确认真实文件形态。

### 4.6 脚本行为自检（参数面）

| 检查 | 结果 |
|---|---|
| `fixF2-hold.sh --help` / `regrF2.sh --help` | rc=0（参数解析器不崩） |
| `--nonsense`（未知参数） | rc=2（用法错误，**不**返回 0 假绿） |
| `regrF2.sh` live 且容器不在 | rc=2 且计为 **SKIP**（非 FAIL）——「环境没到」不得误报成「修复有问题」 |
| `regrF2.sh --stub` | rc=0，只打印 A/B/C 口径，不接触容器 |

> 关于仓库 `scripts/smoke.sh`：它是**浏览器页面**门（要求交付目录下有 `index.html`），
> 本包是 shell 脚本 + Markdown，没有页面可加载。已实测：**v1 基线 `fixf-hold/`（PR #66 已合入）
> 在同一门下同样报 `SMOKE FAIL: no index.html`** —— 该门对本类交付不适用，非本包引入的失败。
> 本包改用上表的等效检查（`bash -n` + 参数面 + G3 四向 + tsc 编译）。

---

## 5. 操作员运行手册（顺序不可颠倒）

```bash
# 0) 先看清现场：dry-run（默认就是 dry，只判门不写文件）
TARGET=/srv/wagate/patches/bot.ts bash fixF2-hold/fixes/fixF2-hold.sh
#    - G1 锚点 ×1 / G3 无 const 裸赋值 / bun 语义自检 全 PASS 才继续
#    - 任一 FAIL：现场代码已变或产物会崩，停手，贴输出再评估

# 1) 落地（自动备份 bot.ts.bak-<UTC戳>，原地重写保留 inode）
TARGET=/srv/wagate/patches/bot.ts bash fixF2-hold/fixes/fixF2-hold.sh --apply

# 2) ★ 关键：先在容器内验证产物能编译，**不要先重启** ★
docker exec wagate bun build /app/bot.ts
#    编译失败 -> 立刻回退，不要重启：
#      TARGET=/srv/wagate/patches/bot.ts bash fixF2-hold/fixes/fixF2-hold.sh --rollback --from <戳>

# 3) 编译通过后，才重启
systemctl restart wagate.service

# 4) 跑机械断言（开头即含容器内 bun build 门 + A/B/C）
bash fixf2-hold/regr/regrF2.sh

# 5) 任何时候回退
TARGET=/srv/wagate/patches/bot.ts bash fixF2-hold/fixes/fixF2-hold.sh --rollback --from <戳>
```

**为什么第 2 步必须在第 3 步之前**：v1 事故就是省了第 2 步 —— 先重启，容器在**加载期**崩，
服务直接起不来。`bun build` 能在重启前就把这类错误暴露出来。

### 5.1 fail-open 开关

```bash
WAGATE_HOLD_RELEASE=0   # 一键回旧版：F1 不联动、F2 不释放（不影响进程启动）
```
联动探测（`__fixF2ActiveTask` 钩子）本身也 fail-open：探不出来就保持旧的 hold 行为，
**绝不因本修复把用户消息弄丢**。

### 5.2 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TARGET` | `/srv/wagate/patches/bot.ts` | 宿主侧 bot.ts 路径（容器内是 `/app/bot.ts`，别混） |
| `WAGATE_HOLD_RELEASE` | `1` | `0` = 关闭本修复（fail-open 回旧版） |
| `WAGATE_UNIT` | `wagate.service` | 重启提示里的 unit 名 |
| `CONTAINER` | `wagate` | 容器名（仅用于打印验证命令，脚本从不 docker exec 改动） |
| `FILE_AUTO_ROUTE` | （未设=启用） | `0` = file-only 直通旧行为（既有开关，未改） |

---

## 6. 硬约束遵守情况

| 约束 | 状态 |
|---|---|
| 只产出、不执行 | ✅ 本包两个脚本均未在落地路径上执行过 |
| 默认 dry-run | ✅ `MODE="dry"` 为默认 |
| 锚点不匹配即中止 | ✅ G1 不匹配 → `gate_fail` 整批中止，绝不做部分替换/猜测性匹配 |
| 备份 + 回滚 | ✅ `.bak-<UTC戳>`；`--rollback --from <戳>`；`cat >` 写回保留 inode（宿主 bind-mount） |
| 容器路径铁律 | ✅ 注释与提示均区分宿主 `/srv/wagate/patches/bot.ts` 与容器 `/app/bot.ts` |
| 不挂新文件到 `/app/extensions/plugins/` | ✅ 本包不安装任何插件文件（只改 bot.ts 单文件） |
| EU 只读 / 零机密 | ✅ 脚本不含任何 token/key/聊天 ID；注入用例只用假用户 `regrF2-a/b/c` |
| 中文注释与报告 | ✅ |
| 不改写 v1 | ✅ `fixf-hold/` 原样保留为基线 |
| 零构建交付 | ✅ 无 `node_modules`、无 npm 构建步骤 |

---

## 7. 文件清单

| 文件 | 一句话 |
|---|---|
| `fixf2-hold/fixes/fixF2-hold.sh` | v2 补丁脚本：默认 dry-run，新增 `--check-body`/`--verify-gate`，带 G3 const 裸赋值静态门（产出前拦住崩容器的补丁），并把落地/回滚与「先编译后重启」铁律写进输出。 |
| `fixf2-hold/regr/regrF2.sh` | v2 回归脚本：**先**容器内 `bun build /app/bot.ts`（构建不过即整轮 FAIL），**再**跑 A/B/C 用例，另有不接触容器的 `--stub` 口径模式。 |
| `fixf2-hold/REPORT.md` | 本文件：v1 根因 → v2 五条修复映射 → 唯一一条预防规则 → 验证证据与操作员运行手册。 |
