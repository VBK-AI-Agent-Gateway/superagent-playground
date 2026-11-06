/**
 * customer-detail.js — 客户详情视图
 * 分区展示基本信息、联系人列表、商机列表与跟进记录（含新增入口）。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatAmount, formatDate, formatDateTime, describeRelativeDay, toText, formatAmountShort } from "../utils/helpers.js";
import { labelOf, CUSTOMER_SOURCES, ACTIVITY_METHODS } from "../utils/constants.js";
import { pageHead, card, emptyState, statusBadge, stageBadge, amountText } from "./ui.js";

/** 基本信息栅格。 */
function infoGrid(customer) {
  const items = [
    ["客户名称", customer.name],
    ["公司简称", customer.company],
    ["所属行业", customer.industry],
    ["客户状态", labelOf(
      [
        { value: "potential", label: "潜在" },
        { value: "following", label: "跟进中" },
        { value: "won", label: "已成交" },
        { value: "lost", label: "已流失" },
      ],
      customer.status
    )],
    ["来源渠道", labelOf(CUSTOMER_SOURCES, customer.source, customer.source)],
    ["负责人", customer.owner],
    ["联系电话", customer.phone],
    ["电子邮箱", customer.email],
    ["地址", customer.address],
    ["下次跟进", customer.nextFollowAt ? `${formatDate(customer.nextFollowAt)}（${describeRelativeDay(customer.nextFollowAt)}）` : "—"],
    ["创建时间", formatDateTime(customer.createdAt)],
    ["最近更新", formatDateTime(customer.updatedAt)],
  ];
  return `<div class="meta-grid">${items
    .map(
      ([label, value]) => `
      <div class="meta-item">
        <div class="meta-item__label">${escapeHtml(label)}</div>
        <div class="meta-item__value">${escapeHtml(toText(value) || "—")}</div>
      </div>`
    )
    .join("")}</div>
    ${customer.tags && customer.tags.length ? `<div class="btn-row tag-row">${customer.tags.map((tag) => `<span class="badge badge--brand">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    ${customer.note ? `<div class="divider"></div><div class="meta-item__label">备注</div><p>${escapeHtml(customer.note)}</p>` : ""}
  `;
}

/** 联系人列表。 */
function contactsBlock(customer) {
  const contacts = store.contactsOf(customer.id);
  const body = contacts.length
    ? `<ul class="list">${contacts
        .map(
          (contact) => `
        <li class="list__item">
          <div class="list__main">
            <div class="list__title">
              ${escapeHtml(contact.name)}
              ${contact.isPrimary ? '<span class="badge badge--ok">主要联系人</span>' : ""}
            </div>
            <div class="list__sub">${escapeHtml([contact.title, contact.phone, contact.email].filter(Boolean).join(" · ") || "—")}</div>
            ${contact.note ? `<div class="list__sub">${escapeHtml(contact.note)}</div>` : ""}
          </div>
          <div class="list__side btn-row">
            <button type="button" class="btn btn--ghost btn--sm" data-action="contact-edit" data-id="${contact.id}">编辑</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="contact-delete" data-id="${contact.id}">删除</button>
          </div>
        </li>`
        )
        .join("")}</ul>`
    : emptyState("暂无联系人", "添加对接人姓名与联系方式，方便后续跟进");
  return card({
    title: "联系人",
    subtitle: `共 ${contacts.length} 位`,
    actions: `<button type="button" class="btn btn--primary btn--sm" data-action="contact-create" data-id="${customer.id}">添加联系人</button>`,
    body,
  });
}

/** 商机列表。 */
function dealsBlock(customer) {
  const deals = store.dealsOf(customer.id);
  const total = deals.reduce((sum, deal) => sum + Number(deal.amount || 0), 0);
  const body = deals.length
    ? `<ul class="list">${deals
        .map(
          (deal) => `
        <li class="list__item">
          <div class="list__main">
            <div class="list__title">${escapeHtml(deal.title)}</div>
            <div class="list__sub">预计成交 ${escapeHtml(formatDate(deal.expectedCloseAt))} · 负责人 ${escapeHtml(deal.owner || "—")}</div>
          </div>
          <div class="list__side">
            ${stageBadge(deal.stage)}
            <span class="num">¥${escapeHtml(formatAmount(deal.amount))}</span>
          </div>
        </li>`
        )
        .join("")}</ul>`
    : emptyState("暂无商机", "在商机看板中为该客户创建商机");
  return card({
    title: "商机",
    subtitle: `共 ${deals.length} 个 · 合计 ¥${formatAmount(total)}`,
    actions: `<button type="button" class="btn btn--ghost btn--sm" data-action="deal-create" data-id="${customer.id}">新增商机</button>`,
    body,
  });
}

/** 跟进记录时间线。 */
function activitiesBlock(customer) {
  const activities = store.activitiesOf(customer.id).slice().reverse();
  const body = activities.length
    ? `<ul class="list">${activities
        .map((activity) => {
          const target = activity.targetType === "deal" ? store.targetName("deal", activity.targetId) : "本客户";
          return `
        <li class="list__item">
          <div class="list__main">
            <div class="list__title">
              <span class="badge badge--brand">${escapeHtml(activity.method || labelOf(ACTIVITY_METHODS, activity.method, "跟进"))}</span>
              ${escapeHtml(formatDateTime(activity.datetime))}
            </div>
            <div class="list__sub">${escapeHtml(activity.content || "—")}</div>
            <div class="list__sub">关联对象：${escapeHtml(target)}${activity.nextFollowAt ? ` · 下次跟进 ${escapeHtml(formatDate(activity.nextFollowAt))}` : ""}</div>
          </div>
          <div class="list__side btn-row">
            <button type="button" class="btn btn--ghost btn--sm" data-action="activity-edit" data-id="${activity.id}">编辑</button>
            <button type="button" class="btn btn--danger btn--sm" data-action="activity-delete" data-id="${activity.id}">删除</button>
          </div>
        </li>`;
        })
        .join("")}</ul>`
    : emptyState("暂无跟进记录", "记录每次沟通内容与下次跟进时间，避免遗漏");
  return card({
    title: "跟进记录",
    subtitle: `共 ${activities.length} 条`,
    actions: `<button type="button" class="btn btn--primary btn--sm" data-action="activity-create" data-target-type="customer" data-id="${customer.id}">添加跟进</button>`,
    body,
  });
}

/** 渲染客户详情。 */
export function renderCustomerDetail(id) {
  const customer = store.getCustomer(id);
  if (!customer) {
    return `
      ${pageHead({ title: "客户不存在", subtitle: "该客户可能已被删除" })}
      ${card({ body: emptyState("找不到这位客户", "返回列表后重新选择") + `<div class="btn-row"><a class="btn btn--primary" href="#/customers">返回客户列表</a></div>` })}
    `;
  }

  const dealTotal = store.dealsOf(customer.id).reduce((sum, deal) => sum + Number(deal.amount || 0), 0);

  return `
    ${pageHead({
      title: customer.name,
      subtitle: `${customer.company || "未填写公司"} · ${dealTotal ? `商机合计 ¥${formatAmountShort(dealTotal)}` : "暂无商机"}`,
      actions: `
        <a class="btn btn--ghost" href="#/customers">返回列表</a>
        <button type="button" class="btn btn--ghost" data-action="activity-create" data-target-type="customer" data-id="${customer.id}">添加跟进</button>
        <button type="button" class="btn btn--ghost" data-action="customer-edit" data-id="${customer.id}">编辑</button>
        <button type="button" class="btn btn--danger" data-action="customer-delete" data-id="${customer.id}">删除</button>
      `,
    })}
    <div class="stack">
      <div class="detail-grid">
        ${card({ title: "基本信息", actions: statusBadge(customer.status), body: infoGrid(customer) })}
        ${card({ title: "概览", body: summaryBlock(customer) })}
      </div>
      ${dealsBlock(customer)}
      ${contactsBlock(customer)}
      ${activitiesBlock(customer)}
    </div>
  `;
}

/** 客户概览小卡片。 */
function summaryBlock(customer) {
  const deals = store.dealsOf(customer.id);
  const activities = store.activitiesOf(customer.id);
  const last = activities[activities.length - 1];
  const items = [
    ["商机数量", `${deals.length} 个`],
    ["商机金额合计", `¥${formatAmount(deals.reduce((sum, deal) => sum + Number(deal.amount || 0), 0))}`],
    ["联系人", `${store.contactsOf(customer.id).length} 位`],
    ["跟进记录", `${activities.length} 条`],
    ["最近一次跟进", last ? formatDateTime(last.datetime) : "—"],
  ];
  return `<div class="meta-grid meta-grid--single">${items
    .map(
      ([label, value]) => `
      <div class="meta-item">
        <div class="meta-item__label">${escapeHtml(label)}</div>
        <div class="meta-item__value">${escapeHtml(value)}</div>
      </div>`
    )
    .join("")}</div>`;
}
