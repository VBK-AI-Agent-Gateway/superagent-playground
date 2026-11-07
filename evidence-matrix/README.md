# 功能证据矩阵取证包（evidence-matrix）

本目录实现 issue #61 的**全功能逐项实测取证包**：把 G1 入口与多模态、G2 投递链与模型池、
G3 数字 AI 员工共 **29 个条目**拆成 5 个只读脚本，逐项产出「判定 + 证据原文摘录 +
采集时间(UTC)」，供操作员留痕与回贴。

## 0. 核心约束（先读这一节）

1. **全部只读**：脚本不修改被检系统的任何文件、配置或进程状态；不重启任何服务；
   特别地 **VM 侧禁止 `stop`/`start`/`restart` `dsh`**（05 脚本连这些写动词都不出现）。
2. **脚本由自动化代理产出、不代执行**：代理无生产凭据，**所有脚本必须由操作员审阅后自行执行**。
3. **幂等**：可反复执行，重复执行不改变系统状态；产物落在 `/tmp/evidence-matrix-<UTC时间戳>/`。
4. **每条出站命令都有时间上限**：`timeout` 包裹；模型调用单次 60s，探活 8s。
5. **输出已脱敏**：token/密钥/电话号码一律掩码（前 6 + 后 4），报告不含明文凭证。
6. **报告中文输出，双格式**：默认 markdown 判定表；加 `--json` 输出机器可读 JSON（无需 `jq`/`python`）。
7. **脚本不触碰**正在运行的工单工作树、绕过检查工具、引擎池进程或 wagate 挂载文件。

## 1. 交付物清单

| 文件 | 作用 | 覆盖条目 |
| --- | --- | --- |
| `_lib.sh` | 公共库：PASS/WARN/FAIL/需人工回归/INFO 判定、超时保护、脱敏、markdown + JSON 渲染、退出码约定 | — |
| `01-eu-entry.sh` | G1 入口与多模态逐项取证 | 1.1 – 1.7 |
| `02-eu-delivery.sh` | G2 投递链逐项取证 | 2.1 – 2.10 |
| `03-eu-models.sh` | 模型池逐项取证（**2.14 串行模型调用为主项**） | 2.14、2.11 – 2.13 |
| `04-eu-employee.sh` | G3 数字 AI 员工取证（EU 侧） | 3.1、3.4 – 3.6 |
| `05-vm-closeout.sh` | G3 收口取证（**VM 侧执行**） | 3.2 |
| `EVIDENCE.md` | 29 项证据矩阵回填模板（判定 / 证据摘录 / 时间戳） | 全部 29 项 |
| `README.md` | 本文件：执行顺序、耗时、回贴模板、人工回归清单 | — |

## 2. 执行顺序与预期耗时

| 顺序 | 脚本 | 执行机 | 预期耗时 | 说明 |
| --- | --- | --- | --- | --- |
| — | 审阅全部脚本 | — | 10–20 min | **必做**：代理不代执行，先人工审阅 |
| 01 | `01-eu-entry.sh` | EU（5.189.129.216） | 2–4 min | 含 2 次真实 DeepInfra 调用（STT/TTS），单次 ≤60s |
| 02 | `02-eu-delivery.sh` | EU | 2–3 min | 以本机日志/源码锚点为主，无重调用 |
| 03 | `03-eu-models.sh` | EU | 3–8 min | 6 次串行模型调用（5 模型 + 边界），每次 ≤60s |
| 04 | `04-eu-employee.sh` | EU | 1–2 min | 只读 GitHub API + 端口探活 + 审计日志 |
| 05 | `05-vm-closeout.sh` | **VM（192.168.58.133）** | 1–2 min | VM 侧只读；禁 stop/start/restart dsh |

整包（EU 侧，01–04）：

```bash
cd evidence-matrix && sudo bash 01-eu-entry.sh 2>&1 | tee /tmp/em-01.txt
sudo bash 02-eu-delivery.sh 2>&1 | tee /tmp/em-02.txt
sudo bash 03-eu-models.sh   2>&1 | tee /tmp/em-03.txt
sudo bash 04-eu-employee.sh 2>&1 | tee /tmp/em-04.txt
```

VM 侧（05）：

```bash
cd evidence-matrix && sudo bash 05-vm-closeout.sh 2>&1 | tee /tmp/em-05.txt
```

逐项复跑（示例，脚本末尾会打印各自适用的复跑命令）：

```bash
bash 01-eu-entry.sh 2>&1 | grep -A5 '1.3'
```

机器可读输出：

```bash
bash 01-eu-entry.sh --json 2>/dev/null | python3 -m json.tool   # python3 仅用于格式化，非运行依赖
```

### 退出码约定

| 退出码 | 含义 |
| --- | --- |
| 0 | 全部 PASS（无 WARN/FAIL/人工项） |
| 1 | 存在 FAIL 不通过 |
| 2 | 无 FAIL，但存在 WARN 警告 |
| 3 | 无 FAIL/WARN，但存在需人工回归项 |

> 注意：取证包内**绝大多数条目含"需人工回归"**，因此退出码 3 属常见且正常；请以判定表为准。

## 3. 已知口径与限制（诚实声明）

- **现场漂移**：脚本对 EU 现场的锚点检查（如 `telegram.ts` 的 video 分支、`bot.ts` 的
  `videos` 透传）以 `/srv/wagate/patches/*` 与容器内 `/app/*` 的**当前**文件为准；若与
  `eu-fix-img-voice/context/` 快照（md5 见其 `CONTEXT.md`）不一致，以现场为准并记录。
- **无凭据即降级**：缺少 `sqlite3`、`gh`、`docker`、token 文件时，相关条目降级为 WARN/INFO，
  不会伪造判定。
- **"送达"类条目不可单方证明**：2.1/2.3/2.4/2.5 等"用户真的收到"的条目，脚本只给发送链路
  与日志证据，**最终判定必须由人工实测截图确认**（见第 5 节）。
- **3.5 端口探测**仅为只读握手（不携带凭证、不做利用性操作），记录"是否可达/是否 TLS"。
- **不做修复**：脚本只取证。发现的缺陷（例如 `model_configs` 缺 `m3` 定价行、视频入口缺口、
  poll 挂载丢失）由对应补丁工单处理，本包不修改任何配置。

## 4. 回贴模板（每条目一份，必须含判定 + 证据摘录 + 时间戳）

```
【条目】2.14 串行模型调用
【判定】PASS 通过
【证据摘录】
  m3 → HTTP 200, 耗时 812ms, 响应: {"id":"...","choices":[{"message":{"content":"pong"...
  zai-org/GLM-5.3-Flash → HTTP 200, 耗时 640ms
  边界（无效 token）→ HTTP 401
【采集时间】2026-11-07T03:25:02Z
【执行机】EU 5.189.129.216 / 脚本 03-eu-models.sh / commit <sha>
【备注】本次未复跑 5 个模型全绿；gemma4:12b 首次冷启动 41s，第二次 900ms
```

判定取值只有五种：`PASS 通过` / `FAIL 不通过` / `WARN 警告` / `需人工回归` / `INFO 信息`。

## 5. 需人工回归的项目列表（机器不可替代）

| # | 人工回归项 | 对应条目 | 回贴内容 |
| --- | --- | --- | --- |
| 1 | 真实 TG 发**图片** → vision 识别 | 1.4、2.3 | 问题 + 模型回答 + 收到图片附件的截图 |
| 2 | 真实 TG 发**视频** → img-lab 处理 | 1.5、2.5 | 指令 + 产物 + 截图 |
| 3 | 真实 TG 发**语音** / 语音回复播放 | 1.2、1.3、2.4 | 语音气泡截图 + 时长 |
| 4 | 真实 TG 发**文件**（xlsx）| 1.6 | 挂起提示 + 补说明后开始处理的截图 |
| 5 | 连续两条**裸图/裸视频** | 1.7 | 两条都被处理的截图 |
| 6 | **长文**回复（>4096 字符）| 2.2 | 多条消息按序到达的截图 |
| 7 | 同会话**并发**两条指令 | 2.7 | 回复顺序与指令顺序一致的截图 |
| 8 | 长任务 **`/stop`** 真实中断 | 2.8 | bot 回复 + 任务确实停止的证据 |
| 9 | 长任务**进度回传**（>2 分钟）| 2.10 | 至少一次进度消息截图 |
| 10 | **VM 侧**数字员工端到端一次任务 | 3.2 | 指令 + 产出 + 时间戳 |

## 6. 自检（代理本机已执行，操作员可复核）

```bash
cd evidence-matrix
for f in _lib.sh 0*.sh; do bash -n "$f" || echo "FAIL $f"; done      # 语法
for f in 0*.sh; do bash "$f" --help >/dev/null 2>&1 || echo "HELP FAIL $f"; done
bash 01-eu-entry.sh --json 2>/dev/null | python3 -m json.tool >/dev/null && echo "JSON OK"
```

> 说明：本包为**纯 shell 脚本 + Markdown** 交付物，**无 `index.html`、无浏览器页面**，
> 因此仓库的 `scripts/smoke.sh`（语法门 + 无头浏览器加载）对纯脚本包**不适用**；
> 等效门禁为上文 `bash -n` 全量语法检查与 `--json` 结构校验。
