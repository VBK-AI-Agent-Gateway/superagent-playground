/**
 * 插件: img-lab —— 视频处理默认能力 (纯插件, 核心零改动; 原图片功能已改为视频)。
 * 机制: before_agent_start 从 video 数组抽 base64(bot 已把 videoMessage 下载成 m.video),
 *       写 /srv/tenants/<sid>/workspace/source-latest.mp4(RW 挂载)。
 * 工具: img_lab(info|trim|scale|frame|mute|rotate); 纯 ffmpeg CLI 处理, 调用成功即直发成品视频。
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
const MAX_BYTES = 100 * 1024 * 1024; // 视频上限 100MB
const VIDEO_B64_RE = /data:video\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined, isError: false, terminate: false });
const err = (text: string) => ({ content: [{ type: "text" as const, text: `img_lab 失败: ${text}` }], details: undefined, isError: true, terminate: false });

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

// ffprobe 取时长(秒); 失败返回 -1
function probeDuration(src: string): Promise<number> {
	return new Promise((resolve) => {
		execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", src], { timeout: 10_000 }, (e, stdout) => {
			if (e) return resolve(-1);
			const d = parseFloat(String(stdout).trim());
			resolve(Number.isFinite(d) ? d : -1);
		});
	});
}

function tenantDir(): { root: string; sid: string; wsDir: string } | null {
	const root = typeof G.__tenantRoot === "string" ? G.__tenantRoot : "/srv/tenants";
	const sid = currentSid();
	if (!sid) return null;
	return { root, sid, wsDir: path.join(root, sid, "workspace") };
}

// 视频源推送: 视频大, 不走沙箱 exec 写(b64 塞命令行会炸)。
// 直接落宿主 /srv/tenants/<sid>/workspace/source-latest.mp4 (RW 挂载), 沙箱与 img_lab execute 都从该挂载路径读。
async function pushVideoToSandbox(sid: string, videoBuf: Buffer): Promise<boolean> {
	try {
		const t = tenantDir();
		if (!t || t.sid !== sid) return false;
		await mkdir(t.wsDir, { recursive: true }).catch(() => 0);
		const dst = path.join(t.wsDir, "source-latest.mp4");
		writeFileSync(dst, videoBuf);
		G.__imgLabSourceSaved = Promise.resolve();
		console.log(`[img-lab] video source written host-copy ${dst} bytes=${videoBuf.length}`);

		// 通用模式: 同步到沙箱 /ws/ (用 __sbxBash 自动推导 cwd)
		try {
			const sbxBash = G.__sbxBash as ((cmd: string, sid?: string) => Promise<{ ok?: boolean; error?: string; text?: string }>) | undefined;
			if (sbxBash) {
				const result = await sbxBash(`cp ${dst} /ws/source-latest.mp4`, sid);
				if (result?.ok === false) {
					console.warn(`[img-lab] /ws sync failed: ${result.error || result.text}`);
					markPendingSync(sid, dst, `/ws/source-latest.mp4`);
				} else {
					console.log(`[img-lab] /ws sync done: /ws/source-latest.mp4`);
				}
			} else {
				console.warn(`[img-lab] /ws sync skipped: __sbxBash not available`);
			}
		} catch (e) {
			console.warn(`[img-lab] /ws sync exception: ${String(e).slice(0, 160)}`);
		}

		return true;
	} catch (e) {
		console.warn(`[img-lab] video source write fail (fail-open): ${String(e).slice(0, 160)}`);
		return false;
	}
}

export default function imgLab(pi: { registerTool: (t: unknown) => void; on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) {
	// 视频任务默认能力提示 + base64 截取落盘: 用户带视频 -> 本插件自动把视频写到 workspace, 模型用 img_lab 处理, 无需用户指名工具。
	pi.on("before_agent_start", async (event: unknown) => {
		// 解法A(白名单修复): 每轮幂等把 img_lab/doc_pack 抬进 active tools —
		// 白名单(options.tools→Set)只在 _refreshToolRegistry 过滤 builtin, setActiveToolsByName 只查 registry(img_lab 在),
		// 故可绕白名单激活; bind 后无新 registerTool 不会再被 refresh 掉, 即使被掉下轮也自愈(每轮幂等)。
		try {
			const getA = (pi as { getActiveTools?: () => string[]; setActiveTools?: (n: string[]) => void });
			const getFn = getA.getActiveTools;
			const setFn = getA.setActiveTools;
			if (typeof getFn === "function" && typeof setFn === "function") {
				const base: string[] = getFn.call(pi) || [];
				const want = new Set([...base, "img_lab", "doc_pack"]);
				// 视频任务(本轮带视频 或 __imgTask 10min 内)只暴露 img_lab + 读类工具(方案C)——
				// 移除写/执行类(sbx_write/sbx_bash/sbx_edit)和 deliver, 切断模型走"沙箱改视频→嵌HTML→deliver"的
				// 绕道, 逼它只能用 img_lab 直发成品视频。读类保留: 模型仍可查看沙箱/视频, 但无法写脚本改视频。
				const evD = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
				const vidsD = Array.isArray(evD.videos) ? evD.videos as Array<Record<string, unknown>> : [];
				const hasVid = vidsD.some((x) => x && typeof x.data === "string" && x.data.length > 500);
				const tD = G.__imgTask;
				const freshTask = !!tD && typeof tD === "object" && "at" in tD && typeof tD.at === "number" && Date.now() - tD.at < 10 * 60_000;
				if (hasVid || freshTask) {
					const WRITE_TOOLS = new Set(["sbx_write", "sbx_bash", "sbx_edit", "deliver"]);
					const removed: string[] = [];
					for (const n of WRITE_TOOLS) if (want.delete(n)) removed.push(n);
					if (removed.length) console.log(`[img-lab] video task: restrict to img_lab (removed ${removed.join(",")})`);
				}
				const wantArr = Array.from(want);
				const changed = wantArr.some((n) => !base.includes(n)) || base.some((n) => !want.has(n));
				if (changed) {
					setFn.call(pi, wantArr);
					console.log(`[img-lab] setActiveTools -> ${wantArr.join(",")}`);
				}
			}
		} catch (e) {
			console.warn(`[img-lab] setActiveTools fail (fail-open): ${String(e).slice(0, 120)}`);
		}
		// 续跑拦截(NOT_DELIVERED 复活): 视频任务标记新鲜 && prompt 是 tenant-core 续跑族 -> 改写为视频收尾指令。
		try {
			const _imgT = G.__imgTask;
			const _freshImg = !!_imgT && typeof _imgT === "object" && "at" in _imgT && typeof _imgT.at === "number" && Date.now() - _imgT.at < 10 * 60_000;
			const _evR = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
			const _prR = typeof _evR.prompt === "string" ? _evR.prompt : "";
			if (_freshImg && _prR && /【铁律】每条消息最多|进度检查: 已完成|【纠正】|【交付倒计时】|所有任务已标记 DONE|现在只执行这一个任务/.test(_prR)) {
				_evR.prompt = "视频处理任务继续: 源视频在 workspace/source-latest.mp4。处理视频一律调用 img_lab 工具(op: info|trim|scale|frame|mute|rotate), 调用成功即自动把成品视频直发 WhatsApp——正文一句话说明即可, 不要写 [IMG:]、不要 deliver 链接、不要嵌 HTML。不要空转找视频、不要输出空正文。";
				console.log("[img-lab] resume rewritten for img task");
				return { prompt: _evR.prompt };
			}
		} catch (e) {
			console.warn(`[img-lab] resume-guard fail (fail-open): ${String(e).slice(0, 120)}`);
		}
		let spInjected = false;
		try {
			const ev = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
			const sp = typeof ev.systemPrompt === "string" ? ev.systemPrompt : "";
			const pr0 = typeof ev.prompt === "string" ? ev.prompt : "";
			let pr = pr0;
			const t = tenantDir();
			const vids = Array.isArray(ev.videos) ? ev.videos as Array<Record<string, unknown>> : [];
			const v0 = vids.find((v) => v && typeof v.data === "string" && v.data.length > 500);
			const m = v0 ? null : pr0.match(VIDEO_B64_RE);
			const rawB64 = v0 ? String(v0.data) : m ? m[1] : "";
			if (!pr0 && !rawB64) return;
			if (rawB64 && t) {
				try {
					const b64 = rawB64.replace(/^data:video\/[\w.+-]+;base64,/, "");
					const videoBuf = Buffer.from(b64, "base64");
					if (videoBuf.length > MAX_BYTES) throw new Error(`视频过大 ${videoBuf.length} > ${MAX_BYTES}`);
					G.__imgTask = { sid: t.sid, at: Date.now() }; // 视频任务标记(续跑拦截+完成信号用, 10min TTL)
					// 视频大: 走 host-copy 落盘 source-latest.mp4 (RW 挂载), 不经沙箱 exec 写(无 stdin + b64 会炸命令行)。
					void pushVideoToSandbox(t.sid, videoBuf);
					pr = m ? pr0.replace(VIDEO_B64_RE, "").trim() : pr0.trim();
					pr += `\n\n【系统提示】用户发送的视频已保存到 ${path.join(t.wsDir, "source-latest.mp4")}。**处理视频(裁剪/缩放/截帧/静音/旋转)一律调用 img_lab 工具**(op: info|trim|scale|frame|mute|rotate; 调用成功即自动把成品视频直发 WhatsApp——正文一句话说明即可)。简单问答/描述视频内容直接文字答, 不必动工具。\n`;
					ev.prompt = pr;
				} catch (e) {
					console.warn(`[img-lab] extract fail: ${String(e).slice(0, 120)}`);
					pr = pr0;
				}
			}
			if (sp && !sp.includes("img_lab 处理指令") && (/视频|录像|裁剪视频|缩放视频|截帧|video|trim|scale/i.test(pr) || pr.includes("source-latest.mp4") || rawB64)) {
				ev.systemPrompt = sp +
					"\n【视频任务处理指引】用户发的视频已在 workspace/source-latest.mp4。**处理视频一律调用 img_lab 工具**(op: info|trim|scale|frame|mute|rotate; 调用成功即自动把成品视频直发 WhatsApp——这是唯一交付方式, 模型只在正文一句话说明做了什么, 不要写 [IMG:] 标记、不要重复发视频、不要 deliver 链接)。简单问答/描述视频内容直接文字答, 不必动工具。禁止空转 sbx_read 反复找视频(视频就在 workspace/source-latest.mp4)。**不要**嵌 HTML 再 deliver github.io(域名常被拒, 用户看不到)。\n";
				spInjected = true;
				console.log("[img-lab] inject: systemPrompt append (video 路线)");
			}
		} catch (e) {
			console.warn(`[img-lab] inject fail (fail-open): ${String(e).slice(0, 120)}`);
		}
		// 解法B(契约修复): event.systemPrompt 原地改 runner 不认, 必须 return 才进 currentSystemPrompt 链;
		// event.prompt 原地改 runner 认, 上面已就地改完。链式: 返回我们拼接后的版本即叠加。
		if (spInjected) return { systemPrompt: ev.systemPrompt as string };
		return undefined;
	});

	// 完成信号: assistant 正文出现 [IMG: 标记(=视频任务交付完成) -> 塞 __lastDeliver,
	// tenant-core settle L646 hasDeliver(runStart) 命中即 finish, 终止 NOT_DELIVERED 续跑循环。
	pi.on("message_end", (event: unknown) => {
		try {
			const _t = G.__imgTask;
			if (!_t || typeof _t !== "object" || !("at" in _t) || typeof _t.at !== "number" || Date.now() - _t.at > 10 * 60_000) return;
			const sid = "sid" in _t && typeof _t.sid === "string" ? _t.sid : "";
			const ev = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
			const m = ev.message;
			if (!m || typeof m !== "object" || !("role" in m) || m.role !== "assistant") return;
			const c = "content" in m && Array.isArray(m.content) ? m.content : [];
			const text = c.filter((x) => x && typeof x === "object" && "type" in x && x.type === "text").map((x) => String((x as { text?: unknown }).text || "")).join("");
			if (!/\[IMG:[^\]]+\]/.test(text)) return;
			G.__lastDeliver = { url: "img-task://done", at: Date.now(), sid };
			console.log("[img-lab] IMG marker seen -> __lastDeliver set (settle will finish)");
		} catch (e) {
			console.warn(`[img-lab] msg_end fail (fail-open): ${String(e).slice(0, 120)}`);
		}
	});

	// 竞态补写钩子已删: 视频源同步 host-copy 落盘, 无沙箱异步写竞态。

	pi.registerTool({
		name: "img_lab",
		description: "对 workspace 视频做本机 ffmpeg 操作并自动把成品视频直发 WhatsApp: info | trim | scale | frame | mute | rotate。视频任务主工具——调用成功即直发成品视频, 无需 deliver 网页、无需写 [IMG:] 标记。",
		promptSnippet: "[IMG_LAB] 视频在 workspace/source-latest.mp4, 处理视频=调 img_lab(自动直发成品视频); 不要走脚本+嵌网页+deliver。",
		promptGuidelines: [
			"处理视频一律用 img_lab(op: info|trim|scale|frame|mute|rotate), 成功即自动直发成品视频到 WhatsApp——正文一句话说明即可。",
			"源视频就在 workspace/source-latest.mp4, 不要 sbx_read/sbx_find 反复找视频。",
			"不要把视频结果嵌 HTML 再 deliver github.io(域名常被拒, 用户看不到)。",
		],
		parameters: {
			type: "object",
			properties: {
				op: { type: "string", description: "info | trim | scale | frame | mute | rotate" },
				start: { type: "number", description: "op=trim 起始秒", optional: true },
				end: { type: "number", description: "op=trim 结束秒", optional: true },
				width: { type: "number", description: "op=scale 目标宽(px, 高度按比例)", optional: true },
				degrees: { type: "number", description: "op=rotate 旋转角度(90/180/270)", optional: true },
			},
			required: ["op"],
		},
		execute: async (_toolCallId: string, params: unknown) => {
			try {
				const a = (params ?? {}) as Record<string, unknown>;
				console.log(`[img-lab] execute params=${JSON.stringify(a).slice(0, 500)}`);
				const t = tenantDir();
				if (!t) { console.error("[img-lab] execute FAIL: tenantDir() null (sid 缺失)"); return err("未识别的会话(sid 缺失)"); }
				await (G.__imgLabSourceSaved as Promise<void> | undefined)?.catch(() => 0);
				const outDir = t.wsDir;
				const src = existsSync(path.join(t.wsDir, "source-latest.mp4")) ? path.join(t.wsDir, "source-latest.mp4") : "";
				if (!src) { console.error(`[img-lab] execute FAIL: 源视频不存在 (checked ${path.join(t.wsDir, "source-latest.mp4")})`); return err("源视频不存在(用户这条消息没带视频?)"); }
				const st = await stat(src);
				if (st.size > MAX_BYTES) return err(`源视频过大 ${st.size} bytes (上限 ${MAX_BYTES})`);
				const dur = await probeDuration(src);
				const op = String(a.op ?? "");
				if (op === "info") return ok(`duration=${dur >= 0 ? dur.toFixed(2) : "?"}s bytes=${st.size} src=${src.split("/").pop()}`);
				await mkdir(outDir, { recursive: true });
				const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
				let out = path.join(outDir, `img-lab-${stamp}.mp4`);
				let argsF: string[];
				if (op === "trim") {
					const s = Number(a.start ?? 0);
					const e = a.end !== undefined ? Number(a.end) : undefined;
					if (!Number.isFinite(s) || s < 0) return err("op=trim 需要 start(秒, >=0)");
					if (e !== undefined && (!Number.isFinite(e) || e <= s)) return err("op=trim 需要 end > start");
					argsF = ["-y", "-ss", String(s), ...(e !== undefined ? ["-to", String(e)] : []), "-i", src, "-c", "copy", out];
					// shortcut: -c copy 只在关键帧边界切, 精确切需重编码; 当前短视频场景够用, 要精确再加 -c:v libx264
				} else if (op === "scale") {
					const w = Math.max(16, Math.min(Number(a.width ?? 720), 4096));
					argsF = ["-y", "-i", src, "-vf", `scale=${w}:-2`, "-c:a", "copy", out];
				} else if (op === "frame") {
					out = path.join(outDir, `img-lab-${stamp}.png`);
					argsF = ["-y", "-i", src, "-frames:v", "1", out];
				} else if (op === "mute") {
					argsF = ["-y", "-i", src, "-an", "-c:v", "copy", out];
				} else if (op === "rotate") {
					const d = Number(a.degrees ?? 90);
					if (![90, 180, 270].includes(d)) return err("op=rotate degrees 需为 90|180|270");
					const transpose = d === 90 ? "transpose=1" : d === 180 ? "transpose=1,transpose=1" : "transpose=2";
					argsF = ["-y", "-i", src, "-vf", transpose, "-c:a", "copy", out];
				} else {
					return err(`未知 op=${op} (可用: info|trim|scale|frame|mute|rotate)`);
				}
				const r = await ff(argsF);
				if (r.code !== 0) return err(`ffmpeg op=${op} 退出码 ${r.code}: ${r.stderr.slice(-300)}`);
				if (!existsSync(out)) return err("ffmpeg 未产出文件");
				const real = await realpath(out);
				// 视频任务"有进展"标记: settle 的 stillWorking 只认这个(读类工具空转不算干活)。
				G.__imgLabCalled = Date.now();
				if (!real.startsWith(t.root)) return err("输出路径逃逸");
				// 直发(doc_pack 同款机制): 经 __progressRoute 取 adapter 直接发视频, 不依赖 LLM 输出标记。
				try {
					const pgR = G.__progressRoute;
					const rm = pgR && pgR instanceof Map ? pgR as Map<string, unknown> : undefined;
					let v: { adapter?: { sock: { sendMessage: (jid: string, content: unknown) => Promise<unknown> } }; channelId?: string } | null = null;
					const dc = G.__docPackChat;
					const dm = dc && typeof dc === "object" ? dc as Record<string, unknown> : undefined;
					const ckRaw = dm ? dm[t.sid] : undefined;
					const ck = typeof ckRaw === "string" ? ckRaw : undefined;
					if (rm) {
						if (ck !== undefined) v = rm.get(ck) as typeof v;
						if (!v && rm.size === 1) for (const val of rm.values()) { v = val as typeof v; break; }
					}
					if (v && v.adapter && v.channelId) {
						await v.adapter.sock.sendMessage(v.channelId, { video: { url: real }, caption: `视频已处理完成(${op}): ${real.split("/").pop()}` });
						console.log(`[img-lab] video sent direct to ${v.channelId}: ${real}`);
						return ok(`成品视频已直接发送给用户(op=${op})。正文一句话说明即可; 不要写 [IMG:] 标记、不要重复发视频。`);
					}
					console.warn("[img-lab] no route for direct send -> fallback [IMG:] marker");
				} catch (se) {
					console.warn(`[img-lab] direct send fail (fallback marker): ${String(se).slice(0, 160)}`);
				}
				return ok(`已生成 ${real}。可在正文末尾单独一行写 [IMG:${real}] 让系统发视频。`);
			} catch (e) {
				const msg = e && typeof e === "object" && "message" in e && typeof e.message === "string" ? e.message : String(e);
				return err(msg.slice(0, 200));
			}
		},
	});
}