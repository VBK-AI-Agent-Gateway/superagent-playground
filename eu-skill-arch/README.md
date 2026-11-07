# eu-skill-arch —— 技能包落位决策与数字AI员工架构（第一阶段：只读诊断脚本包）

本目录是 issue #34 第一阶段交付物：**只读诊断脚本包 + 架构分析报告（第一阶段稿）**。

- **问题 Q1**：新增技能包（岗位技能 / 流程知识包 / 开发 playbook）应该装到 PI（EU wagate 容器内的 pi 智能体）还是 VM（superagent worker）？要给出可直接执行的决策规则。
- **问题 Q2**：面向「数字AI员工」场景，架构该如何设计（身份与边界 / 上岗方式 / 技能生命周期 / 调度 / 质量门 / 监督 / 成本 / 演进路径）。

结论正文见 [ARCHITECTURE-REPORT.md](./ARCHITECTURE-REPORT.md)。本 README 只讲**怎么跑脚本、在哪跑、产出怎么回传**。

---

## 1. 交付物清单

| 文件 | 执行位置 | 参数 | 预期时长 | 说明 |
|------|----------|------|----------|------|
| `01-eu-skill-inventory.sh` | **EU 5.189.129.216**（操作员） | 无 | < 60s | PI 技能机制取证：技能目录、容器对应物、patches 与容器内 md5 对比、skillGuide / settle 豁免、近 7 天技能调用统计 |
| `02-eu-model-gateway.sh` | **EU 5.189.129.216**（操作员） | `$1` = 网关 token | < 90s | 模型网关与服务面取证：`/v1/models`、白名单模型 5 探针、inngest、claw-engine、资源水位、交付四开关 |
| `03-vm-inventory.sh` | **VM 192.168.58.133**（worker，已实测） | 无 | < 30s | superagent 侧取证：主机规模、运行时版本、工单与 worktree、prompts 清单、WORK_TOOLS、交付链三件套、仓库结构 |
| `ARCHITECTURE-REPORT.md` | — | — | — | 中文架构报告：Q1 决策框架 + Q2 架构设计 + 03 实测发现 + 数据缺口清单 |

三个脚本**全部通过 `bash -n` 语法自检**，且**全部只读**（见第 4 节）。

---

## 2. 执行方式

### 2.1 EU 侧（01 / 02）—— 操作员在 EU 服务器上跑

worker 没有任何 EU 凭据（故意设计），EU 侧事实**全部**来自这两个脚本的输出。操作员 SSH 到 EU 后：

```bash
mkdir -p /tmp/eu-skill-arch-out

# 01（无参数）
bash 01-eu-skill-inventory.sh | tee /tmp/eu-skill-arch-out/01.txt

# 02（token 作为第 1 个参数；从环境导入，切勿写进命令历史之外的任何文件）
read -rs WAGATE_TOKEN           # 交互式输入，不回显
bash 02-eu-model-gateway.sh "$WAGATE_TOKEN" | tee /tmp/eu-skill-arch-out/02.txt
unset WAGATE_TOKEN
```

### 2.2 VM 侧（03）—— worker 自己跑

```bash
bash 03-vm-inventory.sh | tee /tmp/eu-skill-arch-out/03.txt
```

可用 `DSH_SA_SRC=/path/to/dsh-sa-git` 覆盖运行时源码路径（默认 `/home/qt/src/dsh-sa-git`）。

---

## 3. 输出收集与第二阶段回传

1. 三个脚本都把结果打到 stdout，**统一 tee 到 `/tmp/eu-skill-arch-out/0X.txt`**。脚本自身只在 `/tmp/eu-skill-arch-out/` 建目录，不写别处。
2. 操作员跑完 01 / 02 后，把 `01.txt` 与 `02.txt` 在 **新 issue** 中回传（正文或附件均可）。
   - **为什么必须新 issue**：按当前系统规则，同一 thread 上的重复评论只算「附加输入」，**不会重启已结束的工单**；要让第二阶段工单真正被创建，必须开新 issue 并在其中 `@` 触发账号。
   - 新 issue 里请附上 `01.txt` / `02.txt` 全文，并注明采集时间（脚本头部已带 UTC 时间戳）。
3. 第二阶段工单将据此补证据、覆核本报告中的所有「待补证」条目并定稿 Q1 / Q2 结论。

---

## 4. 只读声明（可核查）

三个脚本内**不含**以下任何写操作：

- 无 `rm` / `mv` / `chmod` / `chown` / `truncate` / `dd`
- 无 `systemctl start|stop|restart|enable|disable`（只用 `systemctl is-active` / `is-enabled` 查询态）
- 无 `docker restart|stop|start|rm`（只用 `docker exec` 跑只读命令，以及 `docker stats --no-stream`）
- 不改任何配置文件；不写除 `/tmp/eu-skill-arch-out/` 以外的路径
- 不读取 secret 文件内容：`02` 的 token 只经 `$1` 传入、只用于 `Authorization` 头、输出统一 `sed` 脱敏，脚本内不含任何 token 字面量

防御式写法（issue #34 第 3 节要求）：

- `grep` 无匹配时不因非零退出码中断脚本（所有检索都带 `|| echo "[warn] 无匹配"` 兜底）
- `du` / `journalctl` / `docker stats` 一律带 `timeout`（30s / 20s），超时只打印警告
- `mkdir -p` 与 `tee` 失败不影响取证主体
- 循环探测逐个模型执行，单个失败不中断其余探针

自查命令（操作员可复核）：

```bash
bash -n 01-eu-skill-inventory.sh && bash -n 02-eu-model-gateway.sh && bash -n 03-vm-inventory.sh
grep -nE '\b(rm|mv|chmod|chown|truncate)\b|systemctl +(start|stop|restart|enable|disable)|docker +(restart|stop|start|rm)' 0*.sh   # 应无输出
```

---

## 5. 红线（本目录所有产出共同遵守）

- **EU 只读**：不对 EU 做任何写操作；发现的问题只记录进报告，不修
- **无凭据**：worker 不持有 EU / 模型 / GitHub 之外的任何生产凭据
- **仓库与评论严禁出现 token / key / 私钥**
- **修复建议只写进报告**，不落到脚本行为里
- 本目录为**零构建交付物**：无 npm、无 `node_modules`、无构建步骤
