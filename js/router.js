/**
 * router.js — 基于 location.hash 的前端路由，零依赖。
 * 路由表： #/dashboard  #/customers  #/customers/:id  #/customers/:id/edit
 *          #/leads      #/leads/:id      #/deals      #/deals/:id
 *          #/followups
 */

const routes = [];
let notFoundHandler = () => {};
let onNavigate = null;
let started = false;

/** 注册路由。pattern 形如 '/customers/:id'，可读参数以对象传入 handler。 */
export function register(pattern, handler, meta = {}) {
  routes.push({ pattern, handler, meta, segments: split(pattern) });
  return routes.length - 1;
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

/** 每次导航成功后的回调（用于渲染刷新侧栏、标题等）。 */
export function setNavigateHook(fn) {
  onNavigate = fn;
}

function split(path) {
  return String(path || '/').split('/').filter(Boolean);
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart && pathPart.startsWith('/') ? pathPart : `/${pathPart || ''}`;
  const query = {};
  new URLSearchParams(queryPart || '').forEach((value, key) => { query[key] = value; });
  return { path: path.replace(/\/+$/, '') || '/', query };
}

function match(path) {
  const parts = split(path);
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** 生成链接： link('/customers', {q:'a'}) → '#/customers?q=a' */
export function link(path, query) {
  const qs = query && Object.keys(query).length
    ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()
    : '';
  return `#${path}${qs}`;
}

/** 跳转（会写入历史，浏览器后退可用）。 */
export function navigate(path, query) {
  location.hash = link(path, query);
}

export function replace(path, query) {
  const url = link(path, query);
  if (location.hash === url) { resolve(); return; }
  history.replaceState(null, '', url);
  resolve();
}

/** 当前 hash 对应的路径（不含查询串），形如 '/customers'。 */
export function currentPath() {
  return parseHash().path;
}

/** 解析当前 hash 并调用对应视图。 */
export function resolve() {
  const { path, query } = parseHash();
  const found = match(path);
  if (found) {
    found.route.handler({ path, params: found.params, query });
  } else if (path === '/' || path === '') {
    replace('/dashboard');
    return;
  } else {
    notFoundHandler({ path, query });
  }
  if (onNavigate) onNavigate({ path, params: found ? found.params : {}, query });
}

export function start(fallback = '/dashboard') {
  if (started) return;
  started = true;
  window.addEventListener('hashchange', resolve);
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    history.replaceState(null, '', `#${fallback}`);
  }
  resolve();
  return currentPath();
}

export const router = { register, setNotFound, setNavigateHook, start, resolve, navigate, replace, link, currentPath };
export default router;
