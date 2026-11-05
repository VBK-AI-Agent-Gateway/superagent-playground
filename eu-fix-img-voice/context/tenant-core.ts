/**
 * 租户核心：N 个 pi session，每个绑一个 ClawSandbox 沙箱，跨租户并发。
 *
 * 沿用 pi-gateway 的传输层（vendor/pi-gateway-src/adapters/whatsapp.ts），
 * 换掉它的单 agent 核心：这里一个租户一个 session，sid 由 chat 身份派生。
 *
 * 不变的设计优势：
 *   · LLM key 只在宿主 session 侧，沙箱只有 exec 通道
 *   · 沙箱 = 租户边界，destroy 即结算
 *   · fail-closed 白名单 + 群聊静默丢弃
 */
import { mkdir, readdir, readFile, writeFile, chmod, rm, appendFile } from "node:fs/promises";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
function normalizeJid(v: string): string {
	const s = v.trim();
	if (!s) return "";
	if (s.includes("@")) return s;
	const digits = s.replace(/^\+/, "").replace(/\D/g, "");
	return digits ? `${digits}@s.whatsapp.net` : "";
}
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import { httpClient, TENANT_ROOT, type SandboxClient } from "./sandbox.ts";
import { createPersistence, type PersistFs } from "./persist.ts";
import { bindSandbox, isBound, unbindSandbox } from "./router.ts";
import { flushPendingSync, onSandboxCreated } from "./ws-sync-queue.ts";
import { runWithSid } from "./tenant-context.ts";

export interface InMsg {
	platform: string;
	channelId: string; // DM: sender jid / Group: xxx@g.us
	userId: string; // DM: sender jid / Group: participant
	text: string;
	rawText?: string; // 缺省回退 text
	image?: { data: string; mimeType: string }; // 多模态: 图片附件(base64), 传给模型 vision
	videos?: Array<{ data: string }>; // 多模态: 视频附件(base64数组), img-lab 消费
	msgType?: 'text' | 'image' | 'image_text' | 'video_text'; // 统一消息类型
	isGroup: boolean;
}

export interface OutMsg {
	text: string;
	kind: "ack" | "result" | "error";
}

/** 租户唯一允许的工具集：全部经 ClawSandbox 路由，宿主不留任何内置工具。 */
export const SANDBOX_TOOLS = [
	"sbx_bash", "sbx_read", "sbx_write", "sbx_edit", "sbx_grep", "sbx_find", "sbx_ls", "sbx_env", "deliver",
] as const;

/** secrets 存根：宿主侧，不在公网根 /srv/tenants 下。目录700/文件600 */
const SECRETS_ROOT = process.env.SECRETS_ROOT ?? "/srv/secrets";
const SECRET_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface TenantOptions {
	allow: Set<string>; // 空 = 谁都不放行（fail-closed）
	registerCode?: string; // 自助注册码(空 = 关闭注册)
	registeredFile?: string; // 已注册用户持久文件
	client?: SandboxClient;
	persistFs?: PersistFs; // 不给 = 不持久化（空闲即清空）
	extensionPaths?: string[];
	model?: Model<any>; // 必须是已解析的 Model 对象，不能是字符串
	idleMs?: number;
	onProgress?: (sid: string, line: string, chatKey?: string) => void;
}

interface Tenant {
	sid: string;
	sandboxId: string;
	session: AgentSession | null;
	unsub: (() => void) | null;
	chatKey: string;
	lastSeen: number;
	busy: boolean;
	suspended: boolean; // 沙箱已回收，session 还在（记忆保留，等下一条消息拉回沙箱）
	activeProj?: string; // 串台修复: 本任务固定项目名(首轮定死), 后续轮 prompt/deliver 都用它, 模型不再每轮重选
}

// P1(B1) manifest dir enum: FEATURE_MANIFEST_DIR=1 -> scan plugins/<id>/{manifest.json,index.ts}.
// flag default 0 -> not called, extPaths byte-equal to old image (zero impact). parse fail -> skip dir into errors, never drags others.
function enumerateManifestDirs(pluginsDir: string, allow: Set<string> | null, safeMode: boolean): { dirs: string[]; errors: Array<{ path: string; reason: string }> } {
	const dirs: string[] = [];
	const errors: Array<{ path: string; reason: string }> = [];
	try {
		const dirents = readdirSync(pluginsDir, { withFileTypes: true });
		const ids = dirents.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort();
		for (const id of ids) {
			if (safeMode && !allow?.has(id)) continue;
			const manifestPath = pluginsDir + id + "/manifest.json";
			const entryPath = pluginsDir + id + "/index.ts";
			if (!existsSync(manifestPath) || !existsSync(entryPath)) { errors.push({ path: pluginsDir + id, reason: "missing manifest.json or index.ts" }); continue; }
			try {
				const m = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (typeof m?.id !== "string" || m.id !== id || typeof m?.name !== "string" || typeof m?.version !== "string" || !Array.isArray(m?.tools)) { errors.push({ path: manifestPath, reason: "invalid manifest fields or id mismatch" }); continue; }
				dirs.push(entryPath);
			} catch (e) { errors.push({ path: manifestPath, reason: "parse: " + (e as Error).message }); }
		}
	} catch { /* plugins dir missing -> empty */ }
	return { dirs, errors };
}
export function createTenantCore(opts: TenantOptions) {
	const client = opts.client ?? httpClient();
	const idleMs = opts.idleMs ?? 30 * 60_000;
	const tenants = new Map<string, Tenant>();
	const locks = new Map<string, Promise<unknown>>();
	// 扩展路径必须相对**本文件**解析，不能写死绝对路径：
	// 写死的 /srv/pi/clawsandbox-ext/ 在容器里不存在，扩展静默不加载 →
	// createAgentSession 拿到的 tools 白名单全是空名 → 租户一个工具都没有，AI 只能干聊天。
	// 路径必须相对本文件解析(fileURLToPath), 不能硬编码绝对路径:
// 宿主 /srv/wagate/ 但容器 /app/ —— 硬编码 /srv/... 在容器里不存在 -> 扩展静默加载失败(errors 被吞)。
const _baseExt = opts.extensionPaths ?? [fileURLToPath(new URL("./clawsandbox-ext.ts", import.meta.url)), fileURLToPath(new URL("./personal-assistant.ts", import.meta.url)), fileURLToPath(new URL("./extensions/wagate-multimodal.ts", import.meta.url)), fileURLToPath(new URL("./extensions/project-identity.ts", import.meta.url))];
// 插件目录自动发现：extensions/plugins/*.ts 按文件名排序追加（后加载=工具覆盖权）。目录不存在则跳过；加载失败由扩展 errors 收集兜底，绝不拖垮核心。
let extPaths = [..._baseExt];
if (!opts.extensionPaths) {
	try {
		const _pluginsDir = fileURLToPath(new URL("./extensions/plugins/", import.meta.url));
		let _plugins = readdirSync(_pluginsDir).filter((f) => f.endsWith(".ts") && !f.startsWith(".")).sort();
		// SAFE_MODE=1: PI 直连, 只加载白名单插件(4基础+12监工+deliver-pipeline), 其余skip
		if (process.env.WAGATE_SAFE_MODE === "1") {
			const _allow = new Set(["keepalive.ts", "stop-task.ts", "skill-install.ts", "prompt-retry-policy.ts",
				"burst-guard.ts", "deliver-adopt.ts", "doc-pack.ts", "explore-stall.ts", "finalize-guard.ts",
				"img-lab.ts", "img-ops.ts", "project-identity.ts", "repeat-batch.ts", "settle-fallback.ts",
				"stop-cleanup.ts", "upload-ops.ts", "deliver-pipeline.ts"]);
			const _skipped = _plugins.filter(f => !_allow.has(f));
			_plugins = _plugins.filter(f => _allow.has(f));
			if (_skipped.length) console.log(`[safe-mode] skip plugins: ${_skipped.join(",")}`);
		}
		extPaths = [...extPaths, ..._plugins.map((f) => `${_pluginsDir}${f}`)]
		// P1(B1): flag=0(default) -> no enum, extPaths byte-equal to old image; flag=1 -> append manifest dirs (old order unchanged).
		if (process.env.FEATURE_MANIFEST_DIR === "1") {
			const _safe = process.env.WAGATE_SAFE_MODE === "1";
			const _allowM = _safe ? new Set(["keepalive.ts","stop-task.ts","skill-install.ts","prompt-retry-policy.ts","burst-guard.ts","deliver-adopt.ts","doc-pack.ts","explore-stall.ts","finalize-guard.ts","img-lab.ts","img-ops.ts","project-identity.ts","repeat-batch.ts","settle-fallback.ts","stop-cleanup.ts","upload-ops.ts","deliver-pipeline.ts"]) : null;
			const _m = enumerateManifestDirs(_pluginsDir, _allowM, _safe);
			extPaths = [...extPaths, ..._m.dirs];
			if (_m.errors.length) console.warn("[manifest-dir] skip: " + _m.errors.map((e) => e.path + ":" + e.reason).join(", "));
		}
	} catch { /* plugins 目录不存在 -> 无插件 */ }
}
	console.log(`[tenant] extension: ${extPaths.join(", ")}`);
(globalThis as any).__tenantRoot = TENANT_ROOT; // 供 project-identity 扩展写 task.json
// step5: sessionId=sid flag — env 控制(默认 off 零影响), 运行时可 globalThis.__sidAsSessionId=false 热回滚
(globalThis as any).__sidAsSessionId = process.env.PII_SESSION_ID_IS_SID === "1";
// ALS Phase A0: 读点双跑对齐 — on: 读点优先 ALS(sid) fallback 旧单槽(单槽仍写); off(默认)=旧行为
(globalThis as any).__alsSid = process.env.ALS_SID === "1";
console.log(`[ALS-A0] __alsSid=${(globalThis as any).__alsSid} (env ALS_SID=${process.env.ALS_SID})`);
console.log(`[step5] __sidAsSessionId=${(globalThis as any).__sidAsSessionId} (env PII_SESSION_ID_IS_SID=${process.env.PII_SESSION_ID_IS_SID})`);
	const persist = opts.persistFs ? createPersistence(opts.persistFs, client) : null;

	function sidFor(msg: InMsg): string {
		// 白名单外的根本拿不到 sid —— 先判白名单再派生
		const raw = msg.isGroup ? msg.channelId : msg.userId;
		const h = [...raw].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
		return "t" + h.toString(36) + msg.platform.slice(0, 2);
	}

	/**
	 * 保证 session 存在。session = 记忆，它比沙箱活得久：
	 * 空闲回收只销毁沙箱（省算力、结算），session 留着，上下文不丢。
	 */
	async function ensureSession(t: Tenant): Promise<void> {
		if (t.session) return;
		const ws = `${TENANT_ROOT}/${t.sid}/workspace`;
		// 重要：这是一个 **token 目录**，不是沙箱 /ws 的镜像。
		// 它的唯一作用是给 pi 一个真实 cwd（ResourceLoader 需要），
		// 从而让 router 用 cwd 推导出 sid。内容永远在沙箱里，宿主这份不要求同步。
		// 这样就不需要改 ClawSandbox 引擎做 bind mount（设计不变）。
		await mkdir(ws, { recursive: true });
		// 种子记忆文件：首次会话创建模板，让 personal-assistant 注入时有结构可读，
		// 模型看到模板会主动填充（否则空记忆 → 模型不写 → pullMemory 不同步 → 死循环）
		try {
			const profilePath = `${ws}/profile.md`;
			const notesPath = `${ws}/notes.md`;
			if (!existsSync(profilePath)) {
				await writeFile(profilePath, "# 用户偏好\n\n## 代码风格\n- \n\n## 沟通方式\n- \n\n## 技术栈\n- \n");
			}
			if (!existsSync(notesPath)) {
				await writeFile(notesPath, "# 近期事件与待办\n\n## 事件\n- \n\n## 待办\n- \n");
			}
		} catch { /* 种子失败不影响会话 */ }
		const loader = new DefaultResourceLoader({
			cwd: ws,
			agentDir: getAgentDir(), // 共用宿主的凭据/设置：LLM key 不进沙箱
			additionalExtensionPaths: extPaths,
			// 不把 100 个 skill 的 <available_skills> 清单注入 system prompt（每轮省约 37KB）。
			// 技能包库仍在 /root/.pi/agent/skills/，AI 按需用 ls/read 查库（见 personal-assistant 的 skillGuide）。
			noSkills: true,
		});
		await loader.reload();
		// 工具白名单(SANDBOX_TOOLS)只含沙箱内置工具；插件注册的工具(img_ops/img_lab/doc_pack/...)
		// 不在其中会被框架 allowedToolNames 过滤出 _toolRegistry，导致 setActiveTools 无效、模型拿不到工具。
		// 通用修复: 从已加载扩展收集所有插件工具名，并入 tools 白名单。
		const extTools: string[] = [];
		for (const ext of loader.getExtensions()?.extensions ?? []) {
			for (const name of ext.tools.keys()) extTools.push(name);
		}
		const allowedTools = [...new Set([...SANDBOX_TOOLS, ...extTools])];
		// step5: sessionId = sid (flag 热读, 默认 off 零影响) — 让 message_end ctx.sessionManager.getSessionId() 返回 sid 而非 uuid
		// 回滚: 设 globalThis.__sidAsSessionId = false (或删本段) -> 不传 id -> uuid 旧行为
		const _sidOpts = (globalThis as any).__sidAsSessionId === true ? { id: String(t.sid) } : {};
		console.log(`[step5] createAgentSession sid=${t.sid} sessionIdWillBe=${_sidOpts.id || "uuid(default)"}`);
		const created = (await createAgentSession({
			cwd: ws,
			resourceLoader: loader,
			// durable: continueRecent 落盘续跑(而非 inMemory 易失)，进程重启/任务中断后恢复最近上下文。
			sessionManager: SessionManager.continueRecent(ws),
			// 沙箱内置 + 所有插件工具; 宿主其余内置工具仍被白名单排除
			tools: allowedTools,
			...(opts.model ? { model: opts.model } : {}),
			..._sidOpts,
		})) as any;
		const { session } = created;
		// 事件扩展加载断言: tools 断言过了但事件扩展(path 错)仍可能没加载 -> 图片/身份注入静默失效。
		// 所有 extPaths 都必须 loaded, 否则 fail-fast(不带半残扩展跑)。
		const loadedPaths = new Set((created.extensionsResult?.extensions ?? []).map((e: any) => e.path));
		const notLoaded = extPaths.filter((p) => !loadedPaths.has(p));
		if (notLoaded.length) {
			throw new Error(`extension failed to load: ${notLoaded.join(", ")} (errors=${JSON.stringify((created.extensionsResult?.errors ?? []).map((e: any) => `${e.path}: ${String(e.error).slice(0, 120)}`))})`);
		}
		// fail-closed：扩展静默失败过一次（路径写错 → 0 工具 → AI 只能聊天）。
		// 这里显式断言 7 个工具都注册上了，缺一个就报错，不让租户带着空工具列表跑起来。
		const registered = (created.extensionsResult?.extensions ?? []).flatMap((e: any) => [...(e.tools?.keys?.() ?? [])]);
		const missing = SANDBOX_TOOLS.filter((n) => !registered.includes(n));
		if (missing.length) {
			throw new Error(
				`extension tools not registered: ${missing.join(",")} ` +
					`(ext=${extPaths.join(",")}; errors=${JSON.stringify(created.extensionsResult?.errors ?? [])})`,
			);
		}
		t.session = session;
		// 惰性沙箱：session 建好后立刻注册钩子，工具首次 execute 时才会真正建沙箱
		registerLazyEnsure(t);
	}

	/**
	 * 惰性沙箱钩子：聊天 fastpath 不建沙箱，只有模型真正发起第一个工具调用时
	 * （clawsandbox-ext 每个 sbx_* / deliver execute 第一步 await 它）才建沙箱。
	 * 与现有 __readTask/__currentSid 同机制：globalThis 注入闭包，扩展侧只认 sid。
	 * 已绑定则直接返回（ensureSandbox 内部有 isBound+sandboxAlive 探活，重复调用安全）。
	 */
	function registerLazyEnsure(t: Tenant): void {
		// 单飞锁：per-sid 共享同一个 in-flight Promise，并发工具调用绝不双建沙箱（404 事件实测双建过）
		let _inflight: Promise<{ ok: boolean; err?: string }> | null = null;
		// per-sid 注册表：此前单全局槽会被后注册租户覆盖 -> 先注册租户的工具钩子 miss -> 'no active sandbox' 烧步数
		(globalThis as any).__lazyEnsureRegistry = (globalThis as any).__lazyEnsureRegistry || {};
		(globalThis as any).__lazyEnsureRegistry[t.sid] = async (sid: string): Promise<{ ok: boolean; err?: string }> => {
			// _lazyAliveProbe: 早退前探活 — 沙箱被引擎回收但 t.sandboxId/isBound 残留时, 死沙箱不重建致 deliver 卡死
			if (t.sandboxId && isBound(t.sid) && await sandboxAlive(t.sandboxId)) return { ok: true };
			if (_inflight) return _inflight; // 并发调用复用同一 in-flight
			_inflight = (async (): Promise<{ ok: boolean; err?: string }> => {
				try {
					await ensureSandbox(t);
					return { ok: true };
				} catch (e) {
					console.error(`[tenant] sid=${sid} lazy ensureSandbox failed: ${String(e).slice(0, 200)}`);
					return { ok: false, err: String(e).slice(0, 200) };
				} finally {
					_inflight = null;
				}
			})();
			return _inflight;
		};
		// 调度器只装一次：按 sid 查注册表分发；未注册租户放行(router 端有 bound 校验兜底)
		if (!(globalThis as any).__lazyEnsureSandbox) {
			(globalThis as any).__lazyEnsureSandbox = async (sid: string): Promise<{ ok: boolean; err?: string }> => {
				const fn = (globalThis as any).__lazyEnsureRegistry?.[sid];
				if (!fn) return { ok: true };
				return await fn(sid);
			};
		}
	}

	/** 推送宿主 secrets -> 沙箱 /ws/.secrets/（单次 exec Python 写+chmod600；值经 b64 进 code，引擎 audit 只记 code_sha256 不落正文） */
	async function pushSecrets(sid: string, sandboxId: string): Promise<number> {
		// 读两个来源：_shared/（系统共享兜底，如默认 GitHub PAT）+ <sid>/（用户私有，同名覆盖共享）
		const b64: Record<string, string> = {};
		for (const dir of [`${SECRETS_ROOT}/_shared`, `${SECRETS_ROOT}/${sid}`]) {
			let names: string[];
			try { names = await readdir(dir); } catch { continue; }
			for (const n of names) {
				if (!SECRET_NAME_RE.test(n)) continue;
				try { b64[n] = Buffer.from(await readFile(`${dir}/${n}`, "utf8"), "utf8").toString("base64"); } catch {}
			}
		}
		const cnt = Object.keys(b64).length; if (!cnt) return 0;
		const payload = Buffer.from(JSON.stringify(b64), "utf8").toString("base64");
		const code = "import base64,os,json\n" +
			"m=json.loads(base64.b64decode('" + payload + "').decode())\n" +
			"d='/ws/.secrets'\nos.makedirs(d,exist_ok=True)\n" +
			"for k,v in m.items():\n    p=os.path.join(d,k)\n    open(p,'w').write(base64.b64decode(v).decode())\n    os.chmod(p,0o600)\n" +
			"os.chmod(d,0o700)\nprint('secrets',len(m))\n";
		const r = await client.exec(sandboxId, code, 30);
		if (r.exit_code !== 0) console.error(`[tenant] sid=${sid} pushSecrets failed: ${r.stderr.slice(0,200)}`);
		else console.log(`[tenant] sid=${sid} pushed ${cnt} secret(s) -> /ws/.secrets`);
		return cnt;
	}

	/** 拉取沙箱 /ws 里的记忆/任务文件 -> 宿主 workspace/（给 pi 扩展读）。
	 *  只同步 profile.md / notes.md / schedule.json 三个文件；单次 exec 读出成 base64 JSON，
	 *  宿主解码写到 workspace/。失败静默降级，不报错。 */
	/** 兜底：扫 /ws 下所有 .git/config，把 remote URL 里的凭据(ghp_/x-access-token:<pat>@)剥回裸 https，防止 PAT 泄漏进 git 配置。 */
	async function sanitizeRemotes(sandboxId: string): Promise<number> {
		const code = [
			"import os,re,glob",
			"n=0",
			"for c in glob.glob('/ws/**/.git/config',recursive=True):",
			"    try:",
			"        s=open(c).read()",
			"        t=re.sub(r'(https?://)[^/@\\s]*@',r'\\1',s)",
			"        if t!=s:",
			"            open(c,'w').write(t); n+=1",
			"            print('SANITIZED',c)",
			"    except Exception as e: pass",
			"print('sanitize_count',n)",
		].join("\n");
		try {
			const r = await client.exec(sandboxId, code, 20);
			const m = /sanitize_count\s+(\d+)/.exec(r.stdout || "");
			const n = m ? parseInt(m[1], 10) : 0;
			if (n > 0) console.warn(`[tenant] sanitizeRemotes removed PAT from ${n} .git/config`);
			return n;
		} catch { return 0; }
	}

	/** 每租户独立仓库部署：run 结束后自动把 /ws/<项目>/ 部署进 demo-<sid>/<项目>/（只增子目录，不删别人、不自建仓库）。
	 *  彻底解决：模型 git add -A 覆盖旧项目、模型自建新仓库两个问题（部署不归模型管）。 */
	async function autoDeploy(sandboxId: string, sid: string, since: number = 0, forceProj?: string): Promise<{n:number; url:string}> {
			if (String(process.env.WAGATE_LOCAL_ONLY ?? "0") === "1") { console.log("[deploy] local-only: autoDeploy DISABLED (github blocked)"); return { n: 0, url: "" }; }
		const repo = `demo-${sid}`; // 每租户独立仓库(物理隔离)
		// python: 找含 index.html 的项目目录 -> clone 最新 demo-test -> 复制子目录 -> 只 add 子目录 commit push
		const py = [
			"import os,subprocess,glob,shutil,sys,time",
			"ws='/ws'",
			"SINCE=" + String(since),
			"pat=open('/ws/.secrets/github_pat').read().strip() if os.path.isfile('/ws/.secrets/github_pat') else ''",
			"if not pat: print('DEPLOY_SKIP nopat'); sys.exit(0)",
			"user='VBK-AI-Agent-Gateway'; repo='" + repo + "'",
			"# 首次repo不存在则API建仓一次(422=已存在,忽略)",
			"import urllib.request,urllib.error,json as _j",
			"_rq=urllib.request.Request('https://api.github.com/user/repos',data=_j.dumps({'name':repo,'private':False,'auto_init':True}).encode(),method='POST',headers={'Authorization':'Bearer '+pat,'Accept':'application/vnd.github+json','User-Agent':'wagate'})",
			"try:",
			"    urllib.request.urlopen(_rq,timeout=20); print('REPO_CREATED',repo)",
			"except urllib.error.HTTPError as _e:",
			"    if _e.code!=422: print('REPO_CREATE_ERR',_e.code)",
			"except Exception as _e2: print('REPO_CREATE_ERR',str(_e2)[:80])",
			"FORCE='" + (forceProj || "") + "'",
			"# FORCE(deliver 精确推): 忽略 SINCE 时间窗, 直接推 deliver 指向的项目 — 修 DEPLOY_NONE(模型改 demo-<sid>/<proj>/ 子文件不 touch 顶层 <proj> 目录 mtime)",
			"# FORCE(deliver 精确推): 忽略 SINCE, 推 deliver 指向的项目。项目可能在 /ws/<proj>/ 或 /ws/demo-<sid>/<proj>/(模型 sparse 进 demo- 仓库改)",
			"def _ok(d): return os.path.isdir(d) and os.path.isfile(d+'/index.html')",
			"proj=[FORCE] if (FORCE and (_ok(ws+'/'+FORCE) or _ok(ws+'/'+repo+'/'+FORCE))) else [os.path.basename(d) for d in glob.glob(ws+'/*') if os.path.isdir(d) and not os.path.basename(d).startswith('.') and os.path.basename(d) not in ('node_modules','demo-test') and not os.path.basename(d).startswith('demo-') and os.path.isfile(d+'/index.html') and (SINCE<=0 or os.path.getmtime(d)*1000>SINCE)]",
			"if not proj: print('DEPLOY_NONE'); sys.exit(0)",
			"n=0",
			"for p in proj:",
			"    dt='/tmp/_dt_'+p",
			"    shutil.rmtree(dt,ignore_errors=True)",
			"    url='https://x-access-token:'+pat+'@github.com/'+user+'/'+repo+'.git'",
			"    r=subprocess.run(['git','clone','-q','--filter=blob:none','--no-checkout',url,dt],capture_output=True,text=True,timeout=60)",
			"    if r.returncode!=0: print('DEPLOY_CLONE_FAIL',p,r.stderr[:100]); continue",
			"    # C: sparse-checkout 只拉自己子目录 p（不 checkout 别人的）",
			"    subprocess.run(['git','-C',dt,'sparse-checkout','set','--cone',p],capture_output=True,text=True,timeout=30)",
			"    subprocess.run(['git','-C',dt,'checkout','-q','main'],capture_output=True,text=True,timeout=30)",
			"    dst=os.path.join(dt,p)",
			"    if os.path.isdir(dst): shutil.rmtree(dst)",
			"    _src=ws+'/'+p if _ok(ws+'/'+p) else ws+'/'+repo+'/'+p  # 项目可能在 demo-<sid>/<proj>/ 里",
			"    shutil.copytree(_src,dst)",
			"    env=dict(os.environ); env['GIT_TERMINAL_PROMPT']='0'",
			"    def scrub(root):",
			"        # 防线1: 删空文件/空目录；防线2: 删嵌套项目子目录(含 index.html 的次级目录)",
			"        for dp,dn,fn in os.walk(root,topdown=False):",
			"            for f in fn:",
			"                fp=os.path.join(dp,f)",
			"                if os.path.getsize(fp)==0: os.remove(fp)",
			"            for d in dn:",
			"                dd=os.path.join(dp,d)",
			"                if not os.listdir(dd): os.rmdir(dd)",
			"            # dp 相对 root 的深度>0 且含 index.html -> 嵌套项目，整个删",
			"            if dp!=root and os.path.isfile(os.path.join(dp,'index.html')):",
			"                shutil.rmtree(dp,ignore_errors=True)",
			"    def run(c): return subprocess.run(c,capture_output=True,text=True,env=env,timeout=(12 if c[:1]==[\'git\'] and \'push\' in c else 60))",
			"    run(['git','-C',dt,'config','user.name','wagate'])",
			"    run(['git','-C',dt,'config','user.email','wagate@local'])",
			"    ok=False",
			"    for attempt in range(4):",
			"        # 只 add/commit 我自己的子目录 p（不碰别人目录，rebase 后别人提交保留）",
			"        ra=run(['git','-C',dt,'add',p])",
			"        run(['git','-C',dt,'commit','-q','-m','deploy: '+p])  # 无新改动时非0，忽略",
			"        pr=run(['git','-C',dt,'push','-q','origin','main'])",
			"        if pr.returncode==0: ok=True; break",
			"        # 并发冲突(non-fast-forward / 锁) -> 同步远端再重试",
			"        print('DEPLOY_PUSH_RETRY',p,attempt,(pr.stderr or '')[:80])",
			"        run(['git','-C',dt,'fetch','-q','origin','main'])",
			"        run(['git','-C',dt,'reset','-q','--hard','origin/main'])",
			"        run(['git','-C',dt,'checkout','-q','main'])",
			"        run(['git','-C',dt,'merge','-q','--ff-only','origin/main'])",
			"        # 重新确保我的子目录内容在（reset 后工作树=远端，重拷我的产物）",
			"        if os.path.isdir(dst): shutil.rmtree(dst)",
			"        shutil.copytree(os.path.join(ws,p),dst)","        scrub(dst)",
			"        time.sleep(1+attempt)",
			"    if ok: n+=1; print('DEPLOY_OK',p); print('DEPLOY_URL',p)",
			"    else:",
			"        # git push 协议层阻塞(读/API写全通唯独push挂EXIT=124)-> 降级 Contents API 逐文件推",
			"        def api_push(root,sub):",
			"            import base64",
			"            okc=0; failc=0",
			"            for dp,dn,fn in os.walk(root):",
			"                for f in fn:",
			"                    fp=os.path.join(dp,f)",
			"                    if os.path.getsize(fp)==0: continue",
			"                    rel=os.path.relpath(fp,root).replace(os.sep,'/')",
			"                    subpath=(sub+'/'+rel) if sub else rel",
			"                    b=base64.b64encode(open(fp,'rb').read()).decode()",
			"                    body=_j.dumps({'message':'deploy(api): '+rel,'content':b,'branch':'main'})",
			"                    rq=urllib.request.Request('https://api.github.com/repos/'+user+'/'+repo+'/contents/'+subpath,data=body.encode(),headers={'Authorization':'token '+pat,'Accept':'application/vnd.github+json'},method='PUT')",
			"                    try:",
			"                        urllib.request.urlopen(rq,timeout=20); okc+=1",
			"                    except urllib.error.HTTPError as e:",
			"                        if e.code==422: okc+=1  # 同内容已存在",
			"                        else: failc+=1; print('API_PUSH_ERR',rel,e.code)",
			"                    except Exception as e2: failc+=1; print('API_PUSH_ERR',rel,str(e2)[:60])",
			"            return okc,failc",
			"        fc,ff=api_push(ws+'/'+p if os.path.isdir(ws+'/'+p) else ws+'/'+repo+'/'+p, p)",
			"        if ff==0 and fc>0: ok=True; n+=1; print('DEPLOY_OK_API',p); print('DEPLOY_URL',p)",
			"        else: print('DEPLOY_CMD_FAIL',p,'push_failed_after_retries api_ok=%d api_fail=%d'%(fc,ff))",
			"    shutil.rmtree(dt,ignore_errors=True)",
			"print('deploy_count',n)",
		].join("\n");
		try {
			const r = await client.exec(sandboxId, py, 90);
			const srcOut = r.stdout || "";
			(r.stdout || "").split("\n").filter((l) => l.startsWith("DEPLOY_") || l.startsWith("deploy_count")).forEach((l) => console.log(`[deploy] sid=${sid} ${l}`));
			const m = /deploy_count\s+(\d+)/.exec(r.stdout || "");
			const n = m ? parseInt(m[1], 10) : 0;
			const um = /DEPLOY_URL\s+(\S+)/.exec(srcOut);
			const url = n>0 && um ? `https://vbk-ai-agent-gateway.github.io/${repo}/${um[1]}/` : "";
			return { n, url };
		} catch (e) { console.error(`[deploy] sid=${sid} autoDeploy failed: ${String(e).slice(0, 200)}`); return {n:0, url:""}; }
	}
	(globalThis as any).__autoDeploy = autoDeploy; // 暴露: clawsandbox-ext deliver pages-check 404 时兜底推(模型没 push 致 repo 空)

	async function pullMemory(t: Tenant): Promise<void> {
		if (!t.sandboxId) return;
		const files = ["profile.md", "notes.md", "schedule.json"];
		const py = (
			"import base64,json,os\n" +
			"out={}\n" +
			"for f in " + JSON.stringify(files) + ":\n" +
			"    p=os.path.join('/ws',f)\n" +
			"    try:\n" +
			"        if os.path.isfile(p):\n" +
			"            b=open(p,'rb').read()\n" +
			"            if len(b)<=65536: out[f]=base64.b64encode(b).decode()\n" +
			"    except Exception:\n" +
			"        pass\n" +
			"print('MEMB64'+json.dumps(out))\n"
		);
		let r;
		try { r = await client.exec(t.sandboxId, py, 20); } catch { return; }
		if (r.exit_code !== 0) return;
		const line = (r.stdout || "").split("\n").find((l) => l.startsWith("MEMB64"));
		if (!line) return;
		let obj: Record<string, string>;
		try { obj = JSON.parse(line.slice(6)); } catch { return; }
		const ws = `${TENANT_ROOT}/${t.sid}/workspace`;
		try { await mkdir(ws, { recursive: true }); } catch { return; }
		let n = 0;
		for (const name of files) {
			const b64 = obj[name];
			if (!b64) continue;
			try { await writeFile(`${ws}/${name}`, Buffer.from(b64, "base64")); n++; } catch {}
		}
		if (n > 0) console.log(`[tenant] sid=${t.sid} pulled ${n} memory file(s) -> workspace/`);
	}

	/** 沙箱存活探活：引擎侧可能已删沙箱(sandbox_deleted/410)，但进程内 BOUND map 未同步 -> 探活失败即判定死沙箱。 */
	async function sandboxAlive(sandboxId: string): Promise<boolean> {
		try {
			const r = await client.exec(sandboxId, "print(1)", 8);
			// 引擎侧删除通常表现为 exit_code != 0 且 stderr 含 engine 4xx / sandbox_deleted
			if (r.exit_code === 0) return true;
			const err = (r.stderr || "");
			return !(/engine\s*(40[0-9]|410)|sandbox_deleted|not found|404|410/i.test(err));
		} catch { return false; }
	}

	/** 保证这台租户当前有一台活着的沙箱（没有就新建 + 灌回快照）。 */
	async function ensureSandbox(t: Tenant): Promise<void> {
		if (t.sandboxId && isBound(t.sid)) {
			// 已绑定但可能已被引擎回收 -> 探活，死了就解绑走重建，避免往死沙箱发工具
			if (await sandboxAlive(t.sandboxId)) return;
			console.warn(`[tenant] sid=${t.sid} sandbox ${t.sandboxId} dead (engine reclaimed), rebuilding`);
			unbindSandbox(t.sid);
			t.sandboxId = "";
		}
		await ensureSession(t);
		t.sandboxId = await client.create("pass");
		bindSandbox(t.sid, t.sandboxId); // 工具路由靠这个找到本租户的沙箱
		// freshtest4(20261103): 本轮已用沙箱标志 —— settle 豁免判定用（skill_ls/skill_read 等宿主工具不算全链路）
		(globalThis as any).__turnSbxUsed = (globalThis as any).__turnSbxUsed || {};
		(globalThis as any).__turnSbxUsed[t.sid] = true;
		// 任务②(2026-11-03, 方案A): 新沙箱创建/重建 -> uploads 全量重标记, 随后下方 flushPendingSync 全部冲入新沙箱
		// 修 registry 按文件记 done 致新沙箱拿不到已同步过的 uploads(HANDOFF-ORCH-STATE 任务书②; fail-open)
		try { onSandboxCreated(t.sid, t.sandboxId); } catch (e) { console.warn(`[tenant] sid=${t.sid} onSandboxCreated fail-open: ${String(e).slice(0,120)}`); }
		// 进化系统: 沙箱就绪后执行延迟的 /ws/ 同步
		try {
			await flushPendingSync(t.sid);
		} catch (e) {
			console.error(`[tenant] sid=${t.sid} ws-sync flush failed: ${String(e).slice(0, 200)}`);
		}
		// 上一台沙箱的快照灌回来（代码 + node_modules；全局安装不在 /ws，恢复不了）
		if (persist) {
			const t0 = Date.now();
			try {
				const { restored, chunks } = await persist.restore(t.sid, t.sandboxId);
				if (restored) {
					console.log(
						`[tenant] sid=${t.sid} restored snapshot: ${chunks} chunk(s), ${Date.now() - t0}ms`,
					);
				}
			} catch (e) {
				console.error(`[tenant] sid=${t.sid} restore failed: ${String(e).slice(0, 200)}`);
			}
		}
		// 快照 --exclude=.secrets -> 重建必须从宿主重推
		try { await pushSecrets(t.sid, t.sandboxId); }
		catch (e) { console.error(`[tenant] sid=${t.sid} pushSecrets failed: ${String(e).slice(0,200)}`); }
		t.suspended = false;
		console.log(`[tenant] sid=${t.sid} sandbox=${t.sandboxId} pid=${process.pid}`);
	}

	async function ensure(t: Tenant): Promise<void> {
		await ensureSession(t);
		await ensureSandbox(t);
	}

	/**
	 * 空闲回收：**只销毁沙箱**（结算 + 省算力），session 留着 → 记忆不丢。
	 * 下一条消息时 ensureSandbox() 会新建沙箱并把快照灌回来。
	 */
	async function suspend(t: Tenant): Promise<void> {
		if (!t.sandboxId) return;
		// 先快照再销毁 —— DELETE 会 rmtree 宿主的 ws/<sid>，不快照就是永久丢失
		let snapOk = true; // 默认当成功（没配 persist 时不算失败）
		if (persist) {
			const t0 = Date.now();
			// 探活：引擎可能已先回收沙箱（宿主 ws 目录没了），此时 tar 必失败。
			// ensureSandbox 有探活，这里补上 —— 不然 0ms/静默 FAILED 后旧快照被误当"已保存"。
			try {
				// B5修复: 不再用 sandboxAlive 探活决定是否 save —— 探活失败与"ws 目录暂不可见"无法区分,
				// 直接跳过会让仍在的 ws 改动永久 LOST。persist.save 内部已对 ws missing 重试3次并对"真死透"
				// 返回 false、对"仍存在"完成 tar。把判断交给它, 探活不再决定存不存。
				const okSnap = await persist.save(t.sid, t.sandboxId);
				snapOk = okSnap;
				if (okSnap) {
					console.log(`[tenant] sid=${t.sid} snapshot saved in ${Date.now() - t0}ms`);
				} else {
					// 明确区分：沙箱死透(没救) vs 存储失败 —— 但都意味着"本轮改动没进快照"。
					console.warn(`[tenant] sid=${t.sid} snapshot NOT saved (ws dir gone - engine may have reclaimed first; changes may be LOST, keeping last good)`);
				}
			} catch (e) {
				snapOk = false;
				console.error(`[tenant] sid=${t.sid} snapshot exception: ${String(e).slice(0, 160)}`);
			}
		}
		await client.destroy(t.sandboxId); // 结算
		unbindSandbox(t.sid);
		t.sandboxId = "";
		t.suspended = true;
		// 诚实标记：沙箱被回收了，但快照没存上 —— 下次 restore 会拿到旧状态，提前留痕。
		console.log(`[tenant] sid=${t.sid} sandbox reclaimed (settlement done), session kept for memory${snapOk ? "" : " ⚠ snapshot missing — next restore uses STALE state"}`);
	}

	/**
	 * 方案A: 交付成功即快照 —— 不等 reapIdle 的临门一脚。
	 * 背景: /claw-ws 是 :ro 挂载, 引擎(claw-exp)与 wagate 的 reapIdle 是两套独立回收,
	 * suspend 时常目录已被引擎先删 -> save 抛错(catch静默/0ms) -> 新交付的代码进不了快照,
	 * 下次 restore 拿旧快照 -> 改已交付项目(war3/phys)找不到文件。
	 * 故交付成功时趁沙箱还活着先落盘。非阻塞、绝不影响交付流程(失败只记日志)。
	 */
	function snapshotNow(t: Tenant, tag: string): void {
		if (!persist || !t.sandboxId) return;
		void persist.save(t.sid, t.sandboxId).then((ok) => {
			console.log(`[tenant] sid=${t.sid} snapshot@${tag} ${ok ? "saved" : "FAILED(kept last good)"}`);
		}).catch((e) => {
			console.warn(`[tenant] sid=${t.sid} snapshot@${tag} error: ${String(e).slice(0, 140)}`);
		});
	}

	/** /new：真的要清空 —— 快照不要，session 也扔。 */
	async function drop(t: Tenant, { snapshot = false } = {}): Promise<void> {
		t.unsub?.();
		t.unsub = null;
		try {
			await t.session?.abort();
		} catch {}
		t.session = null;
		if (snapshot && persist && t.sandboxId) {
			try {
				await persist.save(t.sid, t.sandboxId);
			} catch (e) {
				console.error(`[tenant] sid=${t.sid} snapshot failed: ${String(e).slice(0, 160)}`);
			}
		}
		if (t.sandboxId) await client.destroy(t.sandboxId); // 结算
		unbindSandbox(t.sid);
		tenants.delete(t.sid);
	}

	/** 等这一轮彻底结束（compaction / auto_retry 之后再放行）。 */
	function runOnce(t: Tenant, text: string, image?: { data: string; mimeType: string }, videos?: Array<{ data: string }>): Promise<string> { // image: 多模态图片附件; videos: 多模态视频附件
		return new Promise<string>((resolve, reject) => {
			let out = "";
			let last = Date.now();
			let retryLeft = 10; // 最多 10 次有效续跑（<=0 即收尾），给复杂任务留空间
			const HALLU_STEER_TEXT = "你上一条回复只输出了文字, 没有调用任何工具, 这是无效交付。必须立即: 1)调用 sbx_write 把真实产物写入沙箱; 2)调用 deliver 交付。禁止再用纯文本声称成功、禁止编造URL。若无法完成, 明确说明失败原因。";
			let halluRetryLeft = 2; // _halluResume: 幻觉URL拦截后续跑上限(独立retryLeft, 防死锁)
			let retryUsed = 0; // 已发起续跑次数（判模型秒退用）
			let failed = false; // 已终止标志(残留的 settle q interval 不得再入)
			let lastSettleAt = 0; // settle 节流(500ms q 并发去重)
			let lastSettleSteps = -1; // 上次 settle 时的 stepCount（判是否在干活）
		(globalThis as any).__turnSbxUsed = (globalThis as any).__turnSbxUsed || {};
		(globalThis as any).__turnSbxUsed[t.sid] = false; // freshtest4: 每 run 重置
			let inflight: Promise<void> | null = null; // 续跑 prompt 是否在飞
let resumeFails = 0; // 续跑连续失败计数(指数退避用)
let truncFlag = false; // A: 最近一轮是否发生截断爆发(上千 toolCall 撞 token 上限全部作废)
			let truncBurst = 0; // D: 连续截断爆发计数(agent 内循环检测)
let truncInThisMsg = false; // D-fix: 本条消息已计过截断(防 60 个 toolResult 秒烧配额)
			let steerTotal = 0; // D: steer 纠正总次数(上限 10)
			const isDelivered = (s: string) => {
				// 收紧(404 修复)：域必须= 本系统 Pages 域 且路径含 demo-<sid>/，假域(仓库名当子域)不算交付
				const _host = "vbk-ai-agent-gateway\\.github\\.io";
				const _base = `demo-${String(t.sid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
				const link = new RegExp(`https?:\\/\\/${_host}\\/[^\\s)]*${_base}\\/`, "i").test(s);
				const negated = /(无法访问|给不了.{0,6}链接|暂时给不了|打不开|链接.{0,4}(打不开|无法访问|404)|没有给出.{0,6}链接|没做出.{0,6}链接)/.test(s);
				return link && !negated;
			};
			(globalThis as any).__currentSid = t.sid; // P0: 标记当前租户, deliver 写入时带 sid 隔离
// Step1: 任务隔离上下文接入(flag __useTaskCtx 默认 off 零影响)
if ((globalThis as any).__useTaskCtx) (globalThis as any).__taskCtxBegin?.(t.sid);
			// deliver 工具提交的链接(结构化参数, 比正则稳) — since = 任务开始时间防串扰
			const hasDeliver = (since: number) => {
				const d: any = (globalThis as any).__lastDeliver;
				// P0: sid 隔离 — 只认本租户的 deliver, 防止并发 run 时别人的 deliver 串进来
				return !!(d && d.url && d.at >= since && (!d.sid || d.sid === t.sid));
			};
			// SDD(spec-kit): 从 ## TASKS 段解析任务列表
			const parseTasks = (s: string): {id: string; desc: string; accept: string}[] => {
				// D10: 容错 —— 非 string 或正则异常都返回空数组, 不让 SDD 解析崩掉 settle
				if (typeof s !== "string" || !s) return [];
				try {
					const mm = s.match(/## TASKS([\s\S]*?)(\n## |$)/);
					if (!mm) return [];
					const r: {id: string; desc: string; accept: string}[] = [];
					for (const line of mm[1].split("\n")) {
						const tm = line.match(/- \[[ xX]\] (T\d+):\s*(.+?)(?:\s*\|\s*验收:\s*(.+))?$/);
						if (tm) r.push({ id: tm[1], desc: tm[2].trim(), accept: (tm[3] || "").trim() });
					}
					return r;
				} catch { console.warn("[sdd] parseTasks failed -> empty"); return []; }
			};
			// SDD: 已完成任务集合(DONE T# 标记)
			const doneTasks = (s: string): Set<string> => { if (typeof s !== "string" || !s) return new Set(); try { return new Set(Array.from(s.matchAll(/\bDONE (T\d+)/g)).map((x: any) => x[1])); } catch { return new Set(); } };;
			const runStart = Date.now();
			let escL1 = false; // L1 软提醒已发标志
			let escIntv: any = null; // 强制交付计时器
			// C4: 验证链接真实可访问(HEAD 取 status)，8s 超时
			let progressTimer = setTimeout(() => {
				opts.onProgress?.(t.sid, "⏳ 仍在开发中，任务较重，请再等一会儿…", t.chatKey);
			}, 300_000);
			// === Bug2 修复: 独立看门狗 —— settle 的静默检测依赖 agent_end, 模型生成超长消息挂起/永不 agent_end 时
			// settle 永不触发, MAX_ITER/续跑/autoDeliver 全部够不着, 只有 1800s 硬超时能救。
			// 这里用纯墙钟: 每 30s 检查 stepCount 与 out.length 是否 300s 都没增长, 是则强制触发 settle()。
			// 不依赖 agent_end, 不破坏 settle 既有 2000ms 并发去重(settle 内部自会节流)。
			let wdLastSteps = -1;
			let wdLastOutLen = -1;
			let wdLastChangeAt = Date.now();
			let wdLastImgLab = -1; // 图片任务: 上次 __imgLabCalled 值(判 img_lab 是否有新产出)
			let wdLastImgLabAt = Date.now(); // 图片任务: 上次 imgLabDone 变化时间(90s 无产出强触 settle)
			const watchdog = setInterval(() => {
				if (failed) return;
				// Bug4 修复: MAX_ITER 原只在 settle() 里查, 但模型疯狂连续执行时
				// stepCount 一直涨 -> watchdog 不算停滞/无 agent_end/无静默 -> settle 不跑 -> MAX_ITER 永不触发。
				// 这里每 30s 无条件检查一次 stepCount, 补上"连续执行但步数失控"的场景。
				if (stepCount > 250) {
					console.log(`[run-log] WATCHDOG MAX_ITER steps=${stepCount} -> auto-deliver`);
					void autoDeliver("max_iter"); return;
				}
				// 图片任务: 进展只认 img_lab 真实产出(__imgLabCalled)。读类工具(sbx_read/sbx_ls)持续涨 stepCount
				// 会让下面"步数有变化"分支每 30s 都 return -> 永不进 300s 判定 -> settle 不触 -> 第4层
				// stillWorking=false 够不着, 模型无限 sbx_read 空转。这里改用 imgLabDone 判进展, 90s 无产出强触 settle。
				const _itW = (globalThis as Record<string, unknown>).__imgTask as { at?: number } | undefined;
				if (_itW && typeof _itW.at === "number" && Date.now() - _itW.at < 600_000) {
					const _doneW = (globalThis as Record<string, unknown>).__imgLabCalled;
					const _kW = typeof _doneW === "number" ? _doneW : -1;
					if (_kW !== wdLastImgLab) { wdLastImgLab = _kW; wdLastImgLabAt = Date.now(); return; }
					if (Date.now() - wdLastImgLabAt >= 90_000) {
						console.log(`[run-log] WATCHDOG imgTask no img_lab output 90s (steps=${stepCount}) -> force settle`);
						wdLastImgLabAt = Date.now(); last = Date.now(); settle();
					}
					return;
				}
				if (stepCount !== wdLastSteps || out.length !== wdLastOutLen) {
					wdLastSteps = stepCount;
					wdLastOutLen = out.length;
					wdLastChangeAt = Date.now();
					return;
				}
				if (Date.now() - wdLastChangeAt >= 300_000) {
					console.warn(`[run-log] WATCHDOG 300s no progress (steps=${stepCount} outLen=${out.length}) -> force settle`);
					wdLastChangeAt = Date.now(); // 重置, 避免连续触发; settle 内部 2000ms 去重仍生效
					last = Date.now();
					settle();
				}
			}, 30_000);
			let timer = setTimeout(() => {
				// 超时必须 abort agent，否则模型继续生成 toolCall、block 继续拦 → 死循环
				console.log(`[run-log] TIMEOUT 1800s — aborting session, trying auto-deliver`);
				t.session?.abort().catch((e: any) => console.warn(`[run-log] abort failed: ${e}`));
				void autoDeliver("timeout");
			}, 1_800_000);
			// === A方案 L1 软提醒: 1500s(超时前300s) 若仍未交付 -> steer 停止探索、立即交付 ===
			escIntv = setInterval(() => {
				if (failed || escL1) return;
				if (Date.now() - runStart < 1_500_000) return;
				escL1 = true;
				console.log(`[run-log] ESC_L1 1500s reached, steer delivery (steps=${stepCount})`);
				t.session?.steer(`【交付倒计时】已接近任务时间上限。立刻停止一切探索和新功能。现在只做交付：交付前必须确保 git 根 = 项目目录——先 cd 到项目目录（如 /ws/<项目名>），确认该目录内存在 .git（若无则在此目录执行 git init）；然后 git add .（不要 git add <项目名>，不要从沙箱根 add 子目录）、git commit、git push 到 demo-${t.sid} 的仓库根（不是子目录），调用 deliver(url) 提交链接，并在正文给出完整可访问的 github.io 链接。其它一律不做。`).catch(() => {});
			}, 15_000);
			// __autoDeployEarly L2: 1650s 仍未交付 -> 提前 autoDeploy(不等1800s), autoDeploy内部自找sandbox, 已交付则n=0无害
			const l2Timer = setTimeout(() => {
				if (failed || !escL1) return;
				console.log(`[run-log] ESC_L2 1650s — autoDeploy early (early fallback, not waiting 1800s) sid=${t.sid}`);
				const sbxId = t.sandboxId || "";
				if (!sbxId || !isBound(t.sid)) { console.warn(`[run-log] AUTODEPLOY_EARLY_NO_SANDBOX sid=${t.sid}`); return; }
				void autoDeploy(sbxId, t.sid, 0, undefined).then(res => console.log(`[run-log] AUTODEPLOY_EARLY sid=${t.sid} n=${res.n} url=${res.url}`)).catch(e => console.warn(`[run-log] AUTODEPLOY_EARLY_FAIL sid=${t.sid} ${String(e).slice(0,120)}`));
			}, 1_650_000);
			function cleanup() {
				failed = true; // 终止即立旗, 三路(fail/finish/!session)全汇聚于此
				clearTimeout(timer); clearTimeout(progressTimer); clearTimeout(l2Timer);
				clearInterval(resetInterval); if (escIntv) clearInterval(escIntv); clearInterval(watchdog);; clearInterval(heartbeat);
(globalThis as any).__sddPlanning = false; // run 结束解除规划期
				t.unsub?.(); t.unsub = null;
			}
			async function finish() {
				// 正常结束但模型没 deliver -> autoDeliver 兜底推内容(否则 repo 空 404); 有 deliver 则不重复推(autoDeliver 内 failed guard + hasDeliver 判)。
				// guard stepCount>0: 纯聊天(寒暄/问答, tools=0 stepCount=0)不 deliver 是正常(settle 判定), 兜底只推有工具步的(防 repo 空 404); 纯聊天无沙箱不该 fail。
				if (stepCount > 0 && !hasDeliver(runStart)) void autoDeliver("finish");
				// D2 修复: session 仍在跑(30s 内有事件)且 out 为空 -> 不透传空串给用户;
				// 兜底文案策略在插件(__settleFallbackText), 核心默认=事实陈述(链接/后台执行), 绝不编造产出。
				const stillActive = Date.now() - last < 30_000;
				if (!out.trim() && stillActive) {
					// P0 sid 隔离: 只认本任务的 deliver, 防并发 run 时别人的 deliver url 串进 fallback (串台根因)
					const _ldRaw: any = (globalThis as any).__lastDeliver;
					const d: any = (_ldRaw && (!_ldRaw.sid || _ldRaw.sid === t.sid)) ? _ldRaw : null;
					const _hook = (globalThis as any).__settleFallbackText;
					const fallback = typeof _hook === "function"
						? _hook({ url: d && d.url ? String(d.url) : null, realUrl: !!(d && d.url && d.url.includes("vbk-ai-agent-gateway.github.io")) })
						: (d && d.url && d.url.includes("vbk-ai-agent-gateway.github.io")) ? `已交付: ${d.url}` : "任务仍在后台执行中，完成后会自动把结果发给你……";
					cleanup();
					console.log(`[run-log] RESOLVE finalLen=0 (empty-out fallback: ${fallback.slice(0, 50)})`);
					resolve(fallback);
					return;
				}
				cleanup();
				const final = out.trim();
				console.log(`[run-log] RESOLVE finalLen=${final.length}`);
				// 全部交给LLM: 程序不判断 delivered/不验链接/不拦代码, LLM给什么就回什么。
				// LLM调deliver会在正文给链接; LLM纯文字就发文字。工具落盘的代码是沙箱内部产物, 不在out里。
				resolve(final); // 纯透传 LLM 输出, 程序不兜底文案
			}
			function fail(e: Error) {
				cleanup();
				reject(e);
			}
			// === A方案 L4 系统兜底: 超时不再=失败, 先系统自动交付再 resolve ===
			async function autoDeliver(reason: string) {
			if (String(process.env.WAGATE_LOCAL_ONLY ?? "0") === "1") { console.log(`[run-log] AUTODELIVER local-only skip (github blocked) reason=${reason}`); cleanup(); resolve(String(out || "").trim() || "任务已结束（本轮未产生新的本地交付）。"); return; }
				if (failed) return;
				console.log(`[run-log] AUTODELIVER reason=${reason} (program auto-deploy via autoDeploy)`);
				// 读 task.deliverBase -> 项目名作 forceProj(精确推 deliver 项目, 防推错)
				let forceProj = "";
				try {
					const rt = (globalThis as Record<string, unknown>).__readTask as ((s: string) => { deliverBase?: string } | null) | undefined;
					const tk = rt ? rt(t.sid) : null;
					const db = String(tk?.deliverBase ?? "");
					const seg = db.replace(/^\/+|\/+$/g, "").split("/");
					if (seg.length >= 2) forceProj = seg[1];
				} catch { /* 读不到 task 就不带 forceProj, autoDeploy 自己找 */ }
				const sandboxId = t.sandboxId;
				if (!sandboxId) {
					console.warn(`[run-log] AUTODEPLOY_NO_SANDBOX sid=${t.sid} reason=${reason}`);
					fail(new Error(`timeout 1800s (${reason}); no sandbox to auto-deploy`));
					return;
				}
				// autoDeploy 内部用固定正确 user=VBK-AI-Agent-Gateway, 不依赖模型拼 remote URL
				const res = await autoDeploy(sandboxId, t.sid, 0, forceProj || undefined);
				if (res.n > 0 && res.url) {
					const finalText = `任务已通过系统自动部署交付（${reason} 触发兜底）。可访问链接：${res.url}`;
					console.log(`[run-log] AUTODEPLOY_OK sid=${t.sid} n=${res.n} url=${res.url}`);
					resolve(finalText);
					return;
				}
				console.warn(`[run-log] AUTODEPLOY_FAIL sid=${t.sid} n=${res.n} reason=${reason}`);
				fail(new Error(`timeout 1800s (${reason}); auto-deploy failed n=${res.n}`));
			}
			// 判定：已交付 或 续跑次数用尽 -> 收尾；否则发起一次续跑并等它结束再判。
			function settle() {
								if (failed) return; // 已终止(timeout/交付后残留 q interval 直接退出)
								// 节流挡下时补一次延迟 settle: q/quiet interval 都是单次触发后 clearInterval,
								// 若落在 2000ms 节流窗内被丢弃 -> 无人再调度 -> session 永久挂起(retryLeft 冻结,
								// 只剩 850s/1800s 超时兜底)。补发保证本次判定不丢。
								if (Date.now() - lastSettleAt < 2000) { setTimeout(() => settle(), 2100 - (Date.now() - lastSettleAt)); return; } // 并发q双触发(63us内)会把stillWorking二次判成卡死烧配额
								lastSettleAt = Date.now();
								if (!t.session) { cleanup(); resolve("会话已结束（可能被 /new 或清理）。请重新发送需求。"); return; }
			const emptyStall = out.trim().length === 0 && (retryUsed >= 2 || Date.now() - runStart > 600_000);
				// 已交付 -> 收尾
				if (isDelivered(out) || hasDeliver(runStart) || lastTools.includes("doc_pack")) { void finish(); return; }
				// 数据分析任务完成判定: upload-ops fresh(G.__uploadTask) + 正文足够长 + 无工具在飞 = 分析已产出, finish 走正常发聊天通道。
				// 原纯文本分支要 stepCount===0, 数据任务用过 sbx_bash(stepCount>0)够不着 -> 卡 NOT_DELIVERED 烧 left -> 走 autoDeploy 网页兜底, 纯数据无网页可推, 聊天空。
				const _upFin = (() => { const t = (globalThis as any).__uploadTask as { at?: number } | undefined; return !!t && typeof t.at === "number" && Date.now() - t.at < 10 * 60_000; })();
				if (_upFin && !inflight && out.trim().length > 1500) {
					console.log("[resume] data-route finish (正文" + out.trim().length + "字) -> 发聊天");
					void finish();
					return;
				}
				// 都走LLM: 模型纯文本回复(0工具步、无续跑在飞、有正文) = 完成, 不强求 deliver。
				// 寒暄/问答不调 deliver 是正常的, 原"未deliver就续跑"会把"你好"逼成开发任务。
				const _turnSbx = ((globalThis as any).__turnSbxUsed || {})[t.sid] === true; // freshtest4: 本轮是否碰过沙箱
				if ((stepCount === 0 || !_turnSbx) && !inflight && out.trim().length > 0) {
					const _text = out.trim();
					// _hallucinatedUrlGuard: 零工具步却宣称已交付 github.io -> 拦截, 不透传不autoDeliver(无内容可推)
					const _hallu = _text.match(/https:\/\/[^\s"'<>\uff08\uff09\u3001\u3002]+\.github\.io\/[^\s"'<>\uff08\uff09\u3001\u3002]*/);
					if (_hallu) {
						console.warn(`[run-log] BLOCK hallucinated-url stepCount=0 url=${_hallu[0]}`);
						if (process.env.WAGATE_SAFE_MODE === "1") {
							console.log(`[run-log][SAFE] skip HALLU-RESUME stepCount=0 (PI直连)`);
						} else if (halluRetryLeft > 0) {
							console.warn(`[run-log] HALLU-RESUME stepCount=0 left=${halluRetryLeft} url=${_hallu[0]}`);
							inflight = t.session.prompt(HALLU_STEER_TEXT, { streamingBehavior: 'followUp' }).then(() => { if (inflight) inflight = null; }).catch(() => { if (inflight) inflight = null; });
							last = Date.now();
							return;
						}
						resolve("本轮未检测到实际开发动作（无文件写入、无部署调用），已拦截疑似虚构的交付链接。请重试，或明确要求先完成开发再交付。");
						return;
					}
					void finish();
					return;
				}
				// 任务在干活(步数比上次判定涨了) 且 600s 硬超时没到 -> 只是还没到链接那步，不算到上限，继续等
				// （stepCount 每次判定间若增长说明模型仍在推进，续跑/放弃会打断复杂任务）
				// 总步数硬上限：防止工具爆发空转

				// CrewAI max_iter 借鉴: 2000 太松(等于无上限, 磨到超时也到不了)。收紧到 250
				// (≈2.4x 成功任务 105 步, 留足余量不误伤正常复杂任务; 早于1800s超时, 打断pages-check 404死循环), 到点不再空转, 走 autoDeliver 强制交付。
				if (stepCount > 250) {
					console.log(`[run-log] settle MAX_ITER steps=${stepCount} -> auto-deliver`);

					void autoDeliver("max_iter"); return;

				}

				// 图片任务: stillWorking 只认 img_lab 真实产出(__imgLabCalled), 读类工具(sbx_read/sbx_ls 等)
				// 空转微涨步数不算"干活" —— 否则模型无限 sbx_read 看图不落 img_lab, stillWorking 恒 true 拖到
				// retry 耗尽空正文收尾。非图片任务维持原步数判定。
				const _g = globalThis as Record<string, unknown>;
				const _it = _g.__imgTask as { at?: number } | undefined;
				const _imgTaskFresh = !!_it && typeof _it.at === "number" && Date.now() - _it.at < 10 * 60_000;
				const _imgLabDone = typeof _g.__imgLabCalled === "number" && Date.now() - (_g.__imgLabCalled as number) < 10 * 60_000;
				const stillWorking = _imgTaskFresh
					? (_imgLabDone || !(stepCount > lastSettleSteps && stepCount > 0))
					: (stepCount > lastSettleSteps && stepCount > 0);
				if (_imgTaskFresh) console.log(`[run-log] settle imgTask stillWorking=${stillWorking} imgLabDone=${_imgLabDone} steps=${stepCount} last=${lastSettleSteps}`);
				// 改进: 更早识别"已产出但未交付" —— 若 out 里已出现真实 github.io 链接(模型已 push 但没调 deliver),
				// 直接走 finish 收尾, 不再续跑。正常任务(未产出链接)够不着, 只加速已可交付状态。
				// 改进: 更早识别"已产出但未交付" —— 若 out 里已出现真实域交付链接(含本 sid base), 直接 finish。
				// (404 修复: 假域 demo-<sid>.github.io 不再触发收尾)
				if (new RegExp(`https?:\\/\\/vbk-ai-agent-gateway\\.github\\.io\\/[^\\s)]*demo-${String(t.sid).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/`, "i").test(out)) {
					console.log(`[run-log] settle EARLY_DELIVER link found in out -> finish`);
					void finish(); return;
				}
				if (stillWorking && Date.now() - runStart < 850_000) {
					lastSettleSteps = stepCount;
					console.log(`[run-log] settle stillWorking steps=${stepCount} retryLeft=${retryLeft} -> continue waiting`);
					// 重新起静默窗口，等模型继续出结果；不消耗 retryLeft、不发起续跑
					const q = setInterval(() => {
						if (Date.now() - last > 5000) { clearInterval(q); settle(); }
					}, 500);
					return;
				}
				// 真卡住(stepCount 没涨)/次数用尽/秒退 -> 续跑或收尾
				// A: 截断爆发轮(上千 toolCall 撞上限全部作废)不烧有效续跑次数,但有总次数硬上限
				const wasTrunc = truncFlag; truncFlag = false;
				if (retryUsed >= 15) { void finish(); return; }
				if ((retryLeft <= 0 && !wasTrunc) || emptyStall) { void finish(); return; }
				if (inflight) return; // 已有续跑在飞: 不烧配额不发进度, 等它的 then 再调 settle（D3: 上移到扣配额前）
				if (!wasTrunc) retryLeft--;
				retryUsed++;
				lastSettleSteps = stepCount;
				console.log(`[run-log] NOT_DELIVERED retry续跑 left=${retryLeft} trunc=${wasTrunc} inflight=${!!inflight} outLen=${out.trim().length} steps=${stepCount}`);
prog(`🔄 任务较重，继续推进中…`, true);
				last = Date.now();
				clearTimeout(timer);
				timer = setTimeout(() => { console.log("[run-log] TIMEOUT 1800s(续装timer) — aborting session, trying auto-deliver"); t.session?.abort().catch((e: any) => console.warn("[run-log] abort failed: " + String(e))); void autoDeliver("timeout-续装"); }, 1_800_000);
				// B: 续跑 prompt 按任务类型选择(原版硬编码游戏流程,工程任务被带偏)
				const isGameTask = /游戏|game|网页|github\.io|可访问.{0,4}链接/i.test(text);
				// 数据分析任务续跑: upload-ops 限制过工具集(G.__uploadTask 新鲜) -> 重锚数据分析, 防 dev resume 把数据任务带偏成开发
				const _upT = (globalThis as any).__uploadTask as { at?: number } | undefined;
				const _upFresh = !!_upT && typeof _upT.at === "number" && Date.now() - _upT.at < 10 * 60_000;
				let resumeText: string;
								// SDD 步进: 解析 TASKS 进度 -> 下一步任务 (spec-kit implement)
				const sddTasks = parseTasks(out);
				const sddDone = doneTasks(out);
				const sddNext = sddTasks.find((x: any) => !sddDone.has(x.id));
				if (_upFresh && !sddTasks.length) {
					// 按意图分档续跑: PPT/doc/img/video 生成后必须调交付工具, data 才输出正文结束(原硬编码"纯分析+禁止交付" 抑制 ppt doc_pack -> 烧 left)
					const _upIntent = (() => { const p = text || ""; if (/(ppt|pptx|幻灯|演示|slides?|slide deck)/i.test(p)) return "ppt"; if (/(pdf|word|docx|\bdoc\b|报告|说明书|方案书|简历|白皮书)/i.test(p)) return "doc"; if (/(网页|网站|页面|game|游戏|h5|landing|站点)/i.test(p)) return "web"; if (/(视频|动画|剪辑|mp4|合成|渲染视频)/i.test(p)) return "video"; if (/(图片|图表|可视化|画|插图|icon|logo|海报|封面)/i.test(p)) return "img"; return "data"; })();
					if (_upIntent === "data") {
						resumeText = "【数据分析续跑·防跑偏】你正在做纯数据分析, 与开发/修bug/交付GitHub Pages完全无关。上一轮只是没把结果写全, 不是卡住。立即: 用 sbx_bash python 读已就绪的数据文件, 算出用户要的汇总, 在正文直接输出完整分析结果(表格/数字), 然后结束。禁止写文件、禁止改代码、禁止 deliver/push、禁止重新探索。拿到数据汇总即完成, 步数应≤10。";
					} else {
						resumeText = `【续跑·${_upIntent} 产出交付】上一轮没把交付走完, 不是卡住。立即接着做: 用工具完成 .${_upIntent === "ppt" ? "pptx" : _upIntent === "doc" ? "pdf/docx" : _upIntent === "img" ? "png" : _upIntent === "video" ? "mp4" : "html"} 产出生成, **生成后必须调用交付工具把它发给用户** (ppt/doc 用 doc_pack, img 用 img_ops, video 用 img_lab, web 用 deliver)。生成完立即调交付工具, 否则用户收不到文件。不要重新探索、不要只报告进度, 直接生成+交付。`;
					}
					console.log(`[resume] data-route resume (uploadTask fresh) -> ${_upIntent} 续跑`);
				} else if (sddTasks.length > 0 && sddNext) {
					resumeText = `进度检查: 已完成 [${Array.from(sddDone).join(',')}]。现在只执行这一个任务 ${sddNext.id}/${sddTasks.length}: ${sddNext.desc}。验收标准: ${sddNext.accept || '任务对应的文件/功能真实存在'}。完成输出 DONE ${sddNext.id}: 证据(文件路径/输出/URL); 卡住输出 BLOCKED ${sddNext.id}: 原因。铁律: 每条消息最多 8 个工具, 等结果再下一步。`;
					console.log("[sdd] next=" + sddNext.id + "/" + sddTasks.length + " done=" + Array.from(sddDone).join(","));
				} else if (sddTasks.length > 0) {
					resumeText = "所有任务已标记 DONE。最后一步: 调用 deliver(url) 工具提交最终可访问链接(url 填页面地址), 并在正文输出完整地址。";
					console.log("[sdd] all " + sddTasks.length + " tasks done -> deliver");
				} else if (wasTrunc) {
					resumeText = "【纠正】你上一条消息生成了上千个 toolCall,撞了输出 token 上限,全部作废、一个都没执行。铁律:每条消息最多 8 个工具(可并行),绝不超 8 个,分多条消息推进。立即用工具继续完成用户最初交代的任务,直接动手,不要重新从头探索、不要长篇分析。" + (isGameTask ? "(交付要求:完成后在正文给出完整可访问的 github.io 链接)" : "(完成后在正文给出最终结果或链接)");
				} else if (isGameTask) {
					resumeText = `【铁律】本次续跑最多调用 8 个工具，可并行但绝不超 8 个 toolCall；每步最多发 8 个工具、等结果再下一步。忽略之前的闲聊。你正在为用户开发一个网页游戏并必须交付可访问链接。立即用工具动手，严格按此流程：1)先 cd 到 /ws，git clone --filter=blob:none --no-checkout https://github.com/VBK-AI-Agent-Gateway/demo-${t.sid}.git demo-${t.sid}（已有就 cd demo-${t.sid}），再 git sparse-checkout set --cone ${readProj(t.sid)} && git checkout main（只拉自己子目录，看不到别人项目）；2)把你写好的游戏 index.html 放到 demo-${t.sid}/${readProj(t.sid)}/ 子目录里（绝不写仓库根 index.html，绝不用 git add -A，绝不自建新仓库）；3)只 git add <你的项目名> 子目录、git commit、git push 到 main；4)push 后 curl GitHub Pages API 确认 status=built；5)在回复正文给出完整 https://vbk-ai-agent-gateway.github.io/demo-${t.sid}/<项目名>/ 链接。不要回答“在吗”，只有给出最终可访问链接才算完成。`;
				} else {
					resumeText = "【铁律】每条消息最多调用 8 个工具(可并行),绝不超 8 个 toolCall,等结果再下一步。继续完成用户最初交代的任务,不要重新开始、不要只报告现状,用工具实际推进;完成后在正文给出最终结果或可访问链接。";
				}
				const t0Resume = Date.now();
				let lzSkipReenter = false; // D1: already-processing 误伤分支在 finally 不再重入 settle
				// E12: session 可能已被 abort/回收 -> 非空断言会崩(历史 t.session.prompt null)。空则走失败计数。
				if ((t as any).stopped) { const _so=out.trim(); console.log("[settle续跑] stopped -> finish no-deliver outLen="+_so.length); cleanup(); resolve(_so || "已中止当前任务。"); return; }
				if (!t.session) { console.warn("[settle续跑] session gone -> skip resume"); resumeFails++; return; }
				inflight = t.session.prompt(resumeText).then(() => {
					if (Date.now() - t0Resume < 2000) { console.warn("[settle续跑] prompt ended in " + (Date.now() - t0Resume) + "ms without running (treated as failure)"); resumeFails++; }
					else resumeFails = 0;
					}).catch((e: any) => {
					const emsg = String((e && e.message) || e);
					console.warn("[settle续跑] prompt rejected: " + emsg.slice(0, 120));
					if (emsg.indexOf("already processing") >= 0) {
						// 续跑死锁修复: 原 lzSkipReenter 等 agent_end 可能永不来(任务卡住) -> 死等1800s。
						// 改: 配额回补 + 轻度 resumeFails, finally 短退避重入 settle 重试(不依赖 agent_end)。
						retryLeft++;
						resumeFails = Math.min(resumeFails + 1, 3); // 封顶3次 -> 退避 3s/6s/12s, 不无限
						return;
					}
					resumeFails++;
					}).finally(() => {
					inflight = null;
					// 续跑结束 -> 再次进入静默判定; 失败按 3s->6s->12s->24s->30s 退避, 等 pi 内部状态恢复
					// D1: already-processing 误伤分支不重入, 交给 agent_end 唤醒
					if (lzSkipReenter) return;
					const wait = resumeFails > 0 ? Math.min(3000 * Math.pow(2, resumeFails), 30000) : 3000;
					const q = setInterval(() => {
						if (Date.now() - last > wait) { clearInterval(q); settle(); }
					}, 500);
				});
			}
			// 解死锁：定时重置计数器（每 30s 强制归 0，不依赖 message_end assistant fire）
			const resetInterval = setInterval(() => {
				(globalThis as any).__toolCallsThisTurn = 0;
				(globalThis as any).__toolCallsTurn = 0;
			}, 30000);
			t.unsub = t.session!.subscribe((ev: any) => {
				if (ev.type === "message_end" && ev.message?.role === "assistant") {
					(globalThis as any).__toolCallsThisTurn = 0; // 重置 tool_call 事件计数器
					(globalThis as any).__readThisTurn = 0; // 重置读工具限量计数器
					(globalThis as any).__toolCallsTurn = 0; // 重置 execute 层计数器
truncInThisMsg = false; // D-fix: 新 assistant 消息开始, 重新计数
					const c = ev.message.content;
					const before = out.length;
					if (Array.isArray(c)) out += c.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
					else if (typeof c === "string") out += c;
					const kinds = Array.isArray(c) ? c.map((x: any) => x?.type).join(",") : typeof c;
					const tcNames = (Array.isArray(c) ? c.filter((x:any) => x.type==="toolCall").map((x:any) => x.toolName || x.name || "?") : []);
						if (Array.isArray(c)) { const _tc = c.find((x:any) => x.type==="toolCall"); if (_tc) console.log(`[probe-tc] keys=${Object.keys(_tc).join(",")} args=${JSON.stringify(_tc.arguments ?? null).slice(0,300)}`); }
						lastTools = tcNames;
						{ const said = out.slice(before).trim(); if (said) lastSaid = said.slice(-160); }
 				console.log(`[run-log] message_end role=assistant tools=${tcNames.length}[${tcNames.slice(0,8).join(",")}${tcNames.length>8?",...":""}] extracted=${out.length - before} totalOut=${out.length} stop=${String((ev.message as any)?.stopReason ?? "?")} contentTC=${Array.isArray((ev.message as any)?.content) ? (ev.message as any).content.filter((x:any)=>x?.type==="toolCall").length : -1}`);
				// BURST_GUARD / 探索循环干预已外移: extensions/plugins/{burst-guard,explore-stall,repeat-batch}.ts
					if (out.length - before > 0) (globalThis as any).__sddPlanning = false; // 首段规划文本出现 -> 解除规划期工具 block
					// ===== HALLU主拦截: 本条assistant无toolCall且输出含幻觉URL (session活着, prompt有效) =====
					const __halluHit = tcNames.length === 0 && /https?:\/\/[^\s)]*github\.io[^\s)]*/i.test(out) && !inflight;
					if (__halluHit) {
						if (process.env.WAGATE_SAFE_MODE === "1") {
							console.log(`[run-log][SAFE] skip HALLU-RESUME path=message_end (PI直连)`);
						} else if (halluRetryLeft > 0) {
							halluRetryLeft--;
							console.warn(`[run-log] HALLU-RESUME path=message_end left=${halluRetryLeft}`);
							inflight = true;
							t.session.prompt(HALLU_STEER_TEXT, { streamingBehavior: 'followUp' }).catch((e:any) => console.warn(`[run-log] HALLU prompt err: ${e?.message ?? e}`)).finally(() => { inflight = false; });
							last = Date.now();
							return;
						}
						console.warn(`[run-log] HALLU exhausted path=message_end left=${halluRetryLeft}, defer to agent_end fallback`);
					}
					// ===== HALLU主拦截 END =====
					last = Date.now();
				}
				if (ev.type === "message_end" && ev.message?.role === "toolResult") {
					// 铁律 block 的 toolResult 不计步（否则 674 个 block 虚高步数）
					const trContent = typeof ev.message.content === "string" ? ev.message.content : JSON.stringify(ev.message.content || "");
					const isTrunc = trContent.includes("was not executed") || trContent.includes("output token limit");
					const isBlocked = trContent.includes("铁律：最多 8 个") || trContent.includes("本条消息已用掉") || trContent.includes("[exec 上限]") || isTrunc;
					if (isTrunc) {
						truncFlag = true; // A: 记录截断爆发
						if (!truncInThisMsg) { // D-fix: 每条截断消息只 +1
						truncInThisMsg = true;
						truncBurst++; // D: agent 内循环检测(连续截断)
						if (truncBurst >= 2 && steerTotal < 10) {
							steerTotal++;
							console.warn(`[循环干预] 连续 ${truncBurst} 次截断爆发, steer 纠正 #${steerTotal}`);
							t.session?.steer("你刚才连续多条消息都生成了大量 toolCall，全部撞输出 token 上限作废，等于没有执行任何工具。改成分步执行：每条消息最多 8 个工具，执行完看结果再继续。现在接着完成最初的任务，不要重新开始、不要只报告现状。").catch(() => {});
							truncBurst = 0;
						}
						}
					} else {
						truncBurst = 0; // 正常/铁律 toolResult = 退出循环
					}
					if (!isBlocked) {
						stepCount++;
					}
				} else if (ev.type === "message_end" && ev.message?.role !== "assistant") {
					console.log(`[run-log] message_end role=${ev.message?.role}`);
				}
				if (ev.type === "compaction_start" || ev.type === "auto_retry_start") {
					opts.onProgress?.(t.sid, "…压缩/重试中");
					last = Date.now();
				}
				if (ev.type === "agent_end") {
					console.log(`[run-log] agent_end outSoFar=${out.length} inflight=${!!inflight}`);
						// 寒暄/纯文本: 0步+无inflight+有正文 = 已完成, 立即收尾, 不等3s静默(省3秒)
						const _turnSbxA = ((globalThis as any).__turnSbxUsed || {})[t.sid] === true; // freshtest4
						if ((stepCount === 0 || !_turnSbxA) && !inflight && out.trim().length > 0) {
							// _hallucinatedUrlGuard(agent_end): 单轮tools=0直接结束+含github.io幻觉URL -> 拦截, 不透传
							const _halluA = out.trim().match(/https:\/\/[^\s"'<>\uff08\uff09\u3001\u3002]+\.github\.io\/[^\s"'<>\uff08\uff09\u3001\u3002]*/);
							if (_halluA) {
								console.warn(`[run-log] BLOCK hallucinated-url path=agent_end url=${_halluA[0]}`);
								// agent_end时session已死, prompt无效; message_end/settle已试过, 兜底resolve
								console.warn(`[run-log] HALLU path=agent_end fallback, left=${halluRetryLeft} -> defer resolve`);
								resolve("本轮未检测到实际开发动作（无文件写入、无部署调用），已拦截疑似虚构的交付链接。请重试，或明确要求先完成开发再交付。");
								return;
							}
							void finish().catch(() => {});
						} else {
					const quiet = setInterval(() => {
						if (Date.now() - last > 3000) { clearInterval(quiet); settle(); }
					}, 500);
						}
				}
			});
				let lastSaid = "";
				let lastTools: string[] = [];
				let heartbeat = 0;
			let stepCount = 0;
				// 30s 实时心跳: 无条件回报 真实进度(步数+耗时+最近工具), 替代粗粒度 %3 触发
				heartbeat = setInterval(() => {
					if (failed || (t as any).stopped) return;
					const el = Math.round((Date.now() - runStart) / 1000);
					const tools = lastTools.length ? lastTools.slice(0,8).join("/") : "-";
					const said = lastSaid ? " · " + lastSaid.replace(/\s+/g," ").slice(0,120) : "";
					// 反馈文案(体验修复): 步数0+无工具=静默规划; 有工具但结果未回=执行中; 其余原格式
					if (stepCount === 0 && lastTools.length === 0) {
						prog(`⏳ ${el}s · 规划中(模型正在本地分析任务)${said}`);
					} else if (stepCount === 0 && lastTools.length > 0) {
						prog(`⏳ ${el}s · 执行 ${tools} 中 · 待结果${said}`);
					} else {
						// step9: __fbState 带 sid 写入 -> 读时比对, 防并发串台(别人的已交付链接进本 sid 进度)。
						// flag: env FB_SID_GATE, 默认 on(比对); =0 回单槽旧行为(不比对)。
						const _fbRaw = (globalThis as any).__fbState || {};
						const fb = (process.env.FB_SID_GATE !== "0" && _fbRaw.sid && _fbRaw.sid !== t.sid) ? {} : _fbRaw;
						const fbLine = fb.delivered ? `✅ 已交付 ${fb.delivered}` : (fb.block ? `🚧 阻塞:${String(fb.block).slice(0,40)}` : (fb.verify ? `🔍 ${fb.verify}` : ""));
						// F3 预计剩余: 经验总步105 + 当前速率; stepCount<5 不显示(避免乱跳)
						let eta = "";
						if (stepCount >= 5) {
							const remainSteps = Math.max(0, 105 - stepCount);
							const secPerStep = el / stepCount;
							const remainSec = Math.round(Math.min(remainSteps * secPerStep, el * 1.5, 1800)); // 反膨胀(20261102压测实证): 显示ETA≤已用×1.5且≤30分, 防轻任务被"经验总步105"高估(实测10分→21分持续上涨)
							eta = remainSteps > 0 ? `⏱ 预计还需 ~${Math.max(1, Math.round(remainSec / 60))}分 | ` : "⏱ 收尾中 | ";
						}
						// D4 目标对齐: 期望关键词覆盖 X/Y; 内部用 | 分隔(不进·split), fbAll=segs[2]整段保留防"处理中"
						const align = fb.align ? `🎯 对齐 ${fb.align} | ` : "";
						const fbAll = eta + align + fbLine;
						prog(`⏳ ${el}s · ${stepCount} 步 · ${tools}${fbAll ? " · " + fbAll : ""}${said}`);
					}
				}, 30000);
			let lastProgAt = 0;
			const prog = (line: string, force = false) => {
				try {
					const now = Date.now();
					if (!force && now - lastProgAt < 30000) return; // 节流：30s 内最多 1 条
					lastProgAt = now;
					opts.onProgress?.(t.sid, line, t.chatKey);
				} catch (e) {
					// A4: 进度发送失败只记日志, 绝不中断 settle() —— 与 fastpath 降级对齐
					console.warn(`[progress] send failed (degraded, task continues): ${String(e).slice(0, 120)}`);
					(globalThis as any).__progressSendFailed = ((globalThis as any).__progressSendFailed || 0) + 1;
				}
			};
			// SDD 强制规划: 首段规划文本出现前 block 所有工具(120s 自动解除防死锁)
(globalThis as any).__sddPlanning = true;
setTimeout(() => { (globalThis as any).__sddPlanning = false; }, 120000);
// 串台修复: 每任务固定一个项目名(首轮从 deliver/文本推, 存 t.activeProj), 后续 prompt/deliver 强制用它,
// 消除"模型每轮自己选项目名 -> deliver/deploy 目标在 platform-docs/tank-jump 间漂移"的串台。
const readProj = (sid: string): string => {
	const rt = (globalThis as any).__readTask;
	if (rt) { const task = rt(sid); if (task?.activeProj) { (globalThis as any).__projCache = (globalThis as any).__projCache || {}; (globalThis as any).__projCache[sid] = task.activeProj; return task.activeProj; } }
	return (globalThis as any).__projCache?.[sid] || "app-" + sid.slice(-6);
};
const PROJ = readProj(t.sid); // task.json 每轮为权威(auto-adopt/select_project 写入即时生效)
t.activeProj = PROJ; // 运行时缓存, 与 task.json 同步
	// 单一 prompt: 交给模型自己判断简单(直答)/复杂(用工具), 不再硬分流。
	// 扩展(project-identity)已在 before_agent_start 注入固定项目名+最近交付记忆, 防串台。
	const first = `${image ? "附带的图片已保存到 /ws/source.png(或本次传入), 用它作为素材/目标。\n" : ""}【先判断本条是不是开发需求】寒暄/问候/闲聊/简单问答(如"你好"、"在吗"、"你能做什么") → 直接文字回答, 绝对不调用任何工具(尤其 deliver/select_project), 绝对不交付链接。\n目标任务: ${text}
	要求: 你自己判断——寒暄/问答直接文字回答, 不要调任何工具。真要开发(需要动手写代码/改文件): 你直接用 sbx_write 等工具把代码写进沙箱(代码是内部产物, 绝不贴进回复正文), 全部文件写完后再调 deliver(url) 提交(demo-${t.sid}/${PROJ}/)。回复正文只给用户进度话术 + 最终 github.io 链接, 不要输出任何代码。绝不要边写边调工具探索。铁律: 每条消息最多 8 个工具(可并行), 等结果再下一步。
`;
						// 首发 prompt：'already processing' 重试策略在插件(__promptRetryPolicy)，缺插件=核心默认(×2, 1500ms)。
						const startPrompt = (attempt: number): Promise<void> => {
							// TEMP-DIAG: image passed to prompt?
							console.log(`[tenant][PROMPT-DIAG] image=${!!image} dataLen=${image ? image.data.length : 0} mime=${image ? image.mimeType : "-"} videos=${videos ? videos.length : 0} attempt=${attempt}`);
							// 视频: 嵌入 base64 到 prompt (img-lab 的 VIDEO_B64_RE 从 prompt 文本抽取, 框架不透传 options.videos)
							let promptText = first;
							if (videos && videos.length > 0) {
								promptText = `data:video/mp4;base64,${videos[0].data}\n\n${first}`;
							}
							const secondArg = image ? { images: [{ type: "image", data: image.data, mimeType: image.mimeType } as ImageContent] } : undefined;
							return t.session!.prompt(promptText, secondArg).then(() => {
								// 首轮 prompt 结束：短暂静默后判定是否需要续跑
								const q = setInterval(() => {
									if (Date.now() - last > 3000) { clearInterval(q); settle(); }
								}, 500);
							}).catch((e: Error) => {
								const msg = String(e && e.message || e);
								const _pol = (globalThis as any).__promptRetryPolicy;
								const p = typeof _pol === "function" ? _pol(msg, attempt) : { retry: msg.includes('already processing') && attempt < 2, delayMs: 1500 };
								if (p && p.retry) {
									console.warn(`[tenant] prompt retry attempt=${attempt + 1} sid=${t.sid} delay=${p.delayMs ?? 1500}ms${typeof _pol === "function" ? " (plugin)" : ""}`);
									return new Promise<void>((res) => setTimeout(res, p.delayMs ?? 1500)).then(() => startPrompt(attempt + 1));
								}
								return fail(e);
							});
						};
						startPrompt(0);
		});
	}

	async function handle(msg: InMsg): Promise<OutMsg[]> {
		// 这两条原来是静默 return []，出了「AI 不回复」根本看不出是哪条被丢的。
		if (msg.isGroup) {
			console.log(`[tenant] drop ${msg.userId} reason=group sid-channel=${msg.channelId}`);
			return []; // R4：群聊静默丢弃
		}
		const text0 = msg.text.trim();
		const platform = (msg as any).platform ?? "whatsapp";
		// /register 在白名单判定**之前**:不在名单的人发注册码也能进来
		if (text0 === "/register" || text0.startsWith("/register ")) {
			return handleRegister(msg.userId, text0, platform);
		}
		if (!opts.allow.has(msg.userId) && !opts.allow.has(`${msg.userId}@${platform}`)) {
			console.log(`[tenant] drop ${msg.userId} reason=not-allowed`);
			return []; // fail-closed
		}
		const text = text0;
		const sid = sidFor(msg);

		if (text === "/new") {
			const old = tenants.get(sid);
			// /new = 真的要清空，所以**不**快照（上一份存档留着，回滚靠 /resume）
			if (old) await drop(old, { snapshot: false });
			return [{ kind: "result", text: "已重置。下一条消息开一台干净沙箱。" }];
		}
		if (text === "/stop") {
			const t = tenants.get(sid);
			if (!t?.session) return [{ kind: "result", text: "没有进行中的任务。" }];
			// 停止清理逻辑外移插件 extensions/plugins/stop-cleanup.ts (globalThis hook, 同 __settleFallbackText/__currentSid 模式)。
			const _hook = (globalThis as any).__stopCleanup;
			if (typeof _hook === "function") {
				const msg = _hook(t); // hook 直接收租户对象, 可改 t.session/t.unsub
				if (typeof msg === "string" && msg) return [{ kind: "result", text: msg }];
			}
			await t.session.abort();
			return [{ kind: "result", text: "已中止。" }];
		}
		if (text === "/list") {
			const mine = [...tenants.values()].filter((t) => t.sid === sid);
			return [
				{
					kind: "result",
					text: mine.length
						? `租户 ${sid}｜${mine[0].suspended ? "已回收（记忆保留）" : `沙箱 ${mine[0].sandboxId}`}｜${mine[0].busy ? "运行中" : "空闲"}`
						: "你还没有会话，发条消息即可开始。",
				},
			];
		}

		if (text === "/secret" || text.startsWith("/secret ")) return handleSecret(sid, text);
		if (text === "/schedule" || text.startsWith("/schedule ") || text === "/schedule list") return handleSchedule(sid, text);

		// 同租户串行（防止同一沙箱并发写），跨租户真并发
		const prev = locks.get(sid) ?? Promise.resolve();
		const job = prev.catch(() => {}).then(async () => {
			let t = tenants.get(sid);
			if (!t) {
				t = { sid, sandboxId: "", session: null, unsub: null, chatKey: `${msg.platform}:${msg.channelId}`, lastSeen: Date.now(), busy: false, suspended: false };
				tenants.set(sid, t);
			}
			// 统一消息处理: 纯图片缓存等文字, 其余直接交给模型(模型自己判断简单/复杂, 用不用工具)
			const msgType = msg.msgType || (msg.image ? (text.trim() ? 'image_text' : 'image') : 'text');
			console.log(`[tenant] sid=${sid} msgType=${msgType}`);
			if (msgType === 'image') {
				// 纯图片（无文字）：缓存图片，等待用户补充文字
				(globalThis as any).__pendingImage = msg.image;
				(globalThis as any).__pendingImageSid = sid;
				return [{ kind: "result" as const, text: "收到图片。请告诉我你想用这张图片做什么？" }];
			}
			// 合并 pending 图片(用户先发图后补文字)
			if (msgType === 'text') {
				const pendingImage = (globalThis as any).__pendingImage;
				if (pendingImage && (globalThis as any).__pendingImageSid === sid) {
					msg.image = pendingImage;
					(globalThis as any).__pendingImage = null;
					(globalThis as any).__pendingImageSid = null;
				}
			}
			// TEMP-DIAG: image merge state
			console.log(`[tenant][IMG-DIAG] msgType=${msgType} msg.image=${!!msg.image} pendingSid=${(globalThis as any).__pendingImageSid ?? "null"} sid=${sid}`);
			// 聊天 fastpath：只建 session(记忆)，不建沙箱。纯文本消息 prompt 直发模型秒回；
			// 沙箱由模型真正发起第一个 sbx_*/deliver 工具调用时经 __lazyEnsureSandbox 惰性建立。
			// WG_LAZY_SANDBOX=0 回退旧行为(消息进来即建沙箱)。
			if (process.env.WG_LAZY_SANDBOX === "0") {
				await ensure(t);
			} else {
				await ensureSession(t);
			}
			const wasBusy = t.busy; // 干活时再发消息 = steer（pi 原生，rpc.md:56）
			t.busy = true;
			t.lastSeen = Date.now();
			try {
				if (wasBusy) {
					await t.session!.steer(text);
					return [{ kind: "ack" as const, text: "已插入当前任务。回复将在当前任务完成时一并送达（任务可能还要几分钟），进度可看实时反馈消息。" }];
				}
				return [{ kind: "result" as const, text: await runWithSid(t.sid, () => runOnce(t, text, msg.image, msg.videos)) }];
			} finally {
				t.busy = false;
				t.lastSeen = Date.now();
				// AI 刚跑完 -> 把记忆/任务文件同步到宿主 workspace/（供扩展读取）
				try { await pullMemory(t); } catch {}
				if (t.sandboxId) { try { await sanitizeRemotes(t.sandboxId); } catch {} }
				// 串行任务间留间隙：上一 job 刚结束(<1s)就又来了下一 job 时，session 内部
				// 可能仍在收尾（'already processing'）——这里补 400ms 缓冲再放行后续 job。
				const prevEnd = (t as any).__lastJobEndAt as number | undefined;
				const gap = prevEnd ? Date.now() - prevEnd : 0;
				if (gap < 1000) {
					console.log(`[tenant] settle gap sid=${sid} gap=${gap}ms`);
					await new Promise((res) => setTimeout(res, 400));
				}
				(t as any).__lastJobEndAt = Date.now();
			}
		});
		locks.set(sid, job.catch(() => {}));
		return job;
	}

	/** /register <码> 自助注册:码对则入白名单(无审核、无用户上限),持久化到文件。 */
	async function handleRegister(userId: string, text: string, platform: string): Promise<OutMsg[]> {
		const code = text.slice("/register".length).trim();
		if (!opts.registerCode) return [{ kind: "result", text: "自助注册未开启。" }];
		if (!code) return [{ kind: "result", text: "用法:/register <注册码>" }];
		if (code !== opts.registerCode) {
			console.log(`[tenant] register fail ${userId} reason=bad-code`);
			return [{ kind: "result", text: "注册码不正确。" }];
		}
		// key 必须与白名单判定一致: userId + "@" + platform (tg=纯数字id, 不能走 normalizeJid 硬编码 whatsapp JID)
		const jid = platform ? `${userId}@${platform}` : userId;
		if (opts.allow.has(jid) || opts.allow.has(userId)) return [{ kind: "result", text: "你已在名单内,直接发消息开始聊天即可。" }];
		opts.allow.add(jid);
		// 安全修复: appendFile 后读回验证, 失败重试1次; 只有真写入才 register ok, 否则 persist FAILED
		// (根因: 曾 register ok 但文件没写 -> restart 丢 allow -> not-allowed)
		let _persisted = !opts.registeredFile; // 无配置则视为持久化(仅内存)
		if (opts.registeredFile) {
			for (let _try = 0; _try < 2 && !_persisted; _try++) {
				try {
					await appendFile(opts.registeredFile, jid + ",", { mode: 0o600 });
					const _rb = await readFile(opts.registeredFile, "utf8");
					_persisted = _rb.split(",").map((s) => s.trim()).includes(jid);
				} catch (e) { console.error(`[tenant] register persist failed(try=${_try}): ${String(e).slice(0,200)}`); }
			}
		}
		if (_persisted) console.log(`[tenant] register ok ${jid} (allow=${opts.allow.size})`);
		else console.error(`[tenant] register PERSIST-FAILED ${jid} (allow=${opts.allow.size}, 内存已加但未写文件, restart会丢)`);
		return [{ kind: "result", text: "注册成功!直接发消息开始和 AI 聊天编程吧。" }];
	}

	/* ===== 定时任务 (schedule) ===== */
	/** schedule.json 持久路径(每租户 workspace 根)。与 profile/notes 同目录, 随 pullMemory 同步。 */
	function schedFile(sid: string): string { return `${TENANT_ROOT}/${sid}/workspace/schedule.json`; }
	function readSched(sid: string): any[] {
		try { const j = JSON.parse(readFileSync(schedFile(sid), "utf-8")); return Array.isArray(j?.tasks) ? j.tasks : []; } catch { return []; }
	}
	function writeSched(sid: string, tasks: any[]): void {
		try { mkdirSync(`${TENANT_ROOT}/${sid}/workspace`, { recursive: true }); writeFileSync(schedFile(sid), JSON.stringify({ tasks }, null, 2)); } catch (e) { console.error(`[sched] write ${sid} failed: ${String(e).slice(0,160)}`); }
	}
	/** 解析 cron 5段(分 时 日 月 周) 是否匹配给定时间。支持 * , - /  以及 @hourly/@daily 简写。 */
	function cronMatch(expr: string, d: Date): boolean {
		const e = expr.trim().toLowerCase();
		if (e === "@hourly") return d.getMinutes() === 0;
		if (e === "@daily" || e === "@midnight") return d.getMinutes() === 0 && d.getHours() === 0;
		if (e === "@weekly") return d.getMinutes() === 0 && d.getHours() === 0 && d.getDay() === 0;
		const parts = e.split(/\s+/);
		if (parts.length !== 5) return false;
		const field = (val: number, spec: string, min: number, max: number): boolean => {
			for (const seg of spec.split(",")) {
				let lo = min, hi = max;
				if (seg.includes("/")) { const [rng, st] = seg.split("/"); const step = parseInt(st, 10) || 1; if (rng !== "*") lo = parseInt(rng, 10); if (val >= lo && (val - lo) % step === 0 && val <= hi) return true; continue; }
				if (seg.includes("-")) { const [a, b] = seg.split("-").map((x) => parseInt(x, 10)); lo = a; hi = b; }
				else if (seg !== "*") { lo = hi = parseInt(seg, 10); }
				if (val >= lo && val <= hi) return true;
			}
			return false;
		};
		return field(d.getMinutes(), parts[0], 0, 59) && field(d.getHours(), parts[1], 0, 23) &&
			field(d.getDate(), parts[2], 1, 31) && field(d.getMonth() + 1, parts[3], 1, 12) &&
			field(d.getDay(), parts[4], 0, 7);
	}
	/** /schedule list | /schedule add <cron|every:秒> <任务描述> | /schedule del <index> | /schedule clear */
	async function handleSchedule(sid: string, text: string): Promise<OutMsg[]> {
		const rest = text.slice("/schedule".length).trim();
		const tasks = readSched(sid);
		const say = (m: string): OutMsg[] => [{ kind: "result", text: m }];
		if (!rest || rest === "list") {
			if (!tasks.length) return say("还没有定时任务。用法：\n/schedule add 0 9 * * * 每天9点查邮件\n/schedule add every:3600 每小时检查一次\n/schedule del <序号>");
			const lines = tasks.map((t, i) => `${i}. [${t.cron ?? ("every:" + (t.everySec ?? t.everyMs / 1000))}] ${t.task}${t.lastRun ? "（上次 " + new Date(t.lastRun).toLocaleString("zh-CN") + "）" : ""}`);
			return say("定时任务：\n" + lines.join("\n") + "\n\n操作：/schedule del <序号>、/schedule clear");
		}
		if (rest.startsWith("add ")) {
			const body = rest.slice(4).trim();
			// 每秒:600 每小时... 形式 (不用 cron 的简易间隔)
			const em = /^every:(\d+)\s+(.+)$/.exec(body);
			if (em) {
				const everySec = Math.max(30, parseInt(em[1], 10)); // 下限30s防刷
				tasks.push({ task: em[2].trim(), everySec, nextRun: Date.now() + everySec * 1000 });
				writeSched(sid, tasks);
				return say(`已添加：每 ${everySec} 秒执行「${em[2].trim()}」。首次将在 ${Math.round(everySec)} 秒后运行。/schedule list 查看全部。`);
			}
			// cron: 前5个空格分隔字段 + 余下是任务
			const seg = body.split(/\s+/);
			if (seg.length >= 6) {
				const cron = seg.slice(0, 5).join(" ");
				const task = seg.slice(5).join(" ");
				if (!cronMatch(cron, new Date())) { /* 即使当前不匹配也接受 */ }
				tasks.push({ task, cron, nextRun: 0 });
				writeSched(sid, tasks);
				return say(`已添加：「${task}」 cron=${cron}。/schedule list 查看。`);
			}
			return say("用法：/schedule add <cron 5段或 every:秒> <任务>。例：/schedule add 0 9 * * * 每天9点查邮件；/schedule add every:3600 每小时检查");
		}
		if (rest.startsWith("del ")) {
			const i = parseInt(rest.slice(4).trim(), 10);
			if (isNaN(i) || i < 0 || i >= tasks.length) return say("序号无效。/schedule list 查看。");
			const rm = tasks.splice(i, 1)[0];
			writeSched(sid, tasks);
			return say(`已删除：${rm.task}`);
		}
		if (rest === "clear") { writeSched(sid, []); return say("已清空全部定时任务。"); }
		return say("用法：/schedule list | /schedule add <cron|every:秒> <任务> | /schedule del <序号> | /schedule clear");
	}

	/* ===== 宿主持久调度器 (P1) ===== */
	/** 进程级、独立于 session。启动即跑(见 init 调用)，每 60s 扫全部租户 schedule.json：
	 *  到点的任务 -> 主动开会话(ensure+runOnce)执行 -> 更新 nextRun/lastRun。重启后自动从文件恢复。 */
	function startScheduler(): void {
		let lastScan = 0;
		setInterval(() => {
			const now = Date.now();
			if (now - lastScan < 55_000) return; // ~60s 一扫(定时器drift容差)
			lastScan = now;
			console.log(`[sched] scan tick @${new Date().toISOString().slice(11,19)}`);
			let root = "";
			try { root = TENANT_ROOT; } catch { return; }
			let sids: string[] = [];
			try { sids = readdirSync(root).filter((d) => { try { return statSync(`${root}/${d}/workspace/schedule.json`).isFile(); } catch { return false; } }); } catch { return; }
			for (const sid of sids) {
				const tasks = readSched(sid);
				if (!tasks.length) continue;
				let changed = false;
				for (const t of tasks) {
					if (!t || !t.task) continue;
					let due = false;
					if (t.cron) {
						// cron: 到匹配的分钟且距上次运行>55s 才触发(防同分钟重触发)
						const d = new Date();
						if (cronMatch(t.cron, d) && (!t.lastRun || now - t.lastRun > 61_000)) due = true;
						if (!due && !t.nextRun) t.nextRun = 0;
					} else if (t.everySec || t.everyMs) {
						const ivMs = t.everyMs ?? (t.everySec ?? 60) * 1000;
						if (!t.nextRun) { t.nextRun = now + ivMs; changed = true; } // 初始化必须落盘
						if (now >= t.nextRun) { due = true; }
					}
					console.log(`[sched] task "${String(t.task).slice(0,30)}" due=${due} nextRun=${t.nextRun} now=${now}`);
					if (!due) continue;
					// 到点 -> 主动开会话执行(异步,不阻塞扫描)
					t.lastRun = now;
					t.nextRun = t.cron ? 0 : now + (t.everyMs ?? (t.everySec ?? 60) * 1000);
					changed = true;
					console.log(`[sched] sid=${sid} DUE -> "${String(t.task).slice(0, 80)}"`);
					void (async () => {
						try {
							let tenant = tenants.get(sid);
							if (!tenant) { tenant = { sid, sandboxId: "", session: null, unsub: null, chatKey: `sched:${sid}`, lastSeen: Date.now(), busy: false, suspended: false }; tenants.set(sid, tenant); }
							const prev = locks.get(sid) ?? Promise.resolve();
							const j = prev.catch(() => {}).then(async () => {
								if (tenant!.busy) { // 忙则跳过本轮,下次再触发
									console.log(`[sched] sid=${sid} busy, skip`);
									return;
								}
								tenant!.busy = true;
								try {
								// 定时任务同样走惰性：只建 session；task 型消息会调工具，天然触发 __lazyEnsureSandbox 建沙箱。
								// WG_LAZY_SANDBOX=0 回退旧行为。
								if (process.env.WG_LAZY_SANDBOX === "0") await ensure(tenant!);
								else await ensureSession(tenant!);
								await runWithSid(tenant!.sid, () => runOnce(tenant!, `[定时任务] ${t.task}`));
							}
								finally { tenant!.busy = false; tenant!.lastSeen = Date.now(); try { await pullMemory(tenant!); } catch {} }
							});
							locks.set(sid, j.catch(() => {}));
							await j;
						} catch (e) { console.error(`[sched] sid=${sid} run failed: ${String(e).slice(0, 160)}`); }
					})();
				}
				if (changed) writeSched(sid, tasks);
			}
		}, 10_000); // 每10s检查但内部节流到60s,响应快且省
		console.log("[sched] scheduler started (scan ~60s, persist across sessions)");
	}

	/** /secret <名> <值> 存；/secret list 列名；/secret del <名> 删。值不回显、不进 LLM */
	async function handleSecret(sid: string, text: string): Promise<OutMsg[]> {
		const rest = text.slice("/secret".length).trim();
		const dir = `${SECRETS_ROOT}/${sid}`;
		if (!rest || rest === "list") {
			let names: string[] = [];
			try { names = (await readdir(dir)).filter((n) => SECRET_NAME_RE.test(n)); } catch {}
			return [{ kind: "result", text: names.length ? `已存：${names.join(", ")}（沙箱 /ws/.secrets/<名>）` : "还没有 secret。用法 /secret <名字> <值>，如 /secret github_pat ghp_xxx" }];
		}
		if (rest.startsWith("del ")) {
			const n = rest.slice(4).trim();
			if (!SECRET_NAME_RE.test(n)) return [{ kind: "result", text: "名字只能是字母/数字/. _ -（≤64）。" }];
			try { await rm(`${dir}/${n}`); } catch {}
			return [{ kind: "result", text: `已删除 ${n}。` }];
	}
		const sp = rest.indexOf(" ");
		if (sp < 0) return [{ kind: "result", text: "用法：/secret <名字> <值>" }];
		const name = rest.slice(0, sp).trim();
		const value = rest.slice(sp + 1);
		if (!SECRET_NAME_RE.test(name)) return [{ kind: "result", text: "名字只能是字母/数字/. _ -（≤64）。" }];
		if (!value) return [{ kind: "result", text: "值为空。" }];
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await writeFile(`${dir}/${name}`, value, { mode: 0o600 });
		await chmod(`${dir}/${name}`, 0o600);
		const t = tenants.get(sid);
		let pushed = 0;
		if (t?.sandboxId && isBound(sid)) {
			try { pushed = await pushSecrets(sid, t.sandboxId); } catch (e) { console.error(`[tenant] sid=${sid} secret push failed: ${String(e).slice(0,200)}`); }
		}
		return [{ kind: "result", text: `已保存 ${name}（沙箱 /ws/.secrets/${name}）${pushed ? "，已推入当前沙箱" : "，下次建沙箱自动注入"}。值不回显、不进 AI 上下文。` }];
	}

	function reapIdle(now = Date.now()): Promise<void> {
		const jobs: Promise<void>[] = [];
		for (const t of [...tenants.values()]) {
			if (!t.busy && now - t.lastSeen > idleMs) jobs.push(suspend(t));
		}
		return Promise.all(jobs).then(() => undefined);
	}
	setInterval(() => void reapIdle(), 60_000).unref?.();
	// P1 定时任务调度器: 进程级、独立session、重启从schedule.json恢复
	setTimeout(() => { try { startScheduler(); } catch (e) { console.error("[sched] start failed: " + String(e).slice(0, 120)); } }, 3_000).unref?.();

	/**
	 * 进化系统: 消息注入接口 (供外部测试系统控制生产系统定向测试)
	 * 直接调用 handle() 函数, 绕过 WhatsApp 网关
	 */
	async function injectMessage(msg: InMsg): Promise<OutMsg[]> {
		console.log(`[injectMessage] sid=${sidFor(msg)} platform=${msg.platform} type=${msg.msgType || "text"} text=${msg.text.slice(0, 50)}`);
		return handle(msg);
	}

	// 方案1(进化系统#5反思): 外部立即 abort 信号 —— 绕过消息队列, 直接中断进行中 run。
	// 供 bot.ts INJECT 轮询在 text==="/stop" 时调用, 不排在 deliver/tool 超时循环后面。
	(globalThis as any).__abortActive = (onlySid?: string): { stopped: boolean; text: string } => {
		let hit = false;
		for (const t of tenants.values()) {
			if (onlySid && t.sid !== onlySid) continue;
			if (!t.session) continue;
			hit = true;
			try { void t.session.abort(); } catch { /* 幂等 */ }
				(t as any).stopped = true;
		}
		console.log(`[__abortActive] sid=${onlySid ?? "*"} hit=${hit}`);

	// _stopSignal: 供 clawsandbox-ext deliver.pages-check 循环查, /stop 后立即 break 不跑满90s
	(globalThis as any).__isStopped = (sid?: string): boolean => {
		for (const t of tenants.values()) {
			if (sid && t.sid !== sid) continue;
			if ((t as any).stopped) return true;
		}
		return false;
	};
		return hit ? { stopped: true, text: "已中止当前任务(立即中断)。" } : { stopped: false, text: "没有进行中的任务。" };
	};
	return {
		handle,
		injectMessage, // 进化系统: 外部测试注入
		reapIdle, // 导出给测试：不用真等 30 分钟
		list: () => [...tenants.values()],
		dropAll: () => Promise.all([...tenants.values()].map((t) => drop(t))),
	};
}