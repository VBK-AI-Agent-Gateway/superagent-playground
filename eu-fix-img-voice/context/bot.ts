/**
 * WhatsApp ↔ pi(多租户) ↔ ClawSandbox 的接线层。
 *
 * 传输层直接复用 pi-gateway(MIT, vendor-pi-gateway-src) 的 WhatsAppAdapter，
 * 只做三件事：
 *   1. 把它的 PlatformMessage 映射到我们的租户核心
 *   2. fail-closed 白名单（它是 allowAll 默认值，我们不要）
 *   3. 修 WhatsApp 语法（它用 Discord 的 ** 加粗，在 WhatsApp 里显示成字面量）
 *
 * 多账号：WA_ACCOUNTS 是 JSON 数组，每元素 = 一个账号（独立登录态/独立 QR）。
 * 所有账号共用一个租户核心 —— sid 由身份哈希派生、与账号无关，同一个人从两个号
 * 发消息 = 同一个租户同一台沙箱（记忆不分裂）。回复按来信号路由（m.adapter）。
 *
 * QR 扫码入口两条：
 *   · 首个账号的 QR 进日志（docker logs 拉出来直接扫）
 *   · HTTP /qr（默认 :8081）：HTML 自刷新页，每个账号一张 PNG 二维码，手机浏览器开即扫
 *
 * 跑法：AGENT_ALLOW="<jid1>,<jid2>" WA_ACCOUNTS='[{"label":"a","session":"/srv/x"}]' bun bot.ts
 */
import { TelegramAdapter } from "./vendor-pi-gateway-src/adapters/telegram.ts";
import type { PlatformAdapter, PlatformMessage } from "./vendor-pi-gateway-src/adapters/base.ts";
import { WhatsAppAdapter } from "./vendor-pi-gateway-src/adapters/whatsapp.ts";
import { createTenantCore } from "./tenant-core.ts";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TENANT_ROOT } from "./sandbox.ts";
import { ensureGatewayModel, GATEWAY_PROVIDER_ID } from "./gateway-model.ts";
import { createServer } from "node:http";
import { readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import QRCode from "qrcode";
import { parseAccounts, normalizeAllow } from "./wa-accounts.ts";

const SESSION_BASE = process.env.WA_SESSION ?? "/srv/pi/wagate/wa-session";
const QR_PORT = Number(process.env.WA_QR_PORT ?? 8081);

const ACCTS = parseAccounts(process.env.WA_ACCOUNTS, SESSION_BASE);

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
const REG_FILE = process.env.REGISTERED_FILE ?? "/etc/wagate.registered";
const REG_CODE = (process.env.REGISTER_CODE ?? "").trim();
function readRegisteredFile(): string[] {
	try { return readFileSync(REG_FILE, "utf8").split(/[,\s]+/).filter(Boolean); } catch { return []; }
}
// 静态白名单 + 已自助注册的用户(持久文件,重启不丢)
const ALLOW = new Set(
	[
		...(process.env.AGENT_ALLOW ?? "").split(","),
		...readRegisteredFile(),
	]
		.map(normalizeAllow)
		.filter(Boolean),
);
const MAX_LEN = 4096;

if (ALLOW.size === 0) {
	console.error("refusing to start: AGENT_ALLOW is empty (fail-closed)");
	process.exit(1);
}

/** 解析一个真实 Model 对象（SDK 不接受字符串）。没配 AGENT_MODEL 就用第一个可用模型。 */
async function resolveModel() {
	// 配了网关就把网关写进 models.json（纯数据；不这么做就找不到 eugw 模型）
	if (process.env.AGENT_LLM_BASE) ensureGatewayModel(getAgentDir());
	const rt = await ModelRuntime.create();
	const spec =
		process.env.AGENT_MODEL ??
		// 没显式指定就用网关那个 —— 生产只走网关
		(process.env.AGENT_LLM_BASE ? `${GATEWAY_PROVIDER_ID}/${process.env.AGENT_LLM_MODEL ?? "grok-4.5"}` : "");
	if (spec) {
		const [provider, ...rest] = spec.split("/");
		const m = rt.getModel(provider, rest.join("/"));
		if (!m) throw new Error(`AGENT_MODEL not found: ${spec}`);
		return m;
	}
	const [first] = await rt.getAvailable();
	if (!first) throw new Error("no model with credentials; check agentDir/models.json + auth");
	console.log(`model: ${first.provider}/${first.id}`);
	return first;
}

/** pi-gateway 用 **粗体**（Discord 语法）；WhatsApp 只认单星号。 */
function formatForPlatform(text: string, platform: string): string {
	if (platform !== "whatsapp") {
		// 剥离 URL 紧邻的 markdown 加粗星号(模型输出 **https://...** -> 复制时带 ** 致 404)。
		// 只动 URL 边界的 **, 不碰正文其他 markdown; 安全保守。
		let r = text.replace(/\*\*(https?:\/\/\S+?)\*\*/g, "$1")
			.replace(/\*\*(https?:\/\/\S+)/g, "$1")
			.replace(/(https?:\/\/\S+)\*\*/g, "$1");
		// URL 粘连英文状态词截断: 模型输出 "交付链接：<url>Push 成功"(URL后无空格紧跟 Push)
		// -> 复制得 ...app-cucste/Push -> 404。URL 路径以 / 结尾后紧跟大写英文词(Push/Done/Success等)
		// 且后随空格或行尾 -> 丢弃该词, 保留到 / (GitHub Pages 路径段通常小写/数字, 保守)。
		r = r.replace(/(https?:\/\/[^\s]+?\/)([A-Z][a-z]{2,})(?=\s|$)/g, "$1");
		return r;
	}
	return toWhatsApp(text);
}
function toWhatsApp(text: string): string {
	return text.replace(/\*\*([^*\n]+)\*\*/g, "*$1*").replace(/__([^_\n]+)__/g, "*$1*");
}

function clip(text: string): string {
	if (text.length <= MAX_LEN) return text;
	// 可见截断：告诉用户后面还有，别让人去搜搜不到（pi-gateway 这里是静默 slice）
	return text.slice(0, MAX_LEN - 80) + `\n\n…[已截断 ${text.length - MAX_LEN + 80} 字，回 /full 取全文]`;
}

	// 进度文案: 不暴露内部工具名, 映射为项目阶段(用户要求"直接说项目步骤进度")
	const _toolStage: Record<string, string> = {
		select_project: "🧭 理解需求", sbx_write: "✍️ 开发功能", sbx_edit: "✍️ 开发功能",
		sbx_read: "🔍 分析规划", sbx_ls: "🔍 分析规划", sbx_grep: "🔍 分析规划", sbx_find: "🔍 分析规划",
		sbx_env: "⚙️ 准备环境", sbx_bash: "⚡ 执行中", deliver: "📦 校验交付",
		fast_path: "⚡ 快速生成", image_convert: "🖼️ 处理素材", write_image_to_sandbox: "🖼️ 处理素材",
		cache_image: "🖼️ 处理素材", merge_image_text: "🖼️ 处理素材", read_sandbox_image: "🖼️ 处理素材",
		img_lab: "🖼️ 处理素材", img_ops: "🖼️ 处理素材", doc_pack: "📄 生成文档",
		install_skill_pack: "🧩 准备环境", sandbox_write: "✍️ 开发功能",
	};
	// 用户看到的人话节点 + 阈值预警(250步max_iter): 工具名已内联图标, 直接用
	const _formatStage = (stage: string, steps: number): string => {
		let s = stage || "⏳ 处理中";
		if (steps >= 230 && steps < 250) s += ` · ⚠️ 步数接近上限，即将自动收尾交付`;
		return s;
	};
	const _stageOf = (tools: string): string => {
		const first = tools.split("/")[0] || "";
		return _toolStage[first] || "处理中";
	};
	// 进化系统[输入归一]: 中文输入法常打全角 ／ｓｔｏｐ, 严格 === 会漏 -> 归一化后比对
	const _normCmd = (t: string): string => t.replace(/[\u200b-\u200f\u2060\ufeff\u00ad]/g, "").replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\u3000/g, " ").trim().toLowerCase(); // 先去 LRM/ZWSP/BOM 等隐藏字符(WhatsApp 注入, 挡 startsWith)
	// A6 自然语言停止(防误触发): 仅句首命令词/整句/短句(≤12字)才认; 任务描述("做个停止按钮")句首是"做"或过长 -> 不触发
	const _isStopIntent = (t: string): boolean => {
		const n = _normCmd(t);
		if (n.startsWith("/stop")) return true; // /stop 及带参数
		if (n.length > 12) return false; // 长文本=任务描述, 非命令
		return /^(停止|停下|别做了|中止|住手|停|stop|halt)/i.test(n) || /^(停止|停下|中止|停|stop)$/.test(n);
	};
	const formatProgressLine = (line: string): string => {
		const m = /^(\u23f3\s*\d+s\s*·\s*)(.+)$/.exec(line);
		if (!m) {
			// 占位文案(仍在开发中/任务较重/继续推进)无骨架 -> 统一包成 ⏳·文案, 与人话节点风格一致
			if (/^[\u23f3\u1f504]/.test(line) || /开发中|任务较重|继续推进/.test(line)) return `⏳ · ${line.replace(/^[\u23f3\u1f504]\s*/, "")}`;
			return line;
		}
		const head = m[1];
		const rest = m[2];
		const ms = /^(\d+\s*步\s*·\s*)([^·]+)([·\s].*)?$/.exec(rest);
		if (ms) {
			const segs = rest.split(/\s*\u00b7\s*/); // [0]=N步 [1]=tools [2]=fbLine [3+]=said
			const steps = (segs[0] || "").trim();
			const tools = (segs[1] || "").trim();
			const fbLine = (segs[2] || "").trim().replace(/\s*\|\s*/g, " · ").replace(/[·\s]+$/, ""); // fbAll 内 | 分隔防·split, 显示转回 ·, 清尾部悬空 // ✅交付/🚧阻塞/🔍验证 (优先3类)
			const stepNum = parseInt(steps, 10) || 0;
			const stage = _stageOf(tools);
			const iconStage = _stageOf ? _formatStage(stage, stepNum) : stage;
			// _realProgress: 保留模型真实自述首句(去重/限长), 让进度反映实际任务状态非固定模板
			let _real = "";
			for (let i = 3; i < segs.length; i++) {
				const _s = (segs[i] || "").trim().replace(/^[·\s]+/, "");
				if (_s && _s.length > 4) { _real = _s.slice(0, 48); break; }
			}
			return head + steps + " · " + iconStage + (fbLine ? " · " + fbLine : "") + (_real ? " · " + _real : "");
		}
		const me = /^(执行\s*)([^\s·]+)(.*)$/.exec(rest);
		if (me) return head + me[1] + _stageOf(me[2]) + me[3];
		return line;
	};
const core = createTenantCore({
	allow: ALLOW,
	registerCode: REG_CODE,
	registeredFile: REG_FILE,
	model: await resolveModel(),
	// 工作区持久化：空闲回收前 tar 快照，下次建沙箱后灌回
	// （代码 + node_modules 能回来；/usr 里的全局安装回不来）
	persistFs: {
		engineWsRoot: process.env.CLAW_WS_ROOT ?? "/claw-ws", // 挂 /home/qt/claw-exp/ws
		persistRoot: process.env.TENANT_PERSIST ?? TENANT_ROOT,
	},
	onProgress: (sid, line, chatKey) => {
		const r = chatKey ? progressRoute.get(chatKey) : undefined;
		console.log(`[progress-raw] sid=${sid} raw=${JSON.stringify(line)} -> shown=${JSON.stringify(formatProgressLine(line))}`);
		const shown = formatProgressLine(line);
		if (r) r.adapter.sendMessage(r.channelId, shown).catch(() => {});
				try { const _g = (globalThis as Record<string, unknown>); if (!_g.__sidChat) _g.__sidChat = new Map<string, string>(); if (sid && chatKey) (_g.__sidChat as Map<string, string>).set(sid, chatKey); } catch { /* fail-open */ }
		console.log(`[progress] sid=${sid} chatKey=${chatKey ?? "-"} line=${shown}`);
	},
});

// 测试注入接口：监听文件信号，在主进程内触发 core.handle()
// evolve-inject.sh 通过写入信号文件触发，扩展钩子共享主进程状态
const INJECT_SIGNAL = "/tmp/wagate-inject-signal.json";
setInterval(async () => {
	try {
		if (!existsSync(INJECT_SIGNAL)) return;
		const raw = await readFile(INJECT_SIGNAL, "utf8");
		let parsed: { channelId?: string; userId?: string; text?: string; media?: unknown; mediaType?: string; platform?: string } | null = null;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// 信号文件非原子写入竞态: 读到半截 JSON -> 本轮静默跳过(不消费文件),
			// 下轮 500ms 重读, 待写入方完成后拿到完整 JSON。避免 SyntaxError 噪声。
			return;
		}
		if (!parsed) return;
		const { channelId, userId, text, media, mediaType, platform, file } = parsed as { channelId?: string; userId?: string; text?: string; media?: unknown; mediaType?: string; platform?: string; file?: { data: string; fileName: string; mimeType: string } };
		await rm(INJECT_SIGNAL, { force: true }); // 消费信号

		console.log(`[inject] 主进程接收注入: channelId=${channelId} text=${text?.slice(0, 50)}`);
		// 方案1(进化系统#5反思): /stop 立即中断进行中 run —— 绕过 core.handle 消息队列,
		// 直接调 __abortActive abort 当前 session, 不排在 deliver/tool 超时循环后面。
		if (_isStopIntent(text)) {
			const _ab = (globalThis as Record<string, unknown>).__abortActive as ((sid?: string) => { stopped: boolean; text: string }) | undefined;
			const res = _ab ? _ab() : { stopped: false, text: "无 abort 钩子" };
			console.log(`[inject] /stop 立即中断 -> ${JSON.stringify(res)}`);
			await writeFile("/tmp/wagate-inject-result.json", JSON.stringify([{ kind: "result", text: res.text }], null, 2));
			return;
		}
		if (file) {
			(globalThis as Record<string, unknown>).__excelPendingFile = file;
			console.log(`[inject] file attachment name=${file.fileName} bytes=${file.data.length} mime=${file.mimeType}`);
		}
		const msg = { platform: platform ?? "telegram", channelId, userId, text, media, mediaType, isGroup: false };
		const result = await core.handle(msg);
		console.log(`[inject] 结果: ${JSON.stringify(result)}`);

		// 将结果写回文件供 docker exec 读取
		const RESULT_FILE = "/tmp/wagate-inject-result.json";
		await writeFile(RESULT_FILE, JSON.stringify(result, null, 2));
	} catch (e) {
		console.error(`[inject] 处理失败: ${e}`);
	}
}, 500);

const fullDump = new Map<string, string>();
// chatKey(platform:channelId) -> {adapter, channelId}：供 onProgress 主动推送开发进度
const progressRoute = new Map<string, { adapter: PlatformAdapter; channelId: string }>();
// 入站去重：channelId+text -> 首次投递时间戳。窗口 2500ms，防平台重复投递导致重复回复。
const dedupMap = new Map<string, number>();
const DEDUP_WINDOW_MS = 2500;
setInterval(() => {
	const now = Date.now();
	for (const [k, ts] of dedupMap) {
		if (now - ts > 30000) dedupMap.delete(k);
	}
}, 30000);
(globalThis as any).__progressRoute = progressRoute;
// label → adapter（回消息时路由回来源账号）；label → 最新 QR（/qr 端点轮询取）
const adapters = new Map<string, PlatformAdapter>();
const qrByLabel = new Map<string, string | null>();
const pairCodeByLabel = new Map<string, string>();

// 统一消息模型
interface UnifiedMessage {
  type: 'text' | 'image' | 'image_text';
  text: string;
  image?: { data: string; mimeType: string };
}

const onMessage = async (m: any, adapter: PlatformAdapter) => {
	const rawText = String(m.content ?? "");
	const text = rawText.trim();
	// 入站去重：同一 channelId+text 在 2500ms 内只处理一次（平台重复投递防护）
	{
		const dedupKey = `${m.channelId}\u0000${text}`;
		const now = Date.now();
		const last = dedupMap.get(dedupKey);
		if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
			console.log(`[bot] dedup drop channelId=${m.channelId} textLen=${text.length}`);
			return;
		}
		dedupMap.set(dedupKey, now);
	}
	const image = m.image as { data: string; mimeType: string } | undefined; // 多模态: 图片附件
	const file = m.file as { data: string; fileName: string; mimeType: string } | undefined; // 多模态: 文档附件 (Excel/CSV)
	if (!text && !image && !file) return; // 纯图片/纯文档(无文字)也放行
	if (file) {
		// 文档落盘交给 upload-ops 通用插件 (before_agent_start 读 G.__excelPendingFile 落盘 workspace/uploads, 任意扩展)
		(globalThis as Record<string, unknown>).__excelPendingFile = file;
		console.log(`[bot] file attachment name=${file.fileName} bytes=${file.data.length} mime=${file.mimeType}`);
	}
	
	// 统一消息模型：明确消息类型
	let unifiedMsg: UnifiedMessage;
	if (image && text) {
		unifiedMsg = { type: 'image_text', text, image };
	} else if (image) {
		unifiedMsg = { type: 'image', text: '', image };
	} else {
		unifiedMsg = { type: 'text', text };
	}
	console.log(`[bot] unified message type=${unifiedMsg.type} textLen=${text.length} hasImage=${!!image}`);

	// 纯文档(无caption文字) -> 补提示, 让 LLM 知道有文件待分析 (upload-ops 通用插件会 restrict 工具 + 按扩展分派技能包 + 给绝对路径)
	const promptText = (text || (file ? `收到文件 ${file.fileName}, 请用数据技能分析它。` : ""));

	// /full：把上一条被截断的全文分条发出（回给来信号）
	if (text === "/full") {
		const prev = fullDump.get(m.channelId);
		if (!prev) {
			await adapter.sendMessage(m.channelId, "没有可展开的上一条消息。");
			return;
		}
		for (let i = 0; i < prev.length; i += MAX_LEN) {
			await adapter.sendMessage(m.channelId, prev.slice(i, i + MAX_LEN));
		}
		return;
	}

	console.log(`[bot] inbound from=${m.userId} channel=${m.channelId} text=${text.slice(0, 80)}`);
	progressRoute.set(`${adapter.platform}:${m.channelId}`, { adapter, channelId: m.channelId });

	// 方案1(进化系统#5反思): 真实消息(如 Telegram)的 /stop 立即中断 —— 绕过 core.handle 消息队列,
	// 否则 /stop 排在 deliver/tool 超时循环后面永远轮不到, 任务停不掉。INJECT 路径见 L~169。
	if (_isStopIntent(text)) {
		const _ab = (globalThis as Record<string, unknown>).__abortActive as ((sid?: string) => { stopped: boolean; text: string }) | undefined;
		const res = _ab ? _ab() : { stopped: false, text: "无 abort 钩子" };
		console.log(`[bot] /stop 立即中断 -> ${JSON.stringify(res)}`);
		try { await adapter.sendMessage(m.channelId, res.text); } catch { /* 回复失败仍已 abort */ }
		return;
	}

	// step8: 文件无 text 默认(FILE_AUTO_ROUTE != "0", on)不自动开跑 — 等用户说要求。
	// 文件留 G.__excelPendingFile(下次发文本 -> upload-ops before_agent_start 落盘+开跑)。
	// 影响面: 仅「文件 + 空 text」路径; 纯文本/图片/带 caption 文件 照旧。
	// flag off(FILE_AUTO_ROUTE=0) = 旧行为(造默认 prompt 立即分析)。
	if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {
		console.log(`[bot] file-only hold: ${file.fileName} saved pending, waiting for user instruction (FILE_AUTO_ROUTE=${process.env.FILE_AUTO_ROUTE || "on"})`);
		try {
			await adapter.sendMessage(m.channelId, `已收到文件 ${file.fileName}。请说明你的要求(如:分析数据/做成PPT/提取表格),我再开始处理。`);
		} catch { /* 回复失败仍 hold */ }
		return;
	}
	let outs;
	try {
		outs = await core.handle({
			platform: adapter.platform,
			channelId: m.channelId,
			userId: m.userId,
			text: promptText,
			rawText: text,
			image, // 多模态: 图片附件(base64), 传给模型 vision
			msgType: unifiedMsg.type, // 统一消息类型
			isGroup: String(m.channelId).endsWith("@g.us"),
		});
	} catch (e) {
		// 原来这里抛出去就断了：onMessage 的异常没人接，用户永远等不到回复，
		// 日志里也只有一条 unhandled rejection。至少回一句可诊断的话。
		console.error(`[bot] handle failed for ${m.userId}:`, e);
		await adapter
			.sendMessage(m.channelId, `处理失败：${String(e).slice(0, 200)}`)
			.catch(() => {});
		return;
	}

	for (const o of outs) {
		const body = formatForPlatform(o.text, adapter.platform);
		if (!body.trim()) continue; // 空回复(LLM调工具但没写正文)发空消息会失败, 跳过
		// [IMG:<路径>] 传输接线: LLM 在正文末尾单独一行写标记 -> 发真实成品图(bot 传输层机制, 不改 LLM 透传铁律)。
		// 安全: 路径限 TENANT_ROOT 前缀 + 白名单扩展名 + 行尾锚定 + 只发 1 张 + 发送后从文本剥离, 用户看不到裸路径。
		const imgRe = /^\s*\[IMG:([^\]\r\n]+)\]\s*$/gm;
		const imgPaths: string[] = [];
		let clipBody = body;
		try {
			clipBody = body.replace(imgRe, (_s: string, p1: string) => {
				const p = String(p1).trim();
				if (imgPaths.length >= 1) return ""; // 限 1 张
				const abs = path.resolve(p);
				if (!abs.startsWith(TENANT_ROOT) || !/\.(png|jpe?g|webp)$/i.test(abs) || !existsSync(abs)) return "";
				imgPaths.push(abs);
				return "";
			}).trim();
		} catch { clipBody = body; }
		fullDump.set(m.channelId, clipBody || body);
		// TEMP-DIAG: capture actual reply text (revert after capturing)
		console.log(`[bot][REPLY-TEXT] ${JSON.stringify(clipBody || body)}`);
		if (clipBody && clipBody.trim()) {
			const payload = clip(clipBody);
			try {
				await adapter.sendMessage(m.channelId, payload);
			} catch (e1) {
				console.warn(`[bot] sendMessage retry channelId=${m.channelId}`, e1);
				try {
					await adapter.sendMessage(m.channelId, payload);
				} catch (e2) {
					console.error(`[bot] sendMessage failed channelId=${m.channelId}`, e2);
				}
			}
		}
		for (const ip of imgPaths) {
			try {
				if (typeof (adapter as any).sendImage === "function") { await (adapter as any).sendImage(m.channelId, ip); }
				console.log(`[bot] sent image to ${m.userId}: ${ip}`);
			} catch (e3) {
				console.warn(`[bot] sendImage failed channelId=${m.channelId}: ${ip}`, e3);
				await adapter.sendMessage(m.channelId, `[图片发送失败] ${ip}`).catch(() => {});
			}
		}
	}
	console.log(`[bot] replied to ${m.userId} (${outs.length} msg)`);
};

// 并发起全部账号，但**错开 15s**：同 IP 同时注册两个新设备会被 WA 限流瞬断（实测 wa1 被 Terminated）
// QR 轮询：Baileys 的 qr 事件在 connect 期间持续刷新
for (const [idx, a] of ACCTS.entries()) {
	// WA_SKIP=wa2,...：临时禁起某些账号（隔离排查用）。坏账号反复握手套失败会把
	// 同进程已连上的账号拖进崩溃循环（实测 wa2 连累 wa1 必断），先禁掉再逐个起。
	if ((process.env.WA_SKIP ?? "").split(",").map((s) => s.trim()).includes(a.label)) {
		console.warn(`[wa:${a.label}] skipped (WA_SKIP)`);
		continue;
	}
	if (idx > 0) await new Promise((r) => setTimeout(r, 15_000));
	// 坏凭据预清理：me 有值但 account 签名 key 全空 = 配对没完成的废凭据（registered 标志位
	// 在 rc14 下不可靠不能用它判）。不清理会让 adapter 反复握手套坏凭据失败重试，
	// 同进程把另一个已连上的账号拖下水（实测 wa1 被 wa2 连累 18s 必断）。清掉 = 重新出码配对。
	try {
		const raw = await readFile(`${a.session}/creds.json`, "utf8");
		const c = JSON.parse(raw) as { noiseKey?: unknown; me?: unknown; account?: Record<string, unknown> };
		// 判据用 noiseKey（Baileys 启动必需）而非 registered/me：实测空壳 {} 或缺 noiseKey 的
		// creds 会让 makeWASocket 启动时 `undefined is not an object (evaluating 'noiseKey')`
		// 崩掉，同进程把另一个已连上的账号拖断（wa1 被 wa2 连累 13s 必断）。
		if (!c.noiseKey) {
			await rm(`${a.session}/creds.json`, { force: true });
			console.warn(`[wa:${a.label}] broken creds (missing noiseKey) - deleted for fresh pairing`);
		}
	} catch { /* 无 creds / 解析失败 = 走注册流，照常 init */ }
	const adapter = new WhatsAppAdapter({
		platform: "whatsapp",
		enabled: true,
		label: a.label,
		sessionPath: a.session,
		printQr: a.label === ACCTS[0].label, // 只有首个账号往终端打，避免多串 QR 糊在一起
		maxMessageLength: MAX_LEN,
	});
	adapters.set(a.label, adapter);
	qrByLabel.set(a.label, null);
	// 关键：base.start() 只存 callbacks，不建 socket —— 必须先 initialize()
	// （pi-gateway 原 runner 是 initialize→start 两步；漏了 initialize 就永远没 QR）
	void Promise.all([
		adapter.initialize(),
		adapter.start({ onMessage: (m: any) => onMessage(m, adapter) }),
	]).catch((e) => console.error(`[wa:${a.label}] start failed:`, e));
	// 轮询 QR：换码就落盘一份 PNG（浏览器被拦时 curl 这个文件拿最新码，不怕 20s 轮换）
	let lastQr: string | null = null;
	setInterval(async () => {
		const qr = adapter.getQrCode();
		qrByLabel.set(a.label, qr);
		const pc = adapter.getPairingCode();
		if (pc) pairCodeByLabel.set(a.label, pc);
		if (qr && qr !== lastQr) {
			lastQr = qr;
			try {
				await writeFile(`${a.session}-qr.png`, await QRCode.toBuffer(qr, { width: 400 }));
			} catch (e) {
				console.error(`[wa:${a.label}] qr save failed:`, e);
			}
		}
	}, 2000).unref?.();
}

// /qr 页面：每账号给两条路 ——
//   1) 深链（主路径）：手机点一下直接进 WhatsApp「链接设备」自动配对，不扫码、不怕码轮换
//   2) PNG 二维码（兑底）：电脑上展示手机扫；码约 20s 轮换，页面 5s 自刷新
// 另外每次 QR 更新都落盘 /srv/wagate/wa-sessions/qr-<label>.png，随时 curl 最新码。
const html = () => `<!doctype html><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;max-width:420px;margin:2em auto">
<h2>wagate 配对</h2>
${ACCTS.map((a) => {
	const qr = qrByLabel.get(a.label);
	const pc = pairCodeByLabel.get(a.label);
	return `<h3>${a.label}</h3>` +
		(pc
			? `<p style="background:#eef;padding:.5em;border-radius:6px"><b>8 位配对码（推荐）：</b><br><span style="font-size:2em;letter-spacing:.15em">${pc}</span><br><small>手机 WhatsApp → 已连接设备 → 连接设备 → 输入配对码</small></p>`
			: "") +
		(qr
			? `<p style="margin:.3em 0"><b>或手机点这里：</b><br><a href="https://wa.me/device-link?code=${encodeURIComponent(qr)}">在 WhatsApp 里配对 ${a.label}</a></p>
<p><img src="/qr/${encodeURIComponent(a.label)}" width="300" alt="qr"><br><small>或扫码；码约 20 秒换一次</small></p>`
			: `<p>等待 QR / 配对码…（2s 后刷新）</p>`);
}).join("<hr>")}
</body>`;

createServer(async (req, res) => {
	const m = req.url?.match(/^\/qr\/([\w-]+)$/);
	if (m) {
		const qr = qrByLabel.get(m[1]);
		if (!qr) return void res.writeHead(404).end();
		const png = await QRCode.toBuffer(qr, { width: 400 });
		return void res.writeHead(200, { "content-type": "image/png" }).end(png);
	}
	if (req.url === "/qr") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html());
	res.writeHead(404).end();
}).listen(QR_PORT, () => console.log(`QR page: http://0.0.0.0:${QR_PORT}/qr  accounts=${ACCTS.map((a) => a.label).join(",")}`));

console.log(`wagate up · accounts=${ACCTS.map((a) => a.label).join(",")} · allow=${ALLOW.size}`);
process.on("SIGTERM", async () => {
	await core.dropAll();
	process.exit(0);
});
// ===== Telegram 初始化（多平台） =====
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (TELEGRAM_BOT_TOKEN) {
  const telegram = new TelegramAdapter({
    enabled: true,
    platform: "telegram",
    token: TELEGRAM_BOT_TOKEN,
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL,
  });
  adapters.set("telegram", telegram);
  void Promise.all([
    telegram.initialize(),
    telegram.start({ onMessage: (m: PlatformMessage) => onMessage(m, telegram) }),
  ]).then(() => console.log("[telegram] Started"))
    .catch((e) => console.error("[telegram] Failed:", (e && (e as Error).message) || String(e)));
}
