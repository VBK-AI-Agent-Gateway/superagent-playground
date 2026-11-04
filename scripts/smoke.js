#!/usr/bin/env node
/** smoke.js <deliverable-dir> — zero-build validation for static web deliverables.
 * 1) syntax gate: compile every .js (skips ES-module-looking files)
 * 2) one headless chromium load: console/page errors collected, screenshot only on failure.
 * Deps: playwright at /home/qt/.local/share/sa-smoke (installed once by smoke.sh).
 */
const path = require("path");
const http = require("http");
const fs = require("fs");
const vm = require("vm");
const { chromium } = require("/home/qt/.local/share/sa-smoke/node_modules/playwright");

const dir = process.argv[2];
const root = dir ? path.resolve(dir) : null;
if (!root || !fs.existsSync(path.join(root, "index.html"))) {
  console.error("SMOKE FAIL: no index.html under", dir || "(missing arg)");
  process.exit(2);
}

const MIME = {".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",
  ".png":"image/png",".jpg":"image/jpeg",".svg":"image/svg+xml",".woff2":"font/woff2",".ico":"image/x-icon"};

function listJs(root) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === ".smoke") continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".js")) out.push(f);
    }
  })(root);
  return out;
}

(async () => {
  const fails = [];
  for (const f of listJs(root)) {
    const src = fs.readFileSync(f, "utf8");
    if (/^\s*(import|export)\s/m.test(src)) continue;
    try { new vm.Script(src, { filename: f }); }
    catch (e) { fails.push("syntax " + path.relative(root, f) + ": " + e.message); }
  }
  if (fails.length) {
    console.log("SMOKE FAIL (syntax)");
    fails.forEach(e => console.log("  -", e));
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load", timeout: 20000 });
  await page.waitForTimeout(3000);
  const title = await page.title();
  const domSize = (await page.content()).length;
  if (errors.length) {
    fs.mkdirSync(path.join(root, ".smoke"), { recursive: true });
    await page.screenshot({ path: path.join(root, ".smoke", "smoke-fail.png") }).catch(() => {});
  }
  await browser.close();
  server.close();
  console.log(`SMOKE ${errors.length ? "FAIL" : "PASS"} title="${title}" dom=${domSize}B errors=${errors.length}`);
  errors.forEach(e => console.log("  -", e));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error("SMOKE FAIL:", e.message); process.exit(1); });
