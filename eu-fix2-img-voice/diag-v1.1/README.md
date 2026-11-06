# eu-diag-voice-img — EU 沙箱只读诊断脚本包

针对 EU 服务器 `5.189.129.216` 上 ClawSandbox 栈（`wagate` 容器）的能力链只读体检：

- `01-diag-voice.sh` — 语音链：STT（`aa-voice.ts`：TG 语音 → base64 → 托管 Whisper 端点）+ TTS（`aa-tts.ts`：`[VOICE:文本]` → 托管 TTS 端点 → sendVoice）
- `02-diag-imgvideo.sh` — 图片/视频插件：`img-ops.ts`（`img_ops(info|resize|rotate|crop|grayscale|invert)`）+ `img-lab.ts`（`img_lab(info|trim|scale|frame|mute|rotate)`），两者都是纯 ffmpeg CLI
- `_lib.sh` — 两个脚本共用的检查/脱敏/汇总函数（被 source，不是独立脚本）

**本包只诊断，不修复。** 输出用于定位问题，任何修复动作都不在范围内。

## 安全性（铁律对齐）

- **纯只读**：不修改 EU 上任何文件/服务/DB/容器状态，不重启容器，不读写 `/srv/tenants`（脚本内不出现该路径），不发送任何 Telegram 消息。
- **写入白名单**：仅容器内 `/tmp/diag-test.png`，由同一条 `docker exec` 命令末尾 `rm -f` 删除；不落任何其他文件。
- **外部调用白名单**：至多 2 次，各一次，均为 `01-diag-voice.sh` 的显式检查项：
  1. `stt-live` — 1 次 POST 到 aa-voice.ts 里的 STT endpoint（合成 1 秒 440Hz WAV）
  2. `tts-live` — 1 次 POST 到 aa-tts.ts 里的 TTS endpoint（短文本「可用性检测」）
  外加 `tg-bot` 的 `getMe`：只读自身身份，**不向任何会话发消息**。
  响应体只在检查项内读取，不落盘（TTS 音频响应用完即删）。
- **密钥脱敏**：任何情况下只打印前 4 字符 + `…` + 长度，完整 key 不写进脚本、不进日志。
- **无硬编码 endpoint/模型**：全部在运行时从插件源文件 grep 提取；提取失败会 `[FAIL]` 并原样打印所用 grep 命令与输出。脚本内不保留任何厂商/模型名兜底值，因此提取不到就直接报错，不会静默用默认值探测。
- **无需回滚**：没有可回滚的持久化改动。
- 用 `--off` 可完全跳过外部 API 实测项（纯本地检查，零外呼）。

## 用法

```bash
scp -r eu-diag-voice-img root@5.189.129.216:/tmp/
bash /tmp/eu-diag-voice-img/01-diag-voice.sh          # 全量（含 2 次 live 探测）
bash /tmp/eu-diag-voice-img/02-diag-imgvideo.sh
```

纯本地模式（不外呼，可反复重跑）：

```bash
bash /tmp/eu-diag-voice-img/01-diag-voice.sh --off
```

以 root 执行（Ubuntu 22.04），依赖宿主机 `curl`、`python3`（仅 `stt-live` 合成 WAV 用）、`docker`，以及容器内 `bun`/`ffmpeg`（缺失会被显式判定并降级）。脚本幂等，可重复执行。

路径如与现场不同，可用环境变量覆盖，无需改脚本：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PATCH_DIR` | `/srv/wagate/patches` | 宿主侧插件源文件目录（`aa-voice.ts`/`aa-tts.ts`/`bot.ts`/`img-*.ts`） |
| `PLUGIN_DIR` | `/app/extensions/plugins` | 容器内插件目录 |
| `CONTAINER` | `wagate` | 容器名 |
| `DOCKER` | `docker` | docker 可执行文件 |
| `WAGATE_ENV_FILE` | `/etc/wagate.env` | 存放 `TELEGRAM_BOT_TOKEN` 的文件 |
| `STT_KEY_FILE` | `/srv/secrets/_shared/deepinfra_stt` | DeepInfra key 文件（STT/TTS 共用） |
| `DIAG_EXPECTED_VERSION` | 未设置 | 设置后会与实际脚本版本比对，不符输出 `[WARN]` |

## 检查项

`01-diag-voice.sh`

| 项 | 检查内容 | FAIL 触发条件 |
| --- | --- | --- |
| `mount-md5` | 宿主 patch 与容器内同名插件 md5 比对 | 文件缺失或 md5 不一致（加载的不是宿主 patch） |
| `stt-key` | key 文件存在且非空 | 缺失或空 |
| `stt-endpoint` | 从 `aa-voice.ts` grep endpoint/模型 | grep 零匹配 |
| `stt-live` | 合成 1s 440Hz WAV → base64 JSON POST，期望 200 + 转写文本（只打印前 50 字符） | 非 200 / 无响应 / 未提取到模型；`--off` 时降级为 WARN |
| `tts-endpoint` | 从 `aa-tts.ts` grep endpoint/模型 | grep 零匹配 |
| `tts-live` | 短中文文本 POST，期望 200 + 前 4 字节 `4f 67 67 53`(OggS) + >1KB | 非 200 / 魔数不符 / 体积过小 / 未提取到模型；`--off` 时降级为 WARN |
| `tg-bot` | `getMe` 期望 `"ok":true` | token 缺失、空、或接口失败 |
| `smoke` | 容器内 bun 分别 import 两个插件 | 文件缺失；bun 存在但 import 失败为 WARN（供定位），bun 缺失降级为文件存在检查 + WARN |

`02-diag-imgvideo.sh`

| 项 | 检查内容 | FAIL 触发条件 |
| --- | --- | --- |
| `ffmpeg-bin` | 容器内 `ffmpeg`/`ffprobe` 及版本 | 任一缺失（全链依赖） |
| `files` | `wc -l` 行数（约 242/302）+ 宿主 patch 是否存在 | 不 FAIL：读取失败为 FAIL，行数不符/未挂载为 WARN |
| `ffmpeg-microtest` | 容器 `/tmp` 生成 PNG 校验魔数后删除 | 无 `89 50 4e 47` |
| `tg-source-entry` | `bot.ts` 中 TG 图片/视频入口 grep | 零匹配 |
| `smoke` | 同 01 的 bun 双插件 import | 同 01 |

## 1.1.0 修复（相对 1.0.0）

1. **`stt-live` 端点占位符**：插件源里的端点可能是模板（如 `.../v1/${MODEL}/audio/transcriptions`）。
   现在先用提取到的模型字面量替换 `${MODEL}` / `${model}` / `${MODEL_ID}` / `${modelId}`；
   若替换后仍残留 `${…}`，该项直接 FAIL 并打印原始端点与提取到的模型，而不是向字面 `${MODEL}` 路径发请求。
2. **`tts-live` 的 `response_format`**：从 `aa-tts.ts` grep 字面 `response_format` 并带入请求体；
   源里没有则不发送（保持默认）。响应为 RIFF/wav 且源未固定 ogg 时评为 **WARN**（源本身就没要求 ogg），
   只有源明确要求非 wav 容器而返回不匹配时才 FAIL。
3. **`smoke` 标签泄漏**：`smoke_or_fallback` 的第一个参数是标签，之前被原样透传给
   `smoke_summary`/`plugin_import_bundle`，导致 bun 去 `import('voice')` / `import('imgvideo')`
   而必然失败、把整项误报为 import 失败。现在标签在入口处 shift 掉，只把真实插件路径传给 bun。
4. **`stt_live` 死代码**：`[ -z "$body" ]` 判断的是 mktemp 的**文件名**，恒为非空，
   永远不触发；改为 `[ ! -s "$body" ]` 判断文件是否真有内容。

## 期望输出

```
=== 01-diag-voice.sh — EU voice chain (STT + TTS) read-only diagnostics ===
eu-diag-voice-img 1.1.0
mode: full (live API probes enabled) | patches: /srv/wagate/patches | container: wagate:/app/extensions/plugins

--- 1. mount-md5 ---
[PASS] mount-md5 — aa-voice.ts host=container (7d1f…)
[PASS] mount-md5 — aa-tts.ts host=container (b30c…)
...
--- 4. stt-live ---
[PASS] stt-live — HTTP 200; transcript head: …
--- 6. tts-live ---
[PASS] tts-live — HTTP 200, 4f 67 67 53 OggS magic, 20480 bytes (body discarded, never written to disk)

SUMMARY: 9 PASS / 0 FAIL / 1 WARN
```

（PASS/FAIL/WARN 数量取决于现场：`DIAG_EXPECTED_VERSION` 未设置会多一条 WARN，
宿主未挂载的插件会多一条 `files` WARN。）

每项统一前缀：`[PASS]` / `[FAIL]` / `[WARN]`，格式为 `<状态> <项目名> — <细节>`；末尾 `SUMMARY: <n> PASS / <n> FAIL / <n> WARN`。

## exit code 与 FAIL 解读

- `0` — 无 FAIL（允许存在 WARN，WARN 表示不确定或降级检查）
- `1` — 至少一个 FAIL
- `2` — 参数错误或无法 source `_lib.sh`

FAIL 一句话解读（本包只诊断不修复）：

- `mount-md5` FAIL → 容器加载的插件不是宿主 patch，宿主改动没生效（挂载/镜像版本问题）。
- `stt-key` FAIL → DeepInfra key 文件缺失或为空，STT/TTS 都会 401/无 key 可用。
- `stt-endpoint` / `tts-endpoint` FAIL → 插件源码里 grep 不到 endpoint/模型，插件被改过或文件不对；请把打印的 grep 命令与输出一并回传。
- `stt-live` FAIL → endpoint/key/模型提取/插件调用形参不匹配，语音输入链断。
- `tts-live` FAIL → 语音输出链断（非 200、返回不是 OggS、或音频异常小）。
- `tg-bot` FAIL → bot token 失效，整条 TG 链路都不可用。
- `ffmpeg-bin` / `ffmpeg-microtest` FAIL → 容器内 ffmpeg 缺失或不可用，img-ops/img-lab 全部工具会失败。
- `tg-source-entry` FAIL → bot.ts 不再把 TG 图片/视频下载进事件，插件拿不到 base64 输入。
- `smoke` FAIL（仅文件缺失）→ 插件文件不在预期路径；若只见 WARN，说明 bun import 有问题但需人工确认。

回传时请附完整输出（脚本本身即脱敏），以及执行的两条命令与实际版本号。
