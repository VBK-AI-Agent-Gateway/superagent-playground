# 坑 #30 准入调查：主会话（orchestrator，router preset）为何在重启后仍固守旧预设

状态：**结论确定**，证据来自只读源码阅读。**未在 EU 侧执行任何命令，未停止/启动/重启 `dsh`，未写入任何状态。**

调查对象：`/home/qt/src/dsh-sa-git/src/`（dsh-superagent 源码）与
`/usr/lib/node_modules/@deepseek-ai/dsh/`（DSH 运行时，版本 `0.2.1-rc.3`）。

---

## 1. 现象（坑 #30）

主会话（master Session，承担准入/orchestrator 角色）在升级 preset 定义后，
**重启 dsh 仍按旧 preset 组合运行**：工具集与提示词分节保持旧版，
新加入的 preset 行不生效，直到人工删掉会话状态才恢复。

## 2. 关键机制（逐条附证据）

### 2.1 preset 是「创建事实」，只被投影事件推进

DSH 把会话实际运行的 preset 记为会话日志里的 `agentPreset` 投影：

- `/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js`
  - L35-40（模块注释）：*"The creation header names the preset a session STARTED with,
    and it is deep-frozen because that is a creation fact."*
  - L51：`init: (header) => header.agentPreset ?? null`
  - L53：`apply: (state, event) => event.type === "agent-preset/selected" ? event.data.agentPreset : state`
  - L41-43（注释）：*"Reconstruction reads the `agentPreset` Session projection, **never the
    header alone**."*

即：**重建会话时读取的是投影（日志事件累积结果），而投影的初值来自创建 header。**
所以一个被持久化的旧会话，重建后 preset 身份由**日志**决定，而不是由当前
`cordis.patch.yml` 里 preset 的定义决定。

### 2.2 「改了 preset 定义」不会改写已有会话的 preset 身份

`select()` 里有一条**短路返回**（同文件 L750-766）：

```js
const current = this.definitions.get(agentPreset)?.generation;
if (current !== void 0 && this.generationFor(agent.ctx) === current &&
    this.owner.sessionProjections.stateOf(agent.session, "agentPreset") === agentPreset)
    return agentPreset;          // <-- 什么都不做，不 append 事件
const preset = await this.recompose(agent.ctx, agentPreset);
agent.session.append("agent-preset/selected", { agentPreset: preset.id });
```

含义：**只有当目标 preset 定义「换了一代」（generation 变化）、或会话投影里的
preset 与目标不同时，才会重新组合（recompose）并落一条事件。**
升级 bundle 后 `generation` 通常确实会变，所以这一步本身是会触发 recompose 的
——**但前提是这段代码真的被跑到**（见 2.3）。

### 2.3 致命点：第一个 turn 之后 preset 被锁死（`agent-preset/locked`）

同文件 L752-756，`select()` 的第一道门：

```js
const boundary = this.owner.sessionProjections.stateOf(agent.session, "turnBoundary");
if (boundary !== void 0 && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0))
    throw new RemoteError("agent-preset/locked", "This session has already started", ...)
```

注释（L743-744）说得直白：*"Select a preset **before a session starts its first turn**."*

而 dsh-superagent 侧的自我纠正逻辑**只在事件回调里**、并且在首次选择时豁免：

`/home/qt/src/dsh-sa-git/src/app/sessions.ts`
- L122-124（注释）：*"Opening a Session in DSH's Web UI before its first turn may select
  the default preset for it: select ours again. **After its first turn DSH refuses any
  selection, which leaves it as it is.**"*
- L125-131：

```ts
child.on('agent-preset/selected', (sessionId, preset) => {
  const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
  const ours = sessionId === this.host.masterId ? ROUTER_PRESET
             : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
  if (!ours || preset === ours || !agent) return
  presets.select(agent, ours).catch(() => {})     // <-- 错误被吞掉
})
```

这条路径是**事件驱动**的：只有 DSH 主动触发 `agent-preset/selected`（例如 Web UI 打开
会话导致 registry 选了默认 preset）时，bundle 才有机会把它改成 `ROUTER_PRESET`。
**启动时恢复一个旧会话不会触发这个事件**，所以这段代码根本不会跑。
即使跑了，对 `lastTurn > 0` 的会话也会抛 `agent-preset/locked`，
而 `.catch(() => {})` **把错误静默吞掉**——这正是坑 #30「无声固守旧 preset」的直接成因。

### 2.4 创建路径只在会话不存在时生效

`sessions.ts` L138-147：

```ts
let result = await ctx.sessionController.resolveAgent(id as SessionId)
if ('error' in result && result.error.code === 'session/not-found') {
  const workspace = await ctx.workspaceRegistry.create(cwd)
  await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
    agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })   // 仅新建时指定
  result = await ctx.sessionController.resolveAgent(id as SessionId)
}
```

`agentPreset: ROUTER_PRESET` **只在 `session/not-found` 分支里**。主会话一旦持久化
（`machine.stateDir` 下），重启走的是 `resolveAgent` 成功分支，**preset 不会再被指定**。

### 2.5 判断「会话是否跑 router preset」也以日志为准

`sessions.ts` L276-280：

```ts
const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
               : projections?.stateOf?.(agent.session, 'agentPreset')
return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
```

同样回落到**投影/日志**，不是当前 patch 定义。因此一旦日志里的 preset 身份陈旧，
系统会**一直认为它是对的**。

## 3. 根因结论（一行）

> 主会话的 preset 是**持久化的「创建事实」**（`agentPreset` 投影，初值取自创建 header）；
> 第一个 turn 之后被 `agent-preset/locked` 冻结，bundle 的纠正逻辑只在
> `agent-preset/selected` 事件上运行且 **静默吞掉异常**，创建分支又只在 `session/not-found`
> 时指定 preset —— 三者叠加，使重启后的旧主会话永远保持旧 preset 组合。

## 4. 是否存在安全的重置路径？

**有，但必须人工执行，且代价是清空主会话这一个会话的状态。**
本单不提供自动脚本（见 §5），原因如下。

### 4.1 安全路径：删除/迁移主会话状态后让 dsh 重建

主会话 id 由 `machine.stateDir` 决定，会话状态落在该目录下 DSH 的会话存储中。
安全顺序（**只针对主会话，不要碰 executor 工单会话**）：

1. **确认没有在途工单**（准入门本身就在主会话里，先停掉 intake，避免重建期间丢事件）。
2. 备份整个 `stateDir`（或至少主会话那一条会话日志）。
3. 仅移除**主会话**的会话记录（保留 `KV`/工单/订阅/触发器数据）。
4. 重启 dsh → `sessions.ts` L141 的 `session/not-found` 分支命中 →
   以 `ROUTER_PRESET` 重新 `create`。
5. 校验：`presetForSession`/`agentPreset` 投影为 `dsh-superagent-router`，
   且新工具/提示词分节可见。

### 4.2 为什么本单不给自动脚本

按 issue #21 的要求，#30 **只做准入调查**，且明确约束：
「仅当存在安全路径时才提供 `reset-admission-session.sh`」，同时
**VM 只读、绝不停/启/重启 `dsh`、绝不写入状态；脚本只打印内容，绝不执行**。

实际评估后**不提供该脚本**，理由：

- 重置动作**必须**在 `dsh` 停止或至少主会话不再活跃时进行，否则会与正在运行的
  会话日志写入竞争，可能损坏会话状态——这直接违反「不停止/不重启 dsh」的约束。
- 会话存储路径与格式属于 DSH 内部实现（`sessionPersistence` / profile 的 `stateDir`），
  在本仓库内**没有**稳定、有文档保证的删除接口；硬编码路径的脚本比人工步骤更危险。
- 一键脚本会把「清空主会话上下文」这种**不可逆**操作变得过于容易触发。

因此交付**人工步骤 + 校验方法**（§4.1），把不可逆决定留给操作员。
若后续需要脚本化，建议在 DSH 侧提供官方的「重置会话 preset」接口，而不是外部猜测存储布局。

## 5. 影响面与建议

- **只影响主会话（orchestrator/router）**：executor 工单会话每次由 `ensure()` 在
  `session/not-found` 时新建，天然拿到当前 preset；但**已存在的工单会话同样受
  `agent-preset/locked` 约束**（L752），升级 preset 后不会自动重组。
- 建议（DSH 侧，非本单范围）：`sessions.ts` L130 的 `.catch(() => {})` 至少应记录
  `agent-preset/locked`，否则这类固守完全静默，正是坑 #30 难以发现的原因。

## 6. 本次调查的边界

- 全程**只读**：源码阅读 + `grep`/`sed`，未执行任何 EU 侧命令。
- 未停止、未启动、未重启 `dsh`；未写入任何会话/状态文件。
- 结论基于 DSH `0.2.1-rc.3` 与 `/home/qt/src/dsh-sa-git` 当前工作树；
  若二者升级，§2 的行号与行为需复核。
