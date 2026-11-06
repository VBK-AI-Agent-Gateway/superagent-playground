/**
 * 插件: img-ops —— 图片处理默认能力 (纯插件, 核心零改动; 与 img-lab 视频能力互补)。
 * 机制: before_agent_start 从 images 数组抽 base64(bot 已把 imageMessage 传进 ev.images),
 *       写 /srv/tenants/<sid>/workspace/source-latest.png(RW 挂载)。
 * 工具: img_ops(info|resize|rotate|crop|grayscale|invert); 纯 ffmpeg CLI 处理, 调用成功即直发成品图片。
 * 卸载: 删本文件即回原状。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, realpath } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markPendingSync } from "../../ws-sync-queue.ts";
import { currentSid } from "../../tenant-context.ts";
const G = globalThis as Record<string, unknown>;
const MAX_BYTES = 30 * 1024 * 1024; // 图片上限 30MB
const IMG_B64_RE = /data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/;
const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: false, terminate: false });
const err = (text: string) => ({ content: [{ type: "text" as const, text: `img_ops 失败: ${text}` }], details: undefined, isError: true, terminate: false });
// 单次 ffmpeg 调用 (execFile 防 shell 注入; 30s 超时)
function ff(args: string[]): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		execFile("ffmpeg", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
			let code = 0;
			if (error && typeof error === "object" && "code" in error && typeof error.code === "number") code = error.code;
			resolve({ code, stderr: String(stderr) });
		});
	});
}
function tenantDir(): { root: string; sid: string; wsDir: string } | null {
	const root = typeof G.__tenantRoot === "string" ? G.__tenantRoot : "/srv/tenants";
	const sid = currentSid();
	if (!sid) return null;
	return { root, sid, wsDir: path.join(root, sid, "workspace") };
}
// 图片源推送: base64 解码直落宿主 workspace (RW 挂载), 沙箱与 img_ops execute 都从该挂载路径读。
async function pushImageToSandbox(sid: string, imgBuf: Buffer, mime: string): Promise<boolean> {
	try {
		const t = tenantDir();
		if (!t || t.sid !== sid) return false;
		await mkdir(t.wsDir, { recursive: true }).catch(() => 0);
		const ext = mime.includes("jpeg") || mime.includes("jpg") ? ".jpg" : ".png";
		const dst = path.join(t.wsDir, `source-latest${ext}`);
		writeFileSync(dst, imgBuf);
		G.__imgOpsSourceSaved = Promise.resolve();
		console.log(`[img-ops] image source written host-copy ${dst} bytes=${imgBuf.length}`);
		try {
			// 通用模式: 用 __sbxBash 在沙箱内写 /ws/ (自动推导 cwd)
			const sbxBash = G.__sbxBash as ((cmd: string, sid?: string) => Promise<{ ok?: boolean; error?: string; text?: string }>) | undefined;
			if (sbxBash) {
				const result = await sbxBash(`cp ${dst} /ws/source-latest${ext}`, sid);
				if (result?.ok === false) {
					console.warn(`[img-ops] /ws sync failed: ${result.error || result.text}`);
					// 失败时标记延迟同步 (沙箱未就绪)
					markPendingSync(sid, dst, `/ws/source-latest${ext}`);
				} else {
					console.log(`[img-ops] /ws sync done: /ws/source-latest${ext}`);
				}
			} else {
				console.warn(`[img-ops] /ws sync skipped: __sbxBash not available`);
			}
		} catch (e) {
			console.warn(`[img-ops] /ws sync exception: ${String(e).slice(0, 160)}`);
		}
		return true;
	} catch (e) {
		console.warn(`[img-ops] image source write fail (fail-open): ${String(e).slice(0, 160)}`);
		return false;
	}
}
export default function imgOps(pi: { registerTool: (t: unknown) => void; on: (event: string, handler: (event: unknown, context?: unknown) => void | Promise<void>) => void; getActiveTools?: () => string[]; setActiveTools?: (names: string[]) => void }) {
	// 图片任务默认能力提示 + base64 截取落盘: 用户带图片 -> 本插件自动把图片写到 workspace, 模型用 img_ops 处理, 无需用户指名工具。
	pi.on("before_agent_start", async (event: unknown) => {
		try {
			const getA = (pi as { getActiveTools?: () => string[]; setActiveTools?: (n: string[]) => void });
			const getFn = getA.getActiveTools;
			const setFn = getA.setActiveTools;
			if (typeof getFn === "function" && typeof setFn === "function") {
				const base: string[] = getFn.call(pi) || [];
				console.log(`[img-ops] getActiveTools (before) -> ${base.join(",")}`);
				const want = new Set([...base, "img_ops"]);
				const evD = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
				const imgsD = Array.isArray(evD.images) ? evD.images as Array<Record<string, unknown>> : [];
				const hasImg = imgsD.some((x) => x && typeof x.data === "string" && x.data.length > 500);
				const tD = G.__imgOpsTask;
				const freshTask = !!tD && typeof tD === "object" && "at" in tD && typeof tD.at === "number" && Date.now() - tD.at < 600_000;
				if (hasImg || freshTask) {
					// 图片任务: 只保留 img_ops, 移除所有探索工具
					const WRITE_TOOLS = new Set(["sbx_write", "sbx_bash", "sbx_edit", "deliver"]);
					const EXPLORE_TOOLS = new Set(["sbx_find", "sbx_grep", "sbx_read", "sbx_ls", "sbx_env"]);
					const removed: string[] = [];
					for (const n of WRITE_TOOLS) if (want.delete(n)) removed.push(n);
					for (const n of EXPLORE_TOOLS) if (want.delete(n)) removed.push(n);
					if (removed.length) console.log(`[img-ops] image task: restrict to img_ops ONLY (removed ${removed.join(",")})`);
				}
				const wantArr = Array.from(want);
				const changed = wantArr.some((n) => !base.includes(n)) || base.some((n) => !want.has(n));
				if (changed) {
					setFn.call(pi, wantArr);
					console.log(`[img-ops] setActiveTools -> ${wantArr.join(",")}`);
					// 调试: 确认工具列表已更新
					const after = getFn.call(pi) || [];
					console.log(`[img-ops] verify getActiveTools -> ${after.join(",")}`);
				}
			}
		} catch (e) {
			console.warn(`[img-ops] setActiveTools fail (fail-open): ${String(e).slice(0, 120)}`);
		}
		// 图片提取落盘: 用户发图片 -> ev.images base64 -> workspace/source-latest.png。
		try {
			const ev = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
			const imgs = Array.isArray(ev.images) ? ev.images as Array<Record<string, unknown>> : [];
			const i0 = imgs.find((x) => x && typeof x.data === "string" && x.data.length > 500);
			const m = i0 ? null : String(ev.prompt ?? "").match(IMG_B64_RE);
			const rawB64 = i0 ? String(i0.data) : m ? m[1] : "";
			const mime = i0 && typeof i0.mimeType === "string" ? i0.mimeType : "image/png";
			const t = tenantDir();
			if (rawB64 && t) {
				try {
					const b64 = rawB64.replace(/^data:image\/[\w.+-]+;base64,/, "");
					const imgBuf = Buffer.from(b64, "base64");
					if (imgBuf.length > MAX_BYTES) throw new Error(`图片过大 ${imgBuf.length} > ${MAX_BYTES}`);
					G.__imgOpsTask = { sid: t.sid, at: Date.now() }; // 图片任务标记(续跑拦截+完成信号用, 10min TTL)
					void pushImageToSandbox(t.sid, imgBuf, mime);
					console.log("[img-ops] image extracted, writing source-latest.*");
				} catch (e) {
					console.warn(`[img-ops] extract fail: ${String(e).slice(0, 120)}`);
				}
			}
			const sp = typeof ev.systemPrompt === "string" ? ev.systemPrompt : "";
			// 图门: 只有真图片 (rawB64 落盘成功或 ev.images 有图) 才 inject 图片指引 (修: Excel 文本 run 误触发)
			if ((rawB64 || imgs.length) && sp && !sp.includes("【图片任务处理指引】**强制规则**")) {
				ev.systemPrompt = sp +
					"\n【图片任务处理指引】用户发的图片已在 workspace/source-latest.png。**强制规则**: 1) 禁止用 sbx_find/sbx_ls/sbx_read 搜索图片, 图片就在 workspace/source-latest.png; 2) 直接调用 img_ops(op: info) 先确认图片; 3) 处理图片(缩放/旋转/裁剪/灰度/反色)一律调用 img_ops 工具(op: info|resize|rotate|crop|grayscale|invert); 4) 调用成功自动直发成品图片到 WhatsApp; 5) 不要反复探索目录 — 这是图片处理任务, 不是文件探索任务; 6) 不要嵌 HTML 再 deliver。";
				console.log("[img-ops] inject: systemPrompt append (image 路线 + 强制规则)");
			}
		} catch (e) {
			console.warn(`[img-ops] inject fail (fail-open): ${String(e).slice(0, 120)}`);
		}
	});
	pi.registerTool({
		name: "img_ops",
		description: "对 workspace 图片做本机 ffmpeg 操作并自动把成品图片直发 WhatsApp: info | resize | rotate | crop | grayscale | invert。图片任务主工具——调用成功即直发成品。",
		promptSnippet: "[IMG_OPS] 图片在 workspace/source-latest.png, 处理图片=img_ops(自动直发成品图片); 不要走脚本+嵌网页+deliver。",
		promptGuidelines: [
			"处理图片一律用 img_ops(op: info|resize|rotate|crop|grayscale|invert), 成功即自动直发成品图片到 WhatsApp——正文一句话说明即可。",
			"源图片就在 workspace/source-latest.png, 不要 sbx_read/sbx_find 反复找图片。",
			"不要把图片结果嵌 HTML 再 deliver github.io(域名常被拒, 用户看不到)。",
		],
		parameters: {
			type: "object",
			properties: {
				op: { type: "string", description: "info | resize | rotate | crop | grayscale | invert" },
				width: { type: "number", description: "op=resize 目标宽(px, 高度按比例)", optional: true },
				degrees: { type: "number", description: "op=rotate 旋转角度(90/180/270)", optional: true },
				x: { type: "number", description: "op=crop 左上角 x(px)", optional: true },
				y: { type: "number", description: "op=crop 左上角 y(px)", optional: true },
				w: { type: "number", description: "op=crop 宽(px)", optional: true },
				h: { type: "number", description: "op=crop 高(px)", optional: true },
			},
			required: ["op"],
		},
		execute: async (_toolCallId: string, params: unknown) => {
			try {
				const a = (params ?? {}) as Record<string, unknown>;
				console.log(`[img-ops] execute params=${JSON.stringify(a).slice(0, 500)}`);
				const t = tenantDir();
				if (!t) { console.error("[img-ops] execute FAIL: tenantDir() null (sid 缺失)"); return err("未识别的会话(sid 缺失)"); }
				await (G.__imgOpsSourceSaved as Promise<void> | undefined)?.catch(() => 0);
				const outDir = t.wsDir;
				const srcPng = path.join(t.wsDir, "source-latest.png");
				const srcJpg = path.join(t.wsDir, "source-latest.jpg");
				const src = existsSync(srcPng) ? srcPng : existsSync(srcJpg) ? srcJpg : "";
				if (!src) { console.error(`[img-ops] execute FAIL: 源图片不存在 (checked ${srcPng}, ${srcJpg})`); return err("源图片不存在(用户这条消息没带图片?)"); }
				const st = await stat(src);
				if (st.size > MAX_BYTES) return err(`源图片过大 ${st.size} bytes (上限 ${MAX_BYTES})`);
				const op = String(a.op ?? "");
				if (op === "info") return ok(`bytes=${st.size} src=${src.split("/").pop()}`);
				await mkdir(outDir, { recursive: true });
				const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
				let out = path.join(outDir, `img-ops-${stamp}.png`);
				let argsF: string[];
				if (op === "resize") {
					const w = Math.max(16, Math.min(Number(a.width ?? 720), 4096));
					argsF = ["-y", "-i", src, "-vf", `scale=${w}:-2`, out];
				} else if (op === "rotate") {
					const d = Number(a.degrees ?? 90);
					if (![90, 180, 270].includes(d)) return err("op=rotate degrees 需为 90|180|270");
					const transpose = d === 90 ? "transpose=1" : d === 180 ? "transpose=1,transpose=1" : "transpose=2";
					argsF = ["-y", "-i", src, "-vf", transpose, out];
				} else if (op === "crop") {
					const cx = Math.max(0, Number(a.x ?? 0));
					const cy = Math.max(0, Number(a.y ?? 0));
					const cw = Math.max(1, Number(a.w ?? 100));
					const ch = Math.max(1, Number(a.h ?? 100));
					argsF = ["-y", "-i", src, "-vf", `crop=${cw}:${ch}:${cx}:${cy}`, out];
				} else if (op === "grayscale") {
					argsF = ["-y", "-i", src, "-vf", "format=gray", out];
				} else if (op === "invert") {
					argsF = ["-y", "-i", src, "-vf", "negate", out];
				} else {
					console.error(`[img-ops] execute FAIL: 未知 op=${op}`);
					return err(`未知 op=${op} (可用: info|resize|rotate|crop|grayscale|invert)`);
				}
				console.log(`[img-ops] execute op=${op} src=${src} out=${out} ffmpegArgs=${argsF.join(" ")}`);
				const r = await ff(argsF);
				if (r.code !== 0) { console.error(`[img-ops] execute FAIL: ffmpeg op=${op} code=${r.code} stderr=${r.stderr.slice(-300)}`); return err(`ffmpeg op=${op} 退出码 ${r.code}: ${r.stderr.slice(-300)}`); }
				if (!existsSync(out)) { console.error(`[img-ops] execute FAIL: ffmpeg 未产出 ${out}`); return err("ffmpeg 未产出文件"); }
				const real = await realpath(out);
				G.__imgOpsCalled = Date.now(); // 图片任务"有进展"标记(settle stillWorking 认这个)
				if (!real.startsWith(t.root)) return err("输出路径逃逸");
				// 直发(img-lab 同款机制): 经 __progressRoute 取 adapter 直接发图片, 不依赖 LLM 输出标记。
				try {
					const pgR = G.__progressRoute;
					const rm = pgR && pgR instanceof Map ? pgR as Map<string, unknown> : undefined;
					let v: { adapter?: { sock: { sendMessage: (jid: string, content: unknown) => Promise<unknown> } }; channelId?: string } | undefined;
					const dc = G.__docPackChat;
					const dm = dc && typeof dc === "object" ? dc as Record<string, unknown> : undefined;
					const ckRaw = dm ? dm[t.sid] : undefined;
					const ck = typeof ckRaw === "string" ? ckRaw : undefined;
					if (rm) {
						if (ck !== undefined) v = rm.get(ck) as typeof v;
						if (!v && rm.size === 1) for (const val of rm.values()) { v = val as typeof v; break; }
					}
					if (v && v.adapter && v.channelId) {
						await v.adapter.sock.sendMessage(v.channelId, { image: { url: real }, caption: `图片已处理完成(${op}): ${real.split("/").pop()}` });
						console.log(`[img-ops] image sent direct to ${v.channelId}: ${real}`);
						return ok(`成品图片已直接发送给用户(op=${op})。正文一句话说明即可; 不要写 [IMG:] 标记、不要重复发图片。`);
					}
					console.warn("[img-ops] no route for direct send -> fallback [IMG:] marker");
				} catch (se) {
					console.warn(`[img-ops] direct send fail (fallback marker): ${String(se).slice(0, 160)}`);
				}
				return ok(`已生成 ${real}。可在正文末尾单独一行写 [IMG:${real}] 让系统发图片。`);
			} catch (e) {
				const msg = e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message : String(e);
				console.error(`[img-ops] execute EXCEPTION: ${msg.slice(0, 300)}`);
				return err(msg.slice(0, 200));
			}
		},
	});
	console.log("[img-ops] tool registered: img_ops");
}