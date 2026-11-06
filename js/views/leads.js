/**
 * leads.js — 线索视图
 * 线索录入、编辑、删除，以及「转化」为正式客户（可选同时创建商机）。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatDate, matchesKeyword, compareValues, paginate, describeRelativeDay } from "../utils/helpers.js";
import { LEAD_STATUS, CUSTOMER_SOURCES, DEFAULT_PAGE_SIZE, labelOf } from "../utils/constants.js";
import { pageHead, card, emptyState, leadBadge, pagination, sortButton } from "./ui.js";

/** 线索页查询状态。 */
export const leadsQuery = {
  keyword: "",
  status: "",
  sort: "createdAt",
  direction: "desc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/** 按条件筛选并排序线索。 */
export function selectLeads() {
  const rows = store.state.leads.filter((lead) => {
    if (leadsQuery.status && lead.status !== leadsQuery.status) return false;
    if (!leadsQuery.keyword) return true;
    return matchesKeyword([lead.name, lead.company, lead.phone, lead.email, lead.owner, lead.source, lead.note], leadsQuery.keyword);
  });
  return rows.sort((a, b) => compareValues(a[leadsQuery.sort], b[leadsQuery.sort], leadsQuery.direction));
}

/** 工具栏。 */
function toolbar(total) {
  return `
    <div class="toolbar">
      <div class="toolbar__field toolbar__field--grow">
        <input class="input" type="search" data-filter="lead-keyword" value="${escapeHtml(leadsQuery.keyword)}" placeholder="搜索线索名称、公司、电话或负责人" aria-label="搜索线索" />
      </div>
      <div class="toolbar__field">
        <select class="select" data-filter="lead-status" aria-label="按线索状态筛选">
          <option value="">全部状态</option>
          ${LEAD_STATUS.map((item) => `<option value="${item.value}"${leadsQuery.status === item.value ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
        </select>
      </div>
      <div class="toolbar__field"><button type="button" class="btn btn--ghost" data-action="lead-reset">重置</button></div>
      <div class="toolbar__meta">共 ${total} 条线索</div>
    </div>
  `;
}

/** 线索表格。 */
function table(rows) {
  const columns = [
    { label: "线索名称", field: "name" },
    { label: "状态", field: "status" },
    { label: "来源", field: "source" },
    { label: "负责人", field: "owner" },
    { label: "下次跟进", field: "nextFollowAt" },
    { label: "录入时间", field: "createdAt" },
  ];
  const head = columns
    .map((column) => `<th>${sortButton(column.label, column.field, leadsQuery.sort, leadsQuery.direction)}</th>`)
    .join("");

  const body = rows
    .map(
      (lead) => `
      <tr>
        <td class="cell-title">
          ${escapeHtml(lead.name)}
          <div class="cell-sub">${escapeHtml([lead.company, lead.phone, lead.email].filter(Boolean).join(" · ") || "—")}</div>
          ${lead.note ? `<div class="cell-sub">${escapeHtml(lead.note)}</div>` : ""}
        </td>
        <td>${leadBadge(lead.status)}</td>
        <td>${escapeHtml(lead.source || "—")}</td>
        <td>${escapeHtml(lead.owner || "—")}</td>
        <td>
          ${escapeHtml(formatDate(lead.nextFollowAt))}
          ${lead.nextFollowAt ? `<div class="cell-sub">${escapeHtml(describeRelativeDay(lead.nextFollowAt))}</div>` : ""}
        </td>
        <td>${escapeHtml(formatDate(lead.createdAt))}</td>
        <td class="cell-actions">
          ${
            lead.status === "converted"
              ? `<a class="btn btn--ghost btn--sm" href="#/customers/${lead.convertedCustomerId}">查看客户</a>`
              : `<button type="button" class="btn btn--primary btn--sm" data-action="lead-convert" data-id="${lead.id}">转化</button>`
          }
          <button type="button" class="btn btn--ghost btn--sm" data-action="lead-edit" data-id="${lead.id}">编辑</button>
          <button type="button" class="btn btn--danger btn--sm" data-action="lead-delete" data-id="${lead.id}">删除</button>
        </td>
      </tr>
    `
    )
    .join("");

  return `
    <div class="table-wrap">
      <table class="table">
        <thead><tr>${head}<th class="cell-right">操作</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

/** 渲染线索页。 */
export function renderLeads() {
  const filtered = selectLeads();
  const page = paginate(filtered, leadsQuery.page, leadsQuery.pageSize);
  leadsQuery.page = page.page;

  const content = filtered.length
    ? table(page.items) + pagination({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })
    : emptyState("暂无线索", "点击右上角「录入线索」开始积累销售线索");

  const newCount = store.state.leads.filter((lead) => lead.status === "new").length;
  const contactedCount = store.state.leads.filter((lead) => lead.status === "contacted").length;
  const convertedCount = store.state.leads.filter((lead) => lead.status === "converted").length;

  const summary = `
    <div class="stat-grid stat-grid--compact">
      <div class="stat"><div class="stat__label">待联系</div><div class="stat__value">${newCount}</div></div>
      <div class="stat"><div class="stat__label">跟进中</div><div class="stat__value">${contactedCount}</div></div>
      <div class="stat stat--ok"><div class="stat__label">已转化</div><div class="stat__value">${convertedCount}</div></div>
      <div class="stat"><div class="stat__label">线索总数</div><div class="stat__value">${store.state.leads.length}</div></div>
    </div>
  `;

  return `
    ${pageHead({
      title: "线索管理",
      subtitle: "收集潜在客户信息，成熟后一键转化为客户与商机",
      actions: `<button type="button" class="btn btn--primary" data-action="lead-create">录入线索</button>`,
    })}
    <div class="stack">
      ${summary}
      ${card({ body: toolbar(filtered.length) + content, tight: true })}
    </div>
  `;
}

/** 转化成功后的提示文案。 */
export function convertResultMessage(result) {
  if (!result) return "线索转化失败";
  const parts = [`已生成客户档案「${result.customer.name}」`];
  if (result.reused) parts.push("（匹配到同名客户，已直接关联）");
  if (result.deal) parts.push(`并创建商机「${result.deal.title}」`);
  return parts.join("");
}

/** 线索状态标签。 */
export const leadStatusLabel = (status) => labelOf(LEAD_STATUS, status);

/** 来源选项（供表单复用）。 */
export const leadSources = CUSTOMER_SOURCES;
