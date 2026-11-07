#!/usr/bin/env bash
# fixG-manifest.sh —— 「文件清单自动滚动」（fixG，默认 dry-run，自带机械门）
#
# 执行位置：EU 服务器（操作员逐行审后自行执行）；agent 从不执行本脚本。
#
# 默认行为：dry-run —— 只做「锚点匹配 + 计数断言 + 改动预览」，并在 /tmp 下的
#   快照副本上真跑 A–D 机械断言，**不碰任何生产文件**。
#   --apply         真正落地（先 .bak-<UTC戳> 备份，再原地重写，保 inode）
#   --verify-gate   只跑机械门（自检 A–D），不看生产锚点，也不写盘
#   --rollback      从 .bak-<时间戳> 还原；用 --from <时间戳> 指定批次
#
# 修复内容（issue #64 根因）：
#   `workspace/activeProj/current-files.txt` 只在 fixB `--apply` 时写过一次
#   （12:53 快照），之后 upload-ops 每次保存的新文件都不会自动进清单，fixB2 的
#   注入于是永远读到过时清单 —— 模型「看不到」新上传的文件。
#   凡「上传 → 注入」链路，清单必须同链路自动滚动。
#
#   ① 上传即入清单：upload-ops 的文件保存点（saved 之后）把新文件路径 append 到清单。
#      幂等（路径已在清单里 -> 只记日志不重复写）；写失败 fail-open（只告警 + 落
#      失败标记文件，主上传链绝不受影响）；可选为每条追加一行时间注释。
#   ② hold 的文件同样入清单：bot.ts 的 file-only hold 保存点同步 append
#      （与 #63 fixF 的「hold 释放」互补：清单可见是第一步；本修复不改 hold 语义）。
#   ③ 清单滚动：追加时清掉已归档路径（`archive-*/` 下的不再列出）+ 上限保护
#      （保留最近 30 条，超出裁最旧），并压掉历史时间注释行 —— 防无限膨胀。
#   ④ 机械门：A 依次传 2 个文件 -> 清单自动含 2 条 / B 重传同名 -> 不重复 /
#      C 归档文件 -> 不再列出 / D 写清单失败 -> 主链不受影响（fail-open）。
#
# 硬约束（违反 = 任务失败）：
#   * 锚文本匹配 + 数量断言 + 失败即中止（fail-closed），绝不按行号硬切
#   * 现场与基线漂移导致锚点对不上时**中止并报告**，不强行 patch
#   * 改动仅限已挂载文件；**严禁新增文件进 /app/extensions/plugins/**（坑#35）
#   * 写盘前做真实 TS 解析门（node + typescript），产物语法错 -> 不写盘
#   * 不读 secret 内容、不打印用户消息正文、不发任何用户可见消息
#
# 逃生阀（运行时，无需重新打补丁）：
#   WAGATE_MANIFEST_ROLL=0   -> 关闭入清单写入，恢复旧行为（只看日志）
#   WAGATE_MANIFEST_MAX=30   -> 清单上限条数（默认 30）
#   WAGATE_MANIFEST_STAMP=1  -> 每条追加带一行 `# <UTC时间>` 注释
#
# 用法：
#   bash fixes/fixG-manifest.sh                  # dry-run（含 A–D 机械门）
#   bash fixes/fixG-manifest.sh --verify-gate    # 只跑机械门
#   bash fixes/fixG-manifest.sh --apply
#   bash fixes/fixG-manifest.sh --rollback --from 20261107-031500

VERSION='1.0.0'
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ---- 共享小工具（与 tri-a2-multifile/lib/_lib.sh 子集等价；保持本目录自包含）----
PATCH_DIR="${PATCH_DIR:-/srv/wagate/patches}"
PLUGIN_DIR="${PLUGIN_DIR:-/app/extensions/plugins}"
CONTAINER="${CONTAINER:-wagate}"
DOCKER="${DOCKER:-docker}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
T_SHORT="${T_SHORT:-15}"
T_LONG="${T_LONG:-30}"

PASS_N=0
FAIL_N=0
WARN_N=0

pass() { PASS_N=$((PASS_N + 1)); printf '[PASS] %s\n' "$*"; }
warn() { WARN_N=$((WARN_N + 1)); printf '[WARN] %s\n' "$*"; }
fail() { FAIL_N=$((FAIL_N + 1)); printf '[FAIL] %s\n' "$*"; }
hr() { printf '\n===== %s =====\n' "$*"; }
safe() { "$@" 2>&1 || printf '[warn] 命令失败或无输出: %s\n' "$*"; }

count_fixed() {
  local f="$1" s="$2" n
  [ -f "$f" ] || { printf '0'; return; }
  n=$(grep -cF -e "$s" "$f" 2>/dev/null) || n=0
  printf '%s' "${n:-0}"
}

sha_of() { [ -f "$1" ] && sha256sum "$1" 2>/dev/null | awk '{print $1}' || printf 'N/A'; }
ts_now() { date -u '+%Y%m%d-%H%M%S' 2>/dev/null || printf 'unknown'; }
backup_of() { printf '%s.bak-%s' "$1" "$2"; }

require_file() {
  local f="$1" what="$2"
  if [ ! -f "$f" ]; then
    fail "$what 不存在：$f（用 PATCH_DIR=... 覆盖后重跑）"
    return 1
  fi
  return 0
}

ts_parse_gate() {
  local pg="$SELF_DIR/parsegate.js" n
  [ -f "$pg" ] || pg="$SELF_DIR/../lib/parsegate.js"
  if [ ! -f "$pg" ]; then printf '[syntax] 找不到 parsegate.js\n'; return 2; fi
  if ! command -v node >/dev/null 2>&1; then printf '[syntax] 环境无 node\n'; return 2; fi
  n=$(node "$pg" "$@" 2>&1); local rc=$?
  printf '%s\n' "$n"
  return $rc
}

gate_summary() {
  printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
  [ "$FAIL_N" -eq 0 ] && return 0 || return 1
}

# ---- 目标与锚点 ----
# fixB2 写下的清单路径约定（相对租户 workspace），本修复沿用同一常量
MANIFEST_REL='activeProj/current-files.txt'
# 块级锚点（每个恰好 1 次命中）
ANCHOR_UP_SAVED='[upload-ops] saved'
ANCHOR_HOLD='saved pending, waiting for user instruction'
FEATURE='__fixGRoll__'

MODE='dry'
FROM_TS=''
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) MODE='apply' ;;
    --rollback) MODE='rollback' ;;
    --verify-gate|--gate) MODE='gate' ;;
    --from) shift; FROM_TS="${1:-}" ;;
    --from=*) FROM_TS="${1#--from=}" ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 看用法）\n' "$1"; exit 2 ;;
  esac
  shift
done

GATE_LOG="${GATE_LOG:-/tmp/fixg-manifest-gate.log}"
gate_log() { printf '%s | %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >> "$GATE_LOG" 2>/dev/null || true; }

gate_fail() {
  local text="$1"
  fail "$text"
  gate_log "ALERT $text"
  printf '\n机械门判定：FAIL —— 已中止，未做任何写入。\n'
  gate_summary
  exit 1
}

# ============================================================================
# 清单滚动助手（注入到生产代码里的运行时逻辑，纯 append 语义、串行、幂等）
# ============================================================================
mlogic() {
  cat <<'TS'

	// [fixG] 文件清单自动滚动：上传/ hold 保存点 -> 幂等 append + 归档清理 + 上限保护。
	// 与 fixB2 同一路径约定（tenant workspace/activeProj/current-files.txt）；写失败 fail-open，
	// 绝不影响主上传链（①②③ 任一层出错只告警 + 落失败标记）。
	const __fixGRoll__ = (file: { fileName?: string; path?: string; filePath?: string } | undefined): void => {
		try {
			if (process.env.WAGATE_MANIFEST_ROLL === "0") return; // 逃生阀
			const ws = (globalThis as Record<string, unknown>).__fixGWorkspace as string | undefined;
			if (!ws) return;
			const __fs = require("node:fs") as typeof import("node:fs");
			const __path = require("node:path") as typeof import("node:path");
			const rel = "MANIFEST_REL_PLACEHOLDER"; // 与 fixB2 的 MANIFEST_REL 同源
			const mf = __path.join(ws, rel);
			// 清单条目一律写成 workspace 相对路径（与 fixB2 读取侧同源）：
			// upload 侧传 "uploads/x" 相对路径 -> 原样；hold 侧可能传绝对路径 -> 折回相对。
			let shown = String(file?.path || file?.filePath || file?.fileName || "").trim();
			if (!shown) return;
			if (__path.isAbsolute(shown)) {
				const relShown = __path.relative(ws, shown);
				// 越出 workspace 的绝对路径一律不记（避免把宿主机路径写进清单）
				if (!relShown || relShown.startsWith("..") || __path.isAbsolute(relShown)) return;
				shown = relShown.split(__path.sep).join("/");
			} else {
				shown = shown.split(__path.sep).join("/");
			}
			if (!__fs.existsSync(mf)) return; // 清单不存在 -> 不创建（fixB2 缺失即 fail-open）
			const max = Number(process.env.WAGATE_MANIFEST_MAX || "30") || 30;
			const stamp = process.env.WAGATE_MANIFEST_STAMP === "1";
			const lines = __fs.readFileSync(mf, "utf8").split("\n").map((s: string) => s.trim()).filter((s: string) => s && !s.startsWith("#"));
			if (lines.indexOf(shown) >= 0) { // 幂等 ①：路径已在清单里
				console.log(`[fixG] manifest already lists ${shown}`);
				return;
			}
			if (!/^https?:\/\//.test(shown) && !__fs.existsSync(__path.isAbsolute(shown) ? shown : __path.join(ws, shown))) return; // 路径不存在 -> 不入清单（清掉误报）
			const next = lines.slice();
			next.push(shown);
			// 幂等 ②：同一路径出现多次 -> 只留最后一条
			const uniq = next.filter((v: string, i: number) => next.lastIndexOf(v) === i);
			// ③ 归档清理：archive-*/ 下的路径不再列出（文件已归档，不应再注入）
			const keep = uniq.filter((v: string) => !/ARCHIVE_RE_PLACEHOLDER/.test(v));
			const dropped = uniq.length - keep.length;
			// ③ 上限保护：保留最近 max 条，裁掉最旧
			const trimmed = keep.length > max ? keep.slice(keep.length - max) : keep;
			const out = trimmed.map((v: string) => v).join("\n") + (trimmed.length ? "\n" : "");
			__fs.writeFileSync(mf, stamp ? `# ${new Date().toISOString()} roll\n${out}` : out); // 写入自动滚动
			console.log(`[fixG] manifest roll ok total=${trimmed.length} droppedArchive=${dropped} max=${max} file=${shown}`);
		} catch (e) {
			// ④ fail-open：写清单失败绝不影响主上传链，只留日志 + 标记
			try {
				const __fs2 = require("node:fs") as typeof import("node:fs");
				__fs2.appendFileSync("/tmp/fixg-manifest-fail.log", `${new Date().toISOString()} manifest roll failed: ${String(e).slice(0, 200)}\n`);
			} catch { /* 连标记都写不了也不能抛 */ }
			console.warn(`[fixG] manifest roll fail, fail-open: ${String(e).slice(0, 160)}`);
		}
	};
	try { (globalThis as Record<string, unknown>).__fixGRoll = __fixGRoll__; } catch { /* fail-open */ }
TS
}

# 占位符渲染：用 node 做字面量替换（sed 的 / 与转义在此处是坑，一律不用）
render_placeholders() {
  # 用 node 做字面量替换（sed 的 / 与转义在此处是坑，一律不用）
  local call_def hold_def
  call_def='__fixGRoll__({ path: `uploads/${name}`, fileName: name });'
  hold_def='__fixGRoll__(file);'
  MLOGIC_REL="$MANIFEST_REL" \
  MLOGIC_CALL="${MLOGIC_CALL:-$call_def}" \
  MLOGIC_HOLD_CALL="${MLOGIC_HOLD_CALL:-$hold_def}" \
  node -e "$(cat <<'JS'
const fs = require("node:fs");
const rel = process.env.MLOGIC_REL;
const RE = /(?:^|\/)archive-[^\/]*\//;
const esc = JSON.stringify(rel).slice(1, -1);
for (const f of process.argv.slice(1)) {
  const out = fs.readFileSync(f, "utf8")
    .split("MANIFEST_REL_PLACEHOLDER").join(esc)
    .split("ARCHIVE_RE_PLACEHOLDER").join(RE.source)
    .split("MANIFEST_LOGIC_PLACEHOLDER_CALL").join(process.env.MLOGIC_CALL || "")
    .split("MANIFEST_HOLD_PLACEHOLDER_CALL").join(process.env.MLOGIC_HOLD_CALL || "");
  fs.writeFileSync(f, out);
}
JS
)" "$@" || return 1
}

# ============================================================================
# 生产代码片段的字节级夹具（A–D 断言真跑这些片段，而非另写一份"看着像"的代码）
# ============================================================================
frag_upload() {
  cat <<'TS'
const __fs = require("node:fs");
const __path = require("node:path");
const __ws = process.env.WAGATE_TENANT_ROOT + "/" + process.env.WAGATE_SID + "/workspace";
(globalThis as Record<string, unknown>).__fixGWorkspace = __ws;
const name = process.env.ENV_FILE_NAME || "unnamed.txt";
const data = process.env.ENV_FILE_DATA || "";
const manifestRel = "activeProj/current-files.txt";
const manifest_path = __path.join(__ws, manifestRel);
{
	const target = __path.join(__ws, "uploads", String(name));
	__fs.mkdirSync(__path.dirname(target), { recursive: true });
	__fs.writeFileSync(target, Buffer.from(data, "base64"));
	console.log(`[upload-ops] saved ${manifest_path}`);
	MANIFEST_LOGIC_BLOCK
}
TS
}

frag_hold() {
  cat <<'TS'
console.log(`[bot] file-only hold: ${file.fileName} saved pending, waiting for user instruction (FILE_AUTO_ROUTE=${process.env.FILE_AUTO_ROUTE || "on"})`);
MANIFEST_HOLD_BLOCK
TS
}

# ============================================================================
# A–D 机械门：在 /tmp 副本上真跑，退出码/清单内容/主链副作用都断言
# ============================================================================
mech_gate() {
  local work="$1"
  local frag="$work/frag"
  ARCHIVE_RE='/(?:^|/)archive-[^/]*/'  # 归档路径识别（与补丁渲染同源）
  mkdir -p "$frag" || return 1
  # 渲染两份片段（占位符替换为真实逻辑）
  printf '%s' "$MLOGIC_SRC" > "$frag/logic.ts"
  awk -v lf="$frag/logic.ts" '
    { if ($0 ~ /^[[:space:]]*MANIFEST_LOGIC_BLOCK[[:space:]]*$/) { while ((getline l < lf) > 0) print l; close(lf); print "MANIFEST_LOGIC_PLACEHOLDER_CALL"; next } print }
  ' <<EOF > "$frag/upload.ts"
$(frag_upload)
EOF
  awk -v lf="$frag/logic.ts" '
    { if ($0 ~ /^[[:space:]]*MANIFEST_HOLD_BLOCK[[:space:]]*$/) { while ((getline l < lf) > 0) print l; close(lf); print "MANIFEST_HOLD_PLACEHOLDER_CALL"; next } print }
  ' <<EOF > "$frag/hold.ts"
$(frag_hold)
EOF
  render_placeholders "$frag/logic.ts" "$frag/upload.ts" "$frag/hold.ts"

  # 夹具工作区
  # 与片段一致：workspace = $WAGATE_TENANT_ROOT/$WAGATE_SID/workspace（WAGATE_SID=t）
  local T="$work/tenant" WS="$work/tenant/t/workspace" MF
  rm -rf "$T"; mkdir -p "$WS/activeProj" "$WS/uploads" "$WS/archive-old"
  MF="$WS/activeProj/current-files.txt"
  : > "$MF"

  # 断言跑的是「注入后逻辑的原样文本」：node -e <脚本>，ENV_FILE_NAME/ENV_FILE_DATA 由外层环境传入
  # 夹具以 .ts 文件运行：node 22 的 type-stripping 只对文件生效，`-e` 会因 `as` 断言解析失败。
  node_run() {
    local src="$1"
    printf '%s\n' "$src" > "$work/run.ts"
    env -i PATH="$PATH" HOME="$HOME" WAGATE_TENANT_ROOT="$work/tenant" WAGATE_SID=t \
      ENV_FILE_NAME="${ENV_FILE_NAME:-a.txt}" ENV_FILE_DATA="${ENV_FILE_DATA:-aGVsbG8=}" \
      node --no-warnings "$work/run.ts"
  }

  local up hold
  up=$(cat "$frag/upload.ts")
  hold=$(cat "$frag/hold.ts")
  # 夹具（人可读，调试用）：合成一个 .ts，内容 = 注入后的片段原样
  printf 'export {};\n' > "$WORK/fragment-rendered.ts"
  printf '%s\n' "$up" >> "$WORK/fragment-rendered.ts"
  {
    printf 'const __ws = process.env.WAGATE_TENANT_ROOT + "/" + process.env.WAGATE_SID + "/workspace";\n'
    printf '(globalThis as Record<string, unknown>).__fixGWorkspace = __ws;\n'
    printf 'const file = { fileName: "h1.csv", path: __ws + "/uploads/h1.csv" };\n'
    printf 'void (async () => {\n'
    printf '%s\n' "$hold"
    printf '})();\n'
  } > "$frag/hold_run.ts"

  hr 'A 依次上传 2 个文件 -> 清单自动含 2 条'
  ( ENV_FILE_NAME=a.txt ENV_FILE_DATA=aGVsbG8= node_run "$up" ) >/dev/null 2>&1
  local rc_a1=$?
  ( ENV_FILE_NAME=b.txt ENV_FILE_DATA=d29ybGQ= node_run "$up" ) >/dev/null 2>&1
  local rc_a2=$?
  printf '  主链退出码: %s / %s\n' "$rc_a1" "$rc_a2"
  local n_a
  n_a=$(grep -cv '^[[:space:]]*$' "$MF" 2>/dev/null); n_a=${n_a:-0}
  printf '  清单内容:\n'; sed 's/^/    /' "$MF"
  if [ "$rc_a1" -eq 0 ] && [ "$rc_a2" -eq 0 ] && grep -qx 'uploads/a.txt' "$MF" && grep -qx 'uploads/b.txt' "$MF" && [ "$n_a" -eq 2 ]; then
    pass "A：两个文件均在清单中（2 条），主链退出码 0"
  else
    fail "A：清单未按预期自动含 2 条（实际 $n_a 条，rc=$rc_a1/$rc_a2）"
  fi

  hr 'B 重传同名文件 -> 清单不重复（幂等）'
  ( ENV_FILE_NAME=a.txt ENV_FILE_DATA=aGVsbG8= node_run "$up" ) >/dev/null 2>&1
  local n_b dup_b
  n_b=$(grep -cv '^[[:space:]]*$' "$MF" 2>/dev/null); n_b=${n_b:-0}
  dup_b=$(grep -cx 'uploads/a.txt' "$MF" 2>/dev/null); dup_b=${dup_b:-0}
  printf '  清单条数=%s，a.txt 出现 %s 次\n' "$n_b" "$dup_b"
  if [ "$dup_b" -eq 1 ] && [ "$n_b" -eq 2 ]; then
    pass "B：重复上传同名文件未产生重复条目（仍 2 条）"
  else
    fail "B：清单重复（a.txt 出现 $dup_b 次 / 共 $n_b 条）"
  fi

  hr 'C 已归档文件 -> 清单不再列出'
  printf 'uploads/old.txt\narchive-old/uploads/c.txt\n' >> "$MF"
  ( ENV_FILE_NAME=d.txt ENV_FILE_DATA=ZGF0YQ== node_run "$up" ) >/dev/null 2>&1
  if grep -q 'archive-old/' "$MF"; then
    fail "C：归档路径仍在清单中（$(grep -n 'archive-old/' "$MF" | tr '\n' ' ')）"
  else
    pass "C：归档路径（archive-*/ 下）已被清理出清单"
  fi
  if grep -qx 'uploads/old.txt' "$MF" && grep -qx 'uploads/d.txt' "$MF" && grep -qx 'uploads/a.txt' "$MF"; then
    pass "C：非归档历史条目与最新条目均保留（未误删）"
  else
    fail "C：清理误删了非归档条目：$(tr '\n' ' ' < "$MF")"
  fi
  if grep -q 'uploads/d.txt' "$MF"; then
    pass "C：归档清理与本次追加在同一次写入中完成（d.txt 已入清单）"
  else
    fail "C：本次追加未落地"
  fi

  hr 'D 清单写入失败 -> 主链不受影响（fail-open）'
  local rc_d
  local fail_log="/tmp/fixg-manifest-fail.log"
  rm -f "$fail_log"
  chmod 400 "$MF" 2>/dev/null
  ( ENV_FILE_NAME=e.txt ENV_FILE_DATA=ZQ== node_run "$up" ) >/dev/null 2>&1
  rc_d=$?
  chmod 600 "$MF" 2>/dev/null
  printf '  只读清单时主链退出码=%s\n' "$rc_d"
  if [ "$rc_d" -eq 0 ] && [ -f "$WS/uploads/e.txt" ]; then
    pass "D：清单不可写时上传主链仍退出 0，文件已落盘（fail-open）"
  else
    fail "D：清单不可写影响了主链（rc=$rc_d，落盘=$([ -f "$WS/uploads/e.txt" ] && echo yes || echo no)）"
  fi
  if [ -f "$fail_log" ] && grep -q 'fail' "$fail_log"; then
    pass "D：写失败被记录到 $fail_log（故障可见，不静默）"
  else
    warn "D：未观察到失败标记（root 用户可能不受 chmod 限制）——已由 WARN 显式声明，不算绿"
  fi

  hr 'E 上限保护（最近 30 条，裁最旧）'
  : > "$MF"
  local i
  for i in $(seq 1 32); do printf 'uploads/old-%02d.txt\n' "$i" >> "$MF"; done
  for i in 1 2 3 4 5; do ( ENV_FILE_NAME="n$i.txt" ENV_FILE_DATA=eA== node_run "$up" ) >/dev/null 2>&1; done
  local n_e
  n_e=$(grep -cv '^[[:space:]]*$' "$MF" 2>/dev/null); n_e=${n_e:-0}
  printf '  32 条旧 + 5 次追加后清单条数=%s（上限 30）\n' "$n_e"
  if [ "$n_e" -le 30 ] && grep -qx 'uploads/n5.txt' "$MF" && ! grep -q 'uploads/old-01.txt' "$MF"; then
    pass "E：清单被约束在上限内且保留最新条目、裁掉最旧"
  else
    fail "E：上限保护未生效（条数=$n_e）"
  fi

  hr 'F hold 路径（bot.ts 保存点）同样入清单'
  : > "$MF"
  mkdir -p "$WS/uploads"; : > "$WS/uploads/h1.csv"
  node_run "$(cat "$frag/hold_run.ts")" >/dev/null 2>&1
  if grep -qx 'uploads/h1.csv' "$MF"; then
    pass "F：file-only hold 保存点把文件路径写进了清单（workspace 相对路径）"
  else
    fail "F：hold 保存点未入清单（清单：$(tr '\n' ' ' < "$MF")）"
  fi
}

# ============================================================================
printf '=== fixG-manifest.sh v%s —— 文件清单自动滚动（fixG，issue #64）===\n' "$VERSION"
printf '模式: %s | 目标: upload-ops.ts + bot.ts | 清单: %s\n' "$MODE" "$MANIFEST_REL"
printf '逃生阀: WAGATE_MANIFEST_ROLL=0（关闭入清单）/ WAGATE_MANIFEST_MAX=30 / WAGATE_MANIFEST_STAMP=1（逐条时间注释）\n'

MLOGIC_SRC=$(mlogic)
WORK=$(mktemp -d /tmp/fixg-manifest.XXXXXX) || { printf 'FATAL: 无法创建临时目录\n'; exit 2; }
trap 'rm -rf "$WORK"' EXIT

if [ "$MODE" = 'gate' ]; then
  hr '机械门 A–F（合成断言，/tmp 副本，不碰生产）'
  mech_gate "$WORK" || warn "机械门执行异常"
  gate_summary; exit $?
fi

if [ "$MODE" = 'rollback' ]; then
  hr '回滚'
  if [ -z "$FROM_TS" ]; then
    printf '未指定 --from，列出可用备份：\n'
    safe timeout "$T_SHORT" bash -c "ls -la $PATCH_DIR/*.bak-* 2>/dev/null | tail -n 40"
    printf '用法: bash %s --rollback --from <时间戳>\n' "$0"
    gate_summary; exit $?
  fi
  for rel in upload-ops.ts bot.ts; do
    tgt="$PATCH_DIR/$rel"; bak=$(backup_of "$tgt" "$FROM_TS")
    if [ -f "$bak" ]; then
      cat "$bak" > "$tgt" && pass "已还原 $rel <- $bak"
    else
      warn "备份不存在: $bak"
    fi
  done
  printf '\n还原后重启：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
  gate_summary; exit $?
fi

# ---- 锚点门（dry / apply 共用）----
hr 'G1 基线锚点门'
printf '宿主插件目录 PATCH_DIR=%s\n容器路径 PLUGIN_DIR=%s\n' "$PATCH_DIR" "$PLUGIN_DIR"

UP="$PATCH_DIR/upload-ops.ts"
BOT="$PATCH_DIR/bot.ts"
require_file "$UP" 'upload-ops.ts' || gate_fail "upload-ops.ts 缺失：$UP（现场路径不同请用 PATCH_DIR= 覆盖）"
require_file "$BOT" 'bot.ts' || gate_fail "bot.ts 缺失：$BOT"
printf '  upload-ops.ts sha256=%s bytes=%s lines=%s\n' "$(sha_of "$UP")" "$(wc -c < "$UP" | tr -d ' ')" "$(wc -l < "$UP" | tr -d ' ')"
printf '  bot.ts       sha256=%s bytes=%s lines=%s\n' "$(sha_of "$BOT")" "$(wc -c < "$BOT" | tr -d ' ')" "$(wc -l < "$BOT" | tr -d ' ')"

# 幂等：已打补丁则跳过
if [ "$(count_fixed "$UP" "$FEATURE")" -gt 0 ] && [ "$(count_fixed "$BOT" "$FEATURE")" -gt 0 ]; then
  warn "两个目标已含特征串 $FEATURE —— 视为已打过补丁（幂等跳过）"
  hr '机械门 A–F（合成断言，/tmp 副本，不碰生产）'
  mech_gate "$WORK" || warn "机械门执行异常"
  gate_summary; exit $?
fi

anchor_chk() { # <file> <label> <anchor>
  local f="$1" label="$2" a="$3" n
  n=$(count_fixed "$f" "$a")
  case "$n" in
    1) pass "$label 锚点命中 1 次：「$a」" ;;
    0) gate_fail "$label 锚点未命中：「$a」0 次 —— 现场与基线漂移，已中止，不强行 patch" ;;
    *) gate_fail "$label 锚点命中 $n 次（期望 1 次）：「$a」不唯一 —— 无法安全定位，已中止" ;;
  esac
}

anchor_chk "$UP" 'upload-ops.ts' "$ANCHOR_UP_SAVED"
anchor_chk "$BOT"  'bot.ts'       "$ANCHOR_HOLD"

# 块门：锚点所在代码块必须能被可靠定位（depth 必须降到 0），否则中止
block_range() { # <file> <anchor> -> 打印 "start end"
  local f="$1" a="$2"
  node -e '
    const fs = require("node:fs");
    const [f, a] = process.argv.slice(1);
    const L = fs.readFileSync(f, "utf8").split("\n");
    const idx = L.findIndex((l) => l.indexOf(a) >= 0);
    if (idx < 0) process.exit(3);
    let d = 0, started = false, end = -1;
    for (let i = idx; i < L.length && i < idx + 200; i++) {
      for (const ch of L[i]) { if (ch === "{") { d++; started = true; } else if (ch === "}") d--; }
      if (started && d <= 0) { end = i; break; }
    }
    if (end < 0) process.exit(4);
    process.stdout.write(`${idx + 1} ${end + 1}`);
  ' "$f" "$a"
}

RANGE_UP=$(block_range "$UP" "$ANCHOR_UP_SAVED"); rc=$?
[ "$rc" -eq 0 ] || gate_fail "upload-ops.ts 锚点所在代码块无法定位（rc=$rc）—— 已中止，不强行 patch"
RANGE_BOT=$(block_range "$BOT" "$ANCHOR_HOLD"); rc=$?
[ "$rc" -eq 0 ] || gate_fail "bot.ts 锚点所在代码块无法定位（rc=$rc）—— 已中止，不强行 patch"

S_UP=${RANGE_UP% *}; E_UP=${RANGE_UP#* }
S_BOT=${RANGE_BOT% *}; E_BOT=${RANGE_BOT#* }
CNT_UP=$((E_UP - S_UP + 1)); CNT_BOT=$((E_BOT - S_BOT + 1))
pass "upload-ops.ts 替换块 L$S_UP..L$E_UP（$CNT_UP 行）"
pass "bot.ts 替换块 L$S_BOT..L$E_BOT（$CNT_BOT 行）"

# 块下界为 1：fixG 只往保存点后插一行 CALL；上界 60 用于挡住「锚点匹配到超大函数体」的错位。
[ "$CNT_UP" -ge 1 ] && [ "$CNT_UP" -le 60 ] || gate_fail "upload-ops.ts 块大小异常（$CNT_UP 行）—— 疑似锚错位置，已中止"
[ "$CNT_BOT" -ge 1 ] && [ "$CNT_BOT" -le 60 ] || gate_fail "bot.ts 块大小异常（$CNT_BOT 行）—— 疑似锚错位置，已中止"

# 与 #63 fixF 的协同：fixF 动 bot.ts hold 分支，本修复动同一分支的保存点。
printf '\n协同检查（fixG x fixF）：bot.ts 块 L%s..L%s 是 fixF 的作业面；\n' "$S_BOT" "$E_BOT"
printf '  若 fixF 已先行 apply，本脚本 dry-run 会先暴露锚点漂移，**不要绕过锚点门**，\n'
printf '  把 `grep -nF -e %s %s` 的实际输出回报后重对锚点。\n' "'$ANCHOR_HOLD'" "$BOT"

# ---- 机械门（写盘前必跑）----
hr 'G2 机械门 A–F（合成断言，/tmp 副本，不碰生产）'
mech_gate "$WORK" || warn "机械门执行异常"

# ---- 改动预览 ----
hr 'G3 改动预览'
printf '  ① upload-ops.ts：替换上表块 L%s..L%s（%s 行），块尾一行追加清单滚动调用\n' "$S_UP" "$E_UP" "$CNT_UP"
printf '  ② bot.ts：在 hold 分支 L%s..L%s 内、hold 日志/回复前后插入清单滚动调用（不改 hold 语义）\n' "$S_BOT" "$E_BOT"
printf '  ③ 注入的运行时逻辑：%s 行（幂等 append + 归档清理 + 上限 30 + fail-open）\n' "$(printf '%s' "$MLOGIC_SRC" | wc -l | tr -d ' ')"
printf '  ④ 清单路径：workspace/%s（可被 MANIFEST_REL 覆盖）\n' "$MANIFEST_REL"
printf '  ⑤ 逃生阀：WAGATE_MANIFEST_ROLL=0 / WAGATE_MANIFEST_MAX / WAGATE_MANIFEST_STAMP\n'

if [ "$MODE" = 'dry' ]; then
  printf '\n（dry-run：未写任何生产文件；确认无误后加 --apply）\n'
  printf '回滚路径：bash %s --rollback --from <批次戳>\n' "$0"
  gate_summary; exit $?
fi

# ---- --apply：备份 -> 重写（保 inode）----
hr 'G4 --apply：备份 -> 重写'
TS=$(ts_now)
bak_up=$(backup_of "$UP" "$TS"); bak_bot=$(backup_of "$BOT" "$TS")
cp -a "$UP" "$bak_up" || gate_fail "备份失败：$UP（未做任何写入）"
cp -a "$BOT" "$bak_bot" || gate_fail "备份失败：$BOT（未做任何写入）"
pass "已备份 upload-ops.ts -> $bak_up"
pass "已备份 bot.ts -> $bak_bot"

LOGIC_RENDERED="$WORK/logic.rendered.ts"
printf '%s' "$MLOGIC_SRC" > "$LOGIC_RENDERED"
render_placeholders "$LOGIC_RENDERED" || gate_fail "逻辑体渲染失败（未做任何写入）"
[ "$(count_fixed "$LOGIC_RENDERED" 'PLACEHOLDER')" -eq 0 ] || gate_fail "逻辑体仍含未渲染占位符（未做任何写入）"

# upload-ops.ts：块尾插入（锚点在块内 -> 追加调用在保存点之后）
TMP_UP="$WORK/upload-ops.new.ts"
awk -v s="$S_UP" -v e="$E_UP" -v lf="$LOGIC_RENDERED" '
  { print }
  NR == e {
    print "\t// [fixG] 文件清单自动滚动（issue #64）：saved 之后把新文件路径幂等 append 到清单"
    while ((getline l < lf) > 0) print l
    close(lf)
    print "\t// [fixG] 调用：把新文件路径入清单（幂等 / 归档清理 / 上限保护）"
    print CALL
  }
' CALL='\t__fixGRoll__({ path: "uploads/" + name, fileName: name });' "$UP" > "$TMP_UP" || gate_fail "upload-ops.ts 重写失败"
[ "$(count_fixed "$TMP_UP" "$FEATURE")" -gt 0 ] || gate_fail "upload-ops.ts 写入前形态门失败：特征串未出现"

# bot.ts：块尾之前插入（hold 回复之后、return 之前 —— 行内容零改动，纯插入）
TMP_BOT="$WORK/bot.new.ts"
awk -v e="$E_BOT" -v lf="$LOGIC_RENDERED" '
  { if (NR == e) { print "\t\t// [fixG] 文件清单自动滚动（issue #64）：hold 的文件同样入清单（不改 hold 语义）"; while ((getline l < lf) > 0) print l; close(lf); print "\t\t__fixGRoll__(file);" } print }
' "$BOT" > "$TMP_BOT" || gate_fail "bot.ts 重写失败"
[ "$(count_fixed "$TMP_BOT" "$FEATURE")" -gt 0 ] || gate_fail "bot.ts 写入前形态门失败：特征串未出现"

out=$(ts_parse_gate "$TMP_UP" "$TMP_BOT"); rc=$?
printf '%s\n' "$out" | sed 's/^/  /'
if [ "$rc" -eq 1 ]; then
  gate_fail "写入前解析门失败：产物语法无效，已中止（未写盘）"
elif [ "$rc" -eq 2 ]; then
  warn "解析门无法执行（缺 node/typescript），语法未验证 —— 写入后请人工复核"
else
  pass "解析门通过（两个产物均可被 TS 解析器解析）"
fi

cat "$TMP_UP" > "$UP" && pass "已写入 upload-ops.ts（保 inode）"
cat "$TMP_BOT" > "$BOT" && pass "已写入 bot.ts（保 inode）"
printf '\n落地完成。重启生效：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
printf '回滚：bash %s --rollback --from %s\n' "$0" "$TS"
gate_summary; exit $?
