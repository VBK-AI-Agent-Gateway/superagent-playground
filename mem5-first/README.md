# mem5-first —— 五层记忆增强·第一批（v2）

**本目录只产出工件，不执行。** 无生产凭据，所有改动由操作员审阅后自行执行。

对应 issue #79 正文（授权与验收以正文为准）。新增注入总量 **< 1.5KB**，注入内容保持中文。

---

## 交付物一览

| 文件 | 作用 |
|---|---|
| `fixes/fix-mem5-first.sh` | 唯一补丁脚本：锚点唯一性校验 → 备份 → 写盘 → 可回滚（幂等） |
| `regr/regr-mem5.sh` | 合成回归：补丁自检 + 源码断言 + 桩 pi 行为级断言 |
| `README.md` | 本文档（操作员运行手册） |
| `mem5-context/*.ts` | 只读基线快照（**不修改**，仅供比对与锚点核对） |

四项交付物（按 issue #79 正文）：

1. **续作层** —— `workspace/continuation.md`，每轮注入 ≤600 字，`agent_end` 追加未完工作
2. **L5 画像写入修复** —— 输入改读 `globalThis.__lastUserText`，并加系统指令拒绝门
3. **租户技能账** —— `workspace/installed-skills.md`，挂在 personal-assistant 工具事件上
4. **交付索引** —— `workspace/deliveries-index.md` + `/srv/tenants/<sid>/last-delivery.json` 易失兜底

---

## 一、先看后做（务必先跑）

```sh
# 1) 锚点唯一性校验（只读，不写盘）
sh fixes/fix-mem5-first.sh --check-anchors --dir "$WAGATE_PLUGIN_DIR"

# 2) 干跑：打印将要写入的改动，不落盘（默认即 dry-run）
sh fixes/fix-mem5-first.sh --dir "$WAGATE_PLUGIN_DIR"

# 3) 回归（与生产无关，全部在临时目录里跑）
sh regr/regr-mem5.sh
```

`$WAGATE_PLUGIN_DIR` 未设置时默认 `/srv/wagate/extensions`。

**退出码**：`0` 正常 ｜ `1` 锚点损坏/命中数 ≠ 1 ｜ `10` 已打过补丁（幂等跳过）｜ `11` 半打补丁（需人工介入）

> 锚点命中数 ≠ 1 就**立即中止**，不会写入任何字节。这一点是硬保护，不要绕过。

---

## 二、应用

```sh
sh fixes/fix-mem5-first.sh --apply --dir "$WAGATE_PLUGIN_DIR"
```

脚本会：

1. 逐锚点校验（每个锚点必须**恰好命中 1 次**）
2. 备份为 `<文件>.bak.mem5.<YYYYmmdd-HHMMSS>`
3. 打补丁，并写入幂等标记 `MEM5_FIRST_V1`

**回滚**（把 `<ts>` 换成输出里提示的时间戳）：

```sh
sh fixes/fix-mem5-first.sh --revert <ts> --dir "$WAGATE_PLUGIN_DIR"
```

回滚用 Python `open("w")` 覆写，**不使用 `sed -i`** —— 避免 inode 更换导致绑定挂载里宿主侧看不到改动（陷阱 #36）。

---

## 三、构建与生效

```sh
# 在容器内构建（RC 协议：先取退出码，再看日志）
bun build ... >/tmp/b.log 2>&1; RC=$?
[ "$RC" -eq 0 ] || { echo "构建失败"; tail -40 /tmp/b.log; }
```

**校验产物一致性**（宿主与容器两侧 md5 必须相同）：

```sh
md5sum <宿主产物路径>
docker exec <容器> md5sum <容器产物路径>
```

随后**重启**（空闲门控，勿在有活跃会话时重启）：

```sh
# 确认无活跃会话后再重启
```

---

## 四、冒烟与端到端验收

```sh
# 冒烟：语法门禁 + 一次无头加载（仅失败时截图到 .smoke/smoke-fail.png）
sh scripts/smoke.sh mem5-first
```

端到端断言（在测试租户会话里）：

1. 用户发送「继续」→ 日志里应看到注入的 `【上次未完工作】` 段落
2. 模型据此接着做未完成的事
3. 检查 `/srv/tenants/<sid>/workspace/continuation.md` 已追加该轮原话
4. 让模型装/用一个技能 → `installed-skills.md` 出现对应行
5. 触发一次交付 → `deliveries-index.md` 追加一行，且 `/srv/tenants/<sid>/last-delivery.json` 被写入

**逃生阀**（一键关停本批全部增强，零注入零写入）：

```sh
WAGATE_MEM_ENHANCE_OFF=1
```

---

## 五、复现触发器自查清单

- [ ] **记忆写入的输入源**：确认 `globalThis.__lastUserText` 在真实链路里被赋值（本补丁已在读取点补写兜底）。若上游改名，L5 会静默写空。
- [ ] **陷阱 #36（inode）**：任何写入都用覆写而非 `sed -i`；校验宿主/容器两侧 md5 一致。
- [ ] **锚点唯一性**：`--check-anchors` 必须全部 `[OK ]` 且命中 1 次。命中 0 或 ≥2 都不要 `--apply`。
- [ ] **注入预算**：回归里实测三段合计 <1.5KB（当前 412B）。新增段落前先看预算。
- [ ] **幂等**：重复 `--apply` 应返回 `10` 且不重复插入。返回 `11` 说明半打补丁，回滚后重来。
- [ ] **`task.json` 单写者仲裁**：本批**不写** `task.json`，只用 `last-delivery.json` 做易失兜底。

---

## 六、边界

- 不改 `tenant-core.ts` / `telegram.ts` / `bot.ts` / `upload-ops.ts` / `route-guard.ts` / `img-ops.ts`
- 不改 `project-identity.ts` / `skill-install.ts`（只读镜像）
- 写入全部包在 `try/catch` 里，**故障开放**：记忆层坏掉不得拖垮对话
- 缺文件静默跳过（首次运行不会报错）
