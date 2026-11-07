/**
 * delivery-hub.ts —— 交付枢纽（蓝图 v3 S1, 2026-11-04）
 * 唯一所有者: acquire(取件,唯一沙箱桥) → validate(门禁集中) → publishLink(发布) → markDelivered(唯一信号)
 * 铁律: fail-open(对外永不抛异常) + 结构化 [hub] 日志 + 门禁规则集中于此(调用方不得自带)
 * S1 范围: deliver_local 薄客户端化; doc_pack/publishFile=S3; task-watchdog=S4(Inngest)
 * S5 (rx5fix2 2026-11-04): html 交付=沙箱优先 refresh + 主路 tar 整目录拉取(单次RPC原子) +
 *    兜底1 pullTree 相对引用补拉 + 兜底2 原单文件; caps 200文件/32MB/单8MB/深4;
 *    防逃逸(条目必须留在项目目录内)/防外链/拒 .git 与 node_modules; 全部 fail-open 不阻断交付。
 *    doc_pack 单文件流(无 index.html/js/css 特征)走原路径零分叉。回滚=恢复 .bak.s5fix2。
 * 事件(fire-forget): wagate/task_started{sessionId,taskId} / wagate/task_delivered{sessionId,taskId,url,via} → Inngest 8288
 * 卸载: 去 unit 挂载 + restart。
 */
import { openSync, readSync, closeSync, statSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const TAG = "[hub]";
const WS_ROOT = "/srv/tenants";
const PREVIEW_BASE = (process.env.PREVIEW_URL_BASE ?? "http://5.189.129.216/ws").replace(/\/+$/, "");
const INNGEST_BASE = (process.env.INNGEST_BASE_URL ?? "http://127.0.0.1:8288").replace(/\/+$/, "");
const EVENT_KEY = String(process.env.INNGEST_EVENT_KEY ?? "");

/** 工具面/守卫豁免清单的唯一声明（S4: upload-ops 与守卫读取此清单） */
const HUB_TOOLS = ["deliver_local", "doc_pack", "sandbox_write"];

const G: any = globalThis as any;

function log(...a: any[]): void { try { console.log(TAG, ...a); } catch { /* noop */ } }
function warn(...a: any[]): void { try { console.warn(TAG, ...a); } catch { /* noop */ } }

/** 发事件到 Inngest（fail-open, fire-forget; 同 aa-inngest-bridge 模式） */
function emit(name: string, data: Record<string, unknown>): void {
  if (!EVENT_KEY) return;
  fetch(`${INNGEST_BASE}/e/${EVENT_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, data }),
  }).then((r) => log("emit", name, `-> ${r.status}`)).catch((e) => warn("emit-fail-open", name, String(e).slice(0, 80)));
}

/** 新鲜度起点 + 轮次 id —— ledger running 行(每轮 before_agent_start 落一行), 无行则 30min 兜底 */
async function roundInfo(sid: string): Promise<{ freshSince: number; roundId: string }> {
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(`${WS_ROOT}/${sid}/ledger.db`, { readonly: true });
    const row = db.query("select id, started_ms from tasks where sid = ? and status = 'running' order by started_ms desc limit 1").get(sid) as { id?: number; started_ms?: number } | null;
    db.close();
    if (row && typeof row.started_ms === "number" && row.started_ms > 0) return { freshSince: row.started_ms - 2000, roundId: String(row.id ?? row.started_ms) };
  } catch { /* fail-open */ }
  return { freshSince: Date.now() - 30 * 60_000, roundId: `t${Date.now()}` };
}

function mtimeOf(p: string): number { try { return statSync(p).mtimeMs; } catch { return 0; } }

/** 有效性门禁（集中表）：64B 下限 + 二进制文档魔数（locdeliv6/8 规则原样收编） */
const _VB: Array<{ re: RegExp; magic: number[]; min: number; name: string }> = [
  { re: /\.(docx|pptx|xlsx|zip)$/i, magic: [0x50, 0x4b], min: 2048, name: "zip容器(docx/pptx/xlsx)" },
  { re: /\.pdf$/i, magic: [0x25, 0x50, 0x44, 0x46], min: 1024, name: "pdf" },
  { re: /\.xls$/i, magic: [0xd0, 0xcf, 0x11, 0xe0], min: 2048, name: "xls" },
];
function validateFile(p: string): string {
  try {
    const st = statSync(p);
    if (st.size < 64) return `无效：文件仅 ${st.size} 字节（占位符/测试文件）`;
    const m = _VB.find((v) => v.re.test(p));
    if (!m) return "";
    if (st.size < m.min) return `无效：仅 ${st.size} 字节，真实${m.name}文档不可能这么小`;
    const fd = openSync(p, "r");
    const buf = Buffer.alloc(m.magic.length);
    try { readSync(fd, buf, 0, m.magic.length, 0); } finally { closeSync(fd); }
    for (let i = 0; i < m.magic.length; i++) if (buf[i] !== m.magic[i]) return `无效：文件头不是有效的${m.name}格式`;
    return "";
  } catch { return ""; } // fail-open: 读取异常不拦
}

/** 沙箱 /ws 反向拉回（唯一桥）：padding 校验 + 体积一致性（截断=拒收, locdeliv7/8 规则原样收编） */
async function pullFromSandbox(sid: string, rel: string, abs: string, maxBytes = 30 * 1024 * 1024): Promise<boolean> {
  try {
    const sb = G.__sbxBash as ((cmd: string, sid?: string) => Promise<{ ok?: boolean; error?: string; text?: string }>) | undefined;
    if (!sb) return false;
    const q = rel.replace(/'/g, "");
    const st = await sb(`test -f '/ws/${q}' && stat -c %s '/ws/${q}'`, sid);
    const sz = parseInt(String(st?.text || "").trim(), 10);
    if (!st?.ok || !(sz > 0) || sz > maxBytes) return false;
    const rb = await sb(`base64 '/ws/${q}'`, sid);
    const b64 = String(rb?.text || "").replace(/\s+/g, "");
    if (!rb?.ok || b64.length <= 0 || b64.length % 4 !== 0) { warn("pull-b64-bad", sid, rel); return false; }
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, Buffer.from(b64, "base64"));
    const wsz = statSync(abs).size;
    if (wsz !== sz) { warn("pull-size-mismatch", sid, `${rel} expect=${sz} got=${wsz}`); try { unlinkSync(abs); } catch { /* noop */ } return false; }
    log("sandbox-pulled", sid, `${rel} size=${sz}`);
    return true;
  } catch (e) { warn("pull-fail-open", sid, String(e).slice(0, 100)); return false; }
}

/** 沙箱文件存在探测（S5, 只读, fail-open） */
async function sandboxFileExists(sid: string, rel: string): Promise<boolean> {
  try {
    const sb = G.__sbxBash as ((cmd: string, sid?: string) => Promise<{ ok?: boolean; error?: string; text?: string }>) | undefined;
    if (!sb) return false;
    const q = rel.replace(/'/g, "");
    const st = await sb(`test -f '/ws/${q}'`, sid);
    return !!st?.ok;
  } catch { return false; }
}

/**
 * S5(rx5fix2): pullProjectDirTar —— 主路：项目目录一次 tar 整拉（原子, 不解析引用）
 * caps: 总量 32MB(不含 .git/node_modules) / 条目 200 / 单文件 8MB(由 tar 上限=总量隐含);
 * 安全: --exclude .git/node_modules + 条目清单校验(必须留在 <base>/ 内, 拒 .. 与绝对路径)。
 * 失败返回 false 由调用方降级 pullTree/单文件, 绝不阻断交付。
 */
async function pullProjectDirTar(sid: string, projBase: string, hostWsRoot: string): Promise<boolean> {
  let tmpTar = "";
  try {
    const sb = G.__sbxBash as ((cmd: string, sid?: string) => Promise<{ ok?: boolean; error?: string; text?: string }>) | undefined;
    if (!sb) return false;
    const b = projBase.replace(/'/g, "");
    if (!b || b === "." || b === "/" || b.startsWith("/")) return false;
    const EXC = "--exclude=*/.git* --exclude=*/node_modules*";
    let probe: { ok?: boolean; error?: string; text?: string } | null = null;
    try { probe = await sb(`du -sb ${EXC} '/ws/${b}' | cut -f1; find '/ws/${b}' -type f | wc -l`, sid); } catch (e2: any) { probe = null; }
    const nums = String((probe as any)?.text || "").trim().split(/\s+/).map((x: string) => parseInt(x, 10) || 0);
    if (!(probe as any)?.ok || nums.length < 2 || !(nums[0] > 0)) return false;
    if (nums[0] > 32 * 1024 * 1024 || nums[1] > 200) { warn("tar-caps", sid, `total=${nums[0]} files=${nums[1]} -> 降级 pullTree`); return false; }
    const rb = await sb(`cd /ws && tar -cf - ${EXC} '${b}' | base64 -w 0`, sid);
    const b64 = String(rb?.text || "").replace(/\s+/g, "");
    if (!rb?.ok || b64.length <= 0 || b64.length % 4 !== 0) { warn("tar-b64-bad", sid, b); return false; }
    const buf = Buffer.from(b64, "base64");
    if (buf.length === 0) { warn("tar-empty", sid, b); return false; }
    tmpTar = `/tmp/hub-tar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar`;
    writeFileSync(tmpTar, buf);
    const listOut = execFileSync("tar", ["-tf", tmpTar], { encoding: "utf8", timeout: 15000 });
    const entries = listOut.split("\n").filter(Boolean);
    if (entries.length === 0) { warn("tar-entries-empty", sid, b); return false; }
    const bad = entries.find((e) => !(e === b || e.startsWith(b + "/")) || e.includes("..") || e.startsWith("/"));
    if (bad) { warn("tar-entries-bad", sid, `${b} bad=${bad.slice(0, 120)}`); return false; }
    mkdirSync(hostWsRoot, { recursive: true });
    execFileSync("tar", ["-xf", tmpTar, "-C", hostWsRoot], { encoding: "utf8", timeout: 30000 });
    log("tar-pulled", sid, `${b} entries=${entries.length} bytes=${buf.length}`);
    return true;
  } catch (e) { warn("tar-fail-open", sid, String(e).slice(0, 120)); return false; }
  finally { if (tmpTar) { try { unlinkSync(tmpTar); } catch { /* noop */ } } }
}

/**
 * S5(rx5fix2): pullTree —— 兜底1：解析 html 相对 src/href 逐个补拉
 * 必须留在项目目录内(有 baseDir 强制前缀, 项目根 html 拒 ..)；拒外链/锚点/data:/javascript:；
 * 词边界属性名, 注释与 srcset 等不匹配；caps 64 文件/单 8MB/总 64MB；fail-open 全程。
 */
async function pullTree(sid: string, rel: string, abs: string): Promise<void> {
  try {
    // 注释剥离（防把示例代码里的 src/href 当引用）
    const html = readFileSync(abs, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const baseDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const seen = new Set<string>();
    const refs: string[] = [];
    const re = /\b(?:src|href)\b\s*=\s*["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const ref = String(m[1] || "").trim();
      if (!ref) continue;
      if (/^(?:https?:)?\/\//i.test(ref)) continue;
      if (/^(?:data:|javascript:|mailto:|tel:|#)/i.test(ref)) continue;
      if (ref.endsWith("/")) continue;
      const p = path.posix.normalize(path.posix.join(baseDir, ref.split("?")[0].split("#")[0]));
      if (!p || p === "." || p.endsWith("/")) continue;
      if (baseDir) { if (!(p === baseDir || p.startsWith(baseDir + "/"))) continue; }
      else { if (p.startsWith("..")) continue; }
      if (p === rel || seen.has(p)) continue;
      seen.add(p); refs.push(p);
      if (refs.length >= 64) { warn("tree-caps", sid, `refs>=64 截断 rel=${rel}`); break; }
    }
    let total = 0, missing = 0;
    for (const r of refs) {
      const a2 = `${WS_ROOT}/${sid}/workspace/${r}`;
      if (await pullFromSandbox(sid, r, a2, 8 * 1024 * 1024)) { try { total += statSync(a2).size; } catch { /* noop */ } } else missing++;
      if (total > 64 * 1024 * 1024) { warn("tree-total", sid, `总补拉 >64MB 截断 rel=${rel}`); break; }
    }
    log("pull-tree", sid, `rel=${rel} refs=${refs.length} missing=${missing}`);
  } catch (e) { warn("tree-fail-open", sid, String(e).slice(0, 100)); }
}

/** S1: acquire —— html: 沙箱优先 refresh + 主路 tar/兜底 single(S5); 其余按原宿主优先; 两路都 fail-open */
async function acquire(sid: string, rel: string): Promise<{ ok: boolean; abs?: string; isDir?: boolean; why?: string; mode?: "tar" | "single" | "host" }> {
  const abs = `${WS_ROOT}/${sid}/workspace/${rel}`;
  if (/\.html?$/i.test(rel)) {
    if (await sandboxFileExists(sid, rel)) {
      const seg = rel.split("/")[0];
      if (rel.includes("/") && seg) {
        if (await pullProjectDirTar(sid, seg, `${WS_ROOT}/${sid}/workspace`)) {
          try { return { ok: true, abs, isDir: statSync(abs).isDirectory(), mode: "tar" }; } catch { /* noop */ }
        }
      }
      if (await pullFromSandbox(sid, rel, abs)) {
        try { return { ok: true, abs, isDir: statSync(abs).isDirectory(), mode: "single" }; } catch { /* noop */ }
      }
      // tar 与 single 都失败 → 落回原宿主优先（fail-open, 绝不让 html 交付变难）
    }
  }
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); return { ok: true, abs, isDir, mode: "host" }; } catch { /* host missing */ }
  if (await pullFromSandbox(sid, rel, abs)) {
    try { isDir = statSync(abs).isDirectory(); return { ok: true, abs, isDir, mode: "single" }; } catch { /* noop */ }
  }
  return { ok: false, why: `交付失败：本地文件不存在 ${abs}（沙箱 /ws 也没有）。请用 sandbox_write 写入产物，或先在沙箱内生成后重试 deliver_local。` };
}

/** S1: validate —— 新鲜度 + 有效性（返回不含 rel 前缀的 reason, 调用方拼 `交付拒绝：${rel} ${reason}`） */
function validate(abs: string, isDir: boolean, freshSince: number): { ok: boolean; code?: string; reason?: string } {
  if ((process.env.WAGATE_LOCAL_FRESH_OFF ?? "0") !== "1") {
    const mt = mtimeOf(isDir ? `${abs}/index.html` : abs) || mtimeOf(abs);
    if (!mt || mt < freshSince) return { ok: false, code: "stale", reason: `是历史产物（最后修改早于本轮任务开始），不能当作本轮交付复述。请先真正完成本轮开发：用 sandbox_write 把本任务的新产物写入 workspace（建议新目录，如 oa-system/index.html），再用新路径调用 deliver_local。` };
  }
  if ((process.env.WAGATE_LOCAL_VALID_OFF ?? "0") !== "1" && !isDir) {
    const vr = validateFile(abs);
    if (vr) return { ok: false, code: "invalid", reason: `${vr}。禁止交付占位符/垃圾字节并谎称有效。文档类(.docx/.pptx/.pdf)请用 doc_pack 工具交付（会把真实文件发给用户），或在沙箱内真正生成后由 doc_pack 拉取；网页类用 sandbox_write 写入真实内容后 deliver_local。` };
  }
  return { ok: true };
}

/** S1: publishLink —— 本地直链拼接 + FS 权威门禁 + HEAD 内容一致性门禁（5s） */
async function publishLink(sid: string, rel: string, abs: string, isDir: boolean): Promise<{ ok: boolean; url?: string; code?: number; why?: string }> {
  const url = `${PREVIEW_BASE}/${encodeURI(String(sid))}/workspace/${rel.split("/").map(encodeURIComponent).join("/")}${isDir ? "/" : ""}`;
  // FS 是唯一权威：宿主文件在不在，nginx 一定照实吐。nginx 80 有 default server(server_name _) ⇒ 错 Host 会拿到 TokenHub 的 200，
  // 所以 HTTP 码不可单独作通过依据，必须与本地字节数比对（尺寸不符=假 200）。
  let expect = 0;
  try { const st = statSync(abs); expect = st.isDirectory() ? 0 : st.size; } catch { return { ok: false, url, code: 0, why: `交付未完成：产物未落盘（${abs}）${url}，请重新调用 deliver_local（不要改用 git push）。` }; }
  let ok = false, code = 0, cl = 0;
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 5000);
    const r = await fetch(url, { method: "HEAD", signal: c.signal });
    clearTimeout(t);
    code = r.status;
    cl = Number(r.headers.get("content-length") ?? "0");
    // 通过条件：200 + 尺寸一致。尺寸缺失(cl=0)时放行（避免 chunked/代理去头造成假 404，宁放过不误杀）。
    ok = code === 200 && (isDir || expect === 0 || cl === 0 || cl === expect);
  } catch { ok = false; }
  if (!ok) {
    const why = code === 200 && cl > 0 && expect > 0 && cl !== expect
      ? `交付未完成：直链返回的内容与产物不一致（远端 ${cl}B ≠ 本地 ${expect}B），该域名/Host 未命中 workspace 静态站。${url} 请直接重试 deliver_local；若持续失败说明产物路径或 nginx 映射有问题。`
      : `交付未完成：产物已落盘但本地直链未就绪（HTTP ${code || "ERR"}）${url}，可能 ws-sync 尚未同步到宿主。请稍等 5~10 秒后重新调用 deliver_local（不要改用 git push）。`;
    return { ok: false, url, code, why };
  }
  return { ok: true, url };
}

/** S1: markDelivered —— 唯一信号（__fbState + __lastDeliver + task_delivered 事件） */
function markDelivered(o: { sid: string; url: string; via: string; summary: string; taskId: string }): void {
  try {
    G.__fbState = Object.assign({}, G.__fbState || {}, { delivered: o.url, block: "", sid: o.sid });
    G.__lastDeliver = { sid: o.sid, url: o.url, at: Date.now(), summary: o.summary };
  } catch { /* fail-open */ }
  emit("wagate/task_delivered", { sessionId: o.sid, taskId: o.taskId, url: o.url, via: o.via, ts: Date.now() });
}

const lastRound = new Map<string, string>();
function emitTaskStarted(sid: string, roundId: string): void {
  if (lastRound.get(sid) === roundId) return;
  lastRound.set(sid, roundId);
  emit("wagate/task_started", { sessionId: sid, taskId: roundId, ts: Date.now() });
}

/** S1+S2: deliver —— deliver_local 的完整交付流程（门面） */
async function deliver(opts: { sid: string; rel: string }): Promise<{ ok: boolean; url?: string; why?: string; code?: string }> {
  try {
    const sid = String(opts.sid || "");
    const rel = String(opts.rel || "").replace(/^\/+/, "").trim();
    if (!sid) return { ok: false, why: "交付失败：无法确定当前租户 sid（会话上下文缺失），请重试一次；仍失败请人工介入。", code: "no-sid" };
    if (!rel || rel.includes("..")) return { ok: false, why: "交付失败：path 非法（须为相对 workspace 的路径，且不含 ..）", code: "bad-path" };
    const ri = await roundInfo(sid);
    emitTaskStarted(sid, ri.roundId);
    const acq = await acquire(sid, rel);
    if (!acq.ok || !acq.abs) return { ok: false, why: acq.why, code: "no-file" };
    // S5: single/host 模式的 html 补拉引用树（tar 模式整目录已含全部引用, 不重复）
    if (!acq.isDir && /\.html?$/i.test(rel) && acq.mode !== "tar") await pullTree(sid, rel, acq.abs);
    const val = validate(acq.abs, !!acq.isDir, ri.freshSince);
    if (!val.ok) { log(`reject ${val.code} sid=${sid} rel=${rel}`); return { ok: false, why: `交付拒绝：${rel} ${val.reason}`, code: val.code }; }
    const pub = await publishLink(sid, rel, acq.abs, !!acq.isDir);
    if (!pub.ok) return { ok: false, why: pub.why, code: "not-ready" };
    markDelivered({ sid, url: pub.url as string, via: "local", summary: "local:" + rel, taskId: ri.roundId });
    log("delivered", sid, `${rel} -> ${pub.url} size=${(() => { try { return statSync(acq.abs as string).size; } catch { return 0; } })()} mode=${acq.mode || "-"}`);
    return { ok: true, url: pub.url };
  } catch (e) {
    warn("deliver-fail-open", String(e).slice(0, 140));
    return { ok: false, why: `交付异常（fail-open）：${String(e).slice(0, 140)}`, code: "exception" };
  }
}

/** 全局暴露（模块顶层初始化: import 即生效, 不依赖 default export 被调用） */
G.__deliveryHub = { deliver, acquire, validate, publishLink, markDelivered, roundInfo, HUB_TOOLS };

export default function deliveryHub() {
  log(`installed (acquire[tar/single/host]/validate/publishLink/markDelivered + pullTree + HUB_TOOLS=${HUB_TOOLS.join(",")})`);
}
