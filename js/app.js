/**
 * app.js — 应用入口：初始化数据、注册路由、渲染外壳、绑定全局操作（导出/导入/清空）。
 * 纯静态、零依赖、原生 ES6 模块。
 */
import * as store from './store.js';
import * as router from './router.js';
import { esc, attr, qs, qsa, on, toast, openModal, confirmDialog, badge, h } from './ui.js';

import * as dashboard from './views/dashboard.js';
import * as customers from './views/customers.js';
import * as leads from './views/leads.js';
import * as deals from './views/deals.js';
import * as followups from './views/followups.js';

const NAV = [
  { path: '/dashboard', label: '仪表盘' },
  { path: '/customers', label: '客户管理' },
  { path: '/leads', label: '线索管理' },
  { path: '/deals', label: '商机管理' },
  { path: '/followups', label: '跟进记录' },
];

/* ------------------------------------------------------------------ routes */

function registerRoutes() {
  router.register('/dashboard', (ctx) => dashboard.render(ctx));
  router.register('/customers', (ctx) => customers.render(ctx));
  router.register('/customers/new', (ctx) => customers.renderNew(ctx));
  router.register('/customers/:id', (ctx) => customers.renderDetail(ctx));
  router.register('/leads', (ctx) => leads.render(ctx));
  router.register('/leads/new', (ctx) => leads.renderNew(ctx));
  router.register('/leads/:id', (ctx) => leads.renderDetail(ctx));
  router.register('/deals', (ctx) => deals.render(ctx));
  router.register('/deals/new', (ctx) => deals.renderNew(ctx));
  router.register('/deals/:id', (ctx) => deals.renderDetail(ctx));
  router.register('/followups', (ctx) => followups.render(ctx));
  router.setNotFound((ctx) => {
    renderNotFound(ctx);
  });
  router.setNavigateHook(() => {
    closeDrawer();
    syncNav();
  });
}

function renderNotFound(ctx) {
  router.replace('/dashboard');
  toast(`页面 ${ctx.path} 不存在，已返回仪表盘`, 'warn');
}

/* ------------------------------------------------------------------- shell */

function shellHtml() {
  return `<header class="topbar">
      <button type="button" class="icon-btn topbar__menu" data-toggle-nav aria-label="切换导航">☰</button>
      <a class="brand" href="#/dashboard">
        <span class="brand__mark">CRM</span>
        <span class="brand__text">客户关系管理</span>
      </a>
      <nav class="topnav" data-topnav>${NAV.map((item) =>
        `<a class="topnav__item" href="#${attr(item.path)}" data-nav="${attr(item.path)}">${esc(item.label)}</a>`).join('')}</nav>
      <div class="topbar__tools">
        <button type="button" class="btn btn--ghost btn--sm" data-export>导出 JSON</button>
        <button type="button" class="btn btn--ghost btn--sm" data-import>导入 JSON</button>
        <button type="button" class="btn btn--ghost btn--sm" data-settings>设置</button>
        <button type="button" class="btn btn--ghost btn--sm" data-toggle-theme title="切换显示主题">◐</button>
        <button type="button" class="btn btn--danger btn--sm" data-clear>清空数据</button>
      </div>
      <input type="file" accept="application/json,.json" data-import-file hidden>
    </header>
    <div class="layout">
      <aside class="sidenav" data-sidenav>
        <nav class="sidenav__nav">${NAV.map((item) =>
          `<a class="sidenav__item" href="#${attr(item.path)}" data-nav="${attr(item.path)}">${esc(item.label)}</a>`).join('')}</nav>
        <div class="sidenav__foot">
          <p class="sidenav__stat" data-sidebar-counts></p>
          <button type="button" class="btn btn--ghost btn--sm btn--block" data-sidebar-import>导入数据</button>
          <button type="button" class="btn btn--ghost btn--sm btn--block" data-sidebar-export>导出数据</button>
        </div>
      </aside>
      <main class="main" id="view" tabindex="-1"></main>
    </div>
    <footer class="footer">
      <span>数据保存在浏览器 localStorage，不会上传服务器。</span>
      <span data-footer-meta></span>
    </footer>`;
}

function currentBase() {
  const path = router.currentPath() || '';
  const found = NAV.find((n) => path === n.path || path.startsWith(`${n.path}/`));
  return found ? found.path : '';
}

function syncNav() {
  const base = currentBase();
  qsa('[data-nav]').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.nav === base);
  });
  const counts = store.counts();
  const host = qs('[data-sidebar-counts]');
  if (host) {
    host.innerHTML = `客户 <b>${counts.customers}</b> · 线索 <b>${counts.leads}</b> · 商机 <b>${counts.deals}</b> · 跟进 <b>${counts.followups}</b>`;
  }
  const meta = qs('[data-footer-meta]');
  if (meta) {
    meta.textContent = `客户 ${counts.customers} · 线索 ${counts.leads} · 商机 ${counts.deals} · 跟进记录 ${counts.followups} · 更新于 ${store.formatDateTime(new Date().toISOString())}`;
  }
  const title = NAV.find((n) => n.path === base);
  document.title = title ? `${title.label} · CRM 客户关系管理` : 'CRM 客户关系管理';
}

function toggleDrawer() {
  const nav = qs('[data-sidenav]');
  const mask = qs('[data-drawer-mask]');
  if (!nav) return;
  const open = !nav.classList.contains('is-open');
  nav.classList.toggle('is-open', open);
  if (open) {
    if (!mask) {
      const el = h('<div class="drawer-mask" data-drawer-mask></div>');
      el.addEventListener('click', closeDrawer);
      document.body.appendChild(el);
    }
  } else if (mask) {
    mask.remove();
  }
}

function closeDrawer() {
  const nav = qs('[data-sidenav]');
  if (nav) nav.classList.remove('is-open');
  const mask = qs('[data-drawer-mask]');
  if (mask) mask.remove();
}

/* -------------------------------------------------------------- data tools */

function doExport() {
  const payload = store.exportJSON();
  const json = JSON.stringify(payload, null, 2);
  const ok = store.downloadJSON();
  if (!ok) {
    openModal({
      title: '导出数据',
      submitText: '关闭',
      body: `<p class="hint">浏览器未允许自动下载，请复制以下 JSON 内容自行保存：</p>
        <textarea class="export-area" rows="12" readonly>${esc(json)}</textarea>`,
      onSubmit: () => true,
    });
  } else {
    toast(`导出成功：客户端 ${payload.customers.length} · 线索 ${payload.leads.length} · 商机 ${payload.deals.length} · 跟进 ${payload.followups.length}`, 'success');
  }
}

function doImport() {
  const input = qs('[data-import-file]');
  if (input) input.click();
}

function handleImportFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try {
      parsed = JSON.parse(String(reader.result));
    } catch (err) {
      toast('导入失败：文件不是合法的 JSON', 'error');
      return;
    }
    openImportDialog(parsed);
  };
  reader.onerror = () => toast('导入失败：文件读取错误', 'error');
  reader.readAsText(file);
}

function openImportDialog(parsed) {
  const preview = ['customers', 'leads', 'deals', 'followups']
    .map((key) => `<li>${key}：${Array.isArray(parsed[key]) ? parsed[key].length : 0} 条</li>`).join('');
  openModal({
    title: '导入数据',
    submitText: '确认导入',
    wide: true,
    body: `<p class="hint">文件解析成功，包含以下数据（导入前会自动备份当前数据，可一键撤销）：</p>
      <ul class="import-preview">${preview}</ul>
      <div class="field"><span class="field__label">导入方式</span>
        <label class="radio"><input type="radio" name="mode" value="replace" checked> 覆盖现有数据（推荐）</label>
        <label class="radio"><input type="radio" name="mode" value="merge"> 合并到现有数据（按 id 去重）</label>
      </div>`,
    onSubmit: (data) => {
      const result = store.importJSON(parsed, { mode: data.mode || 'replace' });
      if (!result.ok) { toast(`导入失败：${result.reason}`, 'error'); return false; }
      toast(`导入成功：客户 ${result.counts.customers} · 线索 ${result.counts.leads} · 商机 ${result.counts.deals} · 跟进 ${result.counts.followups}`, 'success');
      router.replace(router.currentPath() || '/dashboard');
      syncNav();
      return true;
    },
  });
}

async function doClear() {
  const ok = await confirmDialog({
    title: '清空全部数据',
    message: '将删除浏览器本地保存的所有客户、线索、商机与跟进记录（清空前会自动生成一份可撤销快照）。确定继续吗？',
    submitText: '清空数据',
  });
  if (!ok) return;
  store.clearAll();
  toast('数据已清空，可在设置中撤销', 'success');
  router.replace('/dashboard');
  syncNav();
}

function openSettings() {
  const snapshot = store.importUndoSnapshot();
  openModal({
    title: '设置',
    submitText: '保存设置',
    body: `<div class="form-grid cols-1">
        <div class="field"><label class="field__label" for="f_operator">默认操作人</label>
          <input id="f_operator" name="operator" type="text" value="${attr(store.getOperator())}" placeholder="用于跟进记录的操作人署名"></div>
      </div>
      <p class="hint">数据存储：浏览器 localStorage（键名 crm.data.v1）。清空或覆盖导入前的快照可通过下方按钮恢复。</p>
      <div class="settings-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-undo-import ${snapshot ? '' : 'disabled'}>撤销上次清空 / 导入</button>
        <button type="button" class="btn btn--ghost btn--sm" data-reload>重新加载页面</button>
      </div>`,
    onSubmit: (data) => {
      store.saveSettings({ operator: data.operator });
      toast('设置已保存', 'success');
      syncNav();
    },
  });

  on(document.body, 'click', '[data-undo-import]', () => {
    if (!store.undoImport()) { toast('没有可恢复的快照', 'warn'); return; }
    toast('已恢复到上一次快照', 'success');
    router.replace(router.currentPath() || '/dashboard');
    syncNav();
  }, { once: false });
  on(document.body, 'click', '[data-reload]', () => window.location.reload());
}

/* ------------------------------------------------------------------- theme */

const THEME_KEY = 'crm.theme.v1';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (err) { /* 忽略隐私模式写入失败 */ }
}

function initTheme() {
  let theme = 'light';
  try { theme = localStorage.getItem(THEME_KEY) || 'light'; } catch (err) { theme = 'light'; }
  applyTheme(theme);
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  toast(next === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'success');
}

/* -------------------------------------------------------------------- boot */

function bindShell() {
  on(document.body, 'click', '[data-toggle-nav]', toggleDrawer);
  on(document.body, 'click', '[data-toggle-theme]', toggleTheme);
  on(document.body, 'click', '[data-export], [data-sidebar-export]', doExport);
  on(document.body, 'click', '[data-import], [data-sidebar-import]', doImport);
  on(document.body, 'click', '[data-clear]', doClear);
  on(document.body, 'click', '[data-settings]', openSettings);
  on(document.body, 'click', '[data-nav]', () => closeDrawer());

  const input = qs('[data-import-file]');
  if (input) {
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) handleImportFile(file);
      input.value = '';
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDrawer();
  });

  window.addEventListener('hashchange', () => { closeDrawer(); syncNav(); });
  window.addEventListener('storage', (event) => {
    if (event.key === 'crm.data.v1') {
      store.init();
      router.replace(router.currentPath() || '/dashboard');
      syncNav();
    }
  });
}

function boot() {
  const app = qs('#app');
  app.innerHTML = shellHtml();
  initTheme();
  store.init();
  registerRoutes();
  bindShell();
  router.start();
  syncNav();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
