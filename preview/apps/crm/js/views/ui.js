/**
 * ui.js — 共享视图工具：页面骨架、徽标、分页与确认框
 * 视图模块只通过这里的函数产出 HTML 片段，保证转义与样式类名一致。
 */

import { escapeHtml, formatAmount, formatDate, pageWindow } from "../utils/helpers.js";
import { labelOf, stageOf, DEAL_STAGES, CUSTOMER_STATUS, LEAD_STATUS } from "../utils/constants.js";

/** 页面标题栏：标题 + 副标题 + 操作区。 */
export function pageHead({ title, subtitle = "", actions = "" }) {
  return `
    <header class="page-head">
      <div class="page-head__main">
        <h1 class="page-head__title">${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="page-head__sub">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      ${actions ? `<div class="page-head__actions">${actions}</div>` : ""}
    </header>
  `;
}

/** 卡片容器。 */
export function card({ title = "", subtitle = "", body = "", actions = "", tight = false }) {
  const head = title || actions
    ? `<div class="card__head">
         <div>
           ${title ? `<h2 class="card__title">${escapeHtml(title)}</h2>` : ""}
           ${subtitle ? `<div class="card__sub">${escapeHtml(subtitle)}</div>` : ""}
         </div>
         ${actions ? `<div class="btn-row">${actions}</div>` : ""}
       </div>`
    : "";
  return `<section class="card">${head}<div class="card__body${tight ? " card__body--tight" : ""}">${body}</div></section>`;
}

/** 空状态占位。 */
export function emptyState(title, hint = "") {
  return `<div class="empty-state">
      <div class="empty-state__title">${escapeHtml(title)}</div>
      ${hint ? `<div>${escapeHtml(hint)}</div>` : ""}
    </div>`;
}

/** 客户状态徽标。 */
export function statusBadge(status) {
  const tone = { potential: "badge--brand", following: "badge--warn", won: "badge--ok", lost: "badge--muted" };
  return `<span class="badge ${tone[status] || "badge--muted"}">${escapeHtml(labelOf(CUSTOMER_STATUS, status, "未知"))}</span>`;
}

/** 线索状态徽标。 */
export function leadBadge(status) {
  const tone = { new: "badge--brand", contacted: "badge--warn", converted: "badge--ok", dropped: "badge--muted" };
  return `<span class="badge ${tone[status] || "badge--muted"}">${escapeHtml(labelOf(LEAD_STATUS, status, "未知"))}</span>`;
}

/** 商机阶段徽标。 */
export function stageBadge(stage) {
  const definition = stageOf(stage);
  return `<span class="badge badge--dot stage-badge stage-badge--${definition.tone}">${escapeHtml(definition.label)}</span>`;
}

/** 金额展示。 */
export function amountText(value) {
  return `<span class="num">¥${escapeHtml(formatAmount(value))}</span>`;
}

/** 日期展示，空值显示占位符。 */
export function dateText(value) {
  return escapeHtml(formatDate(value));
}

/**
 * 分页控件：上一页 / 页码 / 下一页 + 总数说明。
 * 通过 data-page 属性交给事件委托处理。
 */
export function pagination({ page, totalPages, total, pageSize }) {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  const pages = pageWindow(page, totalPages);
  const pageButtons = pages
    .map((item) => {
      if (item === "…") return `<span class="pagination__btn" aria-hidden="true" disabled>…</span>`;
      const active = item === page ? " is-active" : "";
      return `<button type="button" class="pagination__btn${active}" data-page="${item}">${item}</button>`;
    })
    .join("");
  return `
    <div class="pagination">
      <span class="pagination__info">共 ${total} 条，显示第 ${start}-${end} 条</span>
      <div class="pagination__pages">
        <button type="button" class="pagination__btn" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button>
        ${pageButtons}
        <button type="button" class="pagination__btn" data-page="${page + 1}" ${page >= totalPages ? "disabled" : ""}>下一页</button>
      </div>
    </div>
  `;
}

/** 表头排序按钮，点击在升序/降序之间切换。 */
export function sortButton(label, field, currentField, direction) {
  const isActive = currentField === field;
  const mark = isActive ? (direction === "asc" ? "▲" : "▼") : "↕";
  const markClass = isActive ? "sort-btn__mark" : "sort-btn__mark sort-btn__mark--off";
  return `<button type="button" class="sort-btn" data-sort="${field}">
      ${escapeHtml(label)}<span class="${markClass}">${mark}</span>
    </button>`;
}

/** 商机阶段选项（用于下拉框）。 */
export function stageOptions(selected) {
  return DEAL_STAGES.map(
    (stage) => `<option value="${stage.value}"${stage.value === selected ? " selected" : ""}>${stage.label}</option>`
  ).join("");
}

/** 二次确认对话框的按钮组（由 app.js 装配到模态框中）。 */
export function confirmBody(message) {
  return `<p>${escapeHtml(message)}</p>`;
}
