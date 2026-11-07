/**
 * Personal Assistant Extension — 外围实现，不改 wagate 原设计。
 *
 * 两部分：
 *  ① 持续工作：session_start 读取工作区 schedule.json，为每个任务起定时器，
 *     到点用 pi.sendMessage(..., { triggerTurn: true }) 主动唤醒 AI 执行任务。
 *     定时器在 session_shutdown 里幂等清理。
 *  ② 永久记忆（无条件加载）：before_agent_start 每一轮把 profile.md / notes.md
 *     的内容拼进 systemPrompt，绕开 skill 的概率触发，保证每轮都在场。
 *
 * 生命周期纪律（docs/extensions.md）：
 *  - 工厂函数只注册 handler，绝不起 timer/watcher/process。
 *  - 长生命周期资源（定时器）在 session_start 起。
 *  - 清理放 session_shutdown，且幂等。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
type Globals = { __currentSid?: string; __tenantRoot?: string } & Record<string, unknown>;
const G = globalThis as Globals;

/** 记忆文件：与工作区同目录（wagate 里即 /ws 工作区根）。 */
const MEMORY_FILES = ["profile.md", "notes.md"];
/** 方案2(懒加载): 记忆总长 <= 此值时整段内联(小记忆零回归); 否则只注入清单, 正文按需 read。 */
const WAGATE_EAGER_MEM_MAX = Number(process.env.WAGATE_EAGER_MEM_MAX ?? 400);
/** 任务定义文件：同工作区根。 */
const SCHEDULE_FILE = "schedule.json";
/** 单个记忆文件注入时的截断上限，避免撑爆 system prompt。 */
const MAX_MEMORY_CHARS = 4000;

type ScheduleTask = {
	task: string; // 任务描述，直接交给 AI 执行
	everySec?: number; // 触发间隔（秒）
	everyMs?: number; // 触发间隔（毫秒），优先于 everySec
	delaySec?: number; // 首次触发延迟（秒），默认 0
};

type ScheduleFile = {
	tasks: ScheduleTask[];
};

/** 从记忆文本提取用户声明的身份/称呼（取名X/叫我X/我是X/你是X/称呼X）；匹配到返回身份行，否则空。 */
function extractIdentity(memText: string): string {
	if (!memText) return "";
	// 优先取 profile.md 里的 "## 身份" 结构化段
	const sec = memText.match(/##\s*身份\s*\n+([^\n#]+)/);
	if (sec && sec[1].trim()) {
		const v = sec[1].trim().replace(/^-\s*/, "");
		return `【身份指令】这位用户给你取的名字/称呼是「${v}」。你必须称呼用户为「${v}」，并自认是「${v}」机器人。当用户问"我是谁/你叫我什么/我叫什么"时，直接答「${v}」。`;
	}
	// 回退：从原文找用户给助手取名/称呼的声明
	const m = memText.match(/[^\n]*(?:给我取名|给我取名叫|取名叫|叫我|称呼我|你是我的|我的名字是)[^\n]*/);
	if (m) {
		const line = m[0].trim().slice(0, 120);
		if (line) return `【身份指令】用户身份声明：${line}。据此称呼用户、自认身份。`;
	}
	return "";
}

/** 读一个记忆文件，返回带标注的片段；不存在/空则返回空串。 */
function readMemory(cwd: string, file: string): string {
	try {
		const p = path.join(cwd, file);
		if (!fs.existsSync(p)) return "";
		const raw = fs.readFileSync(p, "utf-8").trim();
		if (!raw) return "";
		const clipped =
			raw.length > MAX_MEMORY_CHARS ? raw.slice(0, MAX_MEMORY_CHARS) + "\n…(已截断)" : raw;
		return `### ${file}\n${clipped}`;
	} catch {
		return "";
	}
}

/** 读任务定义；解析失败一律当“无任务”，不抛错。 */
function readSchedule(cwd: string): ScheduleTask[] {
	try {
		const p = path.join(cwd, SCHEDULE_FILE);
		if (!fs.existsSync(p)) return [];
		const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as ScheduleFile;
		if (!parsed || !Array.isArray(parsed.tasks)) return [];
		return parsed.tasks.filter(
			(t) => t && typeof t.task === "string" && t.task.trim() !== "",
		);
	} catch {
		return [];
	}
}

export default function personalAssistant(pi: ExtensionAPI) {
	console.log("[personal-assistant] 扩展工厂函数已执行");

	// 会话作用域状态
	let cwd: string | undefined; // session_start 记下，before_agent_start 用
	let handles: Array<ReturnType<typeof setInterval>> = []; // 所有定时器句柄
	let started = false; // 幂等标记
	let lastUserText = ""; // agent_end 记住本轮用户输入
	let turnHadTool = false; // agent_end 检测本轮是否调用了工具

	// ②-永久记忆 + 记录 cwd
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		if (started) return; // 幂等：重复 start 不叠加定时器
		started = true;

		// ①-持续工作：为每个任务挂定时器（工厂里绝不起 timer）。
		const tasks = readSchedule(ctx.cwd);
		for (const t of tasks) {
			const everyMs = t.everyMs ?? (t.everySec !== undefined ? t.everySec * 1000 : undefined);
			if (everyMs === undefined || everyMs <= 0) continue;
			const delayMs = (t.delaySec ?? 0) * 1000;

			const fire = () => {
				try {
					pi.sendMessage(
						{
							customType: "scheduled-task",
							content: `[定时任务] ${t.task}`,
							display: true,
						},
						{ triggerTurn: true }, // 让 LLM 主动响应并执行
					);
				} catch {
					// 会话可能正在关闭
				}
			};

			// 首次延迟 -> fire -> 进入固定间隔
			const starter = setTimeout(() => {
				fire();
				const iv = setInterval(fire, everyMs);
				iv.unref?.();
				handles.push(iv);
			}, delayMs);
			starter.unref?.();
			handles.push(starter as unknown as ReturnType<typeof setInterval>);
		}

		if (ctx.hasUI && tasks.length > 0) {
			ctx.ui.notify(`personal-assistant: 已加载 ${tasks.length} 个定时任务`, "info");
		}
	});

	// ②-无条件加载记忆到 system prompt（每一轮）
	pi.on("before_agent_start", async (event) => {
		// 兜底 cwd: session_start 事件可能没触发(框架未emit), cwd 永 falsy -> 记忆不写。
		// 用 globalThis.__currentSid(tenant-core 每轮设, project-identity 同源)推 cwd, 每轮刷新。
		const sid = String(G.__currentSid || "");
		if (sid) {
			const tRoot = typeof G.__tenantRoot === "string" && G.__tenantRoot ? G.__tenantRoot : "/srv/tenants";
			cwd = path.join(tRoot, sid, "workspace");
		}
		// 捕获本轮用户输入 (供 agent_end 记忆写入使用)
		turnHadTool = false;
		const userMatch = event.systemPrompt.match(/## User[\s\S]*?\n([^#]+)/);
		lastUserText = userMatch ? userMatch[1].trim().slice(-500) : "";

		// L1-L5 分层检索路由：根据问题类型选择性加载记忆层
		if (cwd) {
			const question = lastUserText.toLowerCase();
			const layers: string[] = [];

			// L5: 用户画像 (身份/偏好/长期目标)
			if (/用户|偏好|喜欢|我是|身份|画像|profile/.test(question)) {
				layers.push("profile.md");
			}

			// L3: 每日总结 (今天/最近事件)
			if (/今天|最近|今日|当天|daily/.test(question)) {
				const today = new Date().toISOString().slice(0, 10);
				layers.push(`daily/${today}.md`);
			}

			// L4: 每周总结 (这周/趋势)
			if (/这周|本周|每周|周报|趋势|weekly/.test(question)) {
				const now = new Date();
				const weekNum = getWeekNumber(now);
				const weekStr = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
				layers.push(`weekly/${weekStr}.md`);
			}

			// L2: 会话摘要 (上次/会话)
			if (/上次|上次会话|之前|历史|会话|session/.test(question)) {
				const sessionsDir = path.join(cwd, "sessions");
				if (fs.existsSync(sessionsDir)) {
					const recent = fs.readdirSync(sessionsDir).sort().pop();
					if (recent) layers.push(`sessions/${recent}`);
				}
			}

			// L1: 原始日志 (精确事实/细节)
			if (/具体|细节|原文|逐字|精确|log/.test(question)) {
				const logsDir = path.join(cwd, "logs");
				if (fs.existsSync(logsDir)) {
					const todayLog = path.join(logsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
					if (fs.existsSync(todayLog)) layers.push(`logs/${todayLog}`);
				}
			}

			console.log(`[personal-assistant] 检索路由: layers=[${layers.join(", ")}] question="${question.slice(0, 80)}"`);

			// 加载选中的记忆层
			if (layers.length > 0) {
				const loadedMemories = layers.map(f => {
					try {
						const pth = path.join(cwd, f);
						if (!fs.existsSync(pth)) return null;
						const content = fs.readFileSync(pth, "utf8");
						return `### ${f}\n${content.slice(0, 2000)}`; // 每层限制 2KB
					} catch { return null; }
				}).filter(Boolean);

				if (loadedMemories.length > 0) {
					const routingPrompt = `

## 五层记忆路由 (L1-L5 分层检索)

根据问题类型，已自动加载相关记忆层：
${loadedMemories.join("\n\n")}
`;
					return { systemPrompt: event.systemPrompt + routingPrompt };
				}
			}
		}

		// 岗位技能盘点引导：无条件注入（放在记忆 early-return 之前）。
		// 只给 name+description 层面的引导，不预载 SKILL.md 正文（省 token，正文按需用 read 读 <location>）。
		const skillGuide = `

## 技能包库（按需查询，禁止出网）

技能包库只在本机文件系统 /root/.pi/agent/skills/（100 个岗位技能，分属 sales、data、legal、productivity、customer-support、product-management、marketing、finance、enterprise-search、bio-research、cowork-plugin-management 等岗位）。**库是本地目录，不在网络上。**

### 11 岗位 → 技能索引（回答"有哪些岗位/某岗位技能"直接用此段，无需 ls）
- **finance** (8): financial-statements, forecast, journal-entry, journal-entry-prep, metrics-review, performance-report, reconciliation, variance-analysis
- **sales** (21): account-context, account-plan, account-research, account-tiering, call-prep, call-summary, close-management, close-plan +13更多
- **data** (10): build-dashboard, create-viz, data-context-extractor, data-visualization, explore-data, instrument-data-to-allotrope, sql-queries, statistical-analysis +2更多
- **legal** (9): audit-support, compliance-check, legal-response, legal-risk-assessment, review-contract, seo-audit, signature-request, sox-testing +1更多
- **productivity** (30): analyze, brief, competitive-brief, competitive-intelligence, create-an-asset, crm-hygiene-check, customer-research, daily-briefing +22更多
- **customer-support** (5): customer-escalation, customer-health, customer-voice, kb-article, ticket-triage
- **product-management** (3): product-brainstorming, sprint-planning, write-spec
- **marketing** (6): brand-review, campaign-plan, content-creation, draft-content, draft-outreach, email-sequence
- **enterprise-search** (2): knowledge-synthesis, source-management
- **bio-research** (4): nextflow-development, scientific-problem-selection, scvi-tools, single-cell-rna-qc
- **cowork-plugin-management** (2): cowork-plugin-customizer, create-cowork-plugin
(共 100 技能归入 11 岗位; 完整列表仍 ls /root/.pi/agent/skills)

查库规则（务必遵守，避免无谓耗时）：
1. **清单类问答（有哪些技能/某岗位有什么/你会什么）直接用上面索引段文字回答，不调任何工具**（秒回快路径；索引段已覆盖全部 11 岗位与代表技能）。
2. 用户要某技能的**详细用法/执行指导**，或问索引段没有的信息：调 skill_read（参数 name=技能目录名）只读那一个 SKILL.md，一次即可。
3. 仅当用户明确要"完整最新清单"（怀疑索引不全）时才调 skill_ls；bash/sbx_* 读不到宿主技能库，勿再尝试。
4. **技能问答 = 纯文字回答（最高优先级）**：问答即本轮完成。**禁止**调 select_project、sbx_write 建展示页/hub 页、deliver——回答问题不需要项目。只有用户明确要求"开发/做一个 X 应用/页面"才走项目流程。
3. 回答"有哪些岗位/技能/能力/你会什么/会不会做某事"时，优先用上面"11 岗位 → 技能索引"段直接作答（无需 ls）；要全量再 ls，据目录名说明有哪些、能做什么；要细节才 read 单个 SKILL.md。
4. **严禁为回答技能问题触发 network_egress 或任何出网**——技能包是本地 SKILL.md，不是网络资源，出网只会白等超时。
5. 技能包不是沙箱里的 docx/pdf 实体文件，不要去 /ws、/work 找"工作包"文件。

## 环境探测要快（防止单次执行卡几十秒）

- 任务需要确认运行环境时（如"能不能开发软件""环境有没有 python/node/gcc"），**用一条命令一次性并行/合并探测**，例如 \`command -v python3 node gcc; python3 -V\` 一次跑完，**禁止串行逐个探测、禁止逐个 curl/ping pypi/npm/github 连通性**。
- **不要一上来就全量验证所有依赖和所有网络目标**——连通性通常默认可用，只在真正需要下载/联网那一步再验，且只验当前要用的那一个目标。
- 探测类命令控制在 **1-2 次、单次秒回**；如果某步涉及网络且可能慢，**宁可先给结论、告诉用户将要做什么，也不要为"确认可达"空等几十秒**。
- 单次执行一旦接近超时即说明探测过重，应立即收敛、用已有信息作答，不要重试同样的全量探测。

一次 ls 就能回答的问题，不要跑多轮工具；控制在 1-2 次工具调用内给出答案。

【分诊路由 · 开发类需求（最高优先级，覆盖其它交付习惯）】
- 触发词即派单：需求含「系统 / 平台 / app / 后台 / 管理端 / 数据库 / 多用户 / 完整 / 全套 / 上线」任一词，或需要多个页面/模块协作 → 第一个动作就是调 dispatch_dev（附 context=近期对话摘要），禁止先本地构思或建文件。
- 判断不了轻重 → 也调 dispatch_dev 让规划官分级（它可打回 LOCAL_OK，那时本地做不迟；调用本身零成本，不是开单承诺）。
- 只有「明确单页 / 单文档 / 问答 / 小改」才直接本地做；交付前自查：若产物已长成多文件多模块 → 停止交付，改调 dispatch_dev。
- 规划官返回 LOCAL_OK → 才本地做；返回追问 → 转问用户；返回工单 → 停止本地开发，把链接转达用户。
- 用户要「本地简版」时：仅单页 / 文档级，禁多模块；超界再提示转工单。
`;

	// 工具调用铁律：每次 assistant 消息最多 8 个工具（防 toolCall 爆发）
	const oneToolRule = `

## 工具调用铁律（绝对强制，违反即任务失败）

**每次 assistant 消息最多允许调用 8 个工具**——可以并行调用最多 8 个，但绝不在同一条消息里塞超过 8 个 toolCall。

- 需要多个操作？分批推进：这次最多发 8 个工具调用（可并行），等结果回来，再发下一批。
- 这是硬性规则，不是建议。最多 8 个/消息，绝不爆发到几十个。
- 哪怕任务复杂、步骤多，也严格最多 8 个工具调用/消息，逐步推进到交付。
`;
		const basePrompt0 = event.systemPrompt + oneToolRule + skillGuide;
		// 身份/称呼置顶: 从 profile 提取"取名X/叫我X"，放 prompt 最前确保每轮必见(不被尾部记忆淹没)。
		let idLine = "";
		if (cwd) {
			for (const f of MEMORY_FILES) {
				idLine = extractIdentity(readMemory(cwd, f));
				if (idLine) break;
			}
		}
		// basePrompt 不含 idLine; idLine 用 finish() 追加到 systemPrompt 最末尾(紧邻用户问题, 避开头稀释, 提高模型对身份指令的遵从度)。
		const basePrompt = basePrompt0;
		// 就地 prepend 到 ev.systemPrompt(已弃用: 框架只读 result.systemPrompt, mutate 无效。保留判空避免误改)。
		console.log(`[pa-identity] cwd=${cwd ?? "-"} idLine=${JSON.stringify(idLine)}`);
		// finish: 把身份指令追加到 systemPrompt 最末尾。idLine 空则原样返回。
		const finish = (p: string): string => (idLine ? `${p}\n\n${idLine}` : p);
		if (!cwd) return { systemPrompt: finish(basePrompt) };
		const snippets = MEMORY_FILES.map((f) => readMemory(cwd, f)).filter(Boolean);
		if (snippets.length === 0) return { systemPrompt: finish(basePrompt) };
		const memTotal = snippets.join("\n\n").length;
		if (memTotal <= WAGATE_EAGER_MEM_MAX) {
			// 小记忆: 整段内联(与原行为一致, 零回归)
			return {
				systemPrompt:
					finish(basePrompt +
					`

## 个人永久助理 · 长期记忆

以下是本助手为这位用户维护的长期记忆（跨会话持久，存于工作区），每轮对话前都已为你加载：
请据此延续上下文、保持一致。若用户透露新的重要事实或偏好，主动用编辑工具更新对应文件
（profile.md 记身份/偏好，notes.md 记事件/待办/结论），让记忆随对话增长。

${snippets.join("\n\n")}
`),
			};
		}
		// 大记忆: 方案2 懒加载 —— 只注入清单(省 token), 正文按需 read, 避免每轮撑爆 system prompt。
		const listing = MEMORY_FILES.map((f) => {
			try {
				const pth = path.join(cwd, f);
				const st = fs.statSync(pth);
				return `- ${f}（${st.size} 字节）`;
			} catch { return `- ${f}（缺失）`; }
		}).join("\n");
		return {
			systemPrompt:
				finish(basePrompt +
				`

## 个人永久助理 · 长期记忆（按需加载，正文未内联）

该用户的长期记忆存在工作区文件里（较大，为省 token 本轮不内联）。**当任务/对话涉及该用户的身份、偏好、历史事件、待办或需要延续上下文时，先用 read 工具读取所需文件再作答**；无关任务不必读。

记忆文件（工作区 ${cwd}）：
${f.join("\n")}

规则：涉及用户身份/偏好/历史/待办 → 至少读 profile.md；需要近期事件/结论 → 读 notes.md。读到即延续，读不到就按无记忆处理。若用户透露新的重要事实，主动用编辑工具更新对应文件。
`),
		};

		return {
			systemPrompt:
				finish(basePrompt +
				`

## 个人永久助理 · 长期记忆

以下是本助手为这位用户维护的长期记忆（跨会话持久，存于工作区），每轮对话前都已为你加载：
请据此延续上下文、保持一致。若用户透露新的重要事实或偏好，主动用编辑工具更新对应文件
（profile.md 记身份/偏好，notes.md 记事件/待办/结论），让记忆随对话增长。

${snippets.join("\n\n")}
`),
		};
	});

	// ③-记忆强制写入兜底: 模型如果没调用工具写入记忆，这里强制追加
	pi.on("tool_execution_start", async () => {
		turnHadTool = true;
	});

	pi.on("message_end", async (event) => {
		if (!cwd) return;
		// 捕获用户输入(role=user轮), 供同轮及后续 L5 写入 — 不依赖 ## User(systemPrompt 无此标题)
		if (event?.message?.role === "user") {
			const ut = (event.message as any)?.content?.[0]?.text;
			if (ut) lastUserText = String(ut).trim().slice(-500);
			return;
		}
		if (event?.message?.role !== "assistant") return;

		// L1: 原始对话日志 (JSONL, 7天保留)
		try {
			const logDir = path.join(cwd, "logs");
			if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
			const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
			const logEntry = {
				timestamp: new Date().toISOString(),
				role: event.message.role,
				content: (event.message as any).content?.[0]?.text ?? "",
				turnHadTool,
				lastUserText: lastUserText.slice(-200),
			};
			fs.appendFileSync(logFile, JSON.stringify(logEntry) + "\n");

			// 清理 7 天前的日志
			const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
			for (const f of fs.readdirSync(logDir)) {
				const fp = path.join(logDir, f);
				if (fs.statSync(fp).mtimeMs < weekAgo) fs.unlinkSync(fp);
			}
		} catch (e) {
			console.error(`[personal-assistant] L1 日志写入失败: ${e}`);
		}

		// L5: 默认全部进5层记忆(用户要求: 所有聊天默认写, 不靠关键词筛)
		// 保留 lastUserText 非空(没用户输入写无意义) + turnHadTool(防工具轮污染)
		if (!lastUserText || turnHadTool) return;

		try {
			const profilePath = path.join(cwd, "profile.md");
			const template = "# 用户偏好\n\n## 代码风格\n- \n\n## 沟通方式\n- \n\n## 技术栈\n- \n";
			const existing = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : template;
			const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
			const entry = `\n\n## 对话记录 ${timestamp}\n${lastUserText}\n`;

			if (!existing.includes(lastUserText.slice(0, 50))) {
				fs.writeFileSync(profilePath, existing + entry);
				console.log(`[personal-assistant] L5 强制写入: ${profilePath}`);
			}
		} catch (e) {
			console.error(`[personal-assistant] L5 写入失败: ${e}`);
		}
	});

	// L2: 会话摘要生成 + L3/L4 聚合触发
	pi.on("session_shutdown", async () => {
		if (cwd) {
			try {
				// L2: 生成会话摘要
				const sessionsDir = path.join(cwd, "sessions");
				if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

				const now = new Date();
				const dateStr = now.toISOString().slice(0, 10);
				const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "");
				const sessionFile = path.join(sessionsDir, `${dateStr}-${timeStr}.md`);

				const sessionSummary = `# 会话摘要 ${dateStr} ${timeStr}

## 用户目标
- ${lastUserText.slice(0, 100) || "继续对话"}

## 完成事项
- ${turnHadTool ? "执行了工具调用" : "纯文本对话"}

## 关键结论
- 会话已结束，摘要自动生成

## 待办
- [ ] 无
`;

				fs.writeFileSync(sessionFile, sessionSummary);
				console.log(`[personal-assistant] L2 会话摘要: ${sessionFile}`);

				// L3: 每日总结聚合 (每天首次 session_shutdown 时生成)
				const dailyDir = path.join(cwd, "daily");
				if (!fs.existsSync(dailyDir)) fs.mkdirSync(dailyDir, { recursive: true });

				const dailyFile = path.join(dailyDir, `${dateStr}.md`);
				const todaySessions = fs.readdirSync(sessionsDir).filter(f => f.startsWith(dateStr));

				if (todaySessions.length === 1) {
					// 当天首次会话，创建每日总结
					let dailyContent = `# 每日总结 ${dateStr}\n\n## 关键事件\n`;
					for (const sf of todaySessions) {
						const content = fs.readFileSync(path.join(sessionsDir, sf), "utf8");
						const goalMatch = content.match(/## 用户目标\n- (.+)/);
						dailyContent += `- ${sf}: ${goalMatch?.[1] ?? "无目标"}\n`;
					}
					fs.writeFileSync(dailyFile, dailyContent);
					console.log(`[personal-assistant] L3 每日总结: ${dailyFile}`);

					// L4: 每周总结聚合 (每周一首次 session_shutdown 时生成)
					const weekday = now.getDay(); // 0=Sunday, 1=Monday
					if (weekday === 1) {
						const weeklyDir = path.join(cwd, "weekly");
						if (!fs.existsSync(weeklyDir)) fs.mkdirSync(weeklyDir, { recursive: true });

						const weekNum = getWeekNumber(now);
						const weekStr = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
						const weeklyFile = path.join(weeklyDir, `${weekStr}.md`);

						if (!fs.existsSync(weeklyFile)) {
							const weekStart = new Date(now);
							weekStart.setDate(now.getDate() - weekday + 1); // Monday
							const weekDates = Array.from({ length: 7 }, (_, i) => {
								const d = new Date(weekStart);
								d.setDate(weekStart.getDate() + i);
								return d.toISOString().slice(0, 10);
							});

							let weeklyContent = `# 每周总结 ${weekStr}\n\n## 趋势\n`;
							for (const wd of weekDates) {
								const df = path.join(dailyDir, `${wd}.md`);
								if (fs.existsSync(df)) {
									const dc = fs.readFileSync(df, "utf8");
									const eventMatch = dc.match(/## 关键事件\n([\s\S]*?)(\n\n|$)/);
									if (eventMatch) {
										weeklyContent += `- ${wd}: ${eventMatch[1].trim().split("\n")[0]}\n`;
									}
								}
							}
							weeklyContent += `\n## 模式\n- 记忆系统五层架构运行中\n`;

							fs.writeFileSync(weeklyFile, weeklyContent);
							console.log(`[personal-assistant] L4 每周总结: ${weeklyFile}`);
						}
					}
				}
			} catch (e) {
				console.error(`[personal-assistant] L2/L3/L4 生成失败: ${e}`);
			}
		}

		for (const h of handles) {
			try {
				clearInterval(h);
				clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
			} catch {
				// ignore
			}
		}
		handles = [];
		started = false;
		cwd = undefined;
	});
}

// 计算 ISO 周数
function getWeekNumber(d: Date): number {
	const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const dayNum = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
	return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}