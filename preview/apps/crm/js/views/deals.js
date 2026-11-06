/**
 * deals.js — 商机看板视图
 * 六个阶段列（初步接触 / 需求确认 / 报价 / 谈判 / 赢单 / 输单），
 * 每张卡片可用「推进 / 回退」按钮切换阶段，也支持拖拽投放到目标列。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatAmount, formatDate, matchesKeyword } from "../utils/helpers.js";
import { DEAL_STAGES, CLOSED_STAGES, stageOf } from "../utils/constants.js";
import { pageHead, card, emptyState, stageBadge } from "./ui.js";

/** 看板筛选状态（视图层本地状态）。 */
export const dealsQuery = {
  keyword: "",
  owner: "",
  customerId: "",
};

/** 当前筛选后的商机。 */
export function selectDeals() {
  return store.state.deals.filter((deal) => {
    if (dealsQuery.owner && deal.owner !== dealsQuery.owner) return false;
    if (dealsQuery.customerId && deal.customerId !== dealsQuery.customerId) return false;
    if (!dealsQuery.keyword) return true;
    return matchesKeyword(
      [deal.title, deal.note, deal.owner, store.customerNameOfDeal(deal)],
      dealsQuery.keyword
    );
  });
}

/** 工具栏：搜索、负责人筛选、客户筛选。 */
function toolbar(rows) {
  const owners = Array.from(new Set(store.state.deals.map((deal) => deal.owner).filter(Boolean))).sort();
  const customers = store.state.customers;
  return `
    <div class="toolbar">
      <div class="toolbar__field toolbar__field--grow">
        <input class="input" type="search" data-filter="deal-keyword" value="${escapeHtml(dealsQuery.keyword)}" placeholder="搜索商机名称、客户或备注" aria-label="搜索商机" />
      </div>
      <div class="toolbar__field">
        <select class="select" data-filter="deal-owner" aria-label="按负责人筛选">
          <option value="">全部负责人</option>
          ${owners.map((owner) => `<option value="${escapeHtml(owner)}"${dealsQuery.owner === owner ? " selected" : ""}>${escapeHtml(owner)}</option>`).join("")}
        </select>
      </div>
      <div class="toolbar__field">
        <select class="select" data-filter="deal-customer" aria-label="按客户筛选">
          <option value="">全部客户</option>
          ${customers.map((item) => `<option value="${item.id}"${dealsQuery.customerId === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}
        </select>
      </div>
      <div class="toolbar__field"><button type="button" class="btn btn--ghost" data-action="deal-reset">重置</button></div>
      <div class="toolbar__meta">共 ${rows.length} 个商机 · 合计 ¥${formatAmount(rows.reduce((sum, deal) => sum + Number(deal.amount || 0), 0))}</div>
    </div>
  `;
}

/** 单张商机卡片。 */
function dealCard(deal, indexInStage) {
  const stageIndex = DEAL_STAGES.findIndex((stage) => stage.value === deal.stage);
  const prev = stageIndex > 0 ? DEAL_STAGES[stageIndex - 1] : null;
  const next = stageIndex >= 0 && stageIndex < DEAL_STAGES.length - 1 ? DEAL_STAGES[stageIndex + 1] : null;
  const closed = CLOSED_STAGES.includes(deal.stage);

  return `
    <article class="kanban-card${closed ? " kanban-card--closed" : ""}" draggable="true" data-deal-id="${deal.id}" data-stage="${deal.stage}" data-index="${indexInStage}">
      <header class="kanban-card__head">
        <span class="drag-handle" aria-hidden="true" title="拖拽到其它阶段">⠿</span>
        <button type="button" class="kanban-card__title" data-action="deal-edit" data-id="${deal.id}">${escapeHtml(deal.title)}</button>
      </header>
      <div class="kanban-card__meta">
        <span class="num">¥${escapeHtml(formatAmount(deal.amount))}</span>
        <span class="kanban-card__owner">${escapeHtml(deal.owner || "未分配")}</span>
      </div>
      <a class="kanban-card__customer" href="#/customers/${deal.customerId}">${escapeHtml(store.customerNameOfDeal(deal))}</a>
      <div class="kanban-card__sub">预计成交 ${escapeHtml(formatDate(deal.expectedCloseAt))}</div>
      ${
        deal.nextFollowAt
          ? `<div class="kanban-card__sub">下次跟进 ${escapeHtml(formatDate(deal.nextFollowAt))}</div>`
          : ""
      }
      <footer class="kanban-card__foot">
        <div class="btn-row">
          ${
            prev
              ? `<button type="button" class="btn btn--ghost btn--sm" data-action="deal-move-prev" data-id="${deal.id}" title="回退到「${escapeHtml(prev.label)}」">← ${escapeHtml(prev.label)}</button>`
              : ""
          }
          ${
            next
              ? `<button type="button" class="btn btn--ghost btn--sm" data-action="deal-move-next" data-id="${deal.id}" title="推进到「${escapeHtml(next.label)}」">${escapeHtml(next.label)} →</button>`
              : ""
          }
        </div>
        <div class="btn-row">
          <button type="button" class="btn btn--link btn--sm" data-action="deal-activity-create" data-id="${deal.id}">记跟进</button>
          <button type="button" class="btn btn--danger btn--sm" data-action="deal-delete" data-id="${deal.id}">删除</button>
        </div>
      </footer>
    </article>
  `;
}

/** 一列（一个阶段）。 */
function column(stage, deals) {
  const amount = deals.reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
  const cards = deals.length
    ? deals.map((deal, index) => dealCard(deal, index)).join("")
    : `<div class="kanban-col__empty">暂无商机</div>`;
  return `
    <section class="kanban-col kanban-col--${stage.tone}" data-drop-stage="${stage.value}" aria-label="${escapeHtml(stage.label)} 阶段">
      <header class="kanban-col__head">
        <span class="badge badge--dot stage-badge stage-badge--${stage.tone}">${escapeHtml(stage.label)}</span>
        <span class="kanban-col__count">${deals.length}</span>
      </header>
      <div class="kanban-col__amount num">¥${escapeHtml(formatAmount(amount))}</div>
      <div class="kanban-col__body">${cards}</div>
    </section>
  `;
}

/** 渲染商机看板。 */
export function renderDeals() {
  const rows = selectDeals();
  const grouped = DEAL_STAGES.map((stage) => ({
    stage,
    deals: rows
      .filter((deal) => deal.stage === stage.value)
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0)),
  }));

  const hasCustomers = store.state.customers.length > 0;
  const openAmount = rows
    .filter((deal) => !CLOSED_STAGES.includes(deal.stage))
    .reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
  const wonAmount = rows.filter((deal) => deal.stage === "won").reduce((sum, deal) => sum + Number(deal.amount || 0), 0);

  const summary = `
    <div class="stat-grid stat-grid--compact">
      <div class="stat"><div class="stat__label">商机总数</div><div class="stat__value">${rows.length}</div></div>
      <div class="stat"><div class="stat__label">进行中金额</div><div class="stat__value num">¥${escapeHtml(formatAmount(openAmount))}</div></div>
      <div class="stat stat--ok"><div class="stat__label">赢单金额</div><div class="stat__value num">¥${escapeHtml(formatAmount(wonAmount))}</div></div>
      <div class="stat"><div class="stat__label">阶段数</div><div class="stat__value">${DEAL_STAGES.length}</div></div>
    </div>
  `;

  const board = hasCustomers
    ? `<div class="kanban">${grouped.map((group) => column(group.stage, group.deals)).join("")}</div>
       <p class="kanban__hint">提示：可直接把卡片拖到其他阶段列，或使用卡片上的阶段按钮切换。</p>`
    : emptyState("还没有客户", "商机需要关联客户，请先在「客户管理」中创建客户");

  return `
    ${pageHead({
      title: "商机看板",
      subtitle: "按阶段推进每一笔生意，拖拽或点击按钮即可更新阶段",
      actions: hasCustomers
        ? `<a class="btn btn--ghost" href="#/activities">跟进记录</a>
           <button type="button" class="btn btn--primary" data-action="deal-create">新建商机</button>`
        : `<a class="btn btn--primary" href="#/customers">去创建客户</a>`,
    })}
    <div class="stack">
      ${summary}
      ${card({ body: toolbar(rows), tight: true })}
      ${board}
    </div>
  `;
}

/** 阶段流转说明，用于拖拽失败时提示。 */
export function stageFlowHint(from, to) {
  return `商机已从「${stageOf(from).label}」移动到「${stageOf(to).label}」`;
}
