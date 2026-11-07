import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";

/**
 * project-identity 扩展: 项目身份的唯一权威(task.json)。
 *
 * 架构(语义判断归 LLM, 扩展只持久化+校验, 核心零改动):
 *  - 首轮任务(slugFrom 兜底一个 activeProj)写 task.json
 *  - before_agent_start 注入"项目目录规则" —— 模型自行判断新应用 vs 改现有:
 *      改现有 -> 沿用 task.json activeProj; 开发全新应用 -> 先调 select_project(slug) 声明独立新目录
 *  - 注册 select_project 工具: 模型调用 -> 写 task.json 新 activeProj/deliverBase(独立目录)
 *  - deliver 校验(clawsandbox-ext) / deploy forceProj(tenant-core) 读同一 task.json
 *
 * 注意: sid 从 globalThis.__currentSid(tenant-core 每轮设置)取, 与 deliver/deploy 同源。
 */

interface TaskState { activeProj?: string; deliverBase?: string }

const G = globalThis as Record<string, unknown>;
const root = (): string => (typeof G.__tenantRoot === "string" && G.__tenantRoot ? G.__tenantRoot : "/srv/tenants");
const taskPath = (sid: string): string => `${root()}/${sid}/task.json`;

export function readTask(sid: string): TaskState | null {
	if (!sid) return null;
	try {
		if (!existsSync(taskPath(sid))) return null;
		const parsed: unknown = JSON.parse(readFileSync(taskPath(sid), "utf8"));
		if (parsed && typeof parsed === "object") {
			const rec = parsed as Record<string, unknown>;
			return {
				activeProj: typeof rec.activeProj === "string" ? rec.activeProj : undefined,
				deliverBase: typeof rec.deliverBase === "string" ? rec.deliverBase : undefined,
			};
		}
		return null;
	} catch { return null; }
}

export function writeTask(sid: string, patch: TaskState): void {
	if (!sid) return;
	try {
		mkdirSync(dirname(taskPath(sid)), { recursive: true });
		writeFileSync(taskPath(sid), JSON.stringify({ ...(readTask(sid) || {}), ...patch }, null, 2));
	} catch (e) { console.warn(`[project-identity] writeTask failed sid=${sid}: ${String(e).slice(0, 120)}`); }
}

function slugFrom(text: string, sid: string): string {
	const m = text.match(/[a-z0-9][a-z0-9-_]{2,30}/i);
	return (m ? m[0] : "app-" + sid.slice(-6)).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 30);
}

/** 只兜底首轮(无 task.json): 从 prompt slug 一个。已有 activeProj -> 复用(切换由模型 select_project 决定, 非正则猜)。 */
function ensureIdentity(prompt: string, sid: string): string {
	const existing = readTask(sid)?.activeProj;
	if (existing) return existing;
	// SAFE_MODE=1: PI 直连, 跳过 activeProj 注入(不让历史项目名带偏PI)
	if (process.env.WAGATE_SAFE_MODE === "1") {
		console.log(`[project-identity][SAFE] skip activeProj injection sid=${sid}`);
		return undefined;
	}
	const activeProj = slugFrom(prompt, sid);
	writeTask(sid, { activeProj, deliverBase: `demo-${sid}/${activeProj}/` });
	console.log(`[project-identity] sid=${sid} first-task -> activeProj=${activeProj} (persisted task.json)`);
	return activeProj;
}

// 暴露给 tenant-core(clawsandbox-ext deliver 校验 / autoDeploy forceProj) 读同一 task.json
G.__readTask = readTask;
G.__writeTask = writeTask;

const textResult = (msg: string, extra?: Record<string, unknown>, terminate = false) => ({
	content: [{ type: "text" as const, text: msg }],
	details: extra,
	isError: false,
	terminate,
});

export default function projectIdentity(pi: { registerTool: (t: unknown) => void; on: (ev: string, h: (e: unknown, c: unknown) => void) => void }) {
	// 模型显式声明新项目目录 -> 写 task.json, 本轮后续 deliver/deploy 读到新值(独立目录)
	pi.registerTool({
		name: "select_project",
		label: "选择项目目录",
		description: "开发一个全新的应用/游戏(不是修改现有项目)时, 先调用本工具声明一个新的独立项目目录。修改现有应用时不要调用。",
		promptSnippet: "开发全新应用前先 select_project 声明独立目录",
		promptGuidelines: [
			"开发全新应用/游戏(与当前 task.json activeProj 不同的独立项目)前, 先调用 select_project(<英文短横线slug>)。",
			"slug 用简短英文 kebab-case(如 tcm-clinic、chess、game-engine), 不要与现有目录重名。",
			"修改/修复现有应用时不要调用, 直接沿用当前目录。",
		],
		parameters: Type.Object({ slug: Type.String({ description: "新项目的英文 kebab-case 目录名" }) }),
		execute: async (_id: string, args: unknown, _sig: unknown, _upd: unknown, _ctx: unknown) => {
			const sid = typeof G.__currentSid === "string" ? G.__currentSid : "";
			const rawSlug = args && typeof args === "object" && "slug" in args ? args.slug : "";
			let slug = String(rawSlug ?? "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
			if (!slug) slug = "app-" + sid.slice(-6);
			const prev = readTask(sid)?.activeProj;
			if (prev === slug) return textResult(`已在项目目录 ${slug}, 无需切换。`);
			writeTask(sid, { activeProj: slug, deliverBase: `demo-${sid}/${slug}/` });
			console.log(`[project-identity] sid=${sid} select_project prev=${prev || "(none)"} -> activeProj=${slug}`);
			return textResult(`已切换到独立项目目录 ${slug}(即 /ws/${slug} 和 demo-${sid}/${slug}/)。后续 deliver/deploy 均指向此目录。`, { activeProj: slug });
		},
	});

	// 每轮 agent 启动: 注入"项目目录规则" —— 模型自行判断新/旧, 不靠正则猜
	pi.on("before_agent_start", async (event: unknown) => {
		const sid = typeof G.__currentSid === "string" ? G.__currentSid : "";
		if (!sid) return; // 非任务轮不注入
		const ev = event && typeof event === "object" ? event as Record<string, unknown> : {};
		try {
			const prompt = typeof ev.prompt === "string" ? ev.prompt : "";
			// 图片任务让位: project-identity 每轮无条件注入项目目录规则+交付记忆, 会压过 img-lab 的
			// mooncake 图片路线 -> 模型被带去构建 demo 网页(0 次 img_lab 调用, 修好的 source.png 白推)。
			// 检测与 img-lab 同源(ev.images 带图 / prompt 图片关键词 / source.png), 命中则本条不注入,
			// 项目规则留到非图片轮再上; 判定在插件(img-lab)已有, 此处仅让位, 不重复造判定逻辑。
			const hasImg = Array.isArray(ev.images) && (ev.images as unknown[]).some(
				(x) => x !== null && typeof x === "object" && typeof (x as Record<string, unknown>).data === "string",
			);
			const imgT = G.__imgTask;
			const imgFresh = !!imgT && typeof imgT === "object"
				&& typeof (imgT as Record<string, unknown>).at === "number"
				&& Date.now() - Number((imgT as Record<string, unknown>).at) < 10 * 60_000;
			const isImgTask = hasImg || imgFresh || /图片|照片|图像|修改图|draw|image|photo|picture/i.test(prompt) || prompt.includes("source.png");
			if (isImgTask) {
				console.log(`[project-identity] sid=${sid} image task -> yield (skip project rules injection)`);
				return;
			}
			const activeProj = ensureIdentity(prompt, sid);
			// 记忆机制: 上次 deliver 的 summary, 让"修复游戏"默认修最近交付的那个
			const rawLd = G.__lastDeliver;
			const ld = rawLd && typeof rawLd === "object" ? rawLd as Record<string, unknown> : null;
			const ldSummary = ld && typeof ld.summary === "string" ? ld.summary : undefined;
			const ldSid = ld && typeof ld.sid === "string" ? ld.sid : undefined;
			const lastSummary = ldSummary && (!ldSid || ldSid === sid) ? ldSummary : undefined;
			const memory = lastSummary ? `\n【最近交付(记忆)】上次你交付的是: ${lastSummary}。若用户说"修复/改/优化"而未指明对象, 默认修这个最近交付的应用, 不要切换到其他游戏/应用。\n` : "";
			const inject = `\n【重要: 以下项目目录规则只在开发/修改任务时适用。若本条只是寒暄/问候/闲聊(如"你好"、"在吗"、简单问答), 忽略这些规则, 直接用文字回答, 不要调用 deliver/select_project 等任何工具。】\n【项目目录规则】当前项目目录: \`${activeProj}\`(即 /ws/${activeProj} 和 demo-${sid}/${activeProj}/)。\n` +
				`- 修改/修复现有应用: 沿用当前目录 \`${activeProj}\`, 不要调用 select_project。\n` +
				`- 开发全新应用/游戏(独立于现有项目): 先调用 select_project(<英文kebab slug>) 声明新目录, 再开发; 每个新应用独立目录, 不覆盖旧项目。\n` +
				`- deliver(url) 必须指向 .../demo-${sid}/<当前activeProj>/。\n` +
				`其它 /ws 下的历史目录(tank-*/platform-*/等)与本任务无关, 忽略。${memory}\n`;
			// SAFE_MODE=1: PI 直连, 跳过 activeProj 注入到 systemPrompt(不让历史项目带偏PI)
			if (process.env.WAGATE_SAFE_MODE === "1") {
				console.log(`[project-identity][SAFE] skip inject sid=${sid} (no activeProj injection)`);
			} else if (!String(ev.systemPrompt || "").includes("【项目目录规则】")) {
				ev.systemPrompt = String(ev.systemPrompt || "") + inject;
				console.log(`[project-identity] sid=${sid} systemPrompt injected activeProj=${activeProj} lastSummary=${lastSummary ?? "(none)"} (len=${inject.length})`);
			}
		} catch (e) { console.warn(`[project-identity] inject failed: ${String(e).slice(0, 120)}`); }
	});
}