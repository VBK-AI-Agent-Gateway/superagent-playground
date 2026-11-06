/**
 * forms.js — 表单渲染与校验（客户、联系人、线索、商机、跟进）
 * 所有表单使用一致的字段命名，由 store 统一消费；这里只负责结构与校验提示。
 */

import { escapeHtml, toText } from "../utils/helpers.js";
import {
  CUSTOMER_STATUS,
  CUSTOMER_SOURCES,
  LEAD_STATUS,
  ACTIVITY_METHODS,
  ACTIVITY_TARGETS,
  DEAL_STAGES,
  labelOf,
} from "../utils/constants.js";

/** 生成选项列表 HTML。 */
function options(items, selected, placeholder = "请选择") {
  const head = placeholder !== null ? `<option value="">${escapeHtml(placeholder)}</option>` : "";
  return (
    head +
    items
      .map((item) => {
        const value = typeof item === "string" ? item : item.value;
        const label = typeof item === "string" ? item : item.label;
        const isSelected = String(value) === String(selected ?? "") ? " selected" : "";
        return `<option value="${escapeHtml(value)}"${isSelected}>${escapeHtml(label)}</option>`;
      })
      .join("")
  );
}

/** 单个字段包装：标签 + 控件 + 错误占位。 */
function field({ label, name, control, required = false, full = false, hint = "" }) {
  return `
    <div class="field${full ? " form-grid--full" : ""}">
      <label class="field__label" for="f-${name}">${escapeHtml(label)}${required ? ' <span class="req">*</span>' : ""}</label>
      ${control}
      ${hint ? `<div class="field__hint">${escapeHtml(hint)}</div>` : ""}
      <div class="field__error" data-error-for="${name}"></div>
    </div>
  `;
}

function input(name, value = "", { type = "text", placeholder = "" } = {}) {
  return `<input class="input" id="f-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />`;
}

function textarea(name, value = "", { placeholder = "", rows = 3 } = {}) {
  return `<textarea class="textarea" id="f-${name}" name="${name}" rows="${rows}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>`;
}

function select(name, items, selected, placeholder = "请选择") {
  return `<select class="select" id="f-${name}" name="${name}">${options(items, selected, placeholder)}</select>`;
}

/* ---------------- 客户表单 ---------------- */

export function customerForm(customer = {}) {
  return `
    <form id="customer-form" novalidate>
      <div class="form-section">
        <div class="form-section__title">基础信息</div>
        <div class="form-grid">
          ${field({ label: "客户名称", name: "name", required: true, control: input("name", customer.name, { placeholder: "公司或个人名称" }) })}
          ${field({ label: "公司简称", name: "company", control: input("company", customer.company) })}
          ${field({ label: "所属行业", name: "industry", control: input("industry", customer.industry, { placeholder: "如：智能制造" }) })}
          ${field({ label: "客户状态", name: "status", control: select("status", CUSTOMER_STATUS, customer.status || "potential", null) })}
          ${field({ label: "来源渠道", name: "source", control: select("source", CUSTOMER_SOURCES, customer.source) })}
          ${field({ label: "负责人", name: "owner", control: input("owner", customer.owner, { placeholder: "销售负责人" }) })}
        </div>
      </div>
      <div class="form-section">
        <div class="form-section__title">联系方式</div>
        <div class="form-grid">
          ${field({ label: "联系电话", name: "phone", control: input("phone", customer.phone) })}
          ${field({ label: "电子邮箱", name: "email", control: input("email", customer.email, { type: "email" }) })}
          ${field({ label: "地址", name: "address", full: true, control: input("address", customer.address) })}
          ${field({ label: "标签", name: "tags", full: true, hint: "多个标签用逗号分隔", control: input("tags", Array.isArray(customer.tags) ? customer.tags.join("，") : customer.tags, { placeholder: "重点客户，制造业" }) })}
        </div>
      </div>
      <div class="form-section">
        <div class="form-section__title">跟进安排</div>
        <div class="form-grid">
          ${field({ label: "下次跟进日期", name: "nextFollowAt", control: input("nextFollowAt", customer.nextFollowAt, { type: "date" }) })}
          ${field({ label: "备注", name: "note", full: true, control: textarea("note", customer.note, { placeholder: "客户背景、关注点等" }) })}
        </div>
      </div>
    </form>
  `;
}

/** 校验客户表单，返回 { valid, errors, data }。 */
export function validateCustomer(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = toText(value);
  });
  const errors = {};
  if (!data.name) errors.name = "请填写客户名称";
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = "邮箱格式不正确";
  if (data.phone && !/^[\d\s+()-]{6,20}$/.test(data.phone)) errors.phone = "电话格式不正确";
  return { valid: Object.keys(errors).length === 0, errors, data };
}

/* ---------------- 联系人表单 ---------------- */

export function contactForm(contact = {}) {
  return `
    <form id="contact-form" novalidate>
      <div class="form-grid">
        ${field({ label: "姓名", name: "name", required: true, control: input("name", contact.name) })}
        ${field({ label: "职位", name: "title", control: input("title", contact.title, { placeholder: "如：采购经理" }) })}
        ${field({ label: "电话", name: "phone", control: input("phone", contact.phone) })}
        ${field({ label: "邮箱", name: "email", control: input("email", contact.email, { type: "email" }) })}
        ${field({
          label: "主要联系人",
          name: "isPrimary",
          control: `<label class="field__hint"><input type="checkbox" id="f-isPrimary" name="isPrimary" ${contact.isPrimary ? "checked" : ""} /> 标记为对接主联系人</label>`,
        })}
        ${field({ label: "备注", name: "note", full: true, control: textarea("note", contact.note, { rows: 2 }) })}
      </div>
    </form>
  `;
}

export function validateContact(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = key === "isPrimary" ? true : toText(value);
  });
  if (!("isPrimary" in data)) data.isPrimary = false;
  const errors = {};
  if (!data.name) errors.name = "请填写联系人姓名";
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = "邮箱格式不正确";
  return { valid: Object.keys(errors).length === 0, errors, data };
}

/* ---------------- 线索表单 ---------------- */

export function leadForm(lead = {}) {
  return `
    <form id="lead-form" novalidate>
      <div class="form-grid">
        ${field({ label: "线索名称", name: "name", required: true, control: input("name", lead.name, { placeholder: "客户或公司名称" }) })}
        ${field({ label: "公司简称", name: "company", control: input("company", lead.company) })}
        ${field({ label: "联系电话", name: "phone", control: input("phone", lead.phone) })}
        ${field({ label: "电子邮箱", name: "email", control: input("email", lead.email, { type: "email" }) })}
        ${field({ label: "来源渠道", name: "source", control: select("source", CUSTOMER_SOURCES, lead.source) })}
        ${field({ label: "负责人", name: "owner", control: input("owner", lead.owner) })}
        ${field({ label: "线索状态", name: "status", control: select("status", LEAD_STATUS, lead.status || "new", null) })}
        ${field({ label: "下次跟进日期", name: "nextFollowAt", control: input("nextFollowAt", lead.nextFollowAt, { type: "date" }) })}
        ${field({ label: "备注", name: "note", full: true, control: textarea("note", lead.note, { rows: 2, placeholder: "需求概述、沟通要点" }) })}
      </div>
    </form>
  `;
}

export function validateLead(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = toText(value);
  });
  const errors = {};
  if (!data.name) errors.name = "请填写线索名称";
  if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.email = "邮箱格式不正确";
  return { valid: Object.keys(errors).length === 0, errors, data };
}

/* ---------------- 商机表单 ---------------- */

/** 客户下拉选项。 */
function customerOptions(customers, selected) {
  const list = customers.map((item) => ({ value: item.id, label: item.name }));
  return options(list, selected || (customers[0] ? customers[0].id : ""), customers.length ? "请选择客户" : "请先创建客户");
}

export function dealForm(deal = {}, customers = []) {
  return `
    <form id="deal-form" novalidate>
      <div class="form-grid">
        ${field({ label: "商机名称", name: "title", required: true, full: true, control: input("title", deal.title, { placeholder: "如：XX 公司 · 系统采购" }) })}
        ${field({ label: "关联客户", name: "customerId", required: true, control: `<select class="select" id="f-customerId" name="customerId">${customerOptions(customers, deal.customerId)}</select>` })}
        ${field({ label: "预计金额（元）", name: "amount", control: input("amount", deal.amount, { placeholder: "0.00" }) })}
        ${field({ label: "阶段", name: "stage", control: select("stage", DEAL_STAGES, deal.stage || "contact", null) })}
        ${field({ label: "预计成交日期", name: "expectedCloseAt", control: input("expectedCloseAt", deal.expectedCloseAt, { type: "date" }) })}
        ${field({ label: "负责人", name: "owner", control: input("owner", deal.owner) })}
        ${field({ label: "下次跟进日期", name: "nextFollowAt", control: input("nextFollowAt", deal.nextFollowAt, { type: "date" }) })}
        ${field({ label: "备注", name: "note", full: true, control: textarea("note", deal.note, { rows: 2 }) })}
      </div>
    </form>
  `;
}

export function validateDeal(form) {
  const data = {};
  new FormData(form).forEach((value, key) => {
    data[key] = toText(value);
  });
  const errors = {};
  if (!data.title) errors.title = "请填写商机名称";
  if (!data.customerId) errors.customerId = "请选择关联客户";
  if (data.amount && Number.isNaN(Number(data.amount))) errors.amount = "金额必须是数字";
  return { valid: Object.keys(errors).length === 0, errors, data };
}

/* ---------------- 跟进记录表单 ---------------- */

/** 归属对象下拉：客户与商机合并为一个选择器。 */
function targetOptions(customers, deals, targetType, targetId) {
  const groups = [];
  if (customers.length) {
    groups.push(
      `<optgroup label="客户">${customers
        .map(
          (item) =>
            `<option value="customer:${escapeHtml(item.id)}"${targetType === "customer" && targetId === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`
        )
        .join("")}</optgroup>`
    );
  }
  if (deals.length) {
    groups.push(
      `<optgroup label="商机">${deals
        .map(
          (item) =>
            `<option value="deal:${escapeHtml(item.id)}"${targetType === "deal" && targetId === item.id ? " selected" : ""}>${escapeHtml(item.title)}</option>`
        )
        .join("")}</optgroup>`
    );
  }
  return groups.join("") || `<option value="">暂无可关联的客户或商机</option>`;
}

/** 把 datetime-local 需要的时间格式化成 YYYY-MM-DDTHH:mm。 */
function toLocalInput(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function activityForm(activity = {}, customers = [], deals = []) {
  const targetType = activity.targetType || "customer";
  const targetId = activity.targetId || (customers[0] ? customers[0].id : "");
  return `
    <form id="activity-form" novalidate>
      <div class="form-grid">
        ${field({
          label: "归属对象",
          name: "target",
          required: true,
          full: true,
          control: `<select class="select" id="f-target" name="target">${targetOptions(customers, deals, targetType, targetId)}</select>`,
        })}
        ${field({ label: "跟进时间", name: "datetime", required: true, control: `<input class="input" id="f-datetime" name="datetime" type="datetime-local" value="${escapeHtml(toLocalInput(activity.datetime))}" />` })}
        ${field({ label: "跟进方式", name: "method", control: select("method", ACTIVITY_METHODS, activity.method || "电话", null) })}
        ${field({ label: "下次跟进日期", name: "nextFollowAt", control: input("nextFollowAt", activity.nextFollowAt, { type: "date" }) })}
        ${field({ label: "负责人", name: "owner", control: input("owner", activity.owner) })}
        ${field({ label: "跟进内容", name: "content", required: true, full: true, control: textarea("content", activity.content, { placeholder: "沟通内容、客户反馈与下一步计划" }) })}
      </div>
    </form>
  `;
}

export function validateActivity(form) {
  const raw = {};
  new FormData(form).forEach((value, key) => {
    raw[key] = toText(value);
  });
  const errors = {};
  const [targetType, targetId] = (raw.target || "").split(":");
  if (!targetType || !targetId) errors.target = "请选择归属对象";
  if (!raw.content) errors.content = "请填写跟进内容";
  if (!raw.datetime) errors.datetime = "请选择跟进时间";

  const data = {
    targetType: targetType === "deal" ? "deal" : "customer",
    targetId: targetId || "",
    datetime: raw.datetime ? new Date(raw.datetime).toISOString() : "",
    method: raw.method,
    nextFollowAt: raw.nextFollowAt,
    owner: raw.owner,
    content: raw.content,
  };
  return { valid: Object.keys(errors).length === 0, errors, data };
}

/** 线索转化表单：确认目标客户与可选商机信息。 */
export function convertForm(lead = {}) {
  return `
    <form id="convert-form" novalidate>
      <p class="field__hint">将线索「${escapeHtml(lead.name)}」转为客户档案，并可同时创建一条商机。</p>
      <div class="form-grid">
        ${field({ label: "商机名称", name: "dealTitle", full: true, control: input("dealTitle", `${lead.company || lead.name} 商机`) })}
        ${field({ label: "预计金额（元）", name: "dealAmount", control: input("dealAmount", "", { placeholder: "0.00" }) })}
        ${field({ label: "初始阶段", name: "dealStage", control: select("dealStage", DEAL_STAGES, "contact", null) })}
        ${field({
          label: "同时创建商机",
          name: "createDeal",
          full: true,
          control: `<label class="field__hint"><input type="checkbox" id="f-createDeal" name="createDeal" checked /> 勾选后会在商机看板中生成对应卡片</label>`,
        })}
      </div>
    </form>
  `;
}

export function validateConvert(form) {
  const raw = {};
  new FormData(form).forEach((value, key) => {
    raw[key] = toText(value);
  });
  const data = {
    createDeal: "createDeal" in raw,
    dealTitle: raw.dealTitle,
    dealAmount: raw.dealAmount,
    dealStage: raw.dealStage || DEAL_STAGES[0].value,
  };
  const errors = {};
  if (data.dealAmount && Number.isNaN(Number(data.dealAmount))) errors.dealAmount = "金额必须是数字";
  return { valid: Object.keys(errors).length === 0, errors, data };
}

/** 阶段文案（供其他视图复用）。 */
export const stageLabel = (value) => labelOf(DEAL_STAGES, value);
export const activityTargetLabel = (value) => labelOf(ACTIVITY_TARGETS, value);
