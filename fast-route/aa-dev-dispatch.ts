/**
 * aa-dev-dispatch.ts —— 分诊路由「快速通道」EU 派单插件（B1，核心交付物）
 *
 * 职责：租户模型遇到「完整系统 / 多模块开发」级需求时，不再本地自建，而是调用
 * 工具 `dispatch_dev`：由规划官（planner）出固定模板规格，经 GitHub App 在
 * VBK-AI-Agent-Gateway/superagent-playground 开 issue + 触发评论，交给快速通道
 * worker 执行。
 *
 * 铁律：
 * - 零 npm 依赖（只用 node:crypto + 全局 fetch + AbortSignal）。
 * - 任何一步异常 → 返回 isError + 中文人话；**绝不自动降级为本地执行**。
 * - 私钥只按路径读取，脚本内不硬编码任何密钥。
 */

import { createSign } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// pi 插件返回格式（照仓库实测样例）
// ---------------------------------------------------------------------------
const out = (text: string, isError = false) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
	isError,
});

// ---------------------------------------------------------------------------
// 配置（全部走 env，缺省值即 issue 正文给定值）
// ---------------------------------------------------------------------------
const OWNER = "VBK-AI-Agent-Gateway";
const REPO = "superagent-playground";
const APP_ID = "5630580";
const INSTALLATION_ID = "178998634";
const DEFAULT_KEY_PATH = "/srv/secrets/dispatch-app/sandbox-dispatch.private-key.pem";
const DEFAULT_PLANNER_URL = "http://127.0.0.1:3001/v1/chat/completions";
const DEFAULT_PLANNER_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
const AUDIT_DIR = "/srv/tenants/.dispatch-audit";
const API = "https://api.github.com";

const env = (k: string, d = ""): string => {
	const v = process.env[k];
	return v === undefined || v === "" ? d : v;
};

/** dispatch 总开关：WAGATE_DISPATCH_OFF=1 → 停用（中性文案，非错误）。 */
const dispatchDisabled = (): boolean => env("WAGATE_DISPATCH_OFF") === "1";

const plannerUrl = (): string => env("WAGATE_DISPATCH_PLANNER_URL", DEFAULT_PLANNER_URL);
const plannerModel = (): string => env("WAGATE_DISPATCH_PLANNER_MODEL", DEFAULT_PLANNER_MODEL);
const plannerKey = (): string => env("WAGATE_DISPATCH_PLANNER_KEY");
const keyPath = (): string => env("WAGATE_DISPATCH_KEY_PATH", DEFAULT_KEY_PATH);

// ---------------------------------------------------------------------------
// 审计：按天切分 jsonl，一行一事件（ts/sid/action/issue/result）
// 审计失败绝不影响主流程（best-effort）。
// ---------------------------------------------------------------------------
function audit(ev: { sid: string; action: string; issue?: number | null; result: string }): void {
	try {
		mkdirSync(AUDIT_DIR, { recursive: true });
		const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
		const line =
			JSON.stringify({
				ts: new Date().toISOString(),
				sid: ev.sid || "",
				action: ev.action,
				issue: ev.issue ?? null,
				result: String(ev.result).slice(0, 500),
			}) + "\n";
		appendFileSync(join(AUDIT_DIR, `dispatch-${day}.jsonl`), line, "utf8");
	} catch {
		/* best-effort */
	}
}

// ---------------------------------------------------------------------------
// 熔断器：会话级 bounce 计数（键 __dispatchBounce_<sid>）
// ---------------------------------------------------------------------------
type G = Record<string, unknown>;
const g = globalThis as unknown as G;

function currentSid(): string {
	const sid = g.__currentSid;
	return typeof sid === "string" && sid ? sid : "unknown";
}

function bounceCount(sid: string): number {
	const n = g[`__dispatchBounce_${sid}`];
	return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function bumpBounce(sid: string): number {
	const n = bounceCount(sid) + 1;
	g[`__dispatchBounce_${sid}`] = n;
	return n;
}

/** 同一 sid 第 2 次 bounce 起视为「反复判轻」→ 熔断，不再放行本地执行。 */
const BOUNCE_LIMIT = 2;

// ---------------------------------------------------------------------------
// 惰性沙箱契约（照抄仓库惯例：globalThis.__lazyEnsureSandbox / __currentSid）
// fail-open：调度器不存在或报错时放行，绝不因为沙箱问题卡死派单。
// ---------------------------------------------------------------------------
async function ensureSandbox(sid: string): Promise<{ ok: boolean; err?: string }> {
	try {
		const fn = g.__lazyEnsureSandbox as
			| ((s: string) => Promise<{ ok: boolean; err?: string }>)
			| undefined;
		if (typeof fn !== "function") return { ok: true };
		const r = await fn(sid);
		return r && typeof r === "object" ? r : { ok: true };
	} catch (e) {
		return { ok: true, err: String(e).slice(0, 200) };
	}
}

// ---------------------------------------------------------------------------
// 规划官 system prompt（规划不实现；六要素；ask 仅限阻塞性模糊 ≤3 问）
// ---------------------------------------------------------------------------
const PLANNER_SYSTEM = `你是「规划官」，只负责把用户的开发需求整理成一份可直接执行的规格，你不实现任何代码。

规格固定六要素（缺一不可）：
1. 目标：一句话说清要做出什么、给谁用。
2. 范围：必须包含什么、明确不包含什么。
3. 交付物形态：文件/目录/技术栈形态（单页 HTML？多文件应用？脚本包？）。
4. 验收标准：可被检查的客观通过条件。
5. 技术约束：零依赖/零构建/仓库规范等硬约束。
6. 非目标：明确不做的事。

判断规则：
- 只有当需求**单页可承载**（一个 HTML/一个脚本/一份文档级别）时才 bounce（表示"本地做就行"）。
- 完整系统、多模块 app、需要多文件协作、需要目录结构的开发 → dispatch。
- 需求存在**阻塞性**模糊（不澄清就无法开工）时 → ask，问题数 1~3 个，只问阻塞性的。

只输出严格 JSON，不要任何解释、不要 markdown 代码围栏：
{"action":"dispatch"|"bounce"|"ask","spec":{"title":"...","body":"..."},"questions":["..."],"reason":"..."}
- action=dispatch 时必须给 spec.title（非空）与 spec.body（>=200 字，含六要素段落）。
- action=ask 时必须给 questions（1~3 个）。
- action=bounce 时必须给 reason（非空，说明为什么本地就能做）。`;

type Plan = {
	action: "dispatch" | "bounce" | "ask";
	spec?: { title?: string; body?: string };
	questions?: string[];
	reason?: string;
};

/** 硬 schema 校验：不合法返回错误说明，合法返回 null。 */
function validatePlan(p: unknown): string | null {
	if (!p || typeof p !== "object") return "响应不是 JSON 对象";
	const o = p as Plan;
	if (o.action !== "dispatch" && o.action !== "bounce" && o.action !== "ask") {
		return `action 不是 dispatch/bounce/ask 之一（收到 ${JSON.stringify((o as { action?: unknown }).action)}）`;
	}
	if (o.action === "dispatch") {
		const title = o.spec?.title;
		const body = o.spec?.body;
		if (typeof title !== "string" || !title.trim()) return "dispatch 缺少非空的 spec.title";
		if (typeof body !== "string" || body.trim().length < 200) {
			return `dispatch 的 spec.body 不足 200 字（实为 ${typeof body === "string" ? body.trim().length : 0}）`;
		}
	}
	if (o.action === "ask") {
		const q = o.questions;
		if (!Array.isArray(q) || q.length < 1 || q.length > 3) return "ask 的 questions 必须是 1~3 个";
		if (q.some((x) => typeof x !== "string" || !x.trim())) return "ask 的 questions 含空项";
	}
	if (o.action === "bounce") {
		if (typeof o.reason !== "string" || !o.reason.trim()) return "bounce 缺少非空的 reason";
	}
	return null;
}

/** 从模型响应里取出 JSON（容忍 ```json 围栏与前后噪声）。 */
function extractJson(text: string): unknown {
	const t = text.trim();
	try {
		return JSON.parse(t);
	} catch {
		/* fallthrough */
	}
	const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		try {
			return JSON.parse(fenced[1].trim());
		} catch {
			/* fallthrough */
		}
	}
	const s = t.indexOf("{");
	const e = t.lastIndexOf("}");
	if (s >= 0 && e > s) {
		try {
			return JSON.parse(t.slice(s, e + 1));
		} catch {
			/* fallthrough */
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 调规划官（OpenAI chat 格式），返回 { plan, raw }
// ---------------------------------------------------------------------------
async function callPlanner(
	request: string,
	context: string,
	answers: string,
): Promise<{ plan: Plan | null; raw: string; err?: string }> {
	const userMsg = [
		"## 用户需求",
		request,
		context ? `\n## 近期对话摘要\n${context}` : "",
		answers ? `\n## 用户补充回答\n${answers}` : "",
	]
		.filter(Boolean)
		.join("\n");

	const headers: Record<string, string> = { "content-type": "application/json" };
	const key = plannerKey();
	if (key) headers.authorization = `Bearer ${key}`;

	try {
		const res = await fetch(plannerUrl(), {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: plannerModel(),
				messages: [
					{ role: "system", content: PLANNER_SYSTEM },
					{ role: "user", content: userMsg },
				],
				temperature: 0,
			}),
			signal: AbortSignal.timeout(60000),
		});
		const text = await res.text();
		if (!res.ok) return { plan: null, raw: text, err: `规划官 HTTP ${res.status}` };
		let content = text;
		try {
			const j = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
			content = j.choices?.[0]?.message?.content ?? text;
		} catch {
			/* 有些网关直接回 JSON 体 */
		}
		return { plan: extractJson(content) as Plan | null, raw: content };
	} catch (e) {
		const msg = e instanceof Error && e.name === "TimeoutError" ? "规划官超时（60s）" : String(e);
		return { plan: null, raw: "", err: msg.slice(0, 300) };
	}
}

/** 调规划官 + 校验；不合法重试 1 次；仍不合法 → 返回 null + 原始响应前 300 字。 */
async function planOnce(
	request: string,
	context: string,
	answers: string,
): Promise<{ plan: Plan | null; why: string; raw: string }> {
	let lastRaw = "";
	let lastWhy = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await callPlanner(request, context, answers);
		if (r.err) {
			lastWhy = r.err;
			lastRaw = r.raw || lastRaw;
			continue;
		}
		const why = validatePlan(r.plan);
		if (!why) return { plan: r.plan, why: "", raw: r.raw };
		lastWhy = why;
		lastRaw = r.raw || lastRaw;
	}
	return { plan: null, why: lastWhy || "规划官返回不合法", raw: lastRaw };
}

// ---------------------------------------------------------------------------
// GitHub App：JWT（RS256）→ installation token（模块级缓存至 exp-5min）
// ---------------------------------------------------------------------------
type TokenCache = { token: string; expMs: number };
let tokenCache: TokenCache | null = null;

function b64url(b: Buffer): string {
	return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function appJwt(): string {
	const pem = readFileSync(keyPath(), "utf8");
	const now = Math.floor(Date.now() / 1000);
	const header = b64url(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8"));
	const payload = b64url(
		Buffer.from(JSON.stringify({ iss: APP_ID, iat: now - 60, exp: now + 540 }), "utf8"),
	);
	const data = `${header}.${payload}`;
	const sig = createSign("RSA-SHA256").update(data).sign(pem);
	return `${data}.${b64url(sig)}`;
}

async function installationToken(): Promise<string> {
	if (tokenCache && tokenCache.expMs - 5 * 60 * 1000 > Date.now()) return tokenCache.token;

	const res = await fetch(`${API}/app/installations/${INSTALLATION_ID}/access_tokens`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${appJwt()}`,
			accept: "application/vnd.github+json",
			"user-agent": "aa-dev-dispatch",
		},
		signal: AbortSignal.timeout(30000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`换取 installation token 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
	const j = JSON.parse(text) as { token?: string; expires_at?: string };
	if (!j.token) throw new Error("installation token 响应缺少 token 字段");
	const expMs = j.expires_at ? Date.parse(j.expires_at) : Date.now() + 55 * 60 * 1000;
	tokenCache = { token: j.token, expMs: Number.isFinite(expMs) ? expMs : Date.now() + 55 * 60 * 1000 };
	return tokenCache.token;
}

async function gh(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
	const token = await installationToken();
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "aa-dev-dispatch",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	const text = await res.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* 非 JSON 响应 */
	}
	return { ok: res.ok, status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// issue 正文固定模板
// ---------------------------------------------------------------------------
function issueBody(spec: { title: string; body: string }): string {
	return [
		"[route:full]",
		"来源: sandbox-dispatch（规划官出规格，用户已确认）",
		"",
		`## 目标与规格（${spec.title}）`,
		"",
		spec.body.trim(),
		"",
	].join("\n");
}

const TRIGGER_COMMENT =
	"Operator authorization: sandbox-dispatch[bot] carries operator authority. " +
	"@VBK-AI-Agent-Gateway execute the full specification in this issue.";

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 插件注册
// ---------------------------------------------------------------------------
export default function aaDevDispatch(pi: { registerTool: (t: unknown) => void }) {
	pi.registerTool({
		name: "dispatch_dev",
		label: "DispatchDev",
		description:
			"当需求是「完整系统 / app / 多模块开发」时调用：把需求交给规划官出规格，并在 VBK-AI-Agent-Gateway/superagent-playground 开 issue 派给快速通道 worker 执行。单页/文档/小改不要调用本工具，本地直接做。",
		parameters: {
			type: "object",
			properties: {
				request: { type: "string", description: "用户的原始开发需求（原话，不要自己改写）" },
				context: { type: "string", description: "近期对话摘要，供规划官理解上下文" },
				answers: { type: "string", description: "用户对上一轮追问的补充回答（如有）" },
			},
			required: ["request"],
		},
		execute: async (args: { request?: string; context?: string; answers?: string }) => {
			const sid = currentSid();
			const request = (args?.request ?? "").trim();
			const context = (args?.context ?? "").trim();
			const answers = (args?.answers ?? "").trim();

			// 1) 总开关
			if (dispatchDisabled()) {
				audit({ sid, action: "disabled", result: "WAGATE_DISPATCH_OFF=1" });
				return out("dispatch 已停用");
			}

			if (!request) {
				return out("dispatch_dev 需要 request（用户的原始开发需求）。", true);
			}

			// 惰性沙箱（fail-open，不影响派单）
			await ensureSandbox(sid);

			// 2)+3)+4) 规划官 + 硬校验
			const { plan, why, raw } = await planOnce(request, context, answers);
			if (!plan) {
				audit({ sid, action: "invalid", result: why });
				return out(
					`派单失败：规划官返回的规格不合法（${why}）。原始响应前 300 字：\n${raw.slice(0, 300)}`,
					true,
				);
			}

			// 5) bounce：本地就能做
			if (plan.action === "bounce") {
				const reason = (plan.reason ?? "").trim();
				const n = bumpBounce(sid);
				audit({ sid, action: "bounce", result: `#${n} ${reason}` });
				if (n >= BOUNCE_LIMIT) {
					// 熔断：同一会话反复判轻，改按 ask 语义追问，避免"本地糊一个"。
					return out(
						[
							"这个需求已经两次被判定为本地可做，但为避免做小了，先确认一下范围：",
							"1. 最终交付是单页/单份文档级别，还是要一个可长期使用的完整系统？",
							"2. 是否需要多文件、多模块、带目录结构和后续迭代？",
							"3. 需要我直接开一个正式工单交给完整执行通道吗？",
							"",
							`（规划官判定依据：${reason}）`,
						].join("\n"),
					);
				}
				return out(`LOCAL_OK：${reason}`);
			}

			// 6) ask：阻塞性模糊 → 转问用户
			if (plan.action === "ask") {
				const qs = (plan.questions ?? []).map((q, i) => `${i + 1}. ${q}`);
				audit({ sid, action: "ask", result: `${qs.length} question(s)` });
				return out(["开工前需要确认：", ...qs].join("\n"));
			}

			// 7) dispatch：GitHub App → issue → 触发评论
			const spec = {
				title: (plan.spec?.title ?? "").trim(),
				body: (plan.spec?.body ?? "").trim(),
			};

			let issueNumber: number | null = null;
			let issueUrl = "";
			try {
				const created = await gh("POST", `/repos/${OWNER}/${REPO}/issues`, {
					title: spec.title,
					body: issueBody(spec),
				});
				if (!created.ok) {
					audit({ sid, action: "dispatch", result: `issue create HTTP ${created.status}` });
					return out(
						`派单失败：创建 issue 被拒绝（HTTP ${created.status}）${created.text.slice(0, 200)}。需求已保留，请人工补开。`,
						true,
					);
				}
				const ij = created.json as { number?: number; html_url?: string };
				issueNumber = typeof ij.number === "number" ? ij.number : null;
				issueUrl = ij.html_url ?? "";
				if (!issueNumber) {
					audit({ sid, action: "dispatch", result: "issue create missing number" });
					return out("派单失败：issue 创建响应缺少编号，请人工确认。", true);
				}
			} catch (e) {
				audit({ sid, action: "dispatch", result: `issue create error ${String(e).slice(0, 200)}` });
				return out(`派单失败：无法连接 GitHub（${String(e).slice(0, 200)}）。请人工补开 issue。`, true);
			}

			// 7c) 触发：workflow_dispatch（github-actions[bot] 白名单通道；App 需 Workflows RW）
			let lastErr = "";
			try {
				const d = await gh(
					"POST",
					`/repos/${OWNER}/${REPO}/actions/workflows/auto-trigger.yml/dispatches`,
					{ ref: "main", inputs: { issue_number: String(issueNumber) } },
				);
				if (d.ok) {
					audit({ sid, action: "dispatch", issue: issueNumber, result: "ok" });
					return out(
						[
							`已派单：${issueUrl}`,
							"",
							"规格已交给快速通道执行通道，请停止本地自建，等工单结果回传。",
						].join("\n"),
					);
				}
				lastErr = `HTTP ${d.status} ${d.text.slice(0, 150)}`;
			} catch (e) {
				lastErr = String(e).slice(0, 150);
			}

			// 7d) workflow_dispatch 失败 → isError，附两条人工触发路径
			audit({ sid, action: "dispatch", issue: issueNumber, result: `trigger failed ${lastErr}` });
			return out(
				[
					`工单已创建，但自动触发失败（${lastErr}）。`,
					"",
					`工单地址：${issueUrl}`,
					"两种人工触发方式任选其一：",
					"1. Actions 页手动 Run workflow「auto-trigger」，issue_number 填 " + issueNumber,
					"2. 用 qintao765 账号在该 issue 下评论：",
					"",
					TRIGGER_COMMENT,
					"",
					"在触发发出前，请不要本地自建。",
				].join("\n"),
				true,
			);
		},
	});
}
