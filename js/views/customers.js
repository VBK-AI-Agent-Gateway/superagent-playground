/**
 * views/customers.js — 客户管理：列表（搜索/筛选/分页）、新建/编辑、详情、删除。
 */
import * as store from '../store.js';
import {
  esc, attr, badge, btn, renderView, qs, qsa, on, openModal, confirmDialog, toast,
  field, formGrid, paginate, pager, emptyState, dataRow, followupSection,
} from '../ui.js';

export const meta = { title: '客户管理', path: '/customers' };

const PAGE_SIZE = 8;
const blankCustomer = {
  id: '', name: '', industry: '', level: 'B', status: '潜在', source: '官网',
  phone: '', email: '', website: '', address: '', owner: '', note: '',
};

/* ------------------------------------------------------------- form modal */

function contactRow(contact = {}) {
  return `<div class="contact-row" data-contact>
      <input type="hidden" name="contactId" value="${attr(contact.id || '')}">
      <input name="contactName" placeholder="姓名" value="${attr(contact.name || '')}">
      <select name="contactRole">${store.CONTACT_ROLES.map((r) =>
        `<option value="${attr(r)}" ${r === (contact.role || '其他') ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      <input name="contactPhone" placeholder="电话" value="${attr(contact.phone || '')}">
      <input name="contactEmail" type="email" placeholder="邮箱" value="${attr(contact.email || '')}">
      <input name="contactWechat" placeholder="微信" value="${attr(contact.wechat || '')}">
      <label class="check"><input type="checkbox" name="contactPrimary" ${contact.isPrimary ? 'checked' : ''}> 主要联系人</label>
      <button type="button" class="icon-btn icon-btn--danger" data-remove-contact aria-label="删除联系人">×</button>
    </div>`;
}

function customerFormBody(customer = blankCustomer, contacts = []) {
  return `
    ${formGrid([
      field({ label: '客户名称', name: 'name', value: customer.name, required: true, placeholder: '请输入公司全称' }),
      field({ label: '所属行业', name: 'industry', value: customer.industry, placeholder: '如：智能制造' }),
      field({ label: '客户等级', name: 'level', type: 'select', value: customer.level, options: store.CUSTOMER_LEVELS }),
      field({ label: '客户状态', name: 'status', type: 'select', value: customer.status, options: store.CUSTOMER_STATUS }),
      field({ label: '客户来源', name: 'source', type: 'select', value: customer.source, options: store.CUSTOMER_SOURCES }),
      field({ label: '负责人', name: 'owner', value: customer.owner, placeholder: '销售负责人' }),
      field({ label: '联系电话', name: 'phone', value: customer.phone, placeholder: '座机或手机' }),
      field({ label: '邮箱', name: 'email', type: 'email', value: customer.email, placeholder: 'name@example.com' }),
      field({ label: '官网', name: 'website', value: customer.website, placeholder: 'https://' }),
      field({ label: '地址', name: 'address', value: customer.address, placeholder: '省/市/区 详细地址' }),
    ])}
    <div class="form-grid cols-1">
      ${field({ label: '备注', name: 'note', type: 'textarea', value: customer.note, rows: 3, placeholder: '客户背景、合作要点等' })}
    </div>
    <section class="sub-form">
      <div class="sub-form__head">
        <h4>联系人</h4>
        <button type="button" class="btn btn--ghost btn--sm" data-add-contact>+ 添加联系人</button>
      </div>
      <div class="contact-list" data-contact-list>
        ${contacts.length ? contacts.map(contactRow).join('') : '<p class="hint">暂无联系人，可点击「添加联系人」。</p>'}
      </div>
    </section>`;
}

function collectContacts(form) {
  return qsa('[data-contact]', form).map((row) => {
    const data = Object.fromEntries(new FormData(new FormDataShim(row)).entries());
    return {
      id: data.contactId || undefined,
      name: (data.contactName || '').trim(),
      role: data.contactRole,
      phone: (data.contactPhone || '').trim(),
      email: (data.contactEmail || '').trim(),
      wechat: (data.contactWechat || '').trim(),
      isPrimary: !!data.contactPrimary,
    };
  }).filter((c) => c.name || c.phone || c.email);
}

/* FormData 只接受 <form>，这里用一个轻量兼容层读取行内输入。 */
class FormDataShim {
  constructor(row) {
    this.values = qsa('input, select, textarea', row).reduce((acc, el) => {
      acc[el.name] = el.type === 'checkbox' ? (el.checked ? 'on' : '') : el.value;
      return acc;
    }, {});
  }

  entries() {
    return Object.entries(this.values);
  }
}

function openCustomerForm(customer = blankCustomer, onSaved) {
  const editing = !!customer.id;
  const modal = openModal({
    title: editing ? `编辑客户 · ${customer.name}` : '新增客户',
    body: customerFormBody(customer, customer.contacts || []),
    submitText: editing ? '保存修改' : '创建客户',
    wide: true,
    onSubmit: (data) => {
      const contacts = collectContacts(modal.form).map((c) => ({ ...c, isPrimary: !!c.isPrimary }));
      const payload = { ...data, contacts };
      if (editing) {
        store.updateCustomer(customer.id, payload);
        toast('客户已更新', 'success');
      } else {
        const created = store.createCustomer(payload);
        toast('客户已创建', 'success');
        if (onSaved) onSaved(created);
      }
      if (onSaved) onSaved(editing ? store.findCustomer(customer.id) : null);
    },
  });

  const list = qs('[data-contact-list]', modal.root);
  const addBtn = qs('[data-add-contact]', modal.root);
  if (addBtn) addBtn.addEventListener('click', () => {
    const hint = qs('.hint', list);
    if (hint) hint.remove();
    list.appendChild(htmlToNode(contactRow()));
  });
  on(list, 'click', '[data-remove-contact]', (event, target) => {
    target.closest('[data-contact]').remove();
    if (!qs('[data-contact]', list)) {
      list.innerHTML = '<p class="hint">暂无联系人，可点击「添加联系人」。</p>';
    }
  });
}

function htmlToNode(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

/* ------------------------------------------------------------------- list */

function filtered(query) {
  const kw = (query.q || '').trim().toLowerCase();
  const status = query.status || '';
  const level = query.level || '';
  const source = query.source || '';
  const sort = query.sort || 'updatedAt';
  let rows = store.customers().filter((c) => {
    if (status && c.status !== status) return false;
    if (level && c.level !== level) return false;
    if (source && c.source !== source) return false;
    if (!kw) return true;
    return [c.name, c.industry, c.owner, c.phone, c.email, c.address,
      ...(c.contacts || []).map((ct) => `${ct.name}${ct.phone}${ct.email}`)]
      .join(' ').toLowerCase().includes(kw);
  });
  rows = rows.slice().sort((a, b) => {
    if (sort === 'name') return a.name.localeCompare(b.name, 'zh-CN');
    if (sort === 'createdAt') return String(b.createdAt).localeCompare(String(a.createdAt));
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return rows;
}

function filtersHtml(query) {
  const options = (list, current, allLabel) =>
    [`<option value="">${esc(allLabel)}</option>`]
      .concat(list.map((v) => `<option value="${attr(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`))
      .join('');
  return `<form class="toolbar" data-filter-form>
      <input class="toolbar__search" type="search" name="q" value="${attr(query.q || '')}" placeholder="搜索客户名称 / 行业 / 联系人 / 电话">
      <select name="status">${options(store.CUSTOMER_STATUS, query.status, '全部状态')}</select>
      <select name="level">${options(store.CUSTOMER_LEVELS, query.level, '全部等级')}</select>
      <select name="source">${options(store.CUSTOMER_SOURCES, query.source, '全部来源')}</select>
      <select name="sort">${[['updatedAt', '最近更新'], ['createdAt', '创建时间'], ['name', '名称排序']]
        .map(([v, l]) => `<option value="${v}" ${v === (query.sort || 'updatedAt') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="submit" class="btn btn--primary">筛选</button>
      <a class="btn btn--ghost" href="#/customers">重置</a>
    </form>`;
}

export function render(ctx) {
  const query = ctx.query || {};
  const rows = filtered(query);
  const page = paginate(rows, query.page, PAGE_SIZE);
  const activeFilters = ['q', 'status', 'level', 'source'].filter((k) => query[k]);

  const body = `
    ${filtersHtml(query)}
    ${activeFilters.length ? `<p class="filter-note">已启用筛选：${activeFilters.map((k) => esc(`${k}=${query[k]}`)).join('，')}（共 ${rows.length} 条结果）</p>` : ''}
    <section class="card card--flush">
      ${page.slice.length ? `<ul class="row-list">${page.slice.map((c) => dataRow({
        title: c.name,
        href: `#/customers/${c.id}`,
        badgeHtml: badge(c.status),
        subtitle: `${c.industry || '未填写行业'} · 联系人 ${(c.contacts || []).length} 人${c.owner ? ` · 负责人 ${c.owner}` : ''}`,
        meta: [
          { label: '等级', value: c.level },
          { label: '电话', value: c.phone || '—' },
          { label: '来源', value: c.source },
          { label: '更新', value: store.formatDate(c.updatedAt) },
        ],
        actions: [
          btn('详情', { href: `#/customers/${c.id}` }),
          btn('编辑', { attrs: `data-edit-customer="${attr(c.id)}"` }),
          btn('删除', { variant: 'danger', attrs: `data-del-customer="${attr(c.id)}"` }),
        ],
      })).join('')}</ul>
      ${pager({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })}`
      : emptyState(store.customers().length ? '没有符合条件的客户，试试调整筛选条件。' : '还没有客户，点击右上角「新增客户」开始。')}
    </section>`;

  renderView({
    title: '客户管理',
    subtitle: `共 ${store.customers().length} 位客户，按条件筛选后 ${rows.length} 条`,
    actions: `<a class="btn btn--primary" href="#/customers/new">+ 新增客户</a>`,
    body,
  });

  const main = qs('#view');

  const filterForm = qs('[data-filter-form]', main);
  if (filterForm) {
    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(filterForm).entries());
      store.saveSettings({});
      location.hash = `#/customers?${new URLSearchParams({ ...data, page: '1' }).toString()}`;
    });
    on(filterForm, 'change', 'select', () => filterForm.requestSubmit());
    let timer = null;
    const search = qs('input[name="q"]', filterForm);
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => filterForm.requestSubmit(), 300);
    });
  }

  on(main, 'click', '[data-page]', (event, target) => {
    const next = { ...query, page: target.dataset.page };
    location.hash = `#/customers?${new URLSearchParams(next).toString()}`;
  });
  on(main, 'click', '[data-del-customer]', async (event, target) => {
    const customer = store.findCustomer(target.dataset.delCustomer);
    if (!customer) return;
    const ok = await confirmDialog({
      title: '删除客户',
      message: `确定删除客户「${customer.name}」？其关联的跟进记录会一并删除，关联商机将解除客户关联。`,
      submitText: '删除',
    });
    if (!ok) return;
    store.deleteCustomer(customer.id);
    toast('客户已删除', 'success');
    render(ctx);
  });
  on(main, 'click', '[data-edit-customer]', (event, target) => {
    const customer = store.findCustomer(target.dataset.editCustomer);
    if (customer) openCustomerForm(customer, () => render(ctx));
  });
}

/* ------------------------------------------------------------------ detail */

export function renderDetail(ctx) {
  const customer = store.findCustomer(ctx.params.id);
  if (!customer) {
    renderView({ title: '客户不存在', body: emptyState('该客户可能已被删除。', '<a class="btn btn--primary" href="#/customers">返回客户列表</a>') });
    return;
  }
  const deals = store.deals().filter((d) => d.customerId === customer.id);
  const records = store.listFollowups('customer', customer.id);
  const contacts = customer.contacts || [];

  const body = `
    <div class="detail-actions">
      <button type="button" class="btn btn--primary" data-edit-customer="${attr(customer.id)}">编辑客户</button>
      <button type="button" class="btn btn--danger" data-del-customer="${attr(customer.id)}">删除客户</button>
      <a class="btn btn--ghost" href="#/customers">返回列表</a>
    </div>
    <div class="grid grid--7-5">
      <section class="card">
        <header class="card__head"><h2 class="card__title">基本信息</h2>${badge(customer.status)}</header>
        <dl class="dl">
          <div><dt>客户名称</dt><dd>${esc(customer.name)}</dd></div>
          <div><dt>所属行业</dt><dd>${esc(customer.industry || '—')}</dd></div>
          <div><dt>客户等级</dt><dd>${badge(customer.level)}</dd></div>
          <div><dt>客户来源</dt><dd>${esc(customer.source)}</dd></div>
          <div><dt>联系电话</dt><dd>${esc(customer.phone || '—')}</dd></div>
          <div><dt>邮箱</dt><dd>${esc(customer.email || '—')}</dd></div>
          <div><dt>官网</dt><dd>${customer.website ? esc(customer.website) : '—'}</dd></div>
          <div><dt>地址</dt><dd>${esc(customer.address || '—')}</dd></div>
          <div><dt>负责人</dt><dd>${esc(customer.owner || '—')}</dd></div>
          <div><dt>创建时间</dt><dd>${esc(store.formatDateTime(customer.createdAt))}</dd></div>
          <div><dt>最近更新</dt><dd>${esc(store.formatDateTime(customer.updatedAt))}</dd></div>
        </dl>
        ${customer.note ? `<p class="detail-note">${esc(customer.note)}</p>` : ''}
      </section>
      <div class="stack">
        <section class="card">
          <header class="card__head"><h2 class="card__title">联系人 <span class="count">${contacts.length}</span></h2></header>
          ${contacts.length ? `<ul class="contact-list contact-list--read">${contacts.map((c) => `
            <li>
              <div class="contact__name">${esc(c.name)} ${badge(c.role)} ${c.isPrimary ? '<span class="tag">主要</span>' : ''}</div>
              <p>${esc(c.phone || '未填电话')} · ${esc(c.email || '未填邮箱')}${c.wechat ? ` · 微信 ${esc(c.wechat)}` : ''}</p>
            </li>`).join('')}</ul>` : '<p class="chart__empty">暂无联系人。</p>'}
        </section>
        <section class="card">
          <header class="card__head"><h2 class="card__title">关联商机 <span class="count">${deals.length}</span></h2>
            <a class="link" href="#/deals/new?customerId=${attr(customer.id)}">+ 新建商机</a></header>
          ${deals.length ? `<ul class="mini-list">${deals.map((d) => `
            <li>
              <div class="mini-list__head">
                <a class="link" href="#/deals/${attr(d.id)}">${esc(d.title)}</a>${badge(d.stage)}
              </div>
              <p>${esc(store.formatMoney(d.amount))} · 预计成交 ${esc(store.formatDate(d.expectedCloseDate))}</p>
            </li>`).join('')}</ul>` : '<p class="chart__empty">暂无关联商机。</p>'}
        </section>
      </div>
    </div>
    ${followupSection('customer', customer.id, records)}`;

  renderView({
    title: customer.name,
    subtitle: `${customer.industry || '未填写行业'} · 负责人 ${customer.owner || '—'} · 创建于 ${store.formatDate(customer.createdAt)}`,
    body,
  });

  bindDetail(main(), ctx, customer.id);
}

const main = () => qs('#view');

function bindDetail(root, ctx, customerId) {
  on(root, 'click', '[data-edit-customer]', () => {
    const customer = store.findCustomer(customerId);
    if (customer) openCustomerForm(customer, () => renderDetail(ctx));
  });
  on(root, 'click', '[data-del-customer]', async () => {
    const customer = store.findCustomer(customerId);
    if (!customer) return;
    const ok = await confirmDialog({
      title: '删除客户',
      message: `确定删除客户「${customer.name}」？关联跟进记录会一并删除。`,
      submitText: '删除',
    });
    if (!ok) return;
    store.deleteCustomer(customerId);
    toast('客户已删除', 'success');
    location.hash = '#/customers';
  });
  bindFollowupForm(root, 'customer', customerId, () => renderDetail(ctx));
}

/** 供客户/线索/商机详情页共用的跟进记录表单绑定。 */
export function bindFollowupForm(root, targetType, targetId, refresh) {
  const form = qs('[data-followup-form]', root);
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      if (!String(data.content || '').trim()) { toast('请填写跟进内容', 'warn'); return; }
      const at = data.at ? new Date(`${data.at}T09:00:00`).toISOString() : new Date().toISOString();
      store.addFollowup({ targetType, targetId, content: data.content, operator: data.operator, at });
      if (data.operator) store.saveSettings({ operator: data.operator });
      toast('跟进记录已添加', 'success');
      refresh();
    });
  }
  on(root, 'click', '[data-del-followup]', async (event, target) => {
    const ok = await confirmDialog({ title: '删除跟进记录', message: '确定删除这条跟进记录吗？', submitText: '删除' });
    if (!ok) return;
    store.deleteFollowup(target.dataset.delFollowup);
    toast('跟进记录已删除', 'success');
    refresh();
  });
}

export function renderNew(ctx) {
  renderView({
    title: '新增客户',
    subtitle: '填写客户基本信息后可继续补充联系人与商机',
    body: '<section class="card"><p class="chart__empty">正在打开表单…</p></section>',
  });
  openCustomerForm(blankCustomer, (created) => {
    if (created) location.hash = `#/customers/${created.id}`;
    else location.hash = '#/customers';
  });
}

export { openCustomerForm };
export default { render, renderDetail, renderNew, meta };
