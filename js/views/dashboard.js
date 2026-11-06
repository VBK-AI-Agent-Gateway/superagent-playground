/**
 * views/dashboard.js — 仪表盘：关键指标卡片、线索/商机分布图、最近跟进。
 */
import * as store from '../store.js';
import { esc, statCard, barChart, lineChart, donutChart, emptyState, renderView, badge, h, qs } from '../ui.js';

export const meta = { title: '仪表盘', path: '/dashboard' };

function monthPoints(count = 6) {
  const now = new Date();
  const points = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const customers = store.customers().filter((c) => String(c.createdAt).slice(0, 7) === key).length;
    const leads = store.leads().filter((l) => String(l.createdAt).slice(0, 7) === key).length;
    points.push({ key, label: `${d.getMonth() + 1}月`, customers, leads, value: customers + leads });
  }
  return points;
}

function metricsHtml(m) {
  return `<div class="stats">
      ${statCard({ label: '客户总数', value: m.customerTotal, sub: `本月新增 ${m.customersNewThisMonth}`, tone: 'primary' })}
      ${statCard({ label: '线索总数', value: m.leadTotal, sub: `跟进中 ${m.leadsActive} · 本月新增 ${m.leadsNewThisMonth}` })}
      ${statCard({ label: '本月新增', value: m.customersNewThisMonth + m.leadsNewThisMonth, sub: `客户 ${m.customersNewThisMonth} · 线索 ${m.leadsNewThisMonth}`, tone: 'accent' })}
      ${statCard({ label: '成交金额', value: store.formatMoneyShort(m.wonAmount), sub: `赢单 ${m.wonCount} 个 · 输单 ${m.lostCount} 个`, tone: 'success' })}
      ${statCard({ label: '进行中商机', value: m.dealOpen, sub: `预测金额 ${store.formatMoneyShort(m.pipelineAmount)}` })}
      ${statCard({ label: '跟进记录', value: m.followupTotal, sub: '累计记录条数' })}
    </div>`;
}

function chartsHtml() {
  const stage = store.dealStageCounts();
  const stageData = store.DEAL_STAGES.map((s) => ({
    label: s,
    value: stage[s] ? stage[s].amount : 0,
    display: store.formatMoneyShort(stage[s] ? stage[s].amount : 0),
  }));
  const status = store.leadStatusCounts();
  const statusData = store.LEAD_STATUS.map((s) => ({ label: s, value: status[s] || 0, display: `${status[s] || 0} 条` }));
  const points = monthPoints(6);
  return `<div class="grid grid--5-7">
      <section class="card">
        <header class="card__head"><h2 class="card__title">线索状态分布</h2></header>
        ${barChart(statusData, { emptyText: '暂无线索数据' })}
      </section>
      <section class="card">
        <header class="card__head"><h2 class="card__title">近 6 个月新增（客户 + 线索）</h2></header>
        ${lineChart(points.map((p) => ({ label: p.label, value: p.value })))}
        <ul class="legend-inline">
          ${points.map((p) => `<li>${esc(p.label)}：客户 ${p.customers} · 线索 ${p.leads}</li>`).join('')}
        </ul>
      </section>
      <section class="card">
        <header class="card__head"><h2 class="card__title">商机阶段金额</h2></header>
        ${barChart(stageData, { emptyText: '暂无商机数据' })}
      </section>
      <section class="card">
        <header class="card__head"><h2 class="card__title">线索漏斗占比</h2></header>
        ${donutChart(statusData.map((s) => ({ label: s.label, value: s.value })), { size: 160 })}
      </section>
    </div>`;
}

function recentHtml() {
  const records = store.followups()
    .slice()
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, 6);
  if (!records.length) {
    return `<section class="card"><header class="card__head"><h2 class="card__title">最近跟进</h2></header>
      ${emptyState('还没有跟进记录，可在客户/线索/商机详情页添加。')}</section>`;
  }
  return `<section class="card">
      <header class="card__head"><h2 class="card__title">最近跟进</h2>
        <a class="link" href="#/followups">查看全部</a></header>
      <ul class="mini-list">${records.map((f) => {
        const target = store.targetOf(f);
        return `<li>
            <div class="mini-list__head">
              <a class="link" href="${esc(target.url)}">${esc(target.name)}</a>
              ${badge(target.typeLabel)}
              <time>${esc(store.formatDateTime(f.at))}</time>
            </div>
            <p>${esc(f.content)}</p>
            <p class="mini-list__by">操作人：${esc(f.operator)}</p>
          </li>`;
      }).join('')}</ul>
    </section>`;
}

function upcomingHtml() {
  const soon = store.deals()
    .filter((d) => d.stage !== store.WON_STAGE && d.stage !== store.LOST_STAGE)
    .sort((a, b) => String(a.expectedCloseDate || '9999').localeCompare(String(b.expectedCloseDate || '9999')))
    .slice(0, 5);
  if (!soon.length) {
    return `<section class="card"><header class="card__head"><h2 class="card__title">近期预计成交</h2></header>
      ${emptyState('暂无进行中的商机。')}</section>`;
  }
  return `<section class="card">
      <header class="card__head"><h2 class="card__title">近期预计成交</h2>
        <a class="link" href="#/deals">前往看板</a></header>
      <ul class="mini-list">${soon.map((d) => {
        const customer = d.customerId ? store.findCustomer(d.customerId) : null;
        return `<li>
            <div class="mini-list__head">
              <a class="link" href="#/deals/${esc(d.id)}">${esc(d.title)}</a>
              ${badge(d.stage)}
              <time>${esc(store.formatDate(d.expectedCloseDate))}</time>
            </div>
            <p>${esc(customer ? customer.name : '未关联客户')} · ${esc(store.formatMoney(d.amount))}</p>
          </li>`;
      }).join('')}</ul>
    </section>`;
}

export function render(ctx = {}) {
  const m = store.metrics();
  const now = new Date();
  renderView({
    title: '仪表盘',
    subtitle: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 · 数据实时汇总自本地存储`,
    actions: `<a class="btn btn--primary" href="#/customers/new">+ 新增客户</a>
      <button type="button" class="btn" data-action="seed">载入示例数据</button>`,
    body: metricsHtml(m) + chartsHtml()
      + `<div class="grid grid--6-6">${recentHtml()}${upcomingHtml()}</div>`,
  });

  const main = qs('#view');
  const seedBtn = main && main.querySelector('[data-action="seed"]');
  if (seedBtn) seedBtn.addEventListener('click', async () => {
    const { confirmDialog, toast } = await import('../ui.js');
    const ok = await confirmDialog({
      title: '载入示例数据',
      message: '将向当前数据集中追加一组演示用客户、线索、商机与跟进记录，不会删除已有数据。继续吗？',
      submitText: '载入示例',
      danger: false,
    });
    if (!ok) return;
    const { seedDemoData } = await import('../seed.js');
    const added = seedDemoData();
    toast(`已载入示例数据（客户 ${added.customers} · 线索 ${added.leads} · 商机 ${added.deals}）`, 'success');
    render(ctx);
  });

  return h(`<span data-view="dashboard"></span>`);
}

export default { render, meta };
