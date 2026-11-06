/**
 * customers.js — 客户列表视图
 * 支持关键字搜索、状态/来源筛选、多字段排序与分页；每行可编辑或删除。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatDate, matchesKeyword, compareValues, paginate } from "../utils/helpers.js";
import { CUSTOMER_STATUS, CUSTOMER_SOURCES, CUSTOMER_SORT_FIELDS, DEFAULT_PAGE_SIZE } from "../utils/constants.js";
import { pageHead, card, emptyState, statusBadge, pagination, sortButton, amountText } from "./ui.js";

/** 列表页查询状态（仅视图层使用，不写入 store）。 */
export const customersQuery = {
  keyword: "",
  status: "",
  source: "",
  sort: "updatedAt",
  direction: "desc",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/** 重置到第一页（筛选条件变化时调用）。 */
export function resetCustomersPage() {
  customersQuery.page = 1;
}

/** 依据当前查询条件筛选并排序客户。 */
export function selectCustomers() {
  const keyword = customersQuery.keyword;
  let rows = store.state.customers.filter((customer) => {
    if (customersQuery.status && customer.status !== customersQuery.status) return false;
    if (customersQuery.source && customer.source !== customersQuery.source) return false;
    if (!keyword) return true;
    return matchesKeyword(
      [customer.name, customer.company, customer.industry, customer.contact || "", customer.phone, customer.email, customer.owner, (customer.tags || []).join(" ")],
      keyword
    );
  });

  const field = customersQuery.sort;
  const direction = customersQuery.direction === "asc" ? 1 : -1;
  rows = rows.sort((a, b) => {
    if (field === "amount") {
      // 按该客户名下商机金额合计排序
      const sumOf = (id) => store.dealsOf(id).reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
      return (sumOf(a.id) - sumOf(b.id)) * direction;
    }
    return compareValues(a[field], b[field], customersQuery.direction);
  });
  return rows;
}

/** 筛选工具栏。 */
function toolbar(total) {
  const statusFilter = `<select class="select" data-filter="status" aria-label="按状态筛选">
      <option value="">全部状态</option>
      ${CUSTOMER_STATUS.map(
        (item) => `<option value="${item.value}"${customersQuery.status === item.value ? " selected" : ""}>${escapeHtml(item.label)}</option>`
      ).join("")}
    </select>`;
  const sourceFilter = `<select class="select" data-filter="source" aria-label="按来源筛选">
      <option value="">全部来源</option>
      ${CUSTOMER_SOURCES.map(
        (item) => `<option value="${item}"${customersQuery.source === item ? " selected" : ""}>${escapeHtml(item)}</option>`
      ).join("")}
    </select>`;
  const sizeFilter = `<select class="select" data-filter="pageSize" aria-label="每页条数">
      ${[10, 20, 50].map((size) => `<option value="${size}"${customersQuery.pageSize === size ? " selected" : ""}>每页 ${size} 条</option>`).join("")}
    </select>`;

  return `
    <div class="toolbar">
      <div class="toolbar__field toolbar__field--grow">
        <input class="input" type="search" data-filter="keyword" value="${escapeHtml(customersQuery.keyword)}" placeholder="搜索客户名称、公司、联系人、电话或标签" aria-label="搜索客户" />
      </div>
      <div class="toolbar__field">${statusFilter}</div>
      <div class="toolbar__field">${sourceFilter}</div>
      <div class="toolbar__field">${sizeFilter}</div>
      <div class="toolbar__field">
        <button type="button" class="btn btn--ghost" data-action="customer-reset">重置</button>
      </div>
      <div class="toolbar__meta">共 ${total} 位客户</div>
    </div>
  `;
}

/** 客户表格。 */
function table(rows) {
  const columns = [
    { label: "客户名称", field: "name" },
    { label: "状态", field: "status" },
    { label: "来源", field: "source" },
    { label: "负责人", field: "owner" },
    { label: "商机金额", field: "amount", align: "right" },
    { label: "下次跟进", field: "nextFollowAt" },
  ];

  const head = columns
    .map((column) => `<th${column.align ? ` class="cell-${column.align}"` : ""}>${sortButton(column.label, column.field, customersQuery.sort, customersQuery.direction)}</th>`)
    .join("");

  const body = rows
    .map((customer) => {
      const amount = store.dealsOf(customer.id).reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
      const dealCount = store.dealsOf(customer.id).length;
      return `
        <tr>
          <td class="cell-title">
            <a class="table__link" href="#/customers/${customer.id}">${escapeHtml(customer.name)}</a>
            <div class="cell-sub">${escapeHtml(customer.company || customer.industry || "—")}${customer.tags && customer.tags.length ? ` · ${escapeHtml(customer.tags.join(" / "))}` : ""}</div>
          </td>
          <td>${statusBadge(customer.status)}</td>
          <td>${escapeHtml(customer.source || "—")}</td>
          <td>${escapeHtml(customer.owner || "—")}</td>
          <td class="cell-right">${amountText(amount)}<div class="cell-sub">${dealCount} 个商机</div></td>
          <td>${escapeHtml(formatDate(customer.nextFollowAt))}</td>
          <td class="cell-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="customer-edit" data-id="${customer.id}">编辑</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="customer-delete" data-id="${customer.id}">删除</button>
          </td>
        </tr>
      `;
    })
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

/** 渲染客户列表页。 */
export function renderCustomers() {
  const filtered = selectCustomers();
  const page = paginate(filtered, customersQuery.page, customersQuery.pageSize);
  customersQuery.page = page.page;

  const content = filtered.length
    ? table(page.items) +
      pagination({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })
    : emptyState("没有匹配的客户", "试着调整搜索关键字或筛选条件，也可以直接新建客户");

  return `
    ${pageHead({
      title: "客户管理",
      subtitle: "维护客户档案、联系人与跟进节奏",
      actions: `
        <a class="btn btn--ghost" href="#/data">导入 / 导出</a>
        <button type="button" class="btn btn--primary" data-action="customer-create">新建客户</button>
      `,
    })}
    ${card({ body: toolbar(filtered.length) + content, tight: true })}
  `;
}

/** 客户删除确认文案。 */
export function customerDeleteMessage(customer) {
  const dealCount = store.dealsOf(customer.id).length;
  const contactCount = store.contactsOf(customer.id).length;
  return `确定删除客户「${customer.name}」吗？其 ${contactCount} 位联系人与 ${dealCount} 个商机、以及相关跟进记录都会一并删除，且无法恢复。`;
}
