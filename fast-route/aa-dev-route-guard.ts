/**
 * aa-dev-route-guard.ts —— 开发类请求机械守卫（prompt 三连败后的工具级执法）
 *
 * 背景：skillGuide 规则两轮被租户模型绕过（"开发一套crm系统"两次本地糊单页交付）。
 * 本守卫不再依赖文本意图判断：**本轮任何写类/交付类工具，在 dispatch_dev 被调用之前一律拦截**，
 * 迫使模型把请求交给规划官分级。规划官 bounce=LOCAL_OK 放行本地（轻活多花一次零成本调用），
 * dispatch=正式工单。误拦由 BLOCK_LIMIT 降级兜底（照 finalize-guard 惯例）。
 *
 * 事件：before_agent_start（每轮重置）+ tool_call（拦截）
 * 拦截合同：return { block: true, reason } （finalize-guard 实证格式）
 * 放行：dispatch_dev 永不拦；B1 在规划官裁决后置 g.__devRoute_<sid>.called=true
 * 卸载：删本文件 + 去 unit -v + 重启即回退
 */

const BLOCK_TOOLS = new Set([
	"sbx_write",
	"sbx_edit",
	"sbx_bash",
	"sandbox_write",
	"deliver_local",
	"deliver",
	"doc_pack",
	"img_ops",
	"img_lab",
]);
const BLOCK_LIMIT = 5; // 连续拦截上限，超过降级放行防死锁（finalize-guard 惯例）

type G = Record<string, unknown>;
const g = globalThis as unknown as G;

function sidOf(): string {
	const s = g.__currentSid;
	return typeof s === "string" && s ? s : "";
}

type RouteState = { called: boolean; blocked: number };

function stateOf(sid: string): RouteState | undefined {
	const st = g[`__devRoute_${sid}`];
	return st && typeof st === "object" ? (st as RouteState) : undefined;
}

export default function devRouteGuard(pi: {
	on: (event: string, handler: (event: unknown) => unknown) => void;
}) {
	pi.on("before_agent_start", () => {
		try {
			const s = sidOf();
			if (s) g[`__devRoute_${s}`] = { called: false, blocked: 0 };
		} catch {
			/* fail-open */
		}
	});

	pi.on("tool_call", (event: unknown) => {
		try {
			const ev = (event ?? {}) as { toolName?: string; tool?: string; name?: string; args?: unknown };
			const name = String((ev as Record<string, unknown>).toolName ?? ev.tool ?? ev.name ?? "");
			if (!name) return undefined;
			if (name === "dispatch_dev") return undefined; // 放行阀：永不拦截
			const s = sidOf();
			if (!s) return undefined;
			const st = stateOf(s);
			if (!st || st.called) return undefined; // 已过规划官 → 放行

			if (!BLOCK_TOOLS.has(name)) return undefined; // 只拦写类/交付类

			st.blocked += 1;
			if (st.blocked > BLOCK_LIMIT) {
				// 降级放行防死锁（fail-open），留告警
				console.warn(`[dev-route-guard] BLOCK_LIMIT 降级放行 sid=${s} tool=${name} (已拦 ${st.blocked - 1} 次，模型未调 dispatch_dev)`);
				st.called = true;
				return undefined;
			}
			console.warn(`[dev-route-guard] BLOCK tool=${name} sid=${s} n=${st.blocked}`);
			return {
				block: true,
				terminate: false,
				reason:
					"【分诊路由门禁】本轮涉及构建/写操作：必须先调 dispatch_dev 把需求交给规划官分级（调用零成本，不是开单承诺——规划官可判 LOCAL_OK 放你本地继续，或出规格开正式工单）。先调 dispatch_dev（request=用户原话，context=近期对话摘要），拿到结果后再继续原操作。",
			};
		} catch {
			return undefined; // fail-open
		}
	});
}
