// parsegate.js —— 真实 TypeScript 解析门（被 fixes/*.sh 调用，不是独立交付物）
//
// 为什么不用启发式大括号计数：
//   `grep -c` 统计的是**行数**不是出现次数，而且字符串/模板串/注释里的花括号也会被计入
//   （基线 telegram.ts 本身 { =197 / } =200 就"不平衡"）。v1 翻车的正是这类「产物语法无效，
//   但只有真正 --apply 才暴露」的缺陷，所以必须用真正的解析器判定。
//
// 用法：node parsegate.js <file.ts> [file2.ts ...]
//   退出码 0 = 全部可解析
//   退出码 1 = 有文件解析失败（调用方据此 fail-closed 中止，绝不写盘）
//   退出码 2 = 环境缺 typescript（调用方降级为显式 WARN，绝不静默通过）
//
// typescript 查找顺序（不依赖 cwd，因为脚本会在任意目录被调用）：
//   1) 环境变量 TS_MODULE_DIR / NODE_PATH
//   2) 本文件同级的 lib/node_modules（若操作员把依赖随交付目录一起放）
//   3) 逐级向上的 node_modules（标准 Node 解析）
//   4) 常见全局位置
// 找不到就返回 2 —— 明确告警，绝不假装验证过。

const fs = require("node:fs");
const path = require("node:path");

function loadTypeScript() {
  const cands = [];
  if (process.env.TS_MODULE_DIR) cands.push(path.join(process.env.TS_MODULE_DIR, "typescript"));
  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) {
      if (p) cands.push(path.join(p, "typescript"));
    }
  }
  // 本脚本所在目录及其祖先的 node_modules（cwd 无关）
  let d = __dirname;
  for (let i = 0; i < 8; i++) {
    cands.push(path.join(d, "node_modules", "typescript"));
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  cands.push(
    "/usr/lib/node_modules/typescript",
    "/usr/local/lib/node_modules/typescript",
    path.join(process.env.HOME || "/root", ".npm-global/lib/node_modules/typescript")
  );
  for (const c of cands) {
    try {
      return require(c);
    } catch { /* 继续找 */ }
  }
  try { return require("typescript"); } catch { /* 最后再试标准解析 */ }
  return null;
}

const ts = loadTypeScript();
if (!ts) {
  console.error("[SYNTAX-SKIP] 找不到 typescript 模块（试过 TS_MODULE_DIR/NODE_PATH/祖先 node_modules/全局），无法做解析门");
  process.exit(2);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法: node parsegate.js <file.ts> [...]");
  process.exit(2);
}

let bad = 0;
for (const f of files) {
  if (!fs.existsSync(f)) {
    console.log(`[SYNTAX-FAIL] ${f}: 文件不存在`);
    bad++;
    continue;
  }
  const src = fs.readFileSync(f, "utf8");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics || [];
  if (diags.length) {
    bad++;
    console.log(`[SYNTAX-FAIL] ${path.basename(f)}: ${diags.length} 处解析错误`);
    for (const d of diags.slice(0, 5)) {
      const lc = sf.getLineAndCharacterOfPosition(d.start ?? 0);
      console.log(`   L${lc.line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
    }
  } else {
    console.log(`[SYNTAX-OK] ${path.basename(f)} (${src.split("\n").length} 行)`);
  }
}
process.exit(bad ? 1 : 0);
