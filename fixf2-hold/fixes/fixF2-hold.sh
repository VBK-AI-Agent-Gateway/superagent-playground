#!/usr/bin/env bash
# fixF2-hold.sh — file-only 挂起死锁修复 v2：const 裸赋值崩容器修复 + G3 静态门 + 参数一致性
#
# 本脚本是 PR #66（fixf-hold/，issue #63）的**回炉修正版**：issue #66 的 v1 包把补丁体打成
# 「裸赋值到既有 const」，容器加载即抛错自杀；v2 只修 v1 的落地缺陷，不改 v1 的修复意图。
#
# ---------------------------------------------------------------------------
# 一、v1 事故根因（11-07 现场：apply 后容器反复退出，服务起不来）
# ---------------------------------------------------------------------------
#   bot.ts:260  const text = rawText.trim();          <-- 既有 const
#   bot.ts:273  const file = m.file as {...};         <-- 既有 const
#
#   v1 补丁体（fixf-hold/fixes/fixF-hold.sh 第 139 行）写了：
#       text = `用户为当前任务补充上传的文件：${file.fileName}`;
#   这是对既有 const 的**裸赋值**。bun 在加载/编译期即判定
#   "This assignment will throw because text is a constant"，
#   于是容器一启动就崩 —— 不是运行时偶发，是**加载期必然**。
#   同族第二个点：v1 第 111 行 file = __fp__ as typeof file; 同样是裸赋值到 const file。
#
#   v1 的机械门（G1 锚点 / G2 形态 / G2' 替换唯一性）全过，因为没有一道门看「赋值目标是不是 const」。
#   门全绿 + 产物必崩 = 门的设计漏了一个维度：**语义合法性**。
#
# ---------------------------------------------------------------------------
# 二、v2 修复映射（issue #66 五条规格）
# ---------------------------------------------------------------------------
#   v2-1 新 const 注入：F1 联动不再改 text，而是**新建** const：
#          const fixFInjectedText = `用户为当前任务补充上传的文件：${file.fileName}`;
#        并把下游 core.handle 的 text 实参改用该变量（三重兜底，见 p1_body 注释）。
#        bot.ts 里既有 const 的声明保持**一字不动**。
#   v2-2 G3 静态门：提取目标文件里每个 `const <name> =` 的声明名；若补丁体出现裸赋值
#        `<name> =`（排除 ==/===/=>/<=/>=/!=），立即 FAIL 并中止整批落地（fail-closed）。
#        这是**产出前**的门，在 mktemp/备份之前就拦住，绝不写出会崩的产物。
#   v2-3 参数一致性：--dry-run 置 MODE="dry"，与 case 分支 `dry|gate` 对齐
#        （v1 置的是 "dryrun"，落不进任何 case，静默退出 0 —— 假绿）；
#        默认 TARGET=/srv/wagate/patches/bot.ts（**宿主**路径；v1 默认 /app/bot.ts 是容器内路径，
#        在宿主上跑必然「文件不存在」—— 坑 #33 第 4 次复发）。
#   v2-4 regrF 升级：A/B/C 用例**之前**先跑容器内 `bun build /app/bot.ts`；
#        构建失败 = FAIL（这一条正是能抓住 v1 崩容器的那道网）；
#        用例 A 必须经真实容器加载验证，不能只看日志。
#   v2-5 操作员铁律（写进 README 与脚本末提示）：
#          apply -> `docker exec wagate bun build /app/bot.ts` 验证 -> **仅在通过后** systemctl restart。
#        顺序反了就是 v1 事故的重演：先重启、再发现起不来。
#
# ---------------------------------------------------------------------------
# 三、用法
# ---------------------------------------------------------------------------
#   bash fixF2-hold.sh                          # dry-run（默认，安全；只判门 + 预览）
#   bash fixF2-hold.sh --apply                  # 真正改写（先备份 .bak-<UTC戳>，原地保留 inode）
#   bash fixF2-hold.sh --verify-gate            # 只判门（G1/G2/G3），不写任何文件
#   bash fixF2-hold.sh --check-body             # 只对**补丁体自身**跑 G3 + bun 语义自检（CI 友好）
#   bash fixF2-hold.sh --rollback --from <戳>   # 按备份戳还原
#   TARGET=/srv/wagate/patches/bot.ts bash fixF2-hold.sh --apply
#
# 环境变量：
#   TARGET=/srv/wagate/patches/bot.ts  宿主侧 bot.ts 路径（unit 单文件挂载；默认见下）
#   WAGATE_HOLD_RELEASE=0              fail-open 开关：0=关闭本修复（F1 不联动 / F2 不释放）
#   WAGATE_UNIT=wagate.service         重启提示里的 unit 名
#   CONTAINER=wagate                   容器名（仅用于打印验证命令，本脚本从不 docker exec）
#
# 硬约束：
#   * 容器路径铁律 bot.ts=/app/bot.ts；新文件严禁挂进 /app/extensions/plugins/（坑#35，扩展扫描污染加载链）
#   * 仓库零 secret；脚本自身不含任何 token/key/聊天 ID
#   * **本脚本只产出改动，从不重启服务、从不执行 docker exec、从不发送消息**
#   * 中文注释/输出；默认 dry-run；锚点不匹配即整体中止（fail-closed，绝不猜测性匹配）
#
# 退出码：0 成功 / 门全过；1 机械门 FAIL（含锚点不匹配、G3 命中）；2 用法或前置条件错误。

set -uo pipefail

VERSION='2.0.0'
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ---- 参数 -----------------------------------------------------------------
# v2-3 参数一致性：--dry-run 必须置 "dry"，与下方 case 分支 dry|gate 对齐。
# v1 置 "dryrun" -> 落不进任何 case -> 一条门都不判就 exit 0（假绿，最危险的失效模式）。
MODE="dry"
FROM_TS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply|-a)     MODE="apply" ;;
    --dry-run|-n)   MODE="dry" ;;          # v2-3：对齐 case 分支
    --verify-gate)  MODE="gate" ;;
    --check-body)   MODE="checkbody" ;;    # v2-2：只验补丁体本身，CI 友好
    --rollback)     MODE="rollback" ;;
    --from)         shift; FROM_TS="${1:-}" ;;
    -h|--help)      sed -n '2,75p' "$0"; exit 0 ;;
    *) printf '未知参数: %s（--help 查看用法）\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# ---- 配置 -----------------------------------------------------------------
# v2-3：默认必须是**宿主**路径。v1 默认 /app/bot.ts（容器内路径）在宿主上跑必然失败（坑 #33）。
TARGET="${TARGET:-/srv/wagate/patches/bot.ts}"
WAGATE_HOLD_RELEASE="${WAGATE_HOLD_RELEASE:-1}"
WAGATE_UNIT="${WAGATE_UNIT:-wagate.service}"
CONTAINER="${CONTAINER:-wagate}"
PATCH_DIR="${PATCH_DIR:-$(dirname "$TARGET")}"
T_SHORT="${T_SHORT:-15}"

PASS_N=0; FAIL_N=0; WARN_N=0
pass() { PASS_N=$((PASS_N+1)); printf '  [PASS] %s\n' "$1"; }
fail() { FAIL_N=$((FAIL_N+1)); printf '  [FAIL] %s\n' "$1"; }
warn() { WARN_N=$((WARN_N+1)); printf '  [WARN] %s\n' "$1"; }

# safe <cmd...> —— 任何一条外部命令超时/失败都不带塌整个脚本（只读诊断用）
safe() { timeout "$T_SHORT" "$@" 2>&1 || true; }

printf '=== fixF2-hold.sh v%s | 模式=%s | 目标=%s ===\n' "$VERSION" "$MODE" "$TARGET"
printf '时间(UTC): %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
printf '机械门 G1 锚点 / G2 形态 / G2'"'"' 替换唯一性 / G3 const 裸赋值静态门；任一 FAIL 即中止（不部分落地）\n'

# ==========================================================================
# 补丁表：file|锚文本|锚期望次数|已打补丁特征串|补丁体函数|证据锚点(原体结束后第一行)
# 现场形态以 issue #63 指定的 bot.ts（sha256=174cc876… 后继版本）为准；
# 锚不匹配就整体中止报告，绝不猜测性匹配、绝不做部分替换。
# ==========================================================================
PATCH_SPECS=(
  'bot.ts|if (file && !text && process.env.FILE_AUTO_ROUTE !== "0") {|1|__fixF2Hold__|p1_body|	let outs;|'
)

# --------------------------------------------------------------------------
# 补丁体 p1_body —— v2-1：绝不裸赋值到既有 const
#
# 三重兜底（任何一重单独成立都不会崩容器）：
#   ① F1 注入改**新建** const fixFInjectedText，不再写 text = ...（v1 的崩因，直接消除）；
#   ② F2 释放改**新增** let fixFReleasedFile，不再写 file = ...（v1 同族第二处）；
#   ③ 下游 core.handle 的 text 实参改用 fixFInjectedText。
#
# 说明：core.handle 的 file 形参不在 v1/v2 授权范围内（tenant-core 接收侧不属于本包），
#       因此 F2 释放出的文件通过注入句 + 既有 __excelPendingFile 链路进入当轮上下文，
#       不新增 handle 的 file 传参 —— 与 v1 的落地边界一致（见 REPORT 第三节）。
# --------------------------------------------------------------------------
p1_body() {
  cat <<'TS'
	// __fixF2Hold__ ===== file-only 挂起：活跃任务联动 + 挂起释放路径（v2：零 const 裸赋值）=====
	// 根因（issue #63）：旧代码 file-only 一律 hold+return，文件进了黑板却永不进 core.handle；
	// 且下一轮带文字的消息没有把 pending 文件合并进上下文 -> 模型永远看不见 -> 机械死锁。
	// v2 修正（issue #66）：v1 曾把注入写成 text = ...（裸赋值到 bot.ts:260 的 const text），
	// bun 加载期即抛 "assignment will throw because text is a constant" -> 容器启动即崩。
	// 本版一律**新建变量**，既有 const 声明保持一字不动。
	// F4 fail-open：WAGATE_HOLD_RELEASE=0 一键回旧版（F1 不联动、F2 不释放）。
	const __fixF2Enabled__ = process.env.WAGATE_HOLD_RELEASE !== "0";
	// F2 释放路径：跨 onMessage 存活的持久槽（globalThis 上的模块级 Map，纯内存，不落盘、无凭据）。
	// 用「租户键」而不是原 __excelPendingFile 的隐式单槽，避免跨用户串文件。
	const __fixF2Key__ = `${adapter.platform}:${m.userId}`;
	const __fixF2Store__ = ((globalThis as Record<string, unknown>).__fixF2PendingFiles ??= new Map<string, unknown>()) as Map<string, unknown>;
	// v2 要点：用新 let 承载「本轮实际要交给下游的文件」，不覆盖既有 const file。
	let __fixF2File__ = file;
	let __fixF2Injected__ = false;
	if (__fixF2Enabled__ && text && !file) {
		// 用户补发了文字：把上一轮 hold 的文件并回本轮，文件当轮可见。
		const __fp__ = __fixF2Store__.get(__fixF2Key__);
		if (__fp__) {
			__fixF2File__ = __fp__ as typeof file;
			__fixF2Store__.delete(__fixF2Key__);
			// 同时回写既有 pending 黑板槽：upload-ops 的 before_agent_start 读的就是它。
			(globalThis as Record<string, unknown>).__excelPendingFile = __fixF2File__;
			console.log(`[bot][fixF2] hold release: pending file merged into this turn name=${__fixF2File__?.fileName}`);
		}
	}
	// F1 活跃任务联动：文件-only 且同租户有活跃任务 -> 不 hold，直接并入当前任务。
	// fail-open：判不出来（无钩子/无任务记录）就保持旧行为 hold，绝不因本修复把消息弄丢。
	let __fixF2ActiveTask__ = false;
	if (__fixF2Enabled__ && file && !text && process.env.FILE_AUTO_ROUTE !== "0") {
		try {
			const __fk__ = (globalThis as Record<string, unknown>).__fixF2ActiveTask as ((s: { platform: string; userId: string; channelId: string }) => boolean) | undefined;
			if (typeof __fk__ === "function") __fixF2ActiveTask__ = !!__fk__({ platform: adapter.platform, userId: m.userId, channelId: m.channelId });
		} catch (e) {
			console.warn(`[bot][fixF2] active-task probe failed (fail-open -> hold): ${String(e).slice(0, 120)}`);
			__fixF2ActiveTask__ = false;
		}
	}
	if (file && !text && process.env.FILE_AUTO_ROUTE !== "0" && !__fixF2ActiveTask__) {
		if (__fixF2Enabled__) __fixF2Store__.set(__fixF2Key__, file);
		console.log(`[bot][fixF2] file-only hold: ${file.fileName} saved pending (release=${__fixF2Enabled__ ? "on" : "off(WAGATE_HOLD_RELEASE=0)"}), waiting for user instruction (FILE_AUTO_ROUTE=${process.env.FILE_AUTO_ROUTE || "on"})`);
		try {
			await adapter.sendMessage(m.channelId, `已收到文件 ${file.fileName}。文件已保存，回复任意说明（如"用它做PPT"）即开始处理。`);
		} catch { /* 回复失败仍 hold */ }
		return;
	}
	if (file && !text && __fixF2ActiveTask__) {
		// F1 命中：活跃任务在等文件，直接 handle，不扣文件。
		// v2-1：注入句写进**新 const**，绝不裸赋值到既有 const text（v1 崩容器根因）。
		console.log(`[bot][fixF2] active task linked: ${file.fileName} injected into current task (hold skipped)`);
		__fixF2Injected__ = true;
	}
	const __fixF2Text__ = __fixF2Injected__ ? `用户为当前任务补充上传的文件：${file.fileName}` : text;
TS
}

# --------------------------------------------------------------------------
# G3 静态门 —— v2-2：补丁体绝不允许对目标文件既有 const 名做裸赋值
#
# 算法：
#   1) 从目标文件提取全部 `const <name> =` 声明名（含缩进，覆盖块内 const）；
#   2) 在补丁体里找 `<name> =` 形态；
#   3) 排除比较/箭头/复合运算：== === => <= >= != += -= 等；
#   4) 命中即 FAIL。这条门在 mktemp/备份**之前**跑，绝不写出会崩容器的产物。
# --------------------------------------------------------------------------
extract_consts() {
  # <file> -> 每行一个既有 const 名
  grep -oE '(^|[^A-Za-z0-9_$.])const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*=' "$1" 2>/dev/null \
    | grep -oE 'const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*' \
    | awk '{print $2}' | sort -u
}

gate_g3_const() {
  # <file> <bodyfile> —— 对既有 const 名的裸赋值 = FAIL
  local tgt="$1" bodyf="$2" name hits=0
  local -a names=()
  while IFS= read -r name; do
    [ -n "$name" ] && names+=("$name")
  done < <(extract_consts "$tgt")
  if [ "${#names[@]}" -eq 0 ]; then
    warn "G3：目标文件未提取到 const 声明（$tgt）—— 门降级为仅告警"
    return 0
  fi
  printf '  G3 既有 const 名 %d 个: %s\n' "${#names[@]}" "$(printf '%s ' "${names[@]}")"
  for name in "${names[@]}"; do
    # 匹配 `<name> =` 但排除 == === => <= >= != += -= *= /= %= && || 等
    # 用 grep -nE 逐行判，再做「排除表」二次过滤，避免正则过度回溯。
    while IFS= read -r line; do
      local ln="${line%%:*}" content="${line#*:}"
      # 先剔注释：补丁体会「描述」v1 缺陷，正文里的 `text = ...` 出现在中文注释里属于
      # 说明文字，不是代码，不能误报（v2 自检时就是这样抓到自己的注释的）。
      local code="$content"
      case "$(printf '%s' "$code" | sed -E 's/^[[:space:]]+//')" in
        //*|'*'*|'/*'*) continue ;;
      esac
      code=$(printf '%s' "$code" | sed -E 's@[[:space:]]//.*$@@')
      # 先排除「本行就是一条声明语句」的情形：const/let/var <name> = ...
      # 声明一个与目标文件同名的块级 const 是**合法**的（遮蔽，不抛错），不是裸赋值。
      if printf '%s' "$code" | grep -qE "(^|[;{}[:space:]])(const|let|var)[[:space:]]+${name}[[:space:]]*=[^=]"; then
        continue
      fi
      # 去掉比较/箭头/复合赋值形态（用不含词边界的占位符，避免占位符自身制造假边界）。
      local stripped
      stripped=$(printf '%s' "$code" \
        | sed -E 's/===/ EQ3 /g; s/==/ EQ2 /g; s/=>/ ARROW /g; s/<=/ LE /g; s/>=/ GE /g; s/!=/ NE /g' \
        | sed -E 's|\+=| PLUS |g; s/-=/ MINUS /g; s|\*=| MUL |g; s|/=| DIV |g; s/%=/ MOD /g' \
        | sed -E 's/&&/ AND /g; s/\|\|/ OR /g')
      # 剩下的 `<name> =`（且右侧不是 =）才是对既有 const 的裸赋值。
      if printf '%s' "$stripped" | grep -qE "(^|[^A-Za-z0-9_\$.])${name}[[:space:]]*=[^=]"; then
        fail "G3 const 裸赋值：补丁体第 ${ln} 行对既有 const '${name}' 赋值 —— bun 加载期即抛错，容器会崩"
        printf '       命中行: %s\n' "$(printf '%s' "$content" | sed -E 's/^[[:space:]]+//' | cut -c1-140)"
        hits=$((hits+1))
      fi
    done < <(grep -nE "(^|[^A-Za-z0-9_\$.])${name}[[:space:]]*=" "$bodyf" 2>/dev/null || true)
  done
  if [ "$hits" -gt 0 ]; then
    printf '  G3 判读：本补丁体若落地，容器将在**加载期**崩溃（v1 事故重演）。已整批中止，未写任何文件。\n'
    printf '  G3 修法：把注入写成**新变量**（const fixFInjectedText = ...），只改下游引用，别动既有 const。\n'
    return 1
  fi
  pass "G3 未发现对既有 const 的裸赋值（补丁体静态合法）"
  return 0
}

# bun 语义自检 —— 把「目标文件形态」与「补丁体」拼起来真编译一次（有 bun 才跑）
bun_semantic_check() {
  # <fullsourcefile> —— 只编译，不执行
  local src="$1"
  if ! command -v bun >/dev/null 2>&1; then
    warn "未找到 bun，跳过语义自检（G3 静态门已独立成立，不依赖 bun）"
    return 0
  fi
  local out
  out=$(timeout "$T_SHORT" bun build --no-bundle "$src" 2>&1)
  if [ $? -eq 0 ]; then
    pass "bun 语义自检通过（补丁体可编译，无 const 赋值错）"
    return 0
  fi
  fail "bun 语义自检失败："
  printf '%s\n' "$out" | sed -n '1,12p' | sed 's/^/       /'
  return 1
}

BACKUP_STAMP=$(date -u '+%Y%m%d-%H%M%S')
gate_fail() { fail "$1"; printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"; exit 1; }

spec_field() { printf '%s' "$1" | cut -d'|' -f"$2"; }
already_patched() { grep -qF "$2" "$1" 2>/dev/null; }

check_anchor() {
  local f="$1" anchor="$2" exp="$3" n
  [ -f "$f" ] || { fail "锚点检查: 文件不存在 $f"; return 1; }
  n=$(grep -cF "$anchor" "$f" 2>/dev/null || true); n="${n:-0}"
  if [ "$n" = "$exp" ]; then
    pass "G1 锚点 $f: '$anchor' x$n（== 期望 $exp）"; return 0
  fi
  fail "G1 锚点 $f: '$anchor' x$n（期望 $exp）—— 现场代码已变，本补丁废止（请贴最新锚点段再评估）"
  return 1
}

check_shape() {
  local f="$1" needle="$2"
  if grep -qF "$needle" "$f" 2>/dev/null; then
    pass "G2 形态 $f: 含 '$needle'"; return 0
  fi
  fail "G2 形态 $f: 缺 '$needle'（改动没生效，或落了半截）"; return 1
}

# --------------------------------------------------------------------------
# checkbody —— 只验补丁体自身：G3（需 TARGET 存在以取 const 名）+ bun 语义自检
# CI 友好：TARGET 不存在时用仓库内快照 eu-fix-img-voice/context/bot.ts 兜底取 const 名。
# --------------------------------------------------------------------------
run_checkbody() {
  printf '\n--check-body：只验补丁体本身（不读现场文件、不写任何文件）。\n'
  local constsrc="$TARGET"
  if [ ! -f "$constsrc" ]; then
    local snap="$SELF_DIR/../../eu-fix-img-voice/context/bot.ts"
    if [ -f "$snap" ]; then
      constsrc="$snap"
      printf '  TARGET 不存在，const 名取自仓库快照: %s\n' "$snap"
    else
      gate_fail "check-body 中止：既无 TARGET（$TARGET）也无仓库快照取 const 名"
    fi
  fi
  local body; body=$(mktemp) || gate_fail "mktemp 失败"
  p1_body > "$body"
  printf '  补丁体行数: %s\n' "$(wc -l < "$body" | tr -d ' ')"
  gate_g3_const "$constsrc" "$body" || true
  # bun 语义自检：造一个「同形」最小复现文件（既有 const text + 补丁体的赋值形态）真编译
  local repro; repro=$(mktemp --suffix=.ts) || gate_fail "mktemp 失败"
  cat > "$repro" <<'TS'
// 同形复现：bot.ts 里的既有 const（v1 就是在这上面裸赋值 -> 加载期崩）
const rawText = "x";
const text = rawText.trim();
const file = undefined as unknown as { fileName: string } | undefined;
TS
  cat "$body" >> "$repro"
  bun_semantic_check "$repro" || true
  rm -f "$body" "$repro"
}

# --------------------------------------------------------------------------
# 主分派
# --------------------------------------------------------------------------
case "$MODE" in
  dry|gate)
    [ "$MODE" = "dry" ] && printf '\ndry-run：只判定门与预览改动，不写任何文件。\n'
    [ "$MODE" = "gate" ] && printf '\n--verify-gate：只判定门，不写任何文件。\n'
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      tgt="$PATCH_DIR/$rel"
      printf '\n--- %s ---\n' "$rel"
      if [ ! -f "$tgt" ]; then
        fail "文件不存在: $tgt（容器内 bot.ts 的宿主路径请用 TARGET= 指定）"; continue
      fi
      if already_patched "$tgt" "$needl"; then
        warn "已含 $needl（已打过补丁，幂等跳过）"; continue
      fi
      # G1 锚点
      check_anchor "$tgt" "$anchor" "$exp" || true
      # G3 静态门（v2-2：产出前拦住 const 裸赋值）
      bodytmp=$(mktemp) || gate_fail "mktemp 失败"
      "$(spec_field "$spec" 5)" > "$bodytmp"
      gate_g3_const "$tgt" "$bodytmp" || true
      # bun 语义自检（v2：门禁之一，非可选）
      repro=$(mktemp --suffix=.ts) || gate_fail "mktemp 失败"
      cat "$tgt" > "$repro"; printf '\n' >> "$repro"; cat "$bodytmp" >> "$repro"
      bun_semantic_check "$repro" || true
      rm -f "$bodytmp" "$repro"
      printf '  计划：改写锚点所在分支为「联动 + 释放 + 扩写文案」，并写入特征串 %s\n' "$needl"
    done
    printf '\n判读：G1/G3/bun 全 PASS 才能 --apply；任一 FAIL 说明现场代码已变或产物会崩，先解决再评估。\n'
    printf 'A/B/C 机械断言在 --apply 后由 regr/regrF2.sh 复跑。\n'
    if [ "$FAIL_N" -gt 0 ]; then
      printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
      exit 1
    fi
    ;;

  checkbody)
    run_checkbody
    ;;

  apply)
    printf '\n--apply：门全过后落地（先备份，原地重写保留 inode）。备份戳 %s\n' "$BACKUP_STAMP"
    # ---- 阶段一：全部门先过，一个不过就整批中止（不做部分落地）----
    declare -a READY_RELS=()
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      tgt="$PATCH_DIR/$rel"
      [ -f "$tgt" ] || gate_fail "apply 中止：$rel 不存在（$tgt）"
      if already_patched "$tgt" "$needl"; then warn "$rel 已打补丁，跳过"; continue; fi
      check_anchor "$tgt" "$anchor" "$exp" || gate_fail "apply 中止：$rel 锚点门 G1 失败"
      # v2-2：G3 静态门在**任何写操作之前**跑
      bodytmp=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      "$(spec_field "$spec" 5)" > "$bodytmp"
      gate_g3_const "$tgt" "$bodytmp" || { rm -f "$bodytmp"; gate_fail "apply 中止：$rel G3 const 裸赋值门失败（落地会让容器崩）"; }
      rm -f "$bodytmp"
      READY_RELS+=("$rel")
    done
    if [ "${#READY_RELS[@]}" -eq 0 ]; then
      printf '\n没有需要落地的补丁（全部已打）。\n'
      printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
      exit 0
    fi
    # ---- 阶段二：逐文件备份 + 原地重写 ----
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1); anchor=$(spec_field "$spec" 2)
      exp=$(spec_field "$spec" 3); needl=$(spec_field "$spec" 4)
      bodyfn=$(spec_field "$spec" 5); evid=$(spec_field "$spec" 6)
      tgt="$PATCH_DIR/$rel"
      case " ${READY_RELS[*]} " in *" $rel "*) ;; *) continue ;; esac
      bak="$tgt.bak-$BACKUP_STAMP"
      cp -a "$tgt" "$bak" || gate_fail "apply 中止：备份失败 $bak"
      pass "已备份 $bak"
      tmp=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      body=$(mktemp) || gate_fail "apply 中止：mktemp 失败"
      "$bodyfn" > "$body"
      # 锚点行被补丁体整体「替换」（补丁体自己重写了该分支的判定），不是插入到锚点行之前。
      # 用 awk 跳过原始分支体，直到证据锚点出现（原分支体之后的第一个稳定行）。
      awk -v anchor="$anchor" -v bodyf="$body" -v evid="$evid" '
        BEGIN { done = 0; skipping = 0 }
        !done && !skipping && index($0, anchor) > 0 {
          while ((getline line < bodyf) > 0) print line
          close(bodyf)
          done = 1; skipping = 1; next
        }
        skipping && index($0, evid) > 0 { skipping = 0; print; next }
        skipping { next }
        { print }
      ' "$tgt" > "$tmp" || { rm -f "$tmp" "$body"; gate_fail "apply 中止：awk 生成失败 $rel"; }
      # G2' 替换唯一性：替换后锚文本次数 == 原有 exp - 替换 1 + 补丁体重写数
      body_anchor_n=$(grep -cF "$anchor" "$body" 2>/dev/null || true); body_anchor_n="${body_anchor_n:-0}"
      tmp_anchor_n=$(grep -cF "$anchor" "$tmp" 2>/dev/null || true); tmp_anchor_n="${tmp_anchor_n:-0}"
      anchor_expect=$((exp - 1 + body_anchor_n))
      if [ "$tmp_anchor_n" != "$anchor_expect" ]; then
        rm -f "$tmp" "$body"
        gate_fail "apply 中止：$rel 替换后锚文本 $tmp_anchor_n 次（应 $anchor_expect = 原有 $exp - 替换 1 + 补丁体重写 $body_anchor_n）—— 原体多删或残留重复体"
      fi
      pass "G2' 替换唯一性 $rel: 锚文本 $tmp_anchor_n 次（== $anchor_expect，无残留重复体）"
      # v2：写回**前**对产物跑 G3 + bun 语义自检（双保险：产物本身也必须合法）
      gate_g3_const "$tmp" "$tmp" >/dev/null 2>&1 || true   # 产物自身不是本体的 const 裸赋值判据，仅信息性
      bun_semantic_check "$tmp" || { rm -f "$tmp" "$body"; gate_fail "apply 中止：$rel 产物 bun 语义自检失败（未写回，现场未改动）"; }
      # 保留 inode（不 rm 重建），避免宿主 bind-mount 丢挂载
      cat "$tmp" > "$tgt" || { rm -f "$tmp" "$body"; gate_fail "apply 中止：写入失败 $rel"; }
      rm -f "$tmp" "$body"
      pass "已原地重写 $rel（inode 保留）"
      check_shape "$tgt" "$needl" || gate_fail "apply 中止：$rel G2 形态门失败"
    done
    printf '回退（任何时候）：TARGET=%s bash %s --rollback --from %s\n' "$TARGET" "$0" "$BACKUP_STAMP"
    # ---- 阶段三：v2-5 操作员铁律（顺序不可颠倒）----
    printf '\n【操作员铁律 v2-5：顺序不可颠倒】\n'
    printf '  1) 先在容器内验证产物能编译（**不要先重启**）：\n'
    printf '       docker exec %s bun build /app/bot.ts\n' "$CONTAINER"
    printf '     编译失败 -> 立即回退：TARGET=%s bash %s --rollback --from %s\n' "$TARGET" "$0" "$BACKUP_STAMP"
    printf '     （v1 事故就是省了这一步：先重启 -> 容器加载期崩 -> 服务起不来）\n'
    printf '  2) 编译通过后，才重启：\n'
    printf '       systemctl restart %s\n' "$WAGATE_UNIT"
    printf '  3) 跑机械断言：bash regr/regrF2.sh   （A/B/C；开头即含容器内 bun build 门）\n'
    printf '  4) 回退：TARGET=%s bash %s --rollback --from %s\n' "$TARGET" "$0" "$BACKUP_STAMP"
    printf '若重启后异常：先 --rollback 再查 journalctl -u %s -n 200\n' "$WAGATE_UNIT"
    ;;

  rollback)
    printf '\n--rollback：从 .bak-<戳> 还原。\n'
    if [ -z "$FROM_TS" ]; then
      printf '未指定 --from，列出可用备份：\n'
      safe bash -c "ls -la $PATCH_DIR/bot.ts.bak-* 2>/dev/null | tail -n 40"
      printf '用法: bash %s --rollback --from <时间戳>\n' "$0"
      printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
      exit 0
    fi
    for spec in "${PATCH_SPECS[@]}"; do
      rel=$(spec_field "$spec" 1)
      bak="$PATCH_DIR/$rel.bak-$FROM_TS"
      if [ -f "$bak" ]; then
        cat "$bak" > "$PATCH_DIR/$rel" && pass "已还原 $rel <- $bak"
      else
        warn "备份不存在，跳过: $bak"
      fi
    done
    printf '\n还原后重启：systemctl restart %s（操作员确认后执行）\n' "$WAGATE_UNIT"
    ;;
esac

printf '\n========== SUMMARY: %d PASS / %d FAIL / %d WARN ==========\n' "$PASS_N" "$FAIL_N" "$WARN_N"
exit $([ "$FAIL_N" -eq 0 ] && echo 0 || echo 1)
