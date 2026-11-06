#!/usr/bin/env bash
# fixD-tgpush.sh —— 故障修复 D：工单结果 TG 回传（fast-route Phase 2 回程）
#
# 病根：dispatch_dev 把重活派成 GitHub 工单后，跑完的结果永远回不到 TG。
#       用户说「开发一套 crm 系统」→ 派单成功 → 之后 90 分钟零回音 → 用户手动停单。
# 修法：给派单链路加一条「回程」—— 派单即登记 sid→工单映射，
#       由每分钟一次的 poller 盯工单终态，一旦有结论就回传一条 TG（成功给链接，失败给原因）。
#
# 执行位置：EU 服务器 5.189.129.216
# 参数：
#   （默认）          演练（dry-run）：只打印每一步计划，绝不写任何文件
#   --selftest        只做自检（锚点唯一性 / 目标在位 / docker+bun 就绪），不写盘
#   --apply           落盘 + bun 构建验证 + 受控重启 + 健康门禁
#   --rollback [ts]   回滚到指定备份时间戳（省略 ts = 回最近一次）
# 预期时长：dry-run <20s；--apply 约 60~120s（含一次容器重启）
#
# 前置：先跑 04-dev-dispatch-struct.sh，把输出交给操作员评审核对锚点。
#
# 安全边界（必读）：
#   - 零密钥：本脚本不打印、不写入、不传输任何 token / pem 内容；本文件通篇只有变量名与路径名。
#   - 改文件默认 fail-closed：锚点不唯一 / 改写异常 / 构建失败 / 健康门禁不过 → 中止并回滚。
#   - 回传 fail-open：TG 发不出去只记日志，绝不影响派单主链（派单成败只由 GitHub 决定）。
#   - 逃生阀：WAGATE_DISPATCH_TG_PUSH=0 关掉全部 TG 回传。
set -u

MODE="${1:-}"

case "$MODE" in
  ""|--apply|--selftest|--rollback) ;;
  *) echo "[fixD] [FATAL] 未知参数：$MODE（可用：--apply | --selftest | --rollback [ts]）" >&2; exit 2 ;;
esac

TS="${2:-}"

# ---------------------------------------------------------------------------
# 0. 常量（环境可覆盖）
# ---------------------------------------------------------------------------
PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
TARGET="${TARGET:-$PATCH_DIR/aa-dev-dispatch.ts}"
TARGET_IN_CONTAINER="${TARGET_IN_CONTAINER:-/app/aa-dev-dispatch.ts}"
CONTAINER="${CONTAINER:-wagate}"
POLLER="${POLLER:-$PATCH_DIR/aa-dev-tgpush-poll.ts}"
RUNNER="${RUNNER:-$PATCH_DIR/aa-dev-tgpush-runner.sh}"
ENV_FILE="${ENV_FILE:-/etc/wagate.env}"
SERVICE="${SERVICE:-wagate}"
LABEL="fixD"
ALERT_LOG="${ALERT_LOG:-/srv/wagate/dispatch-alerts.log}"

say() { printf '[fixD] %s\n' "$*"; }
die() { printf '[fixD] [FATAL] %s\n' "$*" >&2; exit 1; }
hr()  { printf '\n----- %s -----\n' "$*"; }

BACKUP=""
restore_on_fail() {
  if [ -n "$BACKUP" ] && [ -f "$BACKUP" ]; then
    cat "$BACKUP" > "$TARGET" && say "已回滚 $TARGET ← $BACKUP"
  fi
}

# ---------------------------------------------------------------------------
# 1. 自检：目标在位、锚点唯一、容器与构建工具就绪
# ---------------------------------------------------------------------------
hr "1/7 自检（锚点唯一性 + 依赖在位性）"

[ -f "$TARGET" ] || die "找不到派单插件源码：$TARGET（请确认 fast-route 已部署到本机）"
say "目标文件：$TARGET"
say "           $(wc -l < "$TARGET") 行，md5=$(md5sum "$TARGET" | awk '{print $1}')"

# docker 前置只在需要构建/重启的模式下强制（--apply / --selftest）。
# dry-run 允许在无 docker 的机器上做「锚点唯一性」预演，便于开发侧先自查。
NEED_DOCKER=0
[ "$MODE" = "--apply" ] || [ "$MODE" = "--selftest" ] && NEED_DOCKER=1
if [ "$MODE" = "--rollback" ]; then NEED_DOCKER=0; fi

if [ "$NEED_DOCKER" = "1" ]; then
  command -v docker >/dev/null 2>&1 || die "本机没有 docker 命令——请在 EU 服务器（5.189.129.216）上执行"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" \
    || die "容器 $CONTAINER 未运行，无法做构建与健康验证"
else
  say "演练模式：跳过 docker 前置检查（仅做锚点唯一性等静态自检）"
fi

# 锚点唯一性：匹配数必须恰好 1，否则中止（绝不按行号切分）
anchor() {  # anchor <名称> <固定串>
  local name="$1" pat="$2" n
  n=$(grep -Fc -- "$pat" "$TARGET" 2>/dev/null || true)
  [ "$n" = "1" ] || die "锚点[$name] 匹配 ${n:-0} 次（要求恰好 1 次）：$pat"
  say "锚点[$name] OK（唯一）"
}

A_ISSUE_DECL='let issueNumber: number | null = null;'
A_GH_CREATE='const created = await gh("POST", `/repos/${OWNER}/${REPO}/issues`, {'
A_AUDIT_OK='audit({ sid, action: "dispatch", issue: issueNumber, result: "ok" });'
A_RETURN_OK='`已派单：${issueUrl}`,'
A_IMPORT_FS='} from "node:fs";'
A_EXPORT_DEFAULT='export default function aaDevDispatch('

anchor "issueNumber 声明"   "$A_ISSUE_DECL"
anchor "issue 创建调用"     "$A_GH_CREATE"
anchor "派单成功审计"       "$A_AUDIT_OK"
anchor "派单成功返回"       "$A_RETURN_OK"
anchor "node:fs 导入"       "$A_IMPORT_FS"
anchor "export default"     "$A_EXPORT_DEFAULT"

if grep -qF 'aa-dev-tgpush BEGIN' "$TARGET"; then
  die "目标文件已含 fixD 注入块——本补丁已应用过；如需重做请先 --rollback"
fi

if [ "$MODE" = "--apply" ] || [ "$MODE" = "--selftest" ]; then
  docker exec "$CONTAINER" sh -c 'command -v bun >/dev/null 2>&1' \
    || die "容器 $CONTAINER 内没有 bun，无法做构建验证"
  say "容器内 bun 就绪"
  if [ "$MODE" = "--selftest" ]; then
    printf '\nSELFTEST_OK：目标在位、6 个锚点全部唯一、docker/容器/bun 就绪（未写任何文件）\n'
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# 2. 回滚
# ---------------------------------------------------------------------------
if [ "$MODE" = "--rollback" ]; then
  hr "回滚"
  if [ -z "$TS" ]; then
    BACKUP=$(ls -1t "$TARGET".bak.$LABEL.* 2>/dev/null | head -1 || true)
    [ -n "$BACKUP" ] || die "找不到 $TARGET.bak.$LABEL.* 备份"
  else
    BACKUP="$TARGET.bak.$LABEL.$TS"
    [ -f "$BACKUP" ] || die "备份不存在：$BACKUP"
  fi
  say "回滚 $TARGET ← $BACKUP"
  cat "$BACKUP" > "$TARGET" || die "回滚写入失败"
  say "回滚完成。执行 docker restart $CONTAINER 使旧版生效，然后确认 TG getMe 返回 ok。"
  [ -f "$POLLER" ] && say "提示：回程 poller 仍在 $POLLER（本次不动它；确认不再需要可手工删除）"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. 组装三个待写文件的内容（全部先放变量，dry-run 也能逐行评审）
# ---------------------------------------------------------------------------
hr "2/7 组装补丁内容"

INJECT_BLOCK=$(cat <<'INJECT_EOF'

// ===================== aa-dev-tgpush BEGIN =====================
// 故障修复 D：工单结果 TG 回传（fast-route Phase 2 回程）
// 派单成功的瞬间，把「哪张工单属于哪个会话」登记到映射文件，交给
// aa-dev-tgpush-poll.ts 每分钟盯一次工单终态，一旦有结论就回传一条 TG。
// 这里只登记、不发消息：消息必须等工单真有结论，否则只是把静默换成噪音。
// fail-open：登记失败绝不影响派单本身（派单成败只由 GitHub 决定）。
const DISPATCH_MAPPING = env("WAGATE_DISPATCH_MAPPING", "/srv/wagate/dispatch-mapping.json");
const DISPATCH_TG_PUSH = env("WAGATE_DISPATCH_TG_PUSH", "1") !== "0";

/** 把 sid → 工单 的映射原子落盘（读-改-写，容忍并发：后写者合并在前者之上）。 */
function writeDispatchMapping(row: {
	sid: string;
	chatKey: string;
	issue: number;
	url: string;
	title: string;
}): void {
	try {
		if (!DISPATCH_TG_PUSH) {
			audit({ sid: row.sid, action: "tgpush", issue: row.issue, result: "skipped WAGATE_DISPATCH_TG_PUSH=0" });
			return;
		}
		mkdirSync(join(DISPATCH_MAPPING, ".."), { recursive: true });
		let list: unknown[] = [];
		try {
			const parsed = JSON.parse(readFileSync(DISPATCH_MAPPING, "utf8"));
			if (Array.isArray(parsed)) list = parsed;
		} catch {
			// 首次写入，或文件损坏 → 从空表重建；绝不因为一个坏文件卡死派单
		}
		// 同一张工单只留一条（重派场景以最新为准）
		list = list.filter((x) => !(x && typeof x === "object" && (x as { issue?: number }).issue === row.issue));
		list.push({ ...row, dispatchedAt: Date.now() });
		const tmp = `${DISPATCH_MAPPING}.tmp.${process.pid}`;
		writeFileSync(tmp, JSON.stringify(list, null, 2));
		renameSync(tmp, DISPATCH_MAPPING);
		audit({ sid: row.sid, action: "tgpush", issue: row.issue, result: "mapping written" });
	} catch (e) {
		audit({ sid: row.sid, action: "tgpush", issue: row.issue, result: `mapping failed ${String(e).slice(0, 200)}` });
	}
}

/** 取当前会话的回程地址（platform:channelId）。bot.ts 的 onProgress 一直在维护 __sidChat。 */
function currentChatKey(sid: string): string {
	try {
		const m = g.__sidChat as Map<string, string> | undefined;
		if (m && typeof m.get === "function") {
			const v = m.get(sid);
			if (typeof v === "string" && v) return v;
		}
	} catch {
		// 拿不到就留空：poller 会把这行报进告警日志，绝不静默丢工单
	}
	return "";
}
// ===================== aa-dev-tgpush END =====================
INJECT_EOF
)

CALL_BLOCK=$(cat <<'CALL_EOF'
					// 修复 D：登记回程（工单终态由 aa-dev-tgpush-poll.ts 轮询后回传 TG）
					writeDispatchMapping({
						sid,
						chatKey: currentChatKey(sid),
						issue: issueNumber,
						url: issueUrl,
						title: spec.title,
					});
CALL_EOF
)

POLLER_SRC=$(cat <<'POLLER_EOF'
#!/usr/bin/env bun
/**
 * aa-dev-tgpush-poll.ts —— 工单终态 → TG 结果回传（fast-route Phase 2 回程）
 *
 * 由 /srv/wagate/patches/aa-dev-tgpush-runner.sh 每分钟调一次（容器内执行）。
 * 零 npm 依赖：只用 node:crypto / node:fs / 全局 fetch（与 aa-dev-dispatch.ts 同规矩）。
 *
 * 读：  /srv/wagate/dispatch-mapping.json   派单时登记的 sid → 工单映射
 * 写：  /srv/wagate/dispatch-state.json     每张工单的回程状态（pushed=true = 已回传，幂等去重）
 * 写：  /srv/wagate/dispatch-alerts.log     失败与异常（绝不静默）
 * 发：  Telegram sendMessage（token 从环境变量读，绝不落盘）
 *
 * 环境变量：
 *   WAGATE_DISPATCH_TG_PUSH=0   关掉全部回传（逃生阀）
 *   WAGATE_DISPATCH_MAPPING     映射文件（默认 /srv/wagate/dispatch-mapping.json）
 *   WAGATE_DISPATCH_STATE       状态文件（默认 /srv/wagate/dispatch-state.json）
 *   WAGATE_DISPATCH_SILENT_MIN  静默门禁分钟数（默认 30）
 *   TELEGRAM_BOT_TOKEN          TG 凭证（缺失则只记日志，不回传）
 *   WAGATE_TG_API / WAGATE_DISPATCH_DRY=1（只判不发，用于合成回归）
 *
 * fail-open：本文件任何异常只吞掉自己，绝不抛到进程外，更不许影响 bot.ts 与派单主链。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAPPING = process.env.WAGATE_DISPATCH_MAPPING ?? "/srv/wagate/dispatch-mapping.json";
const STATE = process.env.WAGATE_DISPATCH_STATE ?? "/srv/wagate/dispatch-state.json";
const ALERT_LOG = process.env.WAGATE_DISPATCH_ALERT_LOG ?? "/srv/wagate/dispatch-alerts.log";
const SILENT_MIN = Number(process.env.WAGATE_DISPATCH_SILENT_MIN ?? "30");
const TG_API = process.env.WAGATE_TG_API ?? "https://api.telegram.org";
const DRY = process.env.WAGATE_DISPATCH_DRY === "1";
const OWNER = "VBK-AI-Agent-Gateway";
const REPO = "superagent-playground";
const API = "https://api.github.com";
const APP_ID = "5630580";
const INSTALLATION_ID = "178998634";
const KEY_PATH = process.env.WAGATE_DISPATCH_KEY_PATH ?? "/srv/secrets/dispatch-app/sandbox-dispatch.private-key.pem";

export type MapRow = {
	sid: string;
	chatKey: string;      // "platform:channelId"，如 "telegram:123456789"
	issue: number;
	url: string;
	title: string;
	dispatchedAt: number; // epoch ms
};
export type Row = MapRow & {
	pushed?: boolean;
	pushedAt?: number;
	lastState?: string;
	lastCheckAt?: number;
	alertedSilent?: boolean;
};

const g = globalThis as Record<string, unknown>;

function log(line: string): void {
	try { console.log(`[tgpush] ${line}`); } catch { /* 忽略 */ }
}

/** 失败/异常绝不静默：stdout（journalctl 可见）+ 告警文件（操作员可直接 tail）。 */
export function alert(line: string): void {
	const msg = `${new Date().toISOString()} ${line}`;
	log(`ALERT ${line}`);
	try {
		mkdirSync(dirname(ALERT_LOG), { recursive: true });
		writeFileSync(ALERT_LOG, msg + "\n", { flag: "a" });
	} catch { /* fail-open */ }
}

function readJson<T>(p: string, dflt: T): T {
	try {
		if (!existsSync(p)) return dflt;
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return dflt;
	}
}

/** 原子替换：先写同目录临时文件再 rename，避免 runner 读到半个文件。 */
function writeJsonAtomic(p: string, v: unknown): void {
	try {
		mkdirSync(dirname(p), { recursive: true });
		const tmp = `${p}.tmp.${process.pid}`;
		writeFileSync(tmp, JSON.stringify(v, null, 2));
		renameSync(tmp, p);
	} catch (e) {
		alert(`状态写入失败（${p}）：${String(e).slice(0, 200)}`);
	}
}

/** 从 chatKey（"telegram:<id>"）里取平台与 chat_id；非 telegram 一律跳过。 */
export function parseChatKey(chatKey: string): { platform: string; chatId: string } | null {
	const s = String(chatKey ?? "");
	const i = s.indexOf(":");
	if (i <= 0 || i >= s.length - 1) return null;
	return { platform: s.slice(0, i), chatId: s.slice(i + 1) };
}

/** 发送一条 TG 消息；返回是否成功。token 缺失 / 网络失败都只报警，不抛。 */
export async function sendTg(chatId: string, text: string): Promise<boolean> {
	if (DRY) {
		log(`[dry] 本应发送到 ${chatId}：${text.slice(0, 600)}`);
		return true;
	}
	const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
	if (!token) {
		alert(`TG 回传失败：TELEGRAM_BOT_TOKEN 未配置（chat_id=${chatId}，内容已进日志）`);
		return false;
	}
	try {
		const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
			signal: AbortSignal.timeout(20000),
		});
		if (!res.ok) {
			alert(`TG 回传失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}（chat_id=${chatId}）`);
			return false;
		}
		return true;
	} catch (e) {
		alert(`TG 回传异常：${String(e).slice(0, 200)}（chat_id=${chatId}）`);
		return false;
	}
}

/** GitHub 安装令牌（与 aa-dev-dispatch.ts 同一套 RS256 JWT 流程；只读 issue，不需要额外权限）。 */
async function installationToken(): Promise<string> {
	const cache = g.__tgpushToken as { token: string; expMs: number } | undefined;
	if (cache && cache.expMs - 5 * 60 * 1000 > Date.now()) return cache.token;

	const pem = readFileSync(KEY_PATH, "utf8");
	const now = Math.floor(Date.now() / 1000);
	const b64 = (b: Buffer) =>
		b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
	const head = b64(Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const body = b64(Buffer.from(JSON.stringify({ iss: APP_ID, iat: now - 60, exp: now + 540 })));
	const { createSign } = await import("node:crypto");
	const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem);

	const res = await fetch(`${API}/app/installations/${INSTALLATION_ID}/access_tokens`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${head}.${body}.${b64(sig)}`,
			accept: "application/vnd.github+json",
			"user-agent": "aa-dev-tgpush",
		},
		signal: AbortSignal.timeout(30000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`换取 installation token 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
	const j = JSON.parse(text) as { token?: string; expires_at?: string };
	if (!j.token) throw new Error("installation token 响应缺少 token 字段");
	const expMs = j.expires_at ? Date.parse(j.expires_at) : NaN;
	const safeExp = Number.isFinite(expMs) ? expMs : Date.now() + 55 * 60 * 1000;
	g.__tgpushToken = { token: j.token, expMs: safeExp };
	return j.token;
}

async function ghGet(token: string, path: string): Promise<{ status: number; json: unknown }> {
	const res = await fetch(`${API}${path}`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "aa-dev-tgpush",
		},
		signal: AbortSignal.timeout(30000),
	});
	let json: unknown = null;
	try { json = JSON.parse(await res.text()); } catch { /* 非 JSON 体 */ }
	return { status: res.status, json };
}

export type Verdict = {
	terminal: boolean;
	stateKey: string;
	headline: string;
	lines: string[];
	silentGate?: boolean;
};

/**
 * 判定一张工单的当前状态。判据全部来自 GitHub 事实（issue 状态 / 关联 PR / 工单链接），不猜。
 * 查不到 ≠ 完成：非 200 一律当作「未终结」，下一轮再试，绝不误报成功。
 */
export async function pollIssue(token: string, row: Row): Promise<Verdict> {
	const lines: string[] = [];
	const { status, json } = await ghGet(token, `/repos/${OWNER}/${REPO}/issues/${row.issue}`);

	if (status === 404) {
		return { terminal: true, stateKey: "issue-missing", headline: "工单不存在（可能被删除或仓库改名）", lines };
	}
	if (status !== 200 || !json) {
		return { terminal: false, stateKey: `http-${status}`, headline: "", lines };
	}

	const iss = json as { state?: string; title?: string; state_reason?: string; html_url?: string };
	const state = String(iss.state ?? "open");
	lines.push(`工单：#${row.issue} ${iss.title ?? row.title}`);
	lines.push(`状态：${state === "closed" ? `已关闭（${iss.state_reason ?? "completed"}）` : "进行中"}`);
	lines.push(`链接：${iss.html_url ?? row.url}`);

	if (state === "closed") {
		const reason = String(iss.state_reason ?? "completed");
		const abandoned = reason === "not_planned";
		return {
			terminal: true,
			stateKey: `closed-${reason}`,
			headline: abandoned ? "工单被关闭但未完成" : "工单已完成",
			lines,
		};
	}

	// 未关闭：顺手看一眼有没有关联 PR，让中间态可见（不推送，只当指纹）
	let prKey = "";
	try {
		const r = await ghGet(token, `/repos/${OWNER}/${REPO}/issues/${row.issue}/timeline?per_page=100`);
		if (r.status === 200 && Array.isArray(r.json)) {
			const prs = (r.json as Array<{ event?: string; source?: { issue?: { number?: number; html_url?: string; state?: string } } }>)
				.filter((e) => e.event === "cross-referenced" && e.source?.issue?.number)
				.map((e) => e.source!.issue!);
			if (prs.length) {
				const p = prs[prs.length - 1];
				prKey = `pr-${p.number}-${p.state ?? "open"}`;
				lines.push(`PR：#${p.number}（${p.state ?? "open"}）${p.html_url ?? ""}`);
			}
		}
	} catch { /* 中间态拿不到不影响判定 */ }

	// 静默门禁：派单后 SILENT_MIN 分钟仍无终态 → 必须主动说话，绝不静默
	const ageMin = (Date.now() - Number(row.dispatchedAt ?? Date.now())) / 60000;
	if (ageMin >= SILENT_MIN && !row.alertedSilent) {
		return { terminal: false, stateKey: "silent-gate", headline: "", lines, silentGate: true };
	}
	return { terminal: false, stateKey: prKey || "open", headline: "", lines };
}

/** 主入口：跑一轮。幂等 —— pushed=true 的行不再发；发送失败不写 pushed，下一轮重试。 */
export async function runOnce(): Promise<{ pushed: number; checked: number; pending: number }> {
	const result = { pushed: 0, checked: 0, pending: 0 };
	if (process.env.WAGATE_DISPATCH_TG_PUSH === "0") {
		log("WAGATE_DISPATCH_TG_PUSH=0，本轮跳过（逃生阀）");
		return result;
	}

	const mapping = readJson<MapRow[]>(MAPPING, []);
	if (!Array.isArray(mapping) || mapping.length === 0) {
		log("映射为空，无需回传");
		return result;
	}
	const state = readJson<Record<string, Row>>(STATE, {});
	const open = mapping.filter((r) => !state[String(r.issue)]?.pushed);
	if (open.length === 0) {
		log(`全部 ${mapping.length} 张工单已回传，无需动作`);
		return result;
	}

	let token: string;
	try {
		token = await installationToken();
	} catch (e) {
		// 拿不到令牌 = 本轮「无法判定」：报警但不写 pushed，下一轮重试
		alert(`无法换取 GitHub 安装令牌，本轮回传跳过：${String(e).slice(0, 200)}`);
		return result;
	}

	for (const m of open) {
		const key = String(m.issue);
		const row: Row = { ...m, ...(state[key] ?? {}) };
		result.checked++;
		try {
			const p = await pollIssue(token, row);
			row.lastCheckAt = Date.now();
			row.lastState = p.stateKey;

			if (!p.terminal) {
				if (p.silentGate && !row.alertedSilent) {
					const chat = parseChatKey(row.chatKey);
					const mins = Math.round((Date.now() - Number(row.dispatchedAt ?? Date.now())) / 60000);
					if (chat?.platform === "telegram") {
						const ok = await sendTg(
							chat.chatId,
							[
								`⏳ 已派单 ${mins} 分钟，工单仍在跑`,
								`工单：#${row.issue} ${row.title}`,
								`链接：${row.url}`,
								"",
								`（静默门禁自动提醒：超过 ${SILENT_MIN} 分钟没有终态就会主动说话）`,
							].join("\n"),
						);
						if (ok) { row.alertedSilent = true; result.pushed++; }
					} else {
						alert(`静默门禁命中但 chatKey 非 telegram（${row.chatKey || "空"}），无法回传 issue #${row.issue}`);
						row.alertedSilent = true; // 避免每分钟重复告警
					}
				}
				state[key] = row;
				result.pending++;
				continue;
			}

			// 终结：组装结果消息并回传，成功才写 pushed
			const chat = parseChatKey(row.chatKey);
			if (chat?.platform !== "telegram") {
				alert(`工单 #${row.issue} 已终结，但 chatKey 非 telegram（${row.chatKey || "空"}），无法回传；请手工核对 ${row.url}`);
				row.pushed = true;
				row.pushedAt = Date.now();
				state[key] = row;
				continue;
			}

			const head = p.headline || "工单状态更新";
			const icon = head.includes("未完成") || head.includes("不存在") ? "⚠️" : "✅";
			const text = [`${icon} ${head}`, ...p.lines].join("\n");
			const ok = await sendTg(chat.chatId, text);
			if (ok) {
				row.pushed = true;
				row.pushedAt = Date.now();
				result.pushed++;
				log(`已回传 issue #${row.issue} → ${chat.chatId}（${p.stateKey}）`);
			} else {
				alert(`工单 #${row.issue} 结果回传失败（${p.stateKey}），下一轮重试`);
			}
			state[key] = row;
		} catch (e) {
			// 单行异常不影响其它行；不写 pushed，下一轮重试
			alert(`处理 issue #${row.issue} 异常：${String(e).slice(0, 200)}`);
			state[key] = { ...row, lastCheckAt: Date.now() };
		}
	}

	writeJsonAtomic(STATE, state);
	log(`本轮：检查 ${result.checked}，回传 ${result.pushed}，未终结 ${result.pending}`);
	return result;
}

// 直接执行时跑一次；被 import 时不自跑（供 regrD.sh 做合成回归）。
const isMain = (() => {
	try {
		return /aa-dev-tgpush-poll/.test(String(process.argv[1] ?? ""));
	} catch {
		return false;
	}
})();
if (isMain) {
	runOnce()
		.then((r) => log(`done pushed=${r.pushed} checked=${r.checked} pending=${r.pending}`))
		.catch((e) => alert(`runOnce 顶层异常：${String(e).slice(0, 300)}`));
}
POLLER_EOF
)

RUNNER_SRC=$(cat <<'RUNNER_EOF'
#!/usr/bin/env bash
# aa-dev-tgpush-runner.sh —— 每分钟调一次回程 poller（幂等 + 单实例锁）
# cron 安装：* * * * * /srv/wagate/patches/aa-dev-tgpush-runner.sh >> /var/log/wagate-tgpush.log 2>&1
# 回传链路整体 fail-open：poller 挂了只记日志，绝不影响派单与 bot。
set -u
CONTAINER="${CONTAINER:-wagate}"
POLLER_IN_CONTAINER="${POLLER_IN_CONTAINER:-/app/aa-dev-tgpush-poll.ts}"
LOCK=/tmp/aa-dev-tgpush.lock

if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || { echo "[tgpush-runner] 上一轮仍在跑，跳过"; exit 0; }
else
  LOCKDIR="${LOCK}.d"
  mkdir "$LOCKDIR" 2>/dev/null || { echo "[tgpush-runner] 上一轮仍在跑，跳过"; exit 0; }
  trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT
fi

timeout 55 docker exec "$CONTAINER" bun "$POLLER_IN_CONTAINER" 2>&1 \
  || echo "[tgpush-runner] poller 退出码非 0（fail-open：回传失败不影响派单，详见 /srv/wagate/dispatch-alerts.log）"
RUNNER_EOF
)

printf '%s\n' "  [P1] 在 import { … } from \"node:fs\" 里补：writeFileSync, renameSync"
printf '%s\n' "  [P2] 在 export default function aaDevDispatch( 之前插入注入块（$(printf '%s' "$INJECT_BLOCK" | wc -l) 行）"
printf '%s\n' "  [P3] 在「已派单」成功返回之前插入 writeDispatchMapping(...) 登记调用"
printf '%s\n' "  [P4] 新建回程 poller：$POLLER（$(printf '%s' "$POLLER_SRC" | wc -l) 行）"
printf '%s\n' "  [P5] 新建 runner：$RUNNER（$(printf '%s' "$RUNNER_SRC" | wc -l) 行）+ cron 每分钟一跑"
printf '%s\n' "  [P6] $ENV_FILE 追加 WAGATE_DISPATCH_TG_PUSH=1 / WAGATE_DISPATCH_SILENT_MIN=30"

if [ "$MODE" != "--apply" ]; then
  hr "演练结束（未写任何文件）"
  cat <<'DRY_EOF'

确认无误后执行：

  sudo bash fixes/fixD-tgpush.sh --apply

回滚：

  sudo bash fixes/fixD-tgpush.sh --rollback              # 回最近一次备份
  sudo bash fixes/fixD-tgpush.sh --rollback 20261106T081500Z
  sudo bash fixes/fixD-tgpush.sh --rollback              # 之后手工 docker restart wagate

紧急止血（不改代码，立刻停掉回传）：

  echo 'WAGATE_DISPATCH_TG_PUSH=0' | sudo tee -a /etc/wagate.env && sudo docker restart wagate

DRY_EOF
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. --apply：备份 → 改写 → 构建验证
# ---------------------------------------------------------------------------
hr "3/7 落盘（备份 → 锚点改写 → 构建验证）"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP="$TARGET.bak.$LABEL.$STAMP"
cp -p "$TARGET" "$BACKUP" || die "备份失败：$BACKUP"
say "备份：$BACKUP"

WORK=$(mktemp -d) || die "mktemp 失败"
printf '%s\n' "$INJECT_BLOCK" > "$WORK/inject.ts"
printf '%s\n' "$CALL_BLOCK"   > "$WORK/call.ts"

python3 - "$TARGET" "$WORK/out.ts" "$WORK/inject.ts" "$WORK/call.ts" <<'PY_EOF' || { rm -rf "$WORK"; restore_on_fail; die "改写失败（锚点或 import 不满足，已回滚）"; }
import io, re, sys

src_path, out_path, inject_path, call_path = sys.argv[1:5]
s = io.open(src_path, encoding="utf-8").read()
orig = s
inject = io.open(inject_path, encoding="utf-8").read()
call = io.open(call_path, encoding="utf-8").read()

def replace_once(hay, needle, repl, label):
    n = hay.count(needle)
    if n != 1:
        raise SystemExit(f"锚点[{label}] 匹配 {n} 次（要求恰好 1 次）")
    return hay.replace(needle, repl, 1)

# [P1] 补 node:fs 的 import
m = re.search(r'import \{([^}]*)\} from "node:fs";', s)
if not m:
    raise SystemExit("找不到 node:fs 的 import 语句")
names = [x.strip() for x in m.group(1).split(",") if x.strip()]
for extra in ("writeFileSync", "renameSync"):
    if extra not in names:
        names.append(extra)
s = s[:m.start()] + 'import { ' + ", ".join(names) + ' } from "node:fs";' + s[m.end():]

# [P2] 注入块放在 export default 之前
s = replace_once(s, "export default function aaDevDispatch(", inject + "\nexport default function aaDevDispatch(", "export default")

# [P3] 登记调用插在派单成功分支（audit ok 之后、成功返回之前）。
# 锚点必须跨越「审计行 + return out( + [」三行才唯一：单独一个 return out( 在原文出现 5 次。
s = replace_once(
    s,
    '\t\t\t\t\taudit({ sid, action: "dispatch", issue: issueNumber, result: "ok" });\n\t\t\t\t\treturn out(\n',
    '\t\t\t\t\taudit({ sid, action: "dispatch", issue: issueNumber, result: "ok" });\n'
    + call + '\n\t\t\t\t\treturn out(\n',
    "派单成功返回",
)

if s == orig:
    raise SystemExit("改写后与原文相同——补丁未生效")

io.open(out_path, "w", encoding="utf-8").write(s)
print(f"[fixD] python 锚点改写完成：{len(orig)} → {len(s)} 字节")
PY_EOF

grep -qF 'aa-dev-tgpush BEGIN' "$WORK/out.ts" || { rm -rf "$WORK"; restore_on_fail; die "注入块未写入"; }
grep -qF 'writeDispatchMapping({' "$WORK/out.ts" || { rm -rf "$WORK"; restore_on_fail; die "登记调用未写入"; }

# cat > target 保留 inode（宿主挂载是只读 bind，换 inode 会丢挂载）
cat "$WORK/out.ts" > "$TARGET" || { rm -rf "$WORK"; restore_on_fail; die "写入目标失败"; }
rm -rf "$WORK"
say "新 md5：$(md5sum "$TARGET" | awk '{print $1}')"

printf '%s\n' "$POLLER_SRC" > "$POLLER" || { restore_on_fail; die "poller 写入失败"; }
chmod 0644 "$POLLER"
printf '%s\n' "$RUNNER_SRC" > "$RUNNER" || { restore_on_fail; die "runner 写入失败"; }
chmod 0755 "$RUNNER"
say "poller：$POLLER（$(wc -l < "$POLLER") 行）"
say "runner：$RUNNER（$(wc -l < "$RUNNER") 行）"

# 真实构建验证：rc 必须用变量接，绝不 `cmd | tail; echo $?`
docker exec "$CONTAINER" bun build "$TARGET_IN_CONTAINER" --no-bundle > /tmp/fixD-build.log 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
  tail -30 /tmp/fixD-build.log >&2 || true
  restore_on_fail
  die "bun build 失败（rc=$RC），已回滚到 $BACKUP"
fi
say "bun build OK（--no-bundle，rc=0）"

# poller 语法验证：容器内若尚未挂载，则退到宿主 bun；都没有就明确标注未验证
docker exec "$CONTAINER" bun build "${TARGET_IN_CONTAINER%/*}/aa-dev-tgpush-poll.ts" --no-bundle > /tmp/fixD-build-poll.log 2>&1
RC2=$?
if [ "$RC2" -eq 0 ]; then
  say "容器内 bun build poller OK"
elif command -v bun >/dev/null 2>&1; then
  bun build "$POLLER" --no-bundle > /tmp/fixD-build-poll-host.log 2>&1 \
    && say "宿主 bun build poller OK（注意：容器内暂不可见，需挂载后用 runner 验证）" \
    || { tail -20 /tmp/fixD-build-poll-host.log >&2 || true; restore_on_fail; die "poller 语法检查失败，已回滚"; }
else
  say "[warn] poller 未通过构建验证（容器内不可见且宿主无 bun）——regrD.sh 必须在 EU 上补这一步"
fi

# ---------------------------------------------------------------------------
# 5. 环境变量 + 受控重启 + 健康门禁
# ---------------------------------------------------------------------------
hr "4/7 环境变量开关"
if ! grep -qE '^WAGATE_DISPATCH_TG_PUSH=' "$ENV_FILE" 2>/dev/null; then
  cp -p "$ENV_FILE" "$ENV_FILE.bak.$LABEL.$STAMP" 2>/dev/null || true
  printf '\n# 修复 D：工单结果 TG 回传（1=开，0=逃生阀关）\nWAGATE_DISPATCH_TG_PUSH=1\nWAGATE_DISPATCH_SILENT_MIN=30\n' >> "$ENV_FILE"
  say "已追加 TG 回传开关到 $ENV_FILE（备份 $ENV_FILE.bak.$LABEL.$STAMP）"
else
  say "$ENV_FILE 已有 WAGATE_DISPATCH_TG_PUSH，跳过"
fi

hr "5/7 cron（每分钟一跑）"
CRON_LINE="* * * * * $RUNNER >> /var/log/wagate-tgpush.log 2>&1"
if crontab -l 2>/dev/null | grep -qF "$RUNNER"; then
  say "cron 已存在，跳过"
else
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab - \
    && say "已安装 cron：$CRON_LINE" \
    || say "[warn] cron 安装失败（无 crontab？）——请手工加，或改用 systemd timer"
fi

hr "6/7 受控重启"
RUNNING_DBS=$(docker exec "$CONTAINER" sh -c 'ls /srv/tenants/*/ledger.db 2>/dev/null | head -1' 2>/dev/null || true)
if [ -n "$RUNNING_DBS" ] && [ "${FORCE_RESTART:-0}" != "1" ]; then
  BUSY=$(docker exec "$CONTAINER" sh -c 'for db in /srv/tenants/*/ledger.db; do [ -f "$db" ] || continue; sqlite3 "$db" "select count(*) from ledger where state='"'"'running'"'"'" 2>/dev/null; done' 2>/dev/null | awk '{s+=$1} END{print s+0}')
  if [ "${BUSY:-0}" != "0" ]; then
    say "[warn] 检测到 ${BUSY} 个 running 任务，为避免打断用户而跳过重启。"
    say "[warn] 代码与 poller 已落盘，但需在空闲时执行：docker restart $CONTAINER（或 FORCE_RESTART=1）"
    say "[warn] 未重启 = 新旧代码并存，本次交付记为「已落盘待重启」。"
    exit 0
  fi
fi

say "重启 $CONTAINER ..."
docker restart "$CONTAINER" > /dev/null || { restore_on_fail; die "重启失败，已回滚"; }
sleep 12

hr "7/7 健康门禁（任一不过 = 交付失败并回滚）"
FAIL=0
docker ps --format '{{.Names}} {{.Status}}' | grep "^$CONTAINER " | grep -q 'Up' \
  && say "① 容器在运行" || { say "① [FAIL] 容器未运行"; FAIL=1; }

LOGS=$(docker logs --since 90s "$CONTAINER" 2>&1 | tail -200)
if printf '%s' "$LOGS" | grep -qE 'FATAL|ParseError|SyntaxError|error: Unexpected'; then
  say "② [FAIL] 启动日志有解析/致命错误："
  printf '%s\n' "$LOGS" | grep -E 'FATAL|ParseError|SyntaxError|error: Unexpected' | tail -5
  FAIL=1
else
  say "② 启动日志无 FATAL/ParseError/SyntaxError"
fi

docker exec "$CONTAINER" bun build "$TARGET_IN_CONTAINER" --no-bundle >/dev/null 2>&1 \
  && say "③ 容器内 bun import 冒烟 OK" || { say "③ [FAIL] 容器内 bun import 冒烟失败"; FAIL=1; }

HOST_MD5=$(md5sum "$TARGET" | awk '{print $1}')
CONT_MD5=$(docker exec "$CONTAINER" md5sum "$TARGET_IN_CONTAINER" 2>/dev/null | awk '{print $1}' || echo "")
[ "$HOST_MD5" = "$CONT_MD5" ] \
  && say "④ 宿主/容器 md5 一致（$HOST_MD5）" \
  || { say "④ [FAIL] md5 不一致：宿主=$HOST_MD5 容器=${CONT_MD5:-空}"; FAIL=1; }

docker exec "$CONTAINER" sh -c 'curl -sS --max-time 15 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe"' 2>/dev/null | grep -q '"ok":true' \
  && say "⑤ TG getMe ok（回传发送面可用）" \
  || say "⑤ [warn] TG getMe 未返回 ok:true —— 回传链路可能不可用（不影响派单），请查 token/网络"

if [ "$FAIL" = "0" ]; then
  printf '\nCONCLUSION OK —— 修复 D 已生效。\n'
  printf '备份：%s\n' "$BACKUP"
  printf '回程日志：journalctl -u %s -f | grep tgpush   或   tail -f %s\n' "$SERVICE" "$ALERT_LOG"
  printf '下一步：bash regr/regrD.sh（合成回归，验证 2 分钟内收到回传且重跑 0 重复）\n'
else
  printf '\nCONCLUSION FAIL —— 健康门禁未通过，执行回滚。\n'
  restore_on_fail
  die "请手工 docker restart $CONTAINER 回到旧版，并把本输出交给开发"
fi
