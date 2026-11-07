#!/bin/sh
# fix-mem5-first.sh —— 五层记忆增强·第一批·v2（issue #79）
#
# 四项修复（全部租户级、落 workspace/；不改核心、不 docker build）：
#   ① 断点层   workspace/continuation.md        —— 每轮无条件注入「上次未完工作」(≤600 字)
#   ② L5 写入器 personal-assistant.ts agent_end —— 输入源改读 globalThis.__lastUserText
#                  + 系统指令拒绝门（防把 tenant-core 注入的指令文本写进 profile.md）
#   ③ 租户技能账 workspace/installed-skills.md  —— 工具事件记账 + 每轮注入清单(尾 20 行)
#   ④ 交付索引 workspace/deliveries-index.md + /srv/tenants/<sid>/last-delivery.json
#                  —— markDelivered 成功后落索引与持久兜底（重启后仍能取到上次交付）
#
# 模式：
#   默认            DRY-RUN：只做锚点校验并打印改动清单，绝不写盘。
#   --apply         真正应用；先备份 <file>.bak.mem5.<ts>；python open("w") 截断写（保 inode，坑#36）
#   --revert <ts>   用 <file>.bak.mem5.<ts> 还原
#   --check-anchors 只做锚点唯一性校验（供回归脚本复用；无备份、不写盘）
#
# 目标目录：默认 $WAGATE_PLUGIN_DIR，可用 --dir 覆盖。
#   回归脚本用 --dir 指向 fixture 目录（mem5-context/ 下的快照副本）。
#
# 铁律（issue #79）：
#   - 只改两个已挂载文件：personal-assistant.ts、delivery-hub.ts。绝不动 tenant-core/telegram/
#     bot/upload-ops/route-guard/img-ops/project-identity.ts/skill-install.ts。
#   - 锚点必须恰好出现 1 次，否则中止（防误伤）。已打补丁再来一次 = 幂等无操作退出 0。
#   - task.json 绝不可写（单写者仲裁）；last-delivery.json 是独立新文件。
#   - WAGATE_MEM_ENHANCE_OFF=1 为总逃生阀：零注入、零写入。
#   - 全部新增写入 try/catch fail-open；新增注入总增量 ≤1.5KB。
#   - 严禁 sed -i（坑#36：单文件 bind 挂载锁 inode）——统一 python open("w") 截断写。
#
# 用法：
#   sh fix-mem5-first.sh                          # 干跑
#   sh fix-mem5-first.sh --apply                  # 应用
#   sh fix-mem5-first.sh --check-anchors          # 只校验锚点
#   sh fix-mem5-first.sh --revert 20261107-120000
#   sh fix-mem5-first.sh --dir /path/to/dir       # 覆盖目标目录

set -u

MODE="dry"
REVERT_TS=""
PLUGIN_DIR="${WAGATE_PLUGIN_DIR:-/srv/wagate/extensions}"
STAMP=$(date +%Y%m%d-%H%M%S)

while [ $# -gt 0 ]; do
  case "$1" in
    --apply)         MODE="apply"; shift ;;
    --revert)        MODE="revert"; REVERT_TS="${2:?--revert 需要时间戳}"; shift 2 ;;
    --check-anchors) MODE="check"; shift ;;
    --dir)           PLUGIN_DIR="$2"; shift 2 ;;
    -h|--help)       sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（见 --help）" >&2; exit 2 ;;
  esac
done

PA="$PLUGIN_DIR/personal-assistant.ts"
DH="$PLUGIN_DIR/delivery-hub.ts"
MARK="MEM5_FIRST_V1"

say() { printf '%s\n' "$*"; }
die() { printf '中止：%s\n' "$*" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || die "缺少 python3（截断写依赖它）"

# ---------------------------------------------------------------- 回滚
if [ "$MODE" = "revert" ]; then
  say "== 回滚 mem5-first -> $REVERT_TS"
  for F in "$PA" "$DH"; do
    B="$F.bak.mem5.$REVERT_TS"
    if [ -f "$B" ]; then
      python3 -c '
import sys
with open(sys.argv[1], "rb") as fh:
    data = fh.read().decode("utf-8")
with open(sys.argv[2], "w") as fh:   # 截断写：保 inode（坑#36）
    fh.write(data)
' "$B" "$F" && say "  已还原：$F"
    else
      say "  跳过（无备份）：$B"
    fi
  done
  say "回滚完成。"
  exit 0
fi

[ "$MODE" = "dry" ] && say "*** DRY-RUN（不写盘）。加 --apply 才会应用。***"

[ -f "$PA" ] || die "未找到 $PA —— 用 --dir 指定目录，或设 WAGATE_PLUGIN_DIR"
[ -f "$DH" ] || die "未找到 $DH —— 用 --dir 指定目录，或设 WAGATE_PLUGIN_DIR"

say ""
say "目标目录：$PLUGIN_DIR"
say "  personal-assistant.ts  $(grep -c '' "$PA") 行"
say "  delivery-hub.ts        $(grep -c '' "$DH") 行"

# ---------------------------------------------------------------- 锚点唯一性
say ""
say "== 锚点唯一性校验（每项必须恰好 1 次）"
ANCHOR_RC=0
python3 - "$PA" "$DH" <<'PY' || ANCHOR_RC=$?
import sys, io

pa = io.open(sys.argv[1], encoding="utf-8").read()
dh = io.open(sys.argv[2], encoding="utf-8").read()

# personal-assistant.ts 锚点（均已对 mem5-context 快照逐个验证唯一）
A_PA = [
    ("pa.memfiles",
     'const MEMORY_FILES = ["profile.md", "notes.md"];'),
    ("pa.capture",
     '\t\tconst userMatch = event.systemPrompt.match(/## User[\\s\\S]*?\\n([^#]+)/);\n'
     '\t\tlastUserText = userMatch ? userMatch[1].trim().slice(-500) : "";'),
    ("pa.route.ret",
     '\t\t\t\t\treturn { systemPrompt: event.systemPrompt + routingPrompt };'),
    ("pa.finish",
     '\t\tconst finish = (p: string): string => (idLine ? `${p}\\n\\n${idLine}` : p);'),
    ("pa.agentend.hook",
     '\t// ③-记忆强制写入兜底: 模型如果没调用工具写入记忆，这里强制追加\n'
     '\tpi.on("tool_execution_start", async () => {\n'
     '\t\tturnHadTool = true;\n'
     '\t});'),
]
A_DH = [
    ("dh.markdeliv",
     '    G.__lastDeliver = { sid: o.sid, url: o.url, at: Date.now(), summary: o.summary };'),
    ("dh.eof",
     'export default function deliveryHub() {'),
]

bad = 0
for name, text in A_PA:
    n = pa.count(text)
    print("  [%s] %-18s 命中 %d 次" % ("OK " if n == 1 else "BAD", name, n))
    if n != 1: bad += 1
for name, text in A_DH:
    n = dh.count(text)
    print("  [%s] %-18s 命中 %d 次" % ("OK " if n == 1 else "BAD", name, n))
    if n != 1: bad += 1

if 'MEM5_FIRST_V1' in pa and 'MEM5_FIRST_V1' in dh:
    print("  [INFO] 两文件均已含标记 MEM5_FIRST_V1 —— 幂等，无需再打。")
    sys.exit(10)
if 'MEM5_FIRST_V1' in pa or 'MEM5_FIRST_V1' in dh:
    print("  [BAD ] 部分已应用（半打状态）—— 请先 --revert 回基线。")
    sys.exit(11)
if bad:
    print("  => 有 %d 个锚点未唯一命中，目标文件版本与预期不符。" % bad)
    sys.exit(1)
sys.exit(0)
PY

case "$ANCHOR_RC" in
  0) say "  => 锚点校验通过。" ;;
  10) say ""; say "== 幂等：已应用过 —— 无操作退出（0）"; exit 0 ;;
  11) die "检测到半打状态，请先用 --revert <ts> 回滚到基线。" ;;
  *) die "锚点校验失败（见上）。未做任何改动。" ;;
esac

# __lastUserText 可用性门
if grep -q '__lastUserText' "$PA"; then
  say ""
  say "== __lastUserText 可用性门：目标文件已直读该全局，按直读方案落地。"
else
  say ""
  say "== __lastUserText 可用性门：目标文件未直读该全局 —— 采用 issue #79 允许的兜底："
  say "   在读取点补写 G.__lastUserText，统一从该全局取真实用户原话。"
fi

[ "$MODE" = "check" ] && { say ""; say "--check-anchors 完成（不写盘）。"; exit 0; }

say ""
say "== 将写入的改动"
say "  ① continuation.md 每轮无条件注入（≤600 字）+ agent_end 追加未完工作"
say "  ② L5 输入源 -> globalThis.__lastUserText + 系统指令拒绝门"
say "     （以【开头，或含 先判断本条是不是开发需求 / 防跑偏 / NEW TASK BOUNDARY）"
say "  ③ installed-skills.md：工具调用记账 + 每轮注入尾 20 行"
say "  ④ deliveries-index.md 追加 + /srv/tenants/<sid>/last-delivery.json 持久兜底"
say "  注入总增量预算 ≤1.5KB；WAGATE_MEM_ENHANCE_OFF=1 时零注入零写入。"

if [ "$MODE" = "dry" ]; then
  say ""
  say "== DRY-RUN 结束。确认无误后：sh $0 --apply --dir $PLUGIN_DIR"
  exit 0
fi

# ---------------------------------------------------------------- 应用
say ""
say "== 应用（备份后缀 .bak.mem5.$STAMP）"
for F in "$PA" "$DH"; do
  cp -p "$F" "$F.bak.mem5.$STAMP" || die "备份失败：$F"
  say "  备份：$F.bak.mem5.$STAMP"
done

if ! python3 - "$PA" "$DH" <<'PY'
import sys, io

pa_path, dh_path = sys.argv[1], sys.argv[2]

def load(p): return io.open(p, encoding="utf-8").read()
def save(p, s):
    with io.open(p, "w", encoding="utf-8") as f:  # 截断写：保 inode（坑#36）
        f.write(s)
def sub1(src, anchor, repl, name):
    n = src.count(anchor)
    if n != 1:
        raise SystemExit("锚点 %s 命中 %d 次（要求 1）" % (name, n))
    return src.replace(anchor, repl, 1)

# ==================================================== personal-assistant.ts
pa = load(pa_path)

# ---- (a) 常量 + mem5 辅助函数（插在 MEMORY_FILES 之后） ----
pa = sub1(pa,
'const MEMORY_FILES = ["profile.md", "notes.md"];',
'''const MEMORY_FILES = ["profile.md", "notes.md"];

/* ===== mem5-first (MEM5_FIRST_V1) =====
 * 四项修复同批落地：断点层 / L5 输入源与拒绝门 / 租户技能账 / 交付注入汇总。
 * 逃生阀：WAGATE_MEM_ENHANCE_OFF=1 -> 零注入零写入（即时生效）。
 * 回滚：fixes/fix-mem5-first.sh --revert <ts> */
/** mem5 断点层：上次未完工作 */
const MEM5_CONTINUATION_FILE = "continuation.md";
/** mem5 租户技能账：本租户已装/用过的技能包 */
const MEM5_SKILLS_FILE = "installed-skills.md";
/** mem5 交付索引：每次成功交付一行 */
const MEM5_INDEX_FILE = "deliveries-index.md";
/** mem5 三段注入合计预算（issue #79 硬约束 ≤1.5KB） */
const MEM5_INJECT_BUDGET = 1500;
/** mem5 断点层正文上限 */
const MEM5_CONT_MAX = 600;
/** mem5 技能账/交付索引注入的尾部行数 */
const MEM5_SKILLS_LINES = 20;
const MEM5_INDEX_LINES = 10;

/** mem5 逃生阀：=1 时零注入零写入 */
function mem5Off(): boolean {
	return process.env.WAGATE_MEM_ENHANCE_OFF === "1";
}

/** mem5 系统指令特征串：命中即拒写（防再次把系统指令写进 profile.md） */
const MEM5_SYS_MARKERS = ["【先判断本条是不是开发需求", "防跑偏", "NEW TASK BOUNDARY"];

/** mem5 判断文本是否为系统指令注入（而非真实用户原话）。true = 拒绝写入 */
function mem5IsSystemInstruction(t: string): boolean {
	const s = String(t || "").trim();
	if (!s) return true;
	if (s.startsWith("【")) return true; // 【】包裹 = 系统指令/分诊路由标记
	return MEM5_SYS_MARKERS.some((m) => s.includes(m));
}

/** mem5 取真实用户原话：优先 globalThis.__lastUserText（tenant-core 每轮维护），回退本文件缓存 */
function mem5UserText(fallback: string): string {
	try {
		const g = G.__lastUserText;
		const t = typeof g === "string" && g.trim() ? g : fallback;
		return String(t || "").trim();
	} catch { return String(fallback || "").trim(); }
}

/** mem5 读一段记忆并渲染为注入块；缺失/空/逃生阀开启 -> 空串。可限行数与字数。 */
function mem5Section(cwd: string, file: string, maxChars: number, tailLines: number, head: string): string {
	try {
		if (mem5Off() || !cwd) return "";
		const p = path.join(cwd, file);
		if (!fs.existsSync(p)) return "";
		let raw = fs.readFileSync(p, "utf-8");
		if (tailLines > 0) {
			raw = raw.split("\\n").filter((l) => l.trim() !== "").slice(-tailLines).join("\\n");
		}
		raw = raw.trim();
		if (!raw) return "";
		return `\\n${head}\\n${raw.slice(0, maxChars)}\\n`;
	} catch { return ""; } // fail-open：记忆读失败不阻断本轮
}

/** mem5 汇总三段注入并做总预算裁剪（超预算按序截断，断点层排最前）。 */
function mem5Inject(cwd: string | undefined): string {
	try {
		if (mem5Off() || !cwd) return "";
		const cont = mem5Section(cwd, MEM5_CONTINUATION_FILE, MEM5_CONT_MAX, 0,
			"【上次未完工作】(跨会话断点：若用户说\\"继续\\"就接着做这件事；已完成则忽略)");
		const skills = mem5Section(cwd, MEM5_SKILLS_FILE, MEM5_CONT_MAX, MEM5_SKILLS_LINES,
			"【已装技能包】(本租户技能账：问\\"会什么/装了什么\\"直接据此答，不要出网)");
		const index = mem5Section(cwd, MEM5_INDEX_FILE, MEM5_CONT_MAX, MEM5_INDEX_LINES,
			"【近期交付索引】(用户说\\"修复/改/优化\\"而未指明对象时，默认指最近交付的产物)");
		const parts = [cont, skills, index].filter(Boolean);
		if (parts.length === 0) return "";
		let out = parts.join("");
		if (out.length > MEM5_INJECT_BUDGET) out = out.slice(0, MEM5_INJECT_BUDGET);
		console.log(`[mem5] 注入 断点/技能账/交付索引 共 ${out.length} 字（预算 ${MEM5_INJECT_BUDGET}）`);
		return out;
	} catch { return ""; }
}

/** mem5 追加一行到 workspace 记账文件（首行自动补标题）。 */
function mem5AppendLine(cwd: string, file: string, title: string, line: string): void {
	try {
		if (mem5Off() || !cwd) return;
		const p = path.join(cwd, file);
		if (!fs.existsSync(p)) fs.writeFileSync(p, `# ${title}\\n`);
		fs.appendFileSync(p, line.endsWith("\\n") ? line : line + "\\n");
	} catch (e) {
		console.warn(`[mem5] 追加 ${file} 失败(fail-open): ${String(e).slice(0, 120)}`);
	}
}

/** mem5 断点层写入：agent_end 时把本轮真实用户原话追加为「未完工作」候选。 */
function mem5WriteContinuation(cwd: string, text: string): void {
	try {
		if (mem5Off() || !cwd || !text) return;
		const p = path.join(cwd, MEM5_CONTINUATION_FILE);
		const existing = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "";
		if (existing.includes(text.slice(0, 50))) return; // 去重
		const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
		const entry = `\\n## ${stamp}\\n${text}\\n`;
		if (!existing) fs.writeFileSync(p, `# 断点续作（最近未完工作，尾部最新）\\n${entry}`);
		else fs.appendFileSync(p, entry);
		console.log(`[mem5] 断点层写入: ${p}`);
	} catch (e) {
		console.warn(`[mem5] 断点层写入失败(fail-open): ${String(e).slice(0, 120)}`);
	}
}''', "pa.memfiles")

# ---- (b) L5 输入源改读 __lastUserText + 系统指令拒绝门 ----
pa = sub1(pa,
'\t\tconst userMatch = event.systemPrompt.match(/## User[\\s\\S]*?\\n([^#]+)/);\n'
'\t\tlastUserText = userMatch ? userMatch[1].trim().slice(-500) : "";',
'''\t\t// mem5 修复②：真实用户原话取自 globalThis.__lastUserText（tenant-core 每轮维护）。
\t\t// 旧实现 match(/## User[\\s\\S]*?\\n([^#]+)/) 抓不到用户消息，反而把 tenant-core 注入的
\t\t// 内部指令文本当成用户输入写进 profile.md（画像被污染）。
\t\t// 可用性兜底：若该全局缺失（未挂载/未维护），用事件 prompt 承接，仍走后面的拒绝门。
\t\tif (typeof G.__lastUserText !== "string") {
\t\t\tconst evp = (event as unknown as { prompt?: unknown }).prompt;
\t\t\tif (typeof evp === "string" && evp.trim()) G.__lastUserText = evp.trim();
\t\t}
\t\tconst mem5Raw = mem5UserText("");
\t\t// 系统指令拒绝门：命中即视为非用户原话，本轮不做 L5 写入。
\t\tlastUserText = mem5IsSystemInstruction(mem5Raw) ? "" : mem5Raw.slice(-500);''',
"pa.capture")

# ---- (c) 路由出口注入（该 return 不走 finish，单独拼） ----
pa = sub1(pa,
'\t\t\t\t\treturn { systemPrompt: event.systemPrompt + routingPrompt };',
'\t\t\t\t\treturn { systemPrompt: event.systemPrompt + routingPrompt + mem5Inject(cwd) };',
"pa.route.ret")

# ---- (d) finish 出口注入（覆盖 store 路径全部 return，含 idLine 追加） ----
pa = sub1(pa,
'\t\tconst finish = (p: string): string => (idLine ? `${p}\\n\\n${idLine}` : p);',
'''\t\t// mem5 ④-注入汇总：断点层/技能账/交付索引，附在 systemPrompt 末尾。
\t\t// 走 finish 出口，天然覆盖本 handler 前两个 return（!cwd / 无记忆）及后续记忆分支。
\t\tconst mem5Block = mem5Inject(cwd);
\t\tconst finish = (p: string): string => (idLine ? `${p}${mem5Block}\\n\\n${idLine}` : `${p}${mem5Block}`);''',
"pa.finish")

# ---- (e) 工具记账（技能账）+ agent_end 断点写入 ----
pa = sub1(pa,
'\t// ③-记忆强制写入兜底: 模型如果没调用工具写入记忆，这里强制追加\n'
'\tpi.on("tool_execution_start", async () => {\n'
'\t\tturnHadTool = true;\n'
'\t});',
'''\t// ③-记忆强制写入兜底: 模型如果没调用工具写入记忆，这里强制追加
\tpi.on("tool_execution_start", async () => {
\t\tturnHadTool = true;
\t});

\t// mem5 ③-租户技能账：每次工具调用记一行（同轮同名工具只记一次）。
\t// 挂 tool_execution_start（本版本无 tool_execution_end 事件可用），fail-open。
\tconst mem5SkillsSeen = new Set<string>();
\tpi.on("tool_execution_start", async (event: unknown) => {
\t\ttry {
\t\t\tif (mem5Off() || !cwd) return;
\t\t\tconst ev = (event ?? {}) as Record<string, unknown>;
\t\t\tconst name = String(ev.toolName ?? ev.name ?? "").trim();
\t\t\tif (!name || mem5SkillsSeen.has(name)) return;
\t\t\tif (!/^(skill|skill_install|skill-install)/i.test(name)) return; // 只记技能类工具
\t\t\tmem5SkillsSeen.add(name);
\t\t\tconst stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
\t\t\tmem5AppendLine(cwd, MEM5_SKILLS_FILE, "租户技能账（本租户安装/使用过的技能包）",
\t\t\t\t`- ${stamp} | ${name}`);
\t\t} catch { /* fail-open */ }
\t});

\t// mem5 ①-断点层写入：本轮结束时记录真实用户诉求，供下轮「上次未完工作」注入。
\tpi.on("agent_end", async () => {
\t\ttry {
\t\t\tif (mem5Off() || !cwd) return;
\t\t\tconst t = mem5UserText(lastUserText);
\t\t\tif (mem5IsSystemInstruction(t)) return; // 拒绝门：系统指令不入断点层
\t\t\tmem5WriteContinuation(cwd, t.slice(-500));
\t\t} catch { /* fail-open */ }
\t});''',
"pa.agentend.hook")

save(pa_path, pa)
print("personal-assistant.ts 已打补丁（%d 字节）" % len(pa.encode("utf-8")))

# ==================================================== delivery-hub.ts
dh = load(dh_path)

dh = sub1(dh,
'    G.__lastDeliver = { sid: o.sid, url: o.url, at: Date.now(), summary: o.summary };',
'''    G.__lastDeliver = { sid: o.sid, url: o.url, at: Date.now(), summary: o.summary };
    // mem5-first (MEM5_FIRST_V1)：交付索引 + last-delivery.json 持久兜底
    mem5RecordDeliver(o);''', "dh.markdeliv")

dh = sub1(dh,
'export default function deliveryHub() {',
'''/* ===== mem5-first (MEM5_FIRST_V1)：交付索引 + 持久兜底 =====
 * __lastDeliver 是易失的（进程重启即丢），project-identity 依赖它注入「最近交付」。
 * 这里在 markDelivered 成功点额外落两处持久物（fail-open，绝不阻断交付）：
 *   1) workspace/deliveries-index.md       —— 人可读，供 personal-assistant 注入
 *   2) /srv/tenants/<sid>/last-delivery.json —— 结构化兜底（不动 task.json，避免抢单写者）
 * 逃生阀 WAGATE_MEM_ENHANCE_OFF=1 -> 不写。 */
function mem5RecordDeliver(o: { sid: string; url: string; via: string; summary: string }): void {
  try {
    if (process.env.WAGATE_MEM_ENHANCE_OFF === "1") return;
    const sid = String(o.sid || "");
    if (!sid) return;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const line = `- ${stamp} | ${o.summary} | ${o.url}`;
    const ws = path.join(WS_ROOT, sid, "workspace");
    mkdirSync(ws, { recursive: true });
    const idx = path.join(ws, "deliveries-index.md");
    let existing = "";
    try { existing = readFileSync(idx, "utf-8"); } catch { writeFileSync(idx, "# 交付索引\\n"); }
    if (!existing.includes(o.url)) writeFileSync(idx, (existing || "# 交付索引\\n") + line + "\\n");
    writeFileSync(path.join(WS_ROOT, sid, "last-delivery.json"),
      JSON.stringify({ summary: o.summary, url: o.url, via: o.via, sid, at: Date.now() }, null, 2));
    log(`mem5 交付索引已更新 sid=${sid} url=${o.url}`);
  } catch (e) { warn("mem5-record-fail-open", String(e).slice(0, 120)); }
}

export default function deliveryHub() {''', "dh.eof")

save(dh_path, dh)
print("delivery-hub.ts 已打补丁（%d 字节）" % len(dh.encode("utf-8")))
PY
then
  say ""
  say "!! 补丁写入失败。备份已保留，回滚：sh $0 --revert $STAMP --dir $PLUGIN_DIR"
  exit 1
fi

say ""
say "== 完成。回滚：sh $0 --revert $STAMP --dir $PLUGIN_DIR"
say "   校验请按 README 走 bun build RC 协议（TS 无法用 node --check）。"
exit 0
