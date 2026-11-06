/**
 * views/leads.js — 线索管理：列表、新建/编辑、状态流转、一键转化客户、删除。
 */
import * as store from '../store.js';
import {
  esc, attr, badge, btn, renderView, qs, on, openModal, confirmDialog, toast,
  field, formGrid, paginate, pager, emptyState, dataRow, followupSection,
} from '../ui.js';
import { bindFollowupForm } from './customers.js';

export const meta = { title: '线索管理', path: '/leads' };

const PAGE_SIZE = 8;
const blankLead = {
  id: '', name: '', company: '', phone: '', email: '', source: '官网',
  status: '新建', owner: '', note: '',
};

function leadFormBody(lead = blankLead) {
  return formGrid([
    field({ label: '联系人姓名', name: 'name', value: lead.name, required: true, placeholder: '请输入联系人姓名' }),
    field({ label: '公司名称', name: 'company', value: lead.company, placeholder: '请输入公司名称' }),
    field({ label: '联系电话', name: 'phone', value: lead.phone, placeholder: '手机或座机' }),
    field({ label: '邮箱', name: 'email', type: 'email', value: lead.email, placeholder: 'name@example.com' }),
    field({ label: '线索来源', name: 'source', type: 'select', value: lead.source, options: store.CUSTOMER_SOURCES }),
    field({ label: '负责人', name: 'owner', value: lead.owner, placeholder: '跟进负责人' }),
  ]) + `<div class="form-grid cols-1">${field({
    label: '备注', name: 'note', type: 'textarea', value: lead.note, rows: 3,
    placeholder: '客户需求、预算、时间计划等',
  })}</div>`;
}

export function openLeadForm(lead = blankLead, onSaved) {
  const editing = !!lead.id;
  const modal = openModal({
    title: editing ? `编辑线索 · ${lead.name}` : '新增线索',
    body: leadFormBody(lead),
    submitText: editing ? '保存修改' : '创建线索',
    onSubmit: (data) => {
      if (editing) {
        store.updateLead(lead.id, data);
        toast('线索已更新', 'success');
      } else {
        const created = store.createLead(data);
        toast('线索已创建', 'success');
        if (onSaved) { onSaved(created); return; }
      }
      if (onSaved) onSaved(null);
    },
  });
  return modal;
}

/* ------------------------------------------------------------------- list */

function filtered(query) {
  const kw = (query.q || '').trim().toLowerCase();
  const status = query.status || '';
  const source = query.source || '';
  const sort = query.sort || 'createdAt';
  const rows = store.leads().filter((l) => {
    if (status && l.status !== status) return false;
    if (source && l.source !== source) return false;
    if (!kw) return true;
    return [l.name, l.company, l.phone, l.email, l.owner, l.note]
      .join(' ').toLowerCase().includes(kw);
  });
  return rows.slice().sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (sort === 'status') return store.LEAD_STATUS.indexOf(a.status) - store.LEAD_STATUS.indexOf(b.status);
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

/** 状态流转按钮：仅展示 LEAD_FLOW 允许的下一步与直接目标。 */
function statusButtons(lead) {
  const allowed = store.LEAD_FLOW[lead.status] || [];
  return allowed.map((s) => btn(`→ ${s}`, {
    variant: s === '已流失' ? 'danger' : 'ghost',
    attrs: `data-lead-status="${attr(s)}" data-lead-id="${attr(lead.id)}"`,
  })).join('');
}

function leadActions(lead) {
  if (lead.status === '已转化') {
    return lead.customerId
      ? btn('查看客户', { variant: 'primary', href: `#/customers/${lead.customerId}` })
      : btn('已转化', { variant: 'primary', attrs: 'disabled' });
  }
  if (lead.status === '已流失') {
    return btn('重新跟进', { attrs: `data-lead-status="跟进中" data-lead-id="${attr(lead.id)}"` });
  }
  return btn('转化客户', { variant: 'primary', attrs: `data-convert="${attr(lead.id)}"` });
}

function filtersHtml(query) {
  const opt = (list, current, all) => [`<option value="">${esc(all)}</option>`]
    .concat(list.map((v) => `<option value="${attr(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`)).join('');
  return `<form class="toolbar" data-filter-form>
      <input class="toolbar__search" type="search" name="q" value="${attr(query.q || '')}" placeholder="搜索姓名 / 公司 / 电话 / 邮箱">
      <select name="status">${opt(store.LEAD_STATUS, query.status, '全部状态')}</select>
      <select name="source">${opt(store.CUSTOMER_SOURCES, query.source, '全部来源')}</select>
      <select name="sort">${[['createdAt', '最新创建'], ['name', '姓名排序'], ['status', '按状态']]
        .map(([v, l]) => `<option value="${v}" ${v === (query.sort || 'createdAt') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="submit" class="btn btn--primary">筛选</button>
      <a class="btn btn--ghost" href="#/leads">重置</a>
    </form>`;
}

function statsHtml() {
  const counts = store.leadStatusCounts();
  return `<ul class="chips">${store.LEAD_STATUS.map((s) =>
    `<li class="chip"><span>${esc(s)}</span><b>${counts[s] || 0}</b></li>`).join('')}</ul>`;
}

export function render(ctx) {
  const query = ctx.query || {};
  const rows = filtered(query);
  const page = paginate(rows, query.page, PAGE_SIZE);

  const body = `
    ${statsHtml()}
    ${filtersHtml(query)}
    <section class="card card--flush">
      ${page.slice.length ? `<ul class="row-list">${page.slice.map((l) => dataRow({
        title: l.name,
        href: `#/leads/${l.id}`,
        badgeHtml: badge(l.status),
        subtitle: `${l.company || '未填写公司'}${l.owner ? ` · 负责人 ${l.owner}` : ''}`,
        meta: [
          { label: '电话', value: l.phone || '—' },
          { label: '来源', value: l.source },
          { label: '创建', value: store.formatDate(l.createdAt) },
          { label: '跟进', value: `${store.listFollowups('lead', l.id).length} 条` },
        ],
        actions: [
          btn('详情', { href: `#/leads/${l.id}` }),
          ...statusButtons(l).split('</button>').filter(Boolean).map((s) => s + '</button>'),
          leadActions(l),
          btn('编辑', { attrs: `data-edit-lead="${attr(l.id)}"` }),
          btn('删除', { variant: 'danger', attrs: `data-del-lead="${attr(l.id)}"` }),
        ],
      })).join('')}</ul>
      ${pager({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })}`
      : emptyState(store.leads().length ? '没有符合条件的线索。' : '还没有线索，点击右上角「新增线索」创建。')}
    </section>`;

  renderView({
    title: '线索管理',
    subtitle: `共 ${store.leads().length} 条线索 · 状态流转：新建 → 跟进中 → 已转化 / 已流失`,
    actions: `<a class="btn btn--primary" href="#/leads/new">+ 新增线索</a>`,
    body,
  });

  bindList(qs('#view'), ctx);
}

function bindList(root, ctx) {
  const query = ctx.query || {};
  const filterForm = qs('[data-filter-form]', root);
  if (filterForm) {
    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(filterForm).entries());
      location.hash = `#/leads?${new URLSearchParams({ ...data, page: '1' }).toString()}`;
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
    location.hash = `#/leads?${new URLSearchParams({ ...query, page: target.dataset.page }).toString()}`;
  });
  on(root, 'click', '[data-lead-status]', (event, target) => {
    const result = store.changeLeadStatus(target.dataset.leadId, target.dataset.leadStatus);
    if (!result.ok) toast(result.reason, 'warn');
    else { toast(`线索状态已更新为「${target.dataset.leadStatus}」`, 'success'); render(ctx); }
  });
  on(root, 'click', '[data-convert]', async (event, target) => {
    const lead = store.findLead(target.dataset.convert);
    if (!lead) return;
    openConvertDialog(lead, () => render(ctx));
  });
  on(root, 'click', '[data-edit-lead]', (event, target) => {
    const lead = store.findLead(target.dataset.editLead);
    if (lead) openLeadForm(lead, () => render(ctx));
  });
  on(root, 'click', '[data-del-lead]', async (event, target) => {
    const lead = store.findLead(target.dataset.delLead);
    if (!lead) return;
    const ok = await confirmDialog({
      title: '删除线索',
      message: `确定删除线索「${lead.name}」？其跟进记录会一并删除。`,
      submitText: '删除',
    });
    if (!ok) return;
    store.deleteLead(lead.id);
    toast('线索已删除', 'success');
    render(ctx);
  });
}

/** 一键转化弹窗：确认客户名称与关键字段，确认后线索标记「已转化」。 */
export function openConvertDialog(lead, onDone) {
  const modal = openModal({
    title: `转化线索 · ${lead.name}`,
    submitText: '确认转化',
    body: `<p class="hint">转化后将创建一位新客户，并把线索状态置为「已转化」，同时建立双向关联。</p>`
      + formGrid([
        field({ label: '客户名称', name: 'name', value: lead.company || lead.name, required: true }),
        field({ label: '所属行业', name: 'industry', value: '', placeholder: '如：智能制造' }),
        field({ label: '客户等级', name: 'level', type: 'select', value: 'B', options: store.CUSTOMER_LEVELS }),
        field({ label: '客户状态', name: 'status', type: 'select', value: '潜在', options: store.CUSTOMER_STATUS }),
        field({ label: '客户来源', name: 'source', type: 'select', value: lead.source, options: store.CUSTOMER_SOURCES }),
        field({ label: '负责人', name: 'owner', value: lead.owner || store.getOperator() }),
      ]),
    onSubmit: (data) => {
      const result = store.convertLeadToCustomer(lead.id, data);
      if (!result.ok) { toast(result.reason, 'warn'); return false; }
      toast(`转化成功，已创建客户「${result.customer.name}」`, 'success');
      if (onDone) onDone(result.customer);
      return true;
    },
  });
  return modal;
}

/* ------------------------------------------------------------------ detail */

export function renderDetail(ctx) {
  const lead = store.findLead(ctx.params.id);
  if (!lead) {
    renderView({ title: '线索不存在', body: emptyState('该线索可能已被删除。', '<a class="btn btn--primary" href="#/leads">返回线索列表</a>') });
    return;
  }
  const records = store.listFollowups('lead', lead.id);
  const customer = lead.customerId ? store.findCustomer(lead.customerId) : null;
  const deals = store.deals().filter((d) => d.leadId === lead.id);

  const body = `
    <div class="detail-actions">
      ${store.LEAD_FLOW[lead.status].map((s) => btn(`流转为「${s}」`, {
        attrs: `data-lead-status="${attr(s)}" data-lead-id="${attr(lead.id)}"`,
        variant: s === '已流失' ? 'danger' : 'ghost',
      })).join('')}
      ${lead.status === '已转化' ? '' : btn('一键转化客户', { variant: 'primary', attrs: `data-convert="${attr(lead.id)}"` })}
      ${btn('编辑线索', { attrs: `data-edit-lead="${attr(lead.id)}"` })}
      ${btn('删除线索', { variant: 'danger', attrs: `data-del-lead="${attr(lead.id)}"` })}
      <a class="btn btn--ghost" href="#/leads">返回列表</a>
    </div>
    <div class="grid grid--7-5">
      <section class="card">
        <header class="card__head"><h2 class="card__title">线索信息</h2>${badge(lead.status)}</header>
        <dl class="dl">
          <div><dt>联系人</dt><dd>${esc(lead.name)}</dd></div>
          <div><dt>公司</dt><dd>${esc(lead.company || '—')}</dd></div>
          <div><dt>电话</dt><dd>${esc(lead.phone || '—')}</dd></div>
          <div><dt>邮箱</dt><dd>${esc(lead.email || '—')}</dd></div>
          <div><dt>来源</dt><dd>${esc(lead.source)}</dd></div>
          <div><dt>负责人</dt><dd>${esc(lead.owner || '—')}</dd></div>
          <div><dt>创建时间</dt><dd>${esc(store.formatDateTime(lead.createdAt))}</dd></div>
          <div><dt>最近更新</dt><dd>${esc(store.formatDateTime(lead.updatedAt))}</dd></div>
        </dl>
        ${lead.note ? `<p class="detail-note">${esc(lead.note)}</p>` : ''}
        <ol class="flow">${store.LEAD_STATUS.map((s) => `<li class="${s === lead.status ? 'is-active' : ''}">${esc(s)}</li>`).join('')}</ol>
      </section>
      <div class="stack">
        <section class="card">
          <header class="card__head"><h2 class="card__title">转化结果</h2></header>
          ${customer
            ? `<p class="hint">已转化为客户</p><p><a class="link" href="#/customers/${attr(customer.id)}">${esc(customer.name)}</a></p>`
            : '<p class="chart__empty">尚未转化。点击「一键转化客户」可生成客户档案。</p>'}
        </section>
        <section class="card">
          <header class="card__head"><h2 class="card__title">关联商机 <span class="count">${deals.length}</span></h2></header>
          ${deals.length ? `<ul class="mini-list">${deals.map((d) => `
            <li><div class="mini-list__head"><a class="link" href="#/deals/${attr(d.id)}">${esc(d.title)}</a>${badge(d.stage)}</div>
            <p>${esc(store.formatMoney(d.amount))}</p></li>`).join('')}</ul>`
            : '<p class="chart__empty">暂无关联商机。</p>'}
        </section>
      </div>
    </div>
    ${followupSection('lead', lead.id, records)}`;

  renderView({
    title: `${lead.name}${lead.company ? ` · ${lead.company}` : ''}`,
    subtitle: `线索状态：${lead.status} · 创建于 ${store.formatDate(lead.createdAt)}`,
    body,
  });

  const root = qs('#view');
  on(root, 'click', '[data-lead-status]', (event, target) => {
    const result = store.changeLeadStatus(target.dataset.leadId, target.dataset.leadStatus);
    if (!result.ok) { toast(result.reason, 'warn'); return; }
    toast(`线索状态已更新为「${target.dataset.leadStatus}」`, 'success');
    renderDetail(ctx);
  });
  on(root, 'click', '[data-convert]', () => {
    const current = store.findLead(ctx.params.id);
    openConvertDialog(current, () => renderDetail(ctx));
  });
  on(root, 'click', '[data-edit-lead]', () => {
    openLeadForm(store.findLead(ctx.params.id), () => renderDetail(ctx));
  });
  on(root, 'click', '[data-del-lead]', async () => {
    const ok = await confirmDialog({
      title: '删除线索',
      message: `确定删除线索「${lead.name}」？其跟进记录会一并删除。`,
      submitText: '删除',
    });
    if (!ok) return;
    store.deleteLead(lead.id);
    toast('线索已删除', 'success');
    location.hash = '#/leads';
  });
  bindFollowupForm(root, 'lead', lead.id, () => renderDetail(ctx));
}

export function renderNew() {
  renderView({ title: '新增线索', body: '<section class="card"><p class="chart__empty">正在打开表单…</p></section>' });
  openLeadForm(blankLead, (created) => {
    location.hash = created ? `#/leads/${created.id}` : '#/leads';
  });
}

export default { render, renderDetail, renderNew, openLeadForm, openConvertDialog, meta };
