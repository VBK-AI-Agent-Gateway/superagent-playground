#!/usr/bin/env node
/** check.js <deliverable-dir> — 验收脚本（只读检查，零依赖：仅用 scripts/smoke 已有的 playwright）
 *  覆盖 issue #24 验收标准 (1)-(6)：三页可打开无报错、导航互跳+高亮、
 *  ≥4 个作品卡片、响应式无溢出、表单校验拦截、无外部 CDN 请求。
 */
const path = require("path");
const http = require("http");
const fs = require("fs");
const { chromium } = require("/home/qt/.local/share/sa-smoke/node_modules/playwright");

const root = path.resolve(process.argv[2] || ".");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const results = [];
const ok = (n, pass, extra) => results.push({ n, pass, extra: extra || "" });

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
  const errors = [];
  const external = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route("**/*", route => {
    const url = route.request().url();
    if (!url.startsWith(base) && !url.startsWith("data:") && !url.startsWith("about:")) external.push(url);
    route.continue();
  });
  const page = await ctx.newPage();
  page.on("console", m => { if (m.type() === "error") errors.push(`${page.url()}#console ${m.text()}`); });
  page.on("pageerror", e => errors.push(`${page.url()}#pageerror ${e.message}`));
  page.on("requestfailed", r => { if (r.url().startsWith(base)) errors.push(`${page.url()}#requestfailed ${r.url()}`); });

  // (1) 三页可独立打开
  for (const f of ["index.html", "works.html", "contact.html"]) {
    const resp = await page.goto(`${base}/${f}`, { waitUntil: "load", timeout: 20000 });
    ok(`打开 ${f} 返回 200`, resp && resp.status() === 200, String(resp && resp.status()));
    const sem = await page.evaluate(() => ["header", "nav", "main", "footer"].every(t => document.querySelector(t)));
    ok(`${f} 含 header/nav/main/footer`, sem);
    const enc = await page.evaluate(() => document.characterSet);
    ok(`${f} 编码为 UTF-8`, /utf-8/i.test(enc), enc);
  }

  // (2) 导航互跳 + 当前页高亮
  const navMap = { "index.html": "home", "works.html": "works", "contact.html": "contact" };
  for (const [f, key] of Object.entries(navMap)) {
    await page.goto(`${base}/${f}`, { waitUntil: "load" });
    const hrefs = await page.$$eval(".site-nav a", as => as.map(a => a.getAttribute("href")));
    ok(`${f} 导航含三页链接`, ["index.html", "works.html", "contact.html"].every(h => hrefs.includes(h)), hrefs.join(","));
    const cur = await page.$$eval(".site-nav a[aria-current='page']", as => as.map(a => a.getAttribute("data-nav")));
    ok(`${f} 当前页高亮唯一且为 ${key}`, cur.length === 1 && cur[0] === key, JSON.stringify(cur));
    const bg = await page.$eval(".site-nav a[aria-current='page']", el => getComputedStyle(el).backgroundColor);
    ok(`${f} 高亮有可见背景色`, bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent", bg);
  }
  // 实际点击跳转
  await page.goto(`${base}/index.html`, { waitUntil: "load" });
  await page.click(".site-nav a[data-nav='works']");
  await page.waitForLoadState("load");
  ok("点击导航跳转到 works.html", page.url().endsWith("/works.html"), page.url());
  await page.click(".site-nav a[data-nav='contact']");
  await page.waitForLoadState("load");
  ok("点击导航跳转到 contact.html", page.url().endsWith("/contact.html"), page.url());
  await page.click(".site-nav a[data-nav='home']");
  await page.waitForLoadState("load");
  ok("点击导航回到 index.html", page.url().endsWith("/index.html"), page.url());

  // (3) 作品卡片 ≥4 + 字段完整 + 响应式
  await page.goto(`${base}/works.html`, { waitUntil: "load" });
  const cards = await page.$$eval(".work", els => els.map(e => ({
    title: (e.querySelector(".work__title") || {}).textContent || "",
    thumb: !!e.querySelector(".work__thumb"),
    desc: ((e.querySelector(".work__desc") || {}).textContent || "").trim().length,
    link: (e.querySelector(".work__link") || {}).getAttribute ? e.querySelector(".work__link").getAttribute("href") : null,
  })));
  ok("作品卡片 ≥ 4", cards.length >= 4, String(cards.length));
  ok("每个卡片含标题/缩略图占位/简述/外链",
    cards.every(c => c.title.trim() && c.thumb && c.desc > 10 && /^https?:/.test(c.link || "")),
    JSON.stringify(cards.map(c => [c.title.trim(), c.thumb, c.desc, c.link])));

  for (const [w, h, label] of [[1280, 900, "桌面 1280"], [768, 900, "平板 768"], [375, 720, "移动 375"]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(150);
    const m = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      cols: getComputedStyle(document.querySelector(".works-grid")).gridTemplateColumns.split(" ").length,
      navVisible: !!document.querySelector(".site-nav").offsetParent,
    }));
    ok(`${label} 无横向溢出`, !m.overflow);
    ok(`${label} 导航可见`, m.navVisible);
    ok(`${label} 网格列数合理`, m.cols >= 1 && m.cols <= 4, String(m.cols));
    if (w === 375) ok("移动端作品网格单列", m.cols === 1, String(m.cols));
  }

  // (4) 表单校验
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${base}/contact.html`, { waitUntil: "load" });
  ok("表单含姓名/邮箱/留言三字段",
    await page.evaluate(() => ["name", "email", "message"].every(n => !!document.querySelector(`[name="${n}"]`))));

  await page.click("#contact-form button[type='submit']");
  await page.waitForTimeout(150);
  let st = await page.evaluate(() => ({
    errs: document.querySelectorAll(".field.has-error").length,
    status: document.getElementById("form-status").textContent,
    hidden: document.getElementById("form-status").hidden,
    invalid: document.querySelectorAll("[aria-invalid='true']").length,
    url: location.pathname,
  }));
  ok("空提交被拦截并提示", st.errs === 3 && st.invalid === 3 && !st.hidden && /修正/.test(st.status), JSON.stringify(st));
  ok("空提交未发生页面跳转", st.url.endsWith("/contact.html"), st.url);

  await page.fill("#name", "张三");
  await page.fill("#message", "想聊一个官网改版的项目，下周方便沟通。");
  await page.fill("#email", "not-an-email");
  await page.click("#contact-form button[type='submit']");
  await page.waitForTimeout(150);
  st = await page.evaluate(() => ({
    errs: document.querySelectorAll(".field.has-error").length,
    emailMsg: document.getElementById("email-error").textContent,
    status: document.getElementById("form-status").textContent,
  }));
  ok("邮箱格式错误被拦截并给出邮箱提示", st.errs === 1 && /邮箱/.test(st.emailMsg) && /修正/.test(st.status), JSON.stringify(st));

  await page.fill("#email", "zhangsan@example.com");
  await page.click("#contact-form button[type='submit']");
  await page.waitForTimeout(150);
  st = await page.evaluate(() => ({
    errs: document.querySelectorAll(".field.has-error").length,
    status: document.getElementById("form-status").textContent,
    cls: document.getElementById("form-status").className,
    nameVal: document.getElementById("name").value,
    statusHidden: document.getElementById("form-status").hidden,
  }));
  ok("合法提交给出静态占位成功提示", st.errs === 0 && /静态占位/.test(st.status) && /form-status--ok/.test(st.cls) && !st.statusHidden, JSON.stringify(st));
  ok("成功后表单已重置", st.nameVal === "", st.nameVal);

  // (5) 无外部 CDN / 断网可渲染：屏蔽一切非本地请求后加载三页，样式与脚本仍须生效
  const offCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await offCtx.route("**/*", route => {
    const u = route.request().url();
    if (u.startsWith(base) || u.startsWith("data:") || u.startsWith("about:")) { route.continue(); }
    else { route.abort("internetdisconnected"); }
  });
  const offPage = await offCtx.newPage();
  const offErrors = [];
  offPage.on("pageerror", e => offErrors.push(e.message));
  offPage.on("console", m => { if (m.type() === "error") offErrors.push(m.text()); });
  for (const f of ["index.html", "works.html", "contact.html"]) {
    await offPage.goto(`${base}/${f}`, { waitUntil: "load", timeout: 20000 });
    const styled = await offPage.evaluate(() => getComputedStyle(document.querySelector(".site-header")).borderBottomWidth);
    const scripted = await offPage.evaluate(() => !!document.querySelector(".site-nav a[aria-current='page']"));
    ok(`断网模式打开 ${f}：样式生效`, styled !== "0px", styled);
    ok(`断网模式打开 ${f}：脚本生效`, scripted);
  }
  ok("断网模式三页无脚本报错", offErrors.length === 0, offErrors.join(" | "));
  await offCtx.close();

  // (6) 无外部资源请求、无外部引用
  ok("运行期无任何外部网络请求", external.length === 0, external.slice(0, 5).join(","));
  const g = (f) => fs.readFileSync(path.join(root, f), "utf8");
  const all = ["index.html", "works.html", "contact.html", "css/style.css", "js/main.js", "js/contact.js"].map(g).join("\n");
  // 只把 <a href> 之外的 http(s) 引用（即真正会发起资源请求的写法）视为违规
  const resRefs = all.match(/[^>]*\b(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/gi) || [];
  const badRefs = resRefs.filter(t => !/<a\b/i.test(t.slice(0, t.search(/\b(?:src|href)\s*=/i))));
  const cdn = /@import|cdn\.|unpkg|jsdelivr|googleapis/i.test(all);
  ok("源码内无外部资源引用（仅允许 <a> 外链）", badRefs.length === 0 && !cdn, badRefs.join(" | "));

  await browser.close();
  server.close();

  const failed = results.filter(r => !r.pass);
  results.forEach(r => console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.n}${r.extra ? "  [" + r.extra + "]" : ""}`));
  console.log(`\n${failed.length ? "CHECK FAIL" : "CHECK PASS"}  ${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error("CHECK ERROR:", e.message); process.exit(2); });
