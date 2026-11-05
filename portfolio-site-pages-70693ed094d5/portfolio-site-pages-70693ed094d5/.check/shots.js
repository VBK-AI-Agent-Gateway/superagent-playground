/* shots.js <deliverable-dir> <out-dir> — 生成 PR 用的 After 视觉证据（桌面 + 移动） */
const path = require("path");
const http = require("http");
const fs = require("fs");
const { chromium } = require("/home/qt/.local/share/sa-smoke/node_modules/playwright");

const root = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
fs.mkdirSync(out, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || "/").split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  for (const [name, w, h] of [["desktop", 1280, 900], ["mobile", 375, 780]]) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    for (const [f, label] of [["index.html", "home"], ["works.html", "works"], ["contact.html", "contact"]]) {
      await page.goto(`${base}/${f}`, { waitUntil: "load" });
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, `${name}-${label}.png`), fullPage: false });
    }
    if (name === "desktop") {
      // 校验失败态截图（可见反馈证据）
      await page.goto(`${base}/contact.html`, { waitUntil: "load" });
      await page.fill("#email", "not-an-email");
      await page.click("#contact-form button[type='submit']");
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out, "desktop-contact-validation.png") });
    }
    await page.close();
  }

  await browser.close();
  server.close();
  fs.readdirSync(out).sort().forEach(f => console.log("wrote", f));
})().catch(e => { console.error("SHOTS ERROR:", e.message); process.exit(1); });
