/**
 * views/followups.js — 跟进记录：全量时间线（倒序）、按对象/关键字筛选、快速新增。
 */
import * as store from '../store.js';
import {
  esc, attr, badge, btn, renderView, qs, on, openModal, confirmDialog, toast,
  field, formGrid, paginate, pager, emptyState,
} from '../ui.js';

export const meta = { title: '跟进记录', path: '/followups' };

const PAGE_SIZE = 10;
const TYPE_LABEL = { customer: '客户', lead: '线索', deal: '商机' };

function targetsFor(type) {
  if (type === 'customer') return store.customers().map((c) => ({ value: c.id, label: c.name }));
  if (type === 'lead') return store.leads().map((l) => ({ value: l.id, label: `${l.name}${l.company ? ` · ${l.company}` : ''}` }));
  if (type === 'deal') return store.deals().map((d) => ({ value: d.id, label: d.title }));
  return [];
}

function allRows() {
  return store.followups()
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

function filtered(query) {
  const kw = (query.q || '').trim().toLowerCase();
  const type = query.type || '';
  const targetId = query.targetId || '';
  const from = query.from || '';
  const to = query.to || '';
  return allRows().filter((f) => {
    if (type && f.targetType !== type) return false;
    if (targetId && f.targetId !== targetId) return false;
    const day = String(f.at).slice(0, 10);
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (!kw) return true;
    const target = store.targetOf(f);
    return [f.content, f.operator, target.name].join(' ').toLowerCase().includes(kw);
  });
}

function filtersHtml(query) {
  const typeOptions = [['', '全部对象']].concat(Object.entries(TYPE_LABEL))
    .map(([v, l]) => `<option value="${attr(v)}" ${v === (query.type || '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const targetOptions = ['<option value="">全部具体对象</option>'].concat(
    Object.entries(TYPE_LABEL).flatMap(([type, label]) => {
      const items = targetsFor(type);
      if (!items.length) return [];
      return [`<optgroup label="${attr(label)}">`].concat(items.map((o) =>
        `<option value="${attr(o.value)}" ${o.value === (query.targetId || '') ? 'selected' : ''}>${esc(o.label)}</option>`)).concat(['</optgroup>']);
    }),
  ).join('');
  return `<form class="toolbar toolbar--wrap" data-filter-form>
      <input class="toolbar__search" type="search" name="q" value="${attr(query.q || '')}" placeholder="搜索跟进内容 / 操作人 / 对象名称">
      <select name="type">${typeOptions}</select>
      <select name="targetId">${targetOptions}</select>
      <input type="date" name="from" value="${attr(query.from || '')}" aria-label="起始日期">
      <input type="date" name="to" value="${attr(query.to || '')}" aria-label="结束日期">
      <button type="submit" class="btn btn--primary">筛选</button>
      <a class="btn btn--ghost" href="#/followups">重置</a>
    </form>`;
}

function timelineHtml(rows) {
  return `<ol class="timeline timeline--wide">${rows.map((f) => {
    const target = store.targetOf(f);
    return `<li class="timeline__item">
        <div class="timeline__dot"></div>
        <div class="timeline__body">
          <p class="timeline__meta">
            <a class="link" href="${attr(target.url)}">${esc(target.name)}</a>
            ${badge(TYPE_LABEL[f.targetType] || f.targetType)}
            <b>${esc(f.operator)}</b>
            <time>${esc(store.formatDateTime(f.at))}</time>
            <button type="button" class="link-btn link-btn--danger" data-del-followup="${attr(f.id)}">删除</button>
          </p>
          <p class="timeline__text">${esc(f.content)}</p>
        </div>
      </li>`;
  }).join('')}</ol>`;
}

export function render(ctx) {
  const query = ctx.query || {};
  const rows = filtered(query);
  const page = paginate(rows, query.page, PAGE_SIZE);
  const counts = store.followups().reduce((acc, f) => {
    acc[f.targetType] = (acc[f.targetType] || 0) + 1;
    return acc;
  }, {});

  const body = `
    <ul class="chips">
      <li class="chip"><span>全部记录</span><b>${store.followups().length}</b></li>
      ${Object.entries(TYPE_LABEL).map(([type, label]) =>
        `<li class="chip"><span>${esc(label)}</span><b>${counts[type] || 0}</b></li>`).join('')}
    </ul>
    ${filtersHtml(query)}
    <section class="card">
      ${page.slice.length ? timelineHtml(page.slice)
        : emptyState(store.followups().length ? '没有符合条件的跟进记录。' : '还没有跟进记录，点击右上角「新增跟进」记录第一条。')}
      ${pager({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })}
    </section>`;

  renderView({
    title: '跟进记录',
    subtitle: `共 ${store.followups().length} 条记录，按时间倒序展示`,
    actions: `<button type="button" class="btn btn--primary" data-new-followup>+ 新增跟进</button>`,
    body,
  });

  const root = qs('#view');
  const filterForm = qs('[data-filter-form]', root);
  if (filterForm) {
    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(filterForm).entries());
      const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== ''));
      location.hash = `#/followups?${new URLSearchParams({ ...clean, page: '1' }).toString()}`;
    });
    on(filterForm, 'change', 'select', () => filterForm.requestSubmit());
    let timer = null;
    const search = qs('input[name="q"]', filterForm);
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => filterForm.requestSubmit(), 300);
    });
  }

  on(root, 'click', '[data-page]', (event, target) => {
    location.hash = `#/followups?${new URLSearchParams({ ...query, page: target.dataset.page }).toString()}`;
  });
  on(root, 'click', '[data-new-followup]', () => openFollowupForm(() => render(ctx)));
  on(root, 'click', '[data-del-followup]', async (event, target) => {
    const ok = await confirmDialog({ title: '删除跟进记录', message: '确定删除这条跟进记录吗？', submitText: '删除' });
    if (!ok) return;
    store.deleteFollowup(target.dataset.delFollowup);
    toast('跟进记录已删除', 'success');
    render(ctx);
  });
}

/** 通用「新增跟进」弹窗：选择对象类型与具体对象。 */
export function openFollowupForm(onDone) {
  const typeOptions = Object.entries(TYPE_LABEL).map(([v, l]) => ({ value: v, label: l }));
  const modal = openModal({
    title: '新增跟进记录',
    submitText: '保存记录',
    body: formGrid([
      field({ label: '关联对象类型', name: 'targetType', type: 'select', value: 'customer', options: typeOptions }),
      { html: `<div class="field"><label class="field__label" for="f_targetId">关联对象</label>
          <select id="f_targetId" name="targetId">${['<option value="">请选择</option>'].concat(
            targetsFor('customer').map((o) => `<option value="${attr(o.value)}">${esc(o.label)}</option>`)).join('')}</select></div>` }.html,
      field({ label: '跟进时间', name: 'at', type: 'date', value: store.todayISO() }),
      field({ label: '操作人', name: 'operator', value: store.getOperator(), required: true }),
    ]) + `<div class="form-grid cols-1">${field({
      label: '跟进内容', name: 'content', type: 'textarea', value: '', rows: 4, required: true,
      placeholder: '记录沟通内容、客户反馈与下一步计划…',
    })}</div>`,
    onSubmit: (data) => {
      if (!data.targetId) { toast('请选择要关联的对象', 'warn'); return false; }
      const at = data.at ? new Date(`${data.at}T09:00:00`).toISOString() : new Date().toISOString();
      store.addFollowup({
        targetType: data.targetType, targetId: data.targetId,
        content: data.content, operator: data.operator, at,
      });
      store.saveSettings({ operator: data.operator });
      toast('跟进记录已保存', 'success');
      if (onDone) onDone();
      return true;
    },
  });

  const typeSelect = qs('select[name="targetType"]', modal.form);
  const targetSelect = qs('select[name="targetId"]', modal.form);
  const sync = () => {
    const items = targetsFor(typeSelect.value);
    targetSelect.innerHTML = (items.length ? ['<option value="">请选择</option>'] : ['<option value="">暂无可选对象</option>'])
      .concat(items.map((o) => `<option value="${attr(o.value)}">${esc(o.label)}</option>`)).join('');
  };
  typeSelect.addEventListener('change', sync);
  sync();
  return modal;
}

export default { render, openFollowupForm, meta };
