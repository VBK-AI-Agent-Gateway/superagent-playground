/**
 * 插件: aa-stop-after-deliver —— deliver 成功后结束本轮
 *   (新增; 不改核心、不改现有插件、不 docker build)
 *
 * 背景(核心补丁 TC_STOPAFTER_TURN_V1 的插件化替代):
 *   deliver 成功时返回 {terminate:true}。pi 的 shouldTerminateToolBatch 只保证「退内层工具循环」,
 *   之后外层 runLoop 仍会 getFollowUpMessages() 拉回内部续跑消息(settle/HALLU 等通过
 *   prompt(text,{streamingBehavior:...}) 排队的 follow-up/steer) -> 变成「已交付还继续跑」。
 *
 *   原核心补丁用 session.agent.shouldStopAfterTurn 收尾, 但实测是**死代码**:
 *     (1) pi-coding-agent 从不给 Agent 传 shouldStopAfterTurn (全仓 grep = 0), 插件 ctx 也拿不到 agent/session;
 *     (2) 它读 ctx.toolResults[].terminate, 而 pi 传进来的是 ToolResultMessage
 *         (createToolResultMessage 只带 role/toolCallId/toolName/content/details/usage/isError/timestamp),
 *         根本没有 terminate / result 字段 -> 判定恒 false。
 *     实测 22 天 journal(STOPAFTER_TURN) 触发 0 次, 确认不生效。
 *
 * 本插件用插件真正能拿到的两个官方钩子实现同一意图:
 *   - tool_execution_end: 看到 result.terminate === true (即 deliver 成功) 就下闸(记时间戳);
 *   - input:            下闸后 WINDOW_MS 内、且带 streamingBehavior 的输入 = **内部续跑**
 *                       (pi 只在 prompt(text,{streamingBehavior}) 时发这个事件;
 *                        用户消息走 session.steer() 不经此事件, 插件 steer 走 sendUserMessage 也不经此事件)
 *                       -> 返回 {action:"handled"} 吞掉。队列不增长 -> 外层 runLoop 无消息可续 -> agent_end 干净收尾。
 *
 * 边界: 只吞「已交付之后的内部续跑」, 绝不吞用户消息、绝不替模型产出、绝不编造交付内容。全程 fail-open。
 * 热回滚: globalThis.__stopAfterDeliver = false (即时失效, 无需重启)。
 * 彻底回滚: 删本文件 + 去掉 wagate.service 里对应 -v 挂载 + daemon-reload + restart。
 */
const G = globalThis as Record<string, any>;

/** 交付成功后的抑制窗口(内部续跑才会落在这窗口内) */
const WINDOW_MS = 300_000;
/** per-sid 交付完成时间戳 */
const state: Record<string, number> = (G.__stopAfterDeliverAt ??= {}) as Record<string, number>;

function sidOf(): string {
	return typeof G.__currentSid === "string" ? G.__currentSid : "*";
}

export default function aaStopAfterDeliver(pi: {
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}) {
	// 1) deliver 成功 (result.terminate === true) -> 下闸
	// locdeliv6: 新轮开始 -> 清除上一轮交付闸（跨轮误吞纠正 steer 的修复）
	pi.on("before_agent_start", () => {
		try {
			const s = typeof G.__currentSid === "string" ? G.__currentSid : "";
			if (s && state[s]) { delete state[s]; console.log(`[stop-after-deliver] new round -> gate cleared sid=${s}`); }
		} catch { /* fail-open */ }
	});
	pi.on("tool_execution_end", (event: unknown) => {
		try {
			if (G.__stopAfterDeliver === false) return;
			const ev = event as Record<string, any> | null | undefined;
			const _dlOk = ev?.toolName === "deliver_local" && ev?.result?.isError !== true; if (ev?.result?.terminate !== true && !_dlOk) return;
			const s = sidOf();
			state[s] = Date.now();
			console.log(
				`[stop-after-deliver] deliver done (terminate) sid=${s} tool=${ev.toolName} -> 抑制后续内部续跑 ${WINDOW_MS / 1000}s (plugin)`,
			);
		} catch {
			/* fail-open */
		}
	});

	// 2) 已交付窗口内, 吞掉带 streamingBehavior 的内部续跑 -> 本轮干净结束
	pi.on("input", (event: unknown) => {
		try {
			if (G.__stopAfterDeliver === false) return undefined;
			const ev = event as Record<string, any> | null | undefined;
			// 无 streamingBehavior = 新的 prompt / 用户消息 -> 绝不干预
			if (!ev?.streamingBehavior) return undefined;
			const s = sidOf();
			const at = state[s];
			if (!at || Date.now() - at > WINDOW_MS) return undefined;
			console.warn(
				`[stop-after-deliver] 已交付, 吞掉内部续跑(${ev.streamingBehavior}) sid=${s} text=${String(ev.text || "").slice(0, 60)} (plugin)`,
			);
			return { action: "handled" };
		} catch {
			return undefined; /* fail-open */
		}
	});
}
