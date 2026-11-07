# 图片通道对照表（issue #67）

同一句「处理这张图」，用户**以图片形式**发和**以文件形式**发，走的是两条不同的通道。
本文件把两条通道的入口、落盘位置与下游约定写清楚，避免再次出现「指引与代码不一致」。

---

## 一、两条通道对比

| | **内联图片通道**（照片） | **文件/文档通道**（文档） |
|---|---|---|
| 用户操作 | 直接作为**图片/照片**发送 | 以**文件/文档**附件发送（或发原图不清压） |
| 入口代码 | `telegram.ts` / `bot.ts` 的图片分支 | `upload-ops.ts` 插件 |
| `ev.images` | **有值**（框架注入内联图） | **恒为空**（文本通道没有内联图） |
| 图片落盘 | 框架侧处理 | `/srv/tenants/<sid>/workspace/uploads/<原名>` |
| `img_ops` 能否直接读 | 能（走内联图分支） | **不能** —— 见下方缺陷 |

## 二、缺陷 B 的成因

`img-ops.ts` 只从**源约定路径**取图：

```
/srv/tenants/<sid>/workspace/source-latest.png     ← 优先
/srv/tenants/<sid>/workspace/source-latest.jpg     ← 次选
```

两个都不存在时报错退出：

```
[img-ops] execute FAIL: 源图片不存在 (checked .../source-latest.png, .../source-latest.jpg)
```

而文件通道只把图存到 `workspace/uploads/<原名>`，**从来没有**生成过 `source-latest.*`。
于是文件通道发图 + 要求处理 → 必然失败。

> 注意：`img_ops` **自己**在处理时也会写 `source-latest.*`
> （日志 `[img-ops] image source written host-copy ...`），
> 但那发生在「已经拿到源图之后」，救不了「找不到源图」这一步。

## 三、修复后的桥接（本补丁）

`upload-ops.ts` 保存文件后，紧跟保存点插入桥接段：

| 用户发的扩展名 | 桥接目标 | 说明 |
|---|---|---|
| `.png` | `workspace/source-latest.png` | 与 `img_ops` 首选路径一致 |
| `.jpg` | `workspace/source-latest.jpg` | 与 `img_ops` 次选路径一致 |
| `.jpeg` | `workspace/source-latest.jpg` | **归一**到 `.jpg`；不产生 `source-latest.jpeg` |
| `.gif` / `.webp` / 其他 | 不桥接 | `img_ops` 只认 png/jpg，桥接无意义 |

桥接成功后日志：

```
[upload-ops] img bridge: /srv/tenants/<sid>/workspace/source-latest.jpg synced from <原名>
```

设计要点：

- **fail-open**：桥接失败只 `console.warn`，绝不影响上传本身与后续指引（`catch` 兜住）。
- **逃生阀**：`WAGATE_IMG_BRIDGE_OFF=1` 时整段跳过，等价回退旧行为，便于排障与灰度。
- **失败可见**：桥接异常日志 `[upload-ops] img bridge fail (fail-open): ...`。

## 四、排查速查

| 现象 | 判读 |
|---|---|
| 只有 `uploaded file saved`，没有 `img bridge` | 补丁未生效或服务未重启；检查 `seq:` 标记与容器内 md5 |
| `img bridge fail (fail-open)` | 桥接复制失败（权限/磁盘），图片处理会随即报「源图片不存在」 |
| `execute FAIL: 源图片不存在` | 检查 `source-latest.png/.jpg` 是否存在；确认该消息走的是哪条通道 |
| 处理结果没发回来 | 与通道无关，看 `sendPhoto` / 路由侧 `__progressRoute` |

## 五、给后续改动的约束

1. **不要**再在指引里让模型去 `ev.images` 上找文件通道的图 —— 那里恒为空。
2. 新增任何写 `uploads/` 的通道，都要同时满足 `source-latest.*` 源约定，否则重复缺陷 B。
3. 指引中提到的工具名必须在代码里真实注册（`file_handler` 幽灵引用的教训）；
   建议做一条机械门禁：**「指南列出的工具必须存在」**。
4. `img_ops` / `img_lab` 不应被加回 `BLOCK_TOOLS` —— 它们已在 `imgunlock.20261107-044229` 中放开，
   回退会让整条图片链路重新被拦截。
