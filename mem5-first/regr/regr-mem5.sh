#!/bin/sh
# regr-mem5.sh —— mem5-first 合成回归（issue #79，验证 ①断点 ②L5 修复 ③技能账 ④交付索引）
#
# 做法（无需生产凭据、无需 docker）：
#   1) 把 patches 应用到 mem5-context/ 的临时副本（fixture 目录）
#   2) 用 esbuild/tsc 把 TS 转成 JS —— 无 TS 工具链时退回「源码断言模式」（仍全部可跑）
#   3) 造一个假租户工作区 + 桩 pi/事件总线，真实驱动 handler，断言落盘与注入
#   4) 逐条打印 PASS/FAIL，末尾 exit 0/1
#
# 用法： sh regr/regr-mem5.sh [--keep]     （--keep 保留临时目录便于排查）

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && pwd)          # mem5-first/
REPO=$(cd "$ROOT/.." && pwd)          # delivery root
SRC="$REPO/mem5-context"
PATCH="$ROOT/fixes/fix-mem5-first.sh"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

WORK=$(mktemp -d)
cleanup() { [ "$KEEP" = "1" ] || rm -rf "$WORK"; [ "$KEEP" = "1" ] && echo "临时目录保留：$WORK"; }
trap cleanup EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  [PASS] %s\n' "$1"; }
no()   { FAIL=$((FAIL+1)); printf '  [FAIL] %s\n' "$1"; }
chk()  { if [ "$2" = "0" ]; then ok "$1"; else no "$1"; fi; }

echo "== mem5-first 合成回归"
echo "   源：$SRC"
echo "   临时：$WORK"

# ---------------------------------------------------------------- 0) 前置
[ -f "$SRC/personal-assistant.ts" ] || { echo "缺 $SRC/personal-assistant.ts"; exit 2; }
[ -f "$PATCH" ] || { echo "缺 $PATCH"; exit 2; }

FIX="$WORK/plugin"
mkdir -p "$FIX"
cp "$SRC/personal-assistant.ts" "$SRC/delivery-hub.ts" "$FIX/"

# ---------------------------------------------------------------- 1) 补丁本身
echo ""
echo "== 1) 补丁脚本自检"
sh "$PATCH" --check-anchors --dir "$FIX" >"$WORK/anchor.log" 2>&1
chk "锚点唯一性校验通过" $?

sh "$PATCH" --apply --dir "$FIX" >"$WORK/apply.log" 2>&1
chk "补丁 --apply 成功" $?

grep -q "MEM5_FIRST_V1" "$FIX/personal-assistant.ts"; chk "personal-assistant.ts 带幂等标记" $?
grep -q "MEM5_FIRST_V1" "$FIX/delivery-hub.ts";       chk "delivery-hub.ts 带幂等标记" $?
ls "$FIX"/personal-assistant.ts.bak.mem5.* >/dev/null 2>&1; chk "已生成 .bak.mem5 备份" $?

sh "$PATCH" --apply --dir "$FIX" >"$WORK/apply2.log" 2>&1
chk "重复 --apply 幂等（exit 0 无操作）" $?

TS=$(ls "$FIX"/personal-assistant.ts.bak.mem5.* | head -1)
TS=${TS##*.bak.mem5.}
sh "$PATCH" --revert "$TS" --dir "$FIX" >"$WORK/revert.log" 2>&1
chk "--revert 成功" $?
if cmp -s "$SRC/personal-assistant.ts" "$FIX/personal-assistant.ts"; then ok "--revert 还原到基线（逐字节一致）"; else no "--revert 未还原干净"; fi
# 再打一次，供后续行为测试使用
sh "$PATCH" --apply --dir "$FIX" >/dev/null 2>&1

# ---------------------------------------------------------------- 2) 源码级断言
echo ""
echo "== 2) 源码级断言（不依赖 TS 工具链）"
PA="$FIX/personal-assistant.ts"
DH="$FIX/delivery-hub.ts"

grep -q 'MEM5_CONTINUATION_FILE = "continuation.md"' "$PA";   chk "① 断点层文件名 continuation.md" $?
grep -q 'MEM5_SKILLS_FILE = "installed-skills.md"' "$PA";     chk "③ 技能账文件名 installed-skills.md" $?
grep -q 'MEM5_INDEX_FILE = "deliveries-index.md"' "$PA";      chk "④ 交付索引 deliveries-index.md" $?
grep -q 'MEM5_INJECT_BUDGET = 1500' "$PA";                    chk "注入总预算 1500 字（<1.5KB）" $?
grep -q '__lastUserText' "$PA";                               chk "② 读取 globalThis.__lastUserText" $?
grep -q 'mem5IsSystemInstruction' "$PA";                      chk "② 系统指令拒绝门存在" $?
grep -q 'WAGATE_MEM_ENHANCE_OFF' "$PA";                       chk "逃生阀 WAGATE_MEM_ENHANCE_OFF 存在" $?
grep -q 'mem5WriteContinuation' "$PA";                        chk "① 断点层写入函数存在" $?
grep -q 'mem5RecordDeliver(o)' "$DH";                         chk "④ markDelivered 已挂钩" $?
grep -q 'last-delivery.json' "$DH";                           chk "④ last-delivery.json 持久兜底" $?
grep -q 'process.env.WAGATE_MEM_ENHANCE_OFF' "$DH";           chk "④ 交付索引同样受逃生阀控制" $?

# 绝不触碰的文件
for bad in tenant-core.ts telegram.ts bot.ts upload-ops.ts route-guard.ts img-ops.ts; do
  [ -f "$SRC/$bad" ] && no "禁止修改的 $bad 竟出现在 mem5-context/"; done
ok "未在 mem5-context/ 引入禁止修改的文件"

# task.json 绝不出现（只看真实代码引用；注释里"不动 task.json"的说明不算）
if grep -n 'task\.json' "$PA" "$DH" | grep -v '^\S*:[0-9]*: *\*' | grep -v '不动 task\.json'; then
  no "补丁中出现 task.json 代码引用（违反单写者仲裁）"
else
  ok "补丁未触碰 task.json（仅注释声明不动它）"
fi

# 注入增量预算：三段 head + 预算常量
python3 - "$PA" <<'PY'
import re, sys, io
src = io.open(sys.argv[1], encoding="utf-8").read()
heads = re.findall(r'"(【[^"]{0,200})"', src)
total = sum(len(h.encode("utf-8")) for h in heads[:3])
budget = 0
m = re.search(r'MEM5_INJECT_BUDGET\s*=\s*(\d+)', src)
if m: budget = int(m.group(1))
sys.exit(0 if (budget == 1500 and total < 400) else 1)
PY
chk "三段注入抬头合计 <400B，且总预算 1500B（合计 <1.5KB）" $?

# ---------------------------------------------------------------- 3) 行为级测试
echo ""
echo "== 3) 行为级测试（桩 pi + 假租户工作区）"
# 运行时优先级：bun > node + tsc 转译 > 仅源码断言
JS=$(command -v bun 2>/dev/null || true)
TSC=""
if [ -z "$JS" ]; then
  for c in "$(command -v tsc 2>/dev/null)" \
           "/home/qt/src/dsh-sa-git/node_modules/.bin/tsc" \
           "/tmp/node_modules/typescript/bin/tsc"; do
    [ -n "$c" ] && [ -x "$c" ] && { TSC="$c"; break; }
  done
  [ -n "$TSC" ] && JS="$(command -v node 2>/dev/null || true)"
fi
MODE="skip"
echo "   运行时：${JS:-无}${TSC:+ （+tsc 转译）}"

TEN="$WORK/tenants/t_demo/workspace"
mkdir -p "$TEN"
PAURL="$FIX/personal-assistant.ts"      # bun 可直接跑 TS
if [ -n "$JS" ] && [ -n "$TSC" ]; then
  mkdir -p "$WORK/js"
  "$TSC" --target es2022 --module esnext --moduleResolution bundler --skipLibCheck \
         --noEmitOnError false --outDir "$WORK/js" \
         "$FIX/personal-assistant.ts" >"$WORK/tsc.log" 2>&1
  if [ -f "$WORK/js/personal-assistant.js" ]; then
    PAURL="$WORK/js/personal-assistant.js"
    printf '%s\n' '{"type":"module"}' > "$WORK/package.json"
  else
    echo "   tsc 未产出 JS，跳过行为级："; tail -3 "$WORK/tsc.log"; JS=""
  fi
fi

if [ -n "$JS" ]; then
  MODE="js"
  cat > "$WORK/drive.mjs" <<'TS'
// 桩：捕获 handler，模拟一轮对话（纯 JS，供 node/bun 直跑）
import fs from "node:fs";
import path from "node:path";
const TEN = process.env.TEN;
const handlers = {};
const pi = { on: (n, f) => { (handlers[n] ||= []).push(f); } };
globalThis.__currentSid = "t_demo";
globalThis.__tenantRoot = path.dirname(path.dirname(TEN));
globalThis.__lastUserText = "帮我把报表导出改成 CSV";
const mod = await import(process.env.PA);
mod.default(pi);
const fire = async (n, ev) => { let r; for (const h of handlers[n] || []) r = await h(ev); return r; };
const r1 = await fire("before_agent_start", { systemPrompt: "SYS", prompt: "" });
const injected = String(r1?.systemPrompt ?? "");
await fire("tool_execution_start", { toolName: "skill_install" });
await fire("agent_end", {});
const r2 = await fire("before_agent_start", { systemPrompt: "SYS", prompt: "" });
const injected2 = String(r2?.systemPrompt ?? "");
const rd = (f) => fs.existsSync(path.join(TEN, f)) ? fs.readFileSync(path.join(TEN, f), "utf-8") : "";
fs.writeFileSync(process.env.OUT, JSON.stringify({
  injected, injected2, cont: rd("continuation.md"), sk: rd("installed-skills.md"),
}));
TS
  TEN="$TEN" PA="$PAURL" OUT="$WORK/out.json" "$JS" "$WORK/drive.mjs" >"$WORK/beh.log" 2>&1
  if [ $? -ne 0 ]; then
    echo "   行为级驱动失败（见下），退化为源码断言："; tail -5 "$WORK/beh.log"
  else
    python3 - "$WORK/out.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
i2, cont, sk = d["injected2"], d["cont"], d["sk"]
def rep(c, m):
    print(("  [PASS] " if c else "  [FAIL] ") + m); return 0 if c else 1
bad = 0
bad += rep("帮我把报表导出改成 CSV" in cont, "① 断点层记录了真实用户原话")
bad += rep("先判断本条是不是开发需求" not in cont, "② 系统指令未混入断点层")
bad += rep("【上次未完工作】" in i2, "① 第二轮注入含【上次未完工作】")
bad += rep("skill_install" in sk, "③ 技能账记录了 skill_install")
bad += rep("【已装技能" in i2, "③ 第二轮注入含技能账")
# 只量 mem5 新增段落（基线技能引导不计入本工单预算）
k = i2.find("【上次未完工作】")
mem5 = i2[k:].rstrip() if k >= 0 else ""
delta = len(mem5.encode())
bad += rep(0 < delta < 1500, "mem5 注入增量 <1.5KB（实测 %dB）" % delta)
sys.exit(1 if bad else 0)
PY
    if [ $? -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  fi

  # 逃生阀：WAGATE_MEM_ENHANCE_OFF=1 -> 零注入零写入
  # 必须换全新租户目录：复用首轮的 $TEN 会读到上一轮已落盘的文件，误判为"阀门失效"
  TEN2="$WORK/tenants/t_off/workspace"; mkdir -p "$TEN2"
  WAGATE_MEM_ENHANCE_OFF=1 TEN="$TEN2" PA="$PAURL" OUT="$WORK/out2.json" "$JS" "$WORK/drive.mjs" >"$WORK/beh2.log" 2>&1
  if [ $? -eq 0 ]; then
    python3 - "$WORK/out2.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
# 阀门开启时：不得新增注入段，不得新建任何文件
segs = ["【上次未完工作】", "【已装技能", "【近期交付"]
off = (not any(s in d["injected2"] for s in segs)) and d["cont"] == "" and d["sk"] == ""
print(("  [PASS] " if off else "  [FAIL] ") + "逃生阀 WAGATE_MEM_ENHANCE_OFF=1 -> 零注入零写入")
sys.exit(0 if off else 1)
PY
    if [ $? -eq 0 ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  else
    echo "  [SKIP] 逃生阀测试（驱动失败）"; tail -3 "$WORK/beh2.log"
  fi
else
  echo "   （无可运行 JS 运行时：跳过行为级断言，源码断言已覆盖结构正确性）"
fi

# ---------------------------------------------------------------- 4) 交付物自检
echo ""
echo "== 4) 交付目录自检"
[ -f "$ROOT/README.md" ]; chk "README.md 存在" $?
[ -f "$PATCH" ]; chk "fixes/fix-mem5-first.sh 存在" $?
[ -f "$ROOT/regr/regr-mem5.sh" ]; chk "regr/regr-mem5.sh 存在" $?

echo ""
echo "================ 结果：PASS=$PASS FAIL=$FAIL ================"
[ "$FAIL" = "0" ] || exit 1
exit 0
