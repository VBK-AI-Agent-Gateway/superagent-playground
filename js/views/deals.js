/**
 * views/deals.js — 商机管理：列表、阶段看板（可切换阶段）、新建/编辑、详情、删除。
 */
import * as store from '../store.js';
import {
  esc, attr, badge, btn, renderView, qs, qsa, on, openModal, confirmDialog, toast,
  field, formGrid, paginate, pager, emptyState, dataRow, followupSection,
} from '../ui.js';
import { bindFollowupForm } from './customers.js';

export const meta = { title: '商机管理', path: '/deals' };

const PAGE_SIZE = 8;
const blankDeal = {
  id: '', title: '', customerId: '', leadId: '', amount: '', stage: '初步接洽',
  expectedCloseDate: '', owner: '', note: '',
};

function customerOptions(selected) {
  return [{ value: '', label: '未关联客户' }].concat(
    store.customers().map((c) => ({ value: c.id, label: c.name })),
  ).map((o) => `<option value="${attr(o.value)}" ${o.value === (selected || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
}

function leadOptions(selected) {
  return [{ value: '', label: '未关联线索' }].concat(
    store.leads().filter((l) => l.status !== '已转化').map((l) => ({ value: l.id, label: `${l.name}${l.company ? ` · ${l.company}` : ''}` })),
  ).map((o) => `<option value="${attr(o.value)}" ${o.value === (selected || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
}

function dealFormBody(deal = blankDeal) {
  return formGrid([
    field({ label: '商机名称', name: 'title', value: deal.title, required: true, placeholder: '如：XX 公司年度授权' }),
    { html: `<div class="field"><label class="field__label" for="f_customerId">关联客户</label>
        <select id="f_customerId" name="customerId">${customerOptions(deal.customerId)}</select></div>` }.html,
    { html: `<div class="field"><label class="field__label" for="f_leadId">关联线索</label>
        <select id="f_leadId" name="leadId">${leadOptions(deal.leadId)}</select></div>` }.html,
    field({ label: '金额（元）', name: 'amount', type: 'number', value: deal.amount, min: 0, step: '0.01', placeholder: '0' }),
    field({ label: '阶段', name: 'stage', type: 'select', value: deal.stage, options: store.DEAL_STAGES }),
    field({ label: '预计成交日期', name: 'expectedCloseDate', type: 'date', value: deal.expectedCloseDate }),
    field({ label: '负责人', name: 'owner', value: deal.owner, placeholder: '销售负责人' }),
  ]) + `<div class="form-grid cols-1">${field({
    label: '备注', name: 'note', type: 'textarea', value: deal.note, rows: 3, placeholder: '客户诉求、竞争情况、下一步动作等',
  })}</div>`;
}

export function openDealForm(deal = blankDeal, onSaved) {
  const editing = !!deal.id;
  const modal = openModal({
    title: editing ? `编辑商机 · ${deal.title}` : '新增商机',
    body: dealFormBody(deal),
    submitText: editing ? '保存修改' : '创建商机',
    wide: true,
    onSubmit: (data) => {
      if (editing) {
        store.updateDeal(deal.id, data);
        toast('商机已更新', 'success');
        if (onSaved) onSaved(null);
      } else {
        const created = store.createDeal(data);
        toast('商机已创建', 'success');
        if (onSaved) onSaved(created);
      }
    },
  });
  return modal;
}

/* ------------------------------------------------------------------- view */

function filtered(query) {
  const kw = (query.q || '').trim().toLowerCase();
  const stage = query.stage || '';
  const sort = query.sort || 'expectedCloseDate';
  const rows = store.deals().filter((d) => {
    if (stage && d.stage !== stage) return false;
    if (!kw) return true;
    const customer = d.customerId ? store.findCustomer(d.customerId) : null;
    const lead = d.leadId ? store.findLead(d.leadId) : null;
    return [d.title, d.owner, d.note, customer ? customer.name : '', lead ? lead.name : '']
      .join(' ').toLowerCase().includes(kw);
  });
  return rows.slice().sort((a, b) => {
    if (sort === 'amount') return b.amount - a.amount;
    if (sort === 'createdAt') return String(b.createdAt).localeCompare(String(a.createdAt));
    return String(a.expectedCloseDate || '9999-12-31').localeCompare(String(b.expectedCloseDate || '9999-12-31'));
  });
}

function dealActions(deal, { withStageButton = true } = {}) {
  const idx = store.DEAL_STAGES.indexOf(deal.stage);
  const prev = idx > 0 ? store.DEAL_STAGES[idx - 1] : null;
  const next = idx >= 0 && idx < store.DEAL_STAGES.length - 1 ? store.DEAL_STAGES[idx + 1] : null;
  return [
    btn('详情', { href: `#/deals/${deal.id}` }),
    withStageButton && prev ? btn(`← ${prev}`, { attrs: `data-move="${attr(deal.id)}" data-stage="${attr(prev)}"` }) : '',
    withStageButton && next ? btn(`${next} →`, { variant: 'primary', attrs: `data-move="${attr(deal.id)}" data-stage="${attr(next)}"` }) : '',
    btn('编辑', { attrs: `data-edit-deal="${attr(deal.id)}"` }),
    btn('删除', { variant: 'danger', attrs: `data-del-deal="${attr(deal.id)}"` }),
  ].filter(Boolean).join('');
}

export function render(ctx) {
  const query = ctx.query || {};
  const view = query.view === 'list' ? 'list' : 'board';
  const rows = filtered(query);
  const stageCounts = store.dealStageCounts();
  const m = store.metrics();
  const page = paginate(rows, query.page, PAGE_SIZE);

  const toolbarHtml = `<form class="toolbar" data-filter-form>
      <input class="toolbar__search" type="search" name="q" value="${attr(query.q || '')}" placeholder="搜索商机 / 客户 / 负责人">
      <select name="stage">${['<option value="">全部阶段</option>'].concat(store.DEAL_STAGES.map((s) =>
        `<option value="${attr(s)}" ${s === query.stage ? 'selected' : ''}>${esc(s)}</option>`)).join('')}</select>
      <select name="sort">${[['expectedCloseDate', '按预计成交'], ['amount', '按金额'], ['createdAt', '最新创建']]
        .map(([v, l]) => `<option value="${v}" ${v === (query.sort || 'expectedCloseDate') ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="hidden" name="view" value="${attr(view)}">
      <button type="submit" class="btn btn--primary">筛选</button>
      <a class="btn btn--ghost" href="#/deals?view=${attr(view)}">重置</a>
      <span class="toolbar__spacer"></span>
      <span class="seg">
        <a class="seg__item ${view === 'board' ? 'is-active' : ''}" href="#/deals?view=board">看板</a>
        <a class="seg__item ${view === 'list' ? 'is-active' : ''}" href="#/deals?view=list">列表</a>
      </span>
    </form>`;

  const summaryHtml = `<ul class="chips">
      <li class="chip"><span>进行中商机</span><b>${m.dealOpen}</b></li>
      <li class="chip"><span>预测金额</span><b>${esc(store.formatMoneyShort(m.pipelineAmount))}</b></li>
      <li class="chip"><span>赢单金额</span><b>${esc(store.formatMoneyShort(m.wonAmount))}</b></li>
      <li class="chip"><span>赢单 / 输单</span><b>${m.wonCount} / ${m.lostCount}</b></li>
    </ul>`;

  renderView({
    title: '商机管理',
    subtitle: `共 ${store.deals().length} 个商机 · 阶段：${store.DEAL_STAGES.join(' / ')}`,
    actions: `<a class="btn btn--primary" href="#/deals/new">+ 新增商机</a>`,
    body: summaryHtml + toolbarHtml + (view === 'board' ? boardHtml(rows) : listHtml(page, query, view)),
  });

  bindDeals(qs('#view'), ctx);
}

function boardHtml(rows) {
  const grouped = store.DEAL_STAGES.reduce((acc, s) => { acc[s] = []; return acc; }, {});
  rows.forEach((d) => { if (grouped[d.stage]) grouped[d.stage].push(d); });
  const cards = store.DEAL_STAGES.map((stage, index) => {
    const list = grouped[stage];
    const amount = list.reduce((sum, d) => sum + d.amount, 0);
    return `<section class="kanban-col kanban-col--${index}">
        <header class="kanban-col__head">
          <h3>${esc(stage)} <span class="count">${list.length}</span></h3>
          <span class="kanban-col__amount">${esc(store.formatMoneyShort(amount))}</span>
        </header>
        <div class="kanban-col__body">
          ${list.length ? list.map((d) => kanbanCard(d)).join('') : '<p class="kanban-empty">暂无商机</p>'}
        </div>
      </section>`;
  }).join('');
  return `<div class="kanban">${cards}</div>`;
}

function kanbanCard(deal) {
  const customer = deal.customerId ? store.findCustomer(deal.customerId) : null;
  const lead = deal.leadId ? store.findLead(deal.leadId) : null;
  const idx = store.DEAL_STAGES.indexOf(deal.stage);
  const prev = idx > 0 ? store.DEAL_STAGES[idx - 1] : null;
  const next = idx < store.DEAL_STAGES.length - 1 ? store.DEAL_STAGES[idx + 1] : null;
  const owner = customer ? customer.name : (lead ? `${lead.name}（线索）` : '未关联客户');
  return `<article class="kanban-card" data-deal-card="${attr(deal.id)}">
      <div class="kanban-card__head">
        <a class="kanban-card__title" href="#/deals/${attr(deal.id)}">${esc(deal.title)}</a>
        ${badge(deal.stage)}
      </div>
      <p class="kanban-card__customer">${esc(owner)}</p>
      <p class="kanban-card__amount">${esc(store.formatMoney(deal.amount))}</p>
      <p class="kanban-card__date">预计成交：${esc(store.formatDate(deal.expectedCloseDate))}</p>
      <div class="kanban-card__actions">
        ${prev ? `<button type="button" class="btn btn--ghost btn--sm" data-move="${attr(deal.id)}" data-stage="${attr(prev)}">← ${esc(prev)}</button>` : ''}
        ${next ? `<button type="button" class="btn btn--primary btn--sm" data-move="${attr(deal.id)}" data-stage="${attr(next)}">${esc(next)} →</button>` : ''}
        <button type="button" class="icon-btn" data-edit-deal="${attr(deal.id)}" aria-label="编辑">✎</button>
        <button type="button" class="icon-btn icon-btn--danger" data-del-deal="${attr(deal.id)}" aria-label="删除">×</button>
      </div>
    </article>`;
}

function listHtml(page, query, view) {
  if (!page.slice.length) {
    return `<section class="card">${emptyState(store.deals().length ? '没有符合条件的商机。' : '还没有商机，点击右上角「新增商机」创建。')}</section>`;
  }
  return `<section class="card card--flush">
      <ul class="row-list">${page.slice.map((d) => {
        const customer = d.customerId ? store.findCustomer(d.customerId) : null;
        const lead = d.leadId ? store.findLead(d.leadId) : null;
        return dataRow({
          title: d.title,
          href: `#/deals/${d.id}`,
          badgeHtml: badge(d.stage),
          subtitle: `${customer ? customer.name : (lead ? `${lead.name}（线索）` : '未关联客户')}${d.owner ? ` · 负责人 ${d.owner}` : ''}`,
          meta: [
            { label: '金额', value: store.formatMoney(d.amount) },
            { label: '预计成交', value: store.formatDate(d.expectedCloseDate) },
            { label: '更新', value: store.formatDate(d.updatedAt) },
          ],
          actions: dealActions(d, { withStageButton: false }).split('</a>').length ? [
            btn('详情', { href: `#/deals/${d.id}` }),
            btn('编辑', { attrs: `data-edit-deal="${attr(d.id)}"` }),
            btn('删除', { variant: 'danger', attrs: `data-del-deal="${attr(d.id)}"` }),
          ] : [],
        });
      }).join('')}</ul>
      ${pager({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })}
    </section>`;
}

function bindDeals(root, ctx) {
  const query = ctx.query || {};
  const filterForm = qs('[data-filter-form]', root);
  if (filterForm) {
    filterForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = Object.fromEntries(new FormData(filterForm).entries());
      location.hash = `#/deals?${new URLSearchParams({ ...data, page: '1' }).toString()}`;
    });
    on(filterForm, 'change', 'select', () => filterForm.requestSubmit());
  }

  on(root, 'click', '[data-move]', (event, target) => {
    const deal = store.findDeal(target.dataset.move);
    if (!deal) return;
    store.moveDealStage(deal.id, target.dataset.stage);
    toast(`「${deal.title}」已移动到「${target.dataset.stage}」`, 'success');
    render(ctx);
  });
  on(root, 'click', '[data-edit-deal]', (event, target) => {
    const deal = store.findDeal(target.dataset.editDeal);
    if (deal) openDealForm(deal, () => render(ctx));
  });
  on(root, 'click', '[data-del-deal]', async (event, target) => {
    const deal = store.findDeal(target.dataset.delDeal);
    if (!deal) return;
    const ok = await confirmDialog({
      title: '删除商机',
      message: `确定删除商机「${deal.title}」？其跟进记录会一并删除。`,
      submitText: '删除',
    });
    if (!ok) return;
    store.deleteDeal(deal.id);
    toast('商机已删除', 'success');
    render(ctx);
  });
  on(root, 'click', '[data-page]', (event, target) => {
    location.hash = `#/deals?${new URLSearchParams({ ...query, page: target.dataset.page }).toString()}`;
  });
}

/* ------------------------------------------------------------------ detail */

export function renderDetail(ctx) {
  const deal = store.findDeal(ctx.params.id);
  if (!deal) {
    renderView({ title: '商机不存在', body: emptyState('该商机可能已被删除。', '<a class="btn btn--primary" href="#/deals">返回商机看板</a>') });
    return;
  }
  const customer = deal.customerId ? store.findCustomer(deal.customerId) : null;
  const lead = deal.leadId ? store.findLead(deal.leadId) : null;
  const records = store.listFollowups('deal', deal.id);

  const body = `
    <div class="detail-actions">
      ${store.DEAL_STAGES.filter((s) => s !== deal.stage).map((s) =>
        btn(`切换为「${s}」`, { attrs: `data-move="${attr(deal.id)}" data-stage="${attr(s)}"`, variant: s === store.WON_STAGE ? 'primary' : 'ghost' })).join('')}
      ${btn('编辑商机', { attrs: `data-edit-deal="${attr(deal.id)}"` })}
      ${btn('删除商机', { variant: 'danger', attrs: `data-del-deal="${attr(deal.id)}"` })}
      <a class="btn btn--ghost" href="#/deals">返回看板</a>
    </div>
    <div class="grid grid--7-5">
      <section class="card">
        <header class="card__head"><h2 class="card__title">商机信息</h2>${badge(deal.stage)}</header>
        <dl class="dl">
          <div><dt>商机名称</dt><dd>${esc(deal.title)}</dd></div>
          <div><dt>金额</dt><dd>${esc(store.formatMoney(deal.amount))}</dd></div>
          <div><dt>当前阶段</dt><dd>${badge(deal.stage)}</dd></div>
          <div><dt>预计成交</dt><dd>${esc(store.formatDate(deal.expectedCloseDate))}</dd></div>
          <div><dt>关联客户</dt><dd>${customer ? `<a class="link" href="#/customers/${attr(customer.id)}">${esc(customer.name)}</a>` : '—'}</dd></div>
          <div><dt>关联线索</dt><dd>${lead ? `<a class="link" href="#/leads/${attr(lead.id)}">${esc(lead.name)}</a>` : '—'}</dd></div>
          <div><dt>负责人</dt><dd>${esc(deal.owner || '—')}</dd></div>
          <div><dt>创建时间</dt><dd>${esc(store.formatDateTime(deal.createdAt))}</dd></div>
          <div><dt>最近更新</dt><dd>${esc(store.formatDateTime(deal.updatedAt))}</dd></div>
        </dl>
        ${deal.note ? `<p class="detail-note">${esc(deal.note)}</p>` : ''}
      </section>
      <section class="card">
        <header class="card__head"><h2 class="card__title">阶段进度</h2></header>
        <ol class="flow flow--vertical">${store.DEAL_STAGES.map((s) => {
          const idx = store.DEAL_STAGES.indexOf(s);
          const current = store.DEAL_STAGES.indexOf(deal.stage);
          const cls = s === deal.stage ? 'is-active' : (idx < current ? 'is-done' : '');
          return `<li class="${cls}">${esc(s)}</li>`;
        }).join('')}</ol>
      </section>
    </div>
    ${followupSection('deal', deal.id, records)}`;

  renderView({
    title: deal.title,
    subtitle: `${customer ? customer.name : '未关联客户'} · ${store.formatMoney(deal.amount)} · 当前阶段 ${deal.stage}`,
    body,
  });

  const root = qs('#view');
  on(root, 'click', '[data-move]', (event, target) => {
    store.moveDealStage(target.dataset.move, target.dataset.stage);
    toast(`阶段已切换为「${target.dataset.stage}」`, 'success');
    renderDetail(ctx);
  });
  on(root, 'click', '[data-edit-deal]', () => {
    openDealForm(store.findDeal(deal.id), () => renderDetail(ctx));
  });
  on(root, 'click', '[data-del-deal]', async () => {
    const ok = await confirmDialog({
      title: '删除商机',
      message: `确定删除商机「${deal.title}」？其跟进记录会一并删除。`,
      submitText: '删除',
    });
    if (!ok) return;
    store.deleteDeal(deal.id);
    toast('商机已删除', 'success');
    location.hash = '#/deals';
  });
  bindFollowupForm(root, 'deal', deal.id, () => renderDetail(ctx));
}

export function renderNew(ctx) {
  renderView({ title: '新增商机', body: '<section class="card"><p class="chart__empty">正在打开表单…</p></section>' });
  const preset = { ...blankDeal, customerId: (ctx && ctx.query && ctx.query.customerId) || '' };
  openDealForm(preset, (created) => {
    location.hash = created ? `#/deals/${created.id}` : '#/deals';
  });
}

export default { render, renderDetail, renderNew, openDealForm, meta };
