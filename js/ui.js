/**
 * ui.js — 视图共用工具：HTML 转义、DOM 构建、表单、弹窗、Toast、分页。
 */

/* ------------------------------------------------------------------ escape */

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const attr = (value) => esc(value);

/* --------------------------------------------------------------- DOM utils */

export const qs = (selector, root = document) => root.querySelector(selector);
export const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/** 由 HTML 字符串创建元素。 */
export function h(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html).trim();
  return tpl.content.firstElementChild;
}

/** 监听事件（可选委托选择器）。 */
export function on(root, type, selector, handler) {
  if (typeof selector === 'function') {
    root.addEventListener(type, selector);
    return () => root.removeEventListener(type, selector);
  }
  root.addEventListener(type, (event) => {
    const target = event.target.closest(selector);
    if (target && root.contains(target)) handler(event, target);
  });
}

export function setText(root, selector, value) {
  const el = qs(selector, root);
  if (el) el.textContent = value;
}

/* ------------------------------------------------------------------- toast */

export function toast(message, kind = 'info') {
  let host = qs('#toast-host');
  if (!host) {
    host = h('<div id="toast-host" class="toast-host" aria-live="polite"></div>');
    document.body.appendChild(host);
  }
  const node = h(`<div class="toast toast--${esc(kind)}">${esc(message)}</div>`);
  host.appendChild(node);
  setTimeout(() => node.classList.add('is-visible'), 10);
  setTimeout(() => {
    node.classList.remove('is-visible');
    setTimeout(() => node.remove(), 300);
  }, 2600);
}

/* ------------------------------------------------------------------ modal */

/**
 * 打开通用弹窗。body 为 HTML 字符串；返回 { root, close, form }。
 * form 存在时提交会先做原生校验，再把表单数据交给 onSubmit。
 */
export function openModal({ title, body, submitText = '保存', cancelText = '取消', onSubmit, wide = false }) {
  const footHtml = `
        <footer class="modal__foot">
          <button type="button" class="btn btn--ghost" data-modal-close>${esc(cancelText)}</button>
          ${onSubmit ? `<button type="submit" class="btn btn--primary" data-modal-submit>${esc(submitText)}</button>` : ''}
        </footer>`;

  const wrap = h(`
    <div class="modal-host" role="dialog" aria-modal="true">
      <div class="modal ${wide ? 'modal--wide' : ''}">
        <header class="modal__head">
          <h3 class="modal__title">${esc(title)}</h3>
          <button type="button" class="icon-btn" data-modal-close aria-label="关闭">×</button>
        </header>
        <div class="modal__body"></div>
      </div>
    </div>`);

  const bodyHost = qs('.modal__body', wrap);
  if (onSubmit) {
    // form 必须同时包住字段与提交按钮，type="submit" 才能触发表单提交
    const form = h(`<form class="form" novalidate><div class="modal__lead">${body}</div>${footHtml}</form>`);
    bodyHost.appendChild(form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const data = Object.fromEntries(new FormData(form).entries());
      const result = onSubmit(data, form);
      if (result !== false) close();
    });
  } else {
    bodyHost.innerHTML = `<div class="modal__lead">${body}</div>`;
    bodyHost.appendChild(h(footHtml));
  }

  const close = () => {
    wrap.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => { if (event.key === 'Escape') close(); };

  qsa('[data-modal-close]', wrap).forEach((btn) => btn.addEventListener('click', close));
  wrap.addEventListener('mousedown', (event) => { if (event.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
  const first = qs('input, select, textarea', wrap);
  if (first) setTimeout(() => first.focus(), 30);
  return { root: wrap, close, form: qs('form', wrap) };
}

/** 二次确认弹窗，返回 Promise<boolean>。 */
export function confirmDialog({ title = '确认操作', message, submitText = '确认', danger = true }) {
  return new Promise((resolve) => {
    const modal = openModal({
      title,
      body: `<p class="confirm-text">${esc(message)}</p>`,
      submitText,
      onSubmit: () => { resolve(true); },
    });
    qsa('[data-modal-close]', modal.root).forEach((btn) =>
      btn.addEventListener('click', () => resolve(false)));
    modal.root.addEventListener('mousedown', (event) => {
      if (event.target === modal.root) resolve(false);
    });
    if (danger) qs('[data-modal-submit]', modal.root).classList.add('btn--danger');
  });
}

/* -------------------------------------------------------------------- form */

/** 生成表单字段 HTML。type: text|number|date|select|textarea */
export function field({ label, name, type = 'text', value = '', required = false, options = [], placeholder = '', hint = '', rows = 3, min, max, step }) {
  const id = `f_${name}`;
  const req = required ? 'required' : '';
  const extra = [
    placeholder ? `placeholder="${attr(placeholder)}"` : '',
    min != null ? `min="${attr(min)}"` : '',
    max != null ? `max="${attr(max)}"` : '',
    step != null ? `step="${attr(step)}"` : '',
  ].filter(Boolean).join(' ');
  let control;
  if (type === 'select') {
    control = `<select id="${id}" name="${attr(name)}" ${req}>${options.map((opt) => {
      const value_ = typeof opt === 'string' ? opt : opt.value;
      const label_ = typeof opt === 'string' ? opt : opt.label;
      return `<option value="${attr(value_)}" ${String(value_) === String(value) ? 'selected' : ''}>${esc(label_)}</option>`;
    }).join('')}</select>`;
  } else if (type === 'textarea') {
    control = `<textarea id="${id}" name="${attr(name)}" rows="${rows}" ${req} ${extra}>${esc(value)}</textarea>`;
  } else {
    control = `<input id="${id}" name="${attr(name)}" type="${attr(type)}" value="${attr(value)}" ${req} ${extra}>`;
  }
  return `<div class="field">
      <label class="field__label" for="${id}">${esc(label)}${required ? ' <b class="req">*</b>' : ''}</label>
      ${control}
      ${hint ? `<p class="field__hint">${esc(hint)}</p>` : ''}
    </div>`;
}

export const formGrid = (fields, cols = 2) => `<div class="form-grid cols-${cols}">${fields.join('')}</div>`;

/* -------------------------------------------------------------------- misc */

const BADGE = {
  '新建': 'info', '跟进中': 'warn', '已转化': 'ok', '已流失': 'muted',
  '潜在': 'info', '合作中': 'ok', '暂停': 'warn', '已流失': 'muted',
  '初步接洽': 'info', '需求确认': 'info', '报价': 'warn', '谈判': 'warn', '赢单': 'ok', '输单': 'danger',
  'A': 'ok', 'B': 'info', 'C': 'muted',
};

export const badge = (text, tone) =>
  `<span class="badge badge--${esc(tone || BADGE[text] || 'muted')}">${esc(text)}</span>`;

export function emptyState(text, actionHtml = '') {
  return `<div class="empty"><p class="empty__text">${esc(text)}</p>${actionHtml}</div>`;
}

export function statCard({ label, value, sub = '', tone = '' }) {
  return `<article class="stat ${tone ? `stat--${esc(tone)}` : ''}">
      <p class="stat__label">${esc(label)}</p>
      <p class="stat__value">${esc(value)}</p>
      ${sub ? `<p class="stat__sub">${esc(sub)}</p>` : ''}
    </article>`;
}

/** 数据行渲染成卡片列表（客户/线索/商机共用）。 */
export function dataRow({ title, titleHtml, subtitle, badgeHtml = '', meta = [], actions = [], href }) {
  const head = href
    ? `<a class="row__title" href="${attr(href)}">${titleHtml || esc(title)}</a>`
    : `<span class="row__title">${titleHtml || esc(title)}</span>`;
  return `<li class="row">
      <div class="row__main">
        <div class="row__head">${head}${badgeHtml}</div>
        ${subtitle ? `<p class="row__sub">${esc(subtitle)}</p>` : ''}
        ${meta.length ? `<div class="row__meta">${meta.map((m) => `<span class="meta"><i>${esc(m.label)}</i>${esc(m.value)}</span>`).join('')}</div>` : ''}
      </div>
      ${actions.length ? `<div class="row__actions">${actions.join('')}</div>` : ''}
    </li>`;
}

export const btn = (label, { variant = 'ghost', attrs = '', href = '' } = {}) => (href
  ? `<a class="btn btn--${variant}" href="${attr(href)}" ${attrs}>${esc(label)}</a>`
  : `<button type="button" class="btn btn--${variant}" ${attrs}>${esc(label)}</button>`);

/* ---------------------------------------------------------------- paginate */

export function paginate(items, page, pageSize) {
  const size = Math.max(1, Number(pageSize) || 10);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * size;
  return {
    slice: items.slice(start, start + size),
    page: current,
    pageSize: size,
    totalPages,
    total: items.length,
  };
}

/** 分页控件，按钮带 data-page 属性，由视图绑定事件。 */
export function pager({ page, totalPages, total, pageSize }) {
  if (total === 0) return '';
  const nums = [];
  const from = Math.max(1, page - 2);
  const to = Math.min(totalPages, from + 4);
  for (let i = from; i <= to; i += 1) {
    nums.push(`<button type="button" class="pager__num ${i === page ? 'is-active' : ''}" data-page="${i}">${i}</button>`);
  }
  return `<nav class="pager" aria-label="分页">
      <span class="pager__info">共 ${total} 条 · 每页 ${pageSize} 条 · 第 ${page}/${totalPages} 页</span>
      <div class="pager__ctrl">
        <button type="button" class="pager__num" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        ${nums.join('')}
        <button type="button" class="pager__num" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
      </div>
    </nav>`;
}

/* -------------------------------------------------------------------- view */

/**
 * 渲染视图骨架，进入视图时整体替换内容（每个视图独立模块）。
 * options: { title, subtitle, actions, body, cls }
 */
export function renderView(options) {
  const main = qs('#view');
  if (!main) return null;
  const { title = '', subtitle = '', actions = '', body = '', cls = '' } = options;
  main.className = `view ${cls}`.trim();
  main.innerHTML = `
    ${title ? `<header class="view__head">
      <div>
        <h1 class="view__title">${esc(title)}</h1>
        ${subtitle ? `<p class="view__sub">${esc(subtitle)}</p>` : ''}
      </div>
      ${actions ? `<div class="view__actions">${actions}</div>` : ''}
    </header>` : ''}
    <div class="view__body">${body}</div>`;
  main.scrollTop = 0;
  return main;
}

/* ------------------------------------------------------------------- chart */

/** 纯 CSS 横向条形图。data: [{label, value, display}] */
export function barChart(data, { emptyText = '暂无数据' } = {}) {
  if (!data.length) return `<p class="chart__empty">${esc(emptyText)}</p>`;
  const max = Math.max(...data.map((d) => d.value), 1);
  return `<ul class="chart">${data.map((d) => `
      <li class="chart__row">
        <span class="chart__label" title="${attr(d.label)}">${esc(d.label)}</span>
        <span class="chart__track"><span class="chart__bar" style="width:${Math.round((d.value / max) * 100)}%"></span></span>
        <span class="chart__value">${esc(d.display != null ? d.display : d.value)}</span>
      </li>`).join('')}</ul>`;
}

/** 纯 SVG 折线/面积图，按时间（最近 N 个月）展示数量。 */
export function lineChart(points, { label = '数量' } = {}) {
  if (!points.length) return '<p class="chart__empty">暂无数据</p>';
  const w = 600;
  const hgt = 200;
  const pad = { top: 16, right: 16, bottom: 30, left: 36 };
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = points.length > 1 ? (w - pad.left - pad.right) / (points.length - 1) : 0;
  const x = (i) => pad.left + i * step;
  const y = (v) => hgt - pad.bottom - (v / max) * (hgt - pad.top - pad.bottom);
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(hgt - pad.bottom).toFixed(1)} L${x(0).toFixed(1)},${(hgt - pad.bottom).toFixed(1)} Z`;
  const dots = points.map((p, i) =>
    `<circle class="chart-svg__dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5"><title>${esc(p.label)}：${p.value}</title></circle>`).join('');
  const labels = points.map((p, i) =>
    `<text class="chart-svg__label" x="${x(i).toFixed(1)}" y="${hgt - 10}" text-anchor="middle">${esc(p.label)}</text>`).join('');
  const values = points.map((p, i) =>
    `<text class="chart-svg__value" x="${x(i).toFixed(1)}" y="${(y(p.value) - 8).toFixed(1)}" text-anchor="middle">${p.value}</text>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${w} ${hgt}" role="img" aria-label="${attr(label)}趋势图" preserveAspectRatio="none">
      <line class="chart-svg__axis" x1="${pad.left}" y1="${hgt - pad.bottom}" x2="${w - pad.right}" y2="${hgt - pad.bottom}"></line>
      <path class="chart-svg__area" d="${area}"></path>
      <path class="chart-svg__line" d="${line}"></path>
      ${dots}${labels}${values}
    </svg>`;
}

/** 环形图（纯 SVG 描边），data: [{label, value}] */
export function donutChart(data, { size = 150 } = {}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const r = 54;
  const c = 2 * Math.PI * r;
  if (!total) return '<p class="chart__empty">暂无数据</p>';
  const tones = ['ok', 'info', 'warn', 'danger', 'muted'];
  let offset = 0;
  const arcs = data.filter((d) => d.value > 0).map((d, i) => {
    const len = (d.value / total) * c;
    const arc = `<circle class="donut__arc donut__arc--${tones[i % tones.length]}"
        cx="80" cy="80" r="${r}" fill="none" stroke-width="20"
        stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}"><title>${esc(d.label)}：${d.value}</title></circle>`;
    offset += len;
    return arc;
  }).join('');
  return `<div class="donut">
      <svg class="donut__svg" viewBox="0 0 160 160" width="${size}" height="${size}" role="img" aria-label="占比图">
        <circle class="donut__bg" cx="80" cy="80" r="${r}" fill="none" stroke-width="20"></circle>
        <g transform="rotate(-90 80 80)">${arcs}</g>
        <text class="donut__total" x="80" y="78" text-anchor="middle">${total}</text>
        <text class="donut__unit" x="80" y="96" text-anchor="middle">合计</text>
      </svg>
      <ul class="donut__legend">${data.map((d, i) =>
        `<li><span class="dot dot--${tones[i % tones.length]}"></span>${esc(d.label)}<b>${d.value}</b></li>`).join('')}</ul>
    </div>`;
}

/* ------------------------------------------------------------------ follow */

/**
 * 渲染对象的跟进记录区块：表单 + 倒序时间线。
 * targetType: customer | lead | deal
 */
export function followupSection(targetType, targetId, records) {
  return `<section class="card" id="followup-section">
      <header class="card__head"><h2 class="card__title">跟进记录 <span class="count">${records.length}</span></h2></header>
      <form class="followup-form" data-followup-form data-target-type="${attr(targetType)}" data-target-id="${attr(targetId)}">
        <textarea name="content" rows="3" required placeholder="填写本次沟通内容、客户反馈或下一步计划…"></textarea>
        <div class="followup-form__foot">
          <input name="operator" type="text" placeholder="操作人" value="${attr(getOperatorName())}" required>
          <input name="at" type="date" value="${todayValue()}">
          <button type="submit" class="btn btn--primary">添加跟进</button>
        </div>
      </form>
      ${records.length ? `<ol class="timeline">${records.map((f) => `
        <li class="timeline__item">
          <div class="timeline__dot"></div>
          <div class="timeline__body">
            <p class="timeline__meta">
              <b>${esc(f.operator)}</b>
              <time>${esc(formatDateTime(f.at))}</time>
              <button type="button" class="link-btn link-btn--danger" data-del-followup="${attr(f.id)}">删除</button>
            </p>
            <p class="timeline__text">${esc(f.content)}</p>
          </div>
        </li>`).join('')}</ol>` : '<p class="chart__empty">还没有跟进记录，添加第一条吧。</p>'}
    </section>`;
}

/* 避免循环依赖：这里只做轻量的本地取值。 */
function getOperatorName() {
  try {
    const raw = localStorage.getItem('crm.settings.v1');
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && parsed.operator) || '当前用户';
  } catch (err) {
    return '当前用户';
  }
}

function todayValue() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
