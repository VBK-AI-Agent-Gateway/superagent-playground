# fix-imgdoc-bridge —— 文件（文档）通道发图后 `img_ops` 报「源图片不存在」的修复

> 关联 issue #67（缺陷 B：图片通道指引与真实代码不一致 + 幽灵工具名）。
> **本目录只产出补丁与校验脚本，不执行任何生产操作**：无凭据、不重启服务、不写生产文件。
> 所有落地动作由操作员在审阅后于宿主/容器上手工执行。

---

## 1. 缺陷是什么（一句话）

用户在**文件/文档通道**发一张图，`upload-ops.ts` 会把它存到
`/srv/tenants/<sid>/workspace/uploads/<原名>`；而 `img-ops.ts` 只从**源约定路径**
`/srv/tenants/<sid>/workspace/source-latest.png`（或 `.jpg`）读图。
两者没有对接 → `img_ops` 报 `execute FAIL: 源图片不存在`，图片处理链路在文件通道整体失效。

同时该文件里两处文本是错的：
- 图片分支指引写着「用 img-ops 视觉技能 `(ev.images)` 分析」——文件通道的 `ev.images` 恒为空，照着做必然找不到图；
- 残留一处幽灵引用 `file_handler`（该工具根本不存在）。

## 2. 修复内容（唯一改动文件：`/srv/wagate/patches/upload-ops.ts`）

| # | 改动 | 说明 |
|---|------|------|
| 1 | **桥接**：保存点之后插入一小段代码，把刚落盘的 `.jpg/.jpeg/.png` 复制到 `workspace/source-latest.jpg`（`.jpeg` 归一到 `.jpg`）/ `source-latest.png` | 与 `img_ops` 的源约定对齐；`gif/webp` 有意不桥接（`img_ops` 只认 png/jpg） |
| 2 | **指引纠偏**：把 `(ev.images)` 的误导文本换成 `[imgdoc-bridge]` 新指引 | 明确「图片一律调用 `img_ops(op: info\|resize\|rotate\|crop\|grayscale\|invert)`」 |
| 3 | **清幽灵**：移除 `file_handler` 引用 | 换成指向真实桥接 + PIL 路径的描述 |

桥接段带逃生阀：环境变量 `WAGATE_IMG_BRIDGE_OFF=1` 时不桥接（等价回退到旧行为，用于排障）。

## 3. 操作员执行步骤

```bash
cd <本目录>

# ① 只读预检（不改任何文件）：锚点唯一性 + 现场形态 + 可用备份
TARGET=/srv/wagate/patches/upload-ops.ts bash fixes/fix-imgdoc-bridge.sh --dry-run

# ② 落地（自动备份 .bak.imgbridge.<UTC时间戳>，原地写入并保留 inode）
TARGET=/srv/wagate/patches/upload-ops.ts bash fixes/fix-imgdoc-bridge.sh --apply

# ③ 容器内语法编译检查（只读；exit 0 才继续）
docker exec wagate bun build --no-bundle /app/extensions/plugins/upload-ops.ts

# ④ 宿主 / 容器双端 md5 必须一致（确认挂载生效）
md5sum /srv/wagate/patches/upload-ops.ts
docker exec wagate md5sum /app/extensions/plugins/upload-ops.ts

# ⑤ 冒烟加载（只读）
docker exec wagate bun -e 'await import("/app/extensions/plugins/upload-ops.ts");console.log("SMOKE_OK")'

# ⑥ 选空闲窗口重启（跑前先确认没有并行部署）
systemctl restart wagate.service
```

⑦ 重启后三项确认：服务 `active`；启动日志无插件加载报错；下一张图片能走通 E2E。

## 4. 端到端验收

用户在 Telegram 里**以文件形式**发一张图 + 「把图片转成黑白」，然后看日志链：

```
[upload-ops] uploaded file saved .../uploads/<原名> bytes=... mime=image/jpeg
[upload-ops] img bridge: .../workspace/source-latest.jpg synced from <原名>   ← 本补丁新增
[img-ops] execute params={"op":"grayscale",...}
（随后 sendPhoto 直接把处理结果发回）
```

三项齐全即修复成立。若只出现第 1 条、没有 `img bridge`，说明补丁未生效或服务未重启。

## 5. 回退

```bash
# 方式一：按备份时间戳一键还原（写前会校验备份存在）
TARGET=/srv/wagate/patches/upload-ops.ts bash fixes/fix-imgdoc-bridge.sh --revert <时间戳>
systemctl restart wagate.service

# 方式二：手工还原
cp -a /srv/wagate/patches/upload-ops.ts.bak.imgbridge.<时间戳> /srv/wagate/patches/upload-ops.ts
systemctl restart wagate.service
```

`--list-backups` 可列出当前全部可用备份。

## 6. 安全性质（脚本自带的机械保证）

- **默认 dry-run**：不加 `--apply` 绝不写入。
- **整批中止**：任一锚点计数 ≠ 1 或形态不符 → 直接退出 1，**不做部分落地**，不产生备份文件。
- **写前必先备份**：`.bak.imgbridge.<ts>`；备份失败则不写。
- **inode 保留**：一律用 python3 截断写入，**绝不用 `sed -i`**（换 inode 会让 bind 挂载失联，坑 #36）。
- **幂等**：文件头 `// fix-imgdoc-bridge seq:N` 标记 + 三特征串一致判据；重复 `--apply` 是干净的空操作（exit 0）。
- **写后形态门**：标记注释恰好 1 处、逃生阀代码恰好 1 处、新指引 1 处、幽灵引用 0 处、桥接块位于保存点**之后** —— 任一 FAIL 自动回滚到备份。
- 退出码：`0` 成功、`1` 门禁失败/备份缺失、`2` 用法错误。

## 7. 自检（本机，不接触生产）

```bash
bash -n fixes/fix-imgdoc-bridge.sh      # 语法门
bash regr/regr-imgdoc.sh                # 合成夹具回归：15 PASS / 0 FAIL / 2 WARN
```

`regr-imgdoc.sh` 用**合成夹具**验证桥接语义（`.jpg → source-latest.jpg`、
`.png → source-latest.png`、`.jpeg → source-latest.jpg` 且不产生 `source-latest.jpeg`）、
逃生阀关闭时的空操作，以及新指引不再出现 `ev.images`、不再出现幽灵工具名。
WARN 属预期：本机非生产机，读不到 `/srv/wagate/patches` 现场树。

## 8. 防复发清单

1. **机械门禁**：指引里出现的工具名必须在代码里真实注册 —— 「指南列出的工具必须存在」。
2. **通道桥接一致性**：任何写入 `uploads/` 的通道，都要同时满足下游读取的源约定。
3. **文档同步**：见 [`docs/CHANNELS.md`](docs/CHANNELS.md)，两条图片通道各自的入口与约定都记录在案。
