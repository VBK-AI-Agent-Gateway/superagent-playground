/**
 * activities.js — 跟进记录视图
 * 列表展示全部跟进记录（时间、方式、内容、关联对象、下次跟进日期），
 * 支持按方式 / 归属对象筛选，并按时间倒序排列。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatDate, formatDateTime, describeRelativeDay, matchesKeyword, paginate } from "../utils/helpers.js";
import { ACTIVITY_METHODS, DEFAULT_PAGE_SIZE, labelOf } from "../utils/constants.js";
import { pageHead, card, emptyState, pagination } from "./ui.js";

/** 跟进页查询状态。 */
export const activitiesQuery = {
  keyword: "",
  method: "",
  scope: "",
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

/** 按条件筛选跟进记录，按时间倒序。 */
export function selectActivities() {
  const rows = store.state.activities.filter((activity) => {
    if (activitiesQuery.method && activity.method !== activitiesQuery.method) return false;
    if (activitiesQuery.scope === "customer" && activity.targetType !== "customer") return false;
    if (activitiesQuery.scope === "deal" && activity.targetType !== "deal") return false;
    if (activitiesQuery.scope === "overdue") {
      const target = activity.targetType === "deal" ? store.getDeal(activity.targetId) : store.getCustomer(activity.targetId);
      if (!target || !target.nextFollowAt || new Date(target.nextFollowAt) >= new Date(new Date().toDateString())) return false;
    }
    if (!activitiesQuery.keyword) return true;
    return matchesKeyword(
      [activity.content, activity.method, activity.owner, store.targetName(activity.targetType, activity.targetId)],
      activitiesQuery.keyword
    );
  });
  return rows.sort((a, b) => new Date(b.datetime || 0) - new Date(a.datetime || 0));
}

/** 工具栏。 */
function toolbar(total) {
  return `
    <div class="toolbar">
      <div class="toolbar__field toolbar__field--grow">
        <input class="input" type="search" data-filter="activity-keyword" value="${escapeHtml(activitiesQuery.keyword)}" placeholder="搜索跟进内容、对象或负责人" aria-label="搜索跟进记录" />
      </div>
      <div class="toolbar__field">
        <select class="select" data-filter="activity-method" aria-label="按跟进方式筛选">
          <option value="">全部方式</option>
          ${ACTIVITY_METHODS.map((method) => `<option value="${escapeHtml(method)}"${activitiesQuery.method === method ? " selected" : ""}>${escapeHtml(method)}</option>`).join("")}
        </select>
      </div>
      <div class="toolbar__field">
        <select class="select" data-filter="activity-scope" aria-label="按归属对象筛选">
          <option value="">全部对象</option>
          <option value="customer"${activitiesQuery.scope === "customer" ? " selected" : ""}>仅客户</option>
          <option value="deal"${activitiesQuery.scope === "deal" ? " selected" : ""}>仅商机</option>
          <option value="overdue"${activitiesQuery.scope === "overdue" ? " selected" : ""}>仅逾期未跟进</option>
        </select>
      </div>
      <div class="toolbar__field"><button type="button" class="btn btn--ghost" data-action="activity-reset">重置</button></div>
      <div class="toolbar__meta">共 ${total} 条记录</div>
    </div>
  `;
}

/** 跟进记录表格。 */
function table(rows) {
  const body = rows
    .map((activity) => {
      const isDeal = activity.targetType === "deal";
      const targetName = store.targetName(activity.targetType, activity.targetId);
      const href = isDeal ? `#/deals` : `#/customers/${activity.targetId}`;
      return `
        <tr>
          <td class="cell-nowrap">${escapeHtml(formatDateTime(activity.datetime))}</td>
          <td><span class="badge badge--brand">${escapeHtml(activity.method || "跟进")}</span></td>
          <td>
            <a class="table__link" href="${href}">${escapeHtml(targetName)}</a>
            <div class="cell-sub">${isDeal ? "商机" : "客户"}</div>
          </td>
          <td class="cell-content">${escapeHtml(activity.content || "—")}${activity.owner ? `<div class="cell-sub">负责人：${escapeHtml(activity.owner)}</div>` : ""}</td>
          <td class="cell-nowrap">
            ${activity.nextFollowAt ? `${escapeHtml(formatDate(activity.nextFollowAt))}<div class="cell-sub">${escapeHtml(describeRelativeDay(activity.nextFollowAt))}</div>` : "—"}
          </td>
          <td class="cell-actions">
            <button type="button" class="btn btn--ghost btn--sm" data-action="activity-edit" data-id="${activity.id}">编辑</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="activity-delete" data-id="${activity.id}">删除</button>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>跟进时间</th><th>方式</th><th>归属对象</th><th>跟进内容</th><th>下次跟进</th><th class="cell-right">操作</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

/** 渲染跟进记录页。 */
export function renderActivities() {
  const filtered = selectActivities();
  const page = paginate(filtered, activitiesQuery.page, activitiesQuery.pageSize);
  activitiesQuery.page = page.page;

  const upcoming = store.getUpcomingFollowUps(7);
  const methodCounts = ACTIVITY_METHODS.map((method) => ({
    method,
    count: store.state.activities.filter((activity) => activity.method === method).length,
  }));

  const content = filtered.length
    ? table(page.items) + pagination({ page: page.page, totalPages: page.totalPages, total: page.total, pageSize: page.pageSize })
    : emptyState("暂无跟进记录", "点击「新增跟进」记录一次沟通，并设置下次跟进时间");

  const summary = `
    <div class="stat-grid stat-grid--compact">
      <div class="stat"><div class="stat__label">记录总数</div><div class="stat__value">${store.state.activities.length}</div></div>
      <div class="stat"><div class="stat__label">近 7 天待跟进</div><div class="stat__value">${upcoming.length}</div></div>
      ${methodCounts
        .slice(0, 2)
        .map(
          (item) =>
            `<div class="stat"><div class="stat__label">${escapeHtml(item.method)}沟通</div><div class="stat__value">${item.count}</div></div>`
        )
        .join("")}
    </div>
  `;

  return `
    ${pageHead({
      title: "跟进记录",
      subtitle: "记录每次沟通的时间、方式与内容，并安排下一次跟进",
      actions: `<button type="button" class="btn btn--primary" data-action="activity-create">新增跟进</button>`,
    })}
    <div class="stack">
      ${summary}
      ${card({ body: toolbar(filtered.length) + content, tight: true })}
    </div>
  `;
}

/** 单条记录的展示标题（供删除确认复用）。 */
export function activityTitle(activity) {
  if (!activity) return "该记录";
  return `${labelOf(ACTIVITY_METHODS, activity.method, "跟进")} · ${store.targetName(activity.targetType, activity.targetId)}`;
}
