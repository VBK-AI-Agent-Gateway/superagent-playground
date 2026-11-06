/**
 * app.js — 应用入口
 *
 * 职责：
 * 1. 启动时初始化数据层（store.init）；
 * 2. 监听 hash 变化，选择对应视图并渲染到 #view-host；
 * 3. 在 document 上做统一事件委托，处理 data-action / data-sort / data-page / data-filter；
 * 4. 管理模态框（表单与二次确认）、轻提示（toast）与数据面板。
 *
 * 视图文件只导出「渲染函数」，不绑定任何事件，保证数据与视图分离。
 */

import { store } from "./data/store.js";
import { qs, setHtml, toggleHidden, scrollTop, showFieldError, clearFieldErrors } from "./utils/dom.js";
import { ROUTES, DEFAULT_PAGE_SIZE, DEAL_STAGES, stageOf } from "./utils/constants.js";
import { formatDateTime } from "./utils/helpers.js";
import {
  customerForm,
  validateCustomer,
  contactForm,
  validateContact,
  leadForm,
  validateLead,
  dealForm,
  validateDeal,
  activityForm,
  validateActivity,
  convertForm,
  validateConvert,
} from "./views/forms.js";
import { confirmBody } from "./views/ui.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderCustomers, customersQuery, resetCustomersPage, customerDeleteMessage } from "./views/customers.js";
import { renderCustomerDetail } from "./views/customer-detail.js";
import { renderLeads, leadsQuery } from "./views/leads.js";
import { renderDeals, dealsQuery } from "./views/deals.js";
import { renderActivities, activitiesQuery } from "./views/activities.js";
import { renderDataPanel } from "./views/data-panel.js";

/* ---------------- 元素引用 ---------------- */

const viewHost = qs("#view-host");
const modal = qs("#modal");
const modalTitle = qs("#modal-title");
const modalBody = qs("#modal-body");
const modalFoot = qs("#modal-foot");
const dataPanel = qs("#data-panel");
const toastNode = qs("#toast");
const navToggle = qs("#nav-toggle");
const appNav = qs("#app-nav");
const btnData = qs("#btn-data");
const importFile = qs("#import-file");
const importDealsFile = qs("#import-deals-file");

/** 模态框当前的回调：确认键的行为与关闭后的清理。 */
let modalConfirm = null;
let modalOnClose = null;
let toastTimer = 0;

/* ---------------- 小工具 ---------------- */

/** 轻提示，3 秒后自动消失。 */
function toast(message, tone = "info") {
  if (!toastNode) return;
  toastNode.textContent = message;
  toastNode.className = `toast toast--${tone}`;
  toggleHidden(toastNode, false);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toggleHidden(toastNode, true), 3000);
}

/** 打开模态框；buttons 为 [{ label, action, variant }]。 */
function openModal({ title, body, buttons = [], confirm, onClose }) {
  if (!modal) return;
  setHtml(modalTitle, title || "");
  setHtml(modalBody, body || "");
  setHtml(
    modalFoot,
    buttons
      .map(
        (button) =>
          `<button type="button" class="btn ${button.variant || "btn--ghost"}" data-modal-action="${button.action}">${button.label}</button>`
      )
      .join("")
  );
  modalConfirm = confirm || null;
  modalOnClose = onClose || null;
  toggleHidden(modal, false);
  document.body.classList.add("is-locked");
  const firstField = qs("input, select, textarea", modalBody);
  if (firstField) firstField.focus();
}

/** 关闭模态框。 */
function closeModal() {
  if (!modal || modal.hidden) return;
  toggleHidden(modal, true);
  setHtml(modalBody, "");
  setHtml(modalFoot, "");
  document.body.classList.remove("is-locked");
  const after = modalOnClose;
  modalConfirm = null;
  modalOnClose = null;
  if (after) after();
}

/** 确认对话框：confirmBody 文本 + 确认/取消。 */
function confirmDialog({ title, message, confirmLabel = "确认删除", variant = "btn--danger", onConfirm }) {
  openModal({
    title,
    body: confirmBody(message),
    buttons: [
      { label: "取消", action: "cancel" },
      { label: confirmLabel, action: "confirm", variant },
    ],
    confirm: onConfirm,
  });
}

/** 表单弹窗：装配校验、错误展示与提交。 */
function formDialog({ title, body, validate, onSubmit, submitLabel = "保存" }) {
  openModal({
    title,
    body,
    buttons: [
      { label: "取消", action: "cancel" },
      { label: submitLabel, action: "confirm", variant: "btn--primary" },
    ],
    confirm: () => {
      const form = qs("form", modalBody);
      if (!form) return;
      clearFieldErrors(form);
      const result = validate(form);
      if (!result.valid) {
        Object.keys(result.errors).forEach((name) => showFieldError(form, name, result.errors[name]));
        const firstError = qs(".field__error:not(:empty)", form);
        if (firstError) firstError.scrollIntoView({ block: "center", behavior: "smooth" });
        return;
      }
      onSubmit(result.data);
      closeModal();
    },
  });
}

/** 下载文本文件。 */
function download(filename, text) {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/** 重置列表查询条件：清空关键词与各筛选字段，并回到第一页。 */
function resetListQuery(query, extra = {}) {
  query.keyword = "";
  query.page = 1;
  Object.keys(extra).forEach((key) => {
    query[key] = extra[key];
  });
}

/** 导出文件名：crm-backup-YYYYMMDD-HHmm.json。 */
function exportFilename() {
  const stamp = formatDateTime(new Date().toISOString()).replace(/[^\d]/g, "").slice(0, 12);
  return `crm-backup-${stamp || "data"}.json`;
}

/** 读取用户选中的 JSON 文件。 */
function readJsonFile(file, done) {
  const reader = new FileReader();
  reader.onload = () => done(String(reader.result || ""));
  reader.onerror = () => toast("读取文件失败，请重试", "danger");
  reader.readAsText(file, "utf-8");
}

/* ---------------- 路由 ---------------- */

/** 解析当前 hash，返回 { name, id }。 */
function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [segment, id] = raw.split("/");
  const name = segment || "dashboard";
  return { name, id: id || "" };
}

/** 渲染当前路由对应的视图。 */
function renderRoute() {
  const { name, id } = parseRoute();
  let html = "";
  switch (name) {
    case "customers":
      html = id ? renderCustomerDetail(id) : renderCustomers();
      break;
    case "leads":
      html = renderLeads();
      break;
    case "deals":
      html = renderDeals();
      break;
    case "activities":
      html = renderActivities();
      break;
    case "data":
      html = renderDataPanel();
      break;
    case "dashboard":
      html = renderDashboard();
      break;
    default:
      html = `<div class="empty-state"><h2 class="empty-state__title">页面不存在</h2><p class="empty-state__hint">该地址没有对应的页面，已返回仪表盘。</p><p><a class="btn btn--primary" href="#/dashboard">回到仪表盘</a></p></div>`;
  }
  setHtml(viewHost, html);
  syncNav(name);
  scrollTop();
}

/** 高亮当前导航项。 */
function syncNav(name) {
  const alias = name === "customers" ? "customers" : name;
  Array.from(document.querySelectorAll("[data-nav]")).forEach((link) => {
    link.classList.toggle("is-active", link.dataset.nav === alias);
  });
  document.title = `${navTitle(name)} · CRM 客户关系管理系统`;
}

/** 页面标题。 */
function navTitle(name) {
  const map = {
    dashboard: "仪表盘",
    customers: "客户管理",
    leads: "线索管理",
    deals: "商机看板",
    activities: "跟进记录",
    data: "数据管理",
  };
  return map[name] || "CRM";
}

/** 切换视图后关闭移动端导航。 */
function closeNav() {
  if (!appNav) return;
  appNav.classList.remove("is-open");
  if (navToggle) navToggle.setAttribute("aria-expanded", "false");
}

/* ---------------- 各模块的表单弹窗 ---------------- */

const actions = {
  /* 客户 */
  "customer-create": () =>
    formDialog({
      title: "新建客户",
      body: customerForm(),
      validate: validateCustomer,
      onSubmit: (data) => {
        const customer = store.createCustomer(data);
        toast(`已创建客户「${customer.name}」`, "success");
      },
    }),

  "customer-edit": (id) => {
    const customer = store.getCustomer(id);
    if (!customer) return toast("客户不存在或已被删除", "danger");
    formDialog({
      title: `编辑客户 · ${customer.name}`,
      body: customerForm(customer),
      validate: validateCustomer,
      onSubmit: (data) => {
        store.updateCustomer(id, data);
        toast("客户信息已更新", "success");
      },
    });
  },

  "customer-delete": (id) => {
    const customer = store.getCustomer(id);
    if (!customer) return toast("客户不存在或已被删除", "danger");
    confirmDialog({
      title: "删除客户",
      message: customerDeleteMessage(customer),
      onConfirm: () => {
        store.removeCustomer(id);
        toast("客户及其关联数据已删除", "success");
        if (parseRoute().id === id) window.location.hash = ROUTES.customers;
      },
    });
  },

  /* 联系人 */
  "contact-create": (id) => {
    const customer = store.getCustomer(id);
    if (!customer) return toast("客户不存在或已被删除", "danger");
    formDialog({
      title: `新增联系人 · ${customer.name}`,
      body: contactForm(),
      validate: validateContact,
      onSubmit: (data) => {
        store.createContact(id, data);
        toast("联系人已添加", "success");
      },
    });
  },

  "contact-edit": (id) => {
    const contact = store.state.contacts.find((item) => item.id === id);
    if (!contact) return toast("联系人不存在", "danger");
    formDialog({
      title: `编辑联系人 · ${contact.name}`,
      body: contactForm(contact),
      validate: validateContact,
      onSubmit: (data) => {
        store.updateContact(id, data);
        toast("联系人已更新", "success");
      },
    });
  },

  "contact-delete": (id) => {
    const contact = store.state.contacts.find((item) => item.id === id);
    if (!contact) return toast("联系人不存在", "danger");
    confirmDialog({
      title: "删除联系人",
      message: `确定删除联系人「${contact.name}」吗？`,
      onConfirm: () => {
        store.removeContact(id);
        toast("联系人已删除", "success");
      },
    });
  },

  /* 线索 */
  "lead-create": () =>
    formDialog({
      title: "录入线索",
      body: leadForm(),
      validate: validateLead,
      onSubmit: (data) => {
        const lead = store.createLead(data);
        toast(`已录入线索「${lead.name}」`, "success");
      },
    }),

  "lead-edit": (id) => {
    const lead = store.getLead(id);
    if (!lead) return toast("线索不存在", "danger");
    formDialog({
      title: `编辑线索 · ${lead.name}`,
      body: leadForm(lead),
      validate: validateLead,
      onSubmit: (data) => {
        store.updateLead(id, data);
        toast("线索已更新", "success");
      },
    });
  },

  "lead-delete": (id) => {
    const lead = store.getLead(id);
    if (!lead) return toast("线索不存在", "danger");
    confirmDialog({
      title: "删除线索",
      message: `确定删除线索「${lead.name}」吗？该操作不可撤销。`,
      onConfirm: () => {
        store.removeLead(id);
        toast("线索已删除", "success");
      },
    });
  },

  "lead-convert": (id) => {
    const lead = store.getLead(id);
    if (!lead) return toast("线索不存在", "danger");
    if (lead.status === "converted") return toast("该线索已转化", "warn");
    formDialog({
      title: `转化线索 · ${lead.name}`,
      body: convertForm(lead),
      validate: validateConvert,
      submitLabel: "确认转化",
      onSubmit: (data) => {
        const result = store.convertLead(id, {
          createDeal: data.createDeal,
          dealTitle: data.dealTitle,
          dealAmount: data.dealAmount,
          dealStage: data.dealStage,
        });
        const parts = [`线索已转化为客户「${result.customer.name}」`];
        if (result.deal) parts.push(`并创建商机「${result.deal.title}」`);
        toast(parts.join("，"), "success");
      },
    });
  },

  /* 商机 */
  "deal-create": () => {
    if (!store.state.customers.length) return toast("请先创建客户，再新建商机", "warn");
    formDialog({
      title: "新建商机",
      body: dealForm({}, store.state.customers),
      validate: validateDeal,
      onSubmit: (data) => {
        const deal = store.createDeal(data);
        toast(`已创建商机「${deal.title}」`, "success");
      },
    });
  },

  "deal-edit": (id) => {
    const deal = store.getDeal(id);
    if (!deal) return toast("商机不存在", "danger");
    formDialog({
      title: `编辑商机 · ${deal.title}`,
      body: dealForm(deal, store.state.customers),
      validate: validateDeal,
      onSubmit: (data) => {
        store.updateDeal(id, data);
        toast("商机已更新", "success");
      },
    });
  },

  "deal-delete": (id) => {
    const deal = store.getDeal(id);
    if (!deal) return toast("商机不存在", "danger");
    confirmDialog({
      title: "删除商机",
      message: `确定删除商机「${deal.title}」吗？其跟进记录会一并删除。`,
      onConfirm: () => {
        store.removeDeal(id);
        toast("商机已删除", "success");
      },
    });
  },

  "deal-move-next": (id) => actions["deal-move-shift"](id, 1),
  "deal-move-prev": (id) => actions["deal-move-shift"](id, -1),

  /** 商机阶段按顺序前进/后退一格。 */
  "deal-move-shift": (id, step) => {
    const deal = store.getDeal(id);
    if (!deal) return toast("商机不存在", "danger");
    const index = stageValues.indexOf(deal.stage);
    const nextIndex = index + step;
    if (index < 0 || nextIndex < 0 || nextIndex >= stageValues.length) return;
    const nextStage = stageValues[nextIndex];
    store.moveDealStage(id, nextStage);
    toast(`「${deal.title}」已进入「${stageLabelText(nextStage)}」`, "success");
  },

  /* 跟进记录 */
  /** 看板卡片上的「记跟进」：归属对象预设为该商机。 */
  "deal-activity-create": (id) => {
    const deal = store.getDeal(id);
    if (!deal) return toast("商机不存在", "danger");
    formDialog({
      title: `新增跟进 · ${deal.title}`,
      body: activityForm({ targetType: "deal", targetId: id }, store.state.customers, store.state.deals),
      validate: validateActivity,
      submitLabel: "保存跟进",
      onSubmit: (data) => {
        store.createActivity(data);
        toast("跟进记录已保存", "success");
      },
    });
  },

  "activity-create": (id) => {
    const route = parseRoute();
    const preset =
      route.name === "customers" && route.id
        ? { targetType: "customer", targetId: route.id }
        : { targetType: "customer", targetId: "" };
    if (!store.state.customers.length && !store.state.deals.length) {
      return toast("请先创建客户或商机，再记录跟进", "warn");
    }
    formDialog({
      title: "新增跟进",
      body: activityForm(preset, store.state.customers, store.state.deals),
      validate: validateActivity,
      submitLabel: "保存跟进",
      onSubmit: (data) => {
        store.createActivity(data);
        toast("跟进记录已保存", "success");
      },
    });
  },

  "activity-edit": (id) => {
    const activity = store.getActivity(id);
    if (!activity) return toast("跟进记录不存在", "danger");
    formDialog({
      title: "编辑跟进",
      body: activityForm(activity, store.state.customers, store.state.deals),
      validate: validateActivity,
      onSubmit: (data) => {
        store.updateActivity(id, data);
        toast("跟进记录已更新", "success");
      },
    });
  },

  "activity-delete": (id) => {
    const activity = store.getActivity(id);
    if (!activity) return toast("跟进记录不存在", "danger");
    confirmDialog({
      title: "删除跟进记录",
      message: `确定删除 ${formatDateTime(activity.datetime)} 的这条跟进记录吗？`,
      onConfirm: () => {
        store.removeActivity(id);
        toast("跟进记录已删除", "success");
      },
    });
  },

  /* 工具栏：重置筛选条件 */
  "customer-reset": () => {
    resetCustomersPage();
    renderRoute();
  },
  "lead-reset": () => {
    resetListQuery(leadsQuery, { status: "" });
    renderRoute();
  },
  "deal-reset": () => {
    resetListQuery(dealsQuery, { owner: "", customerId: "" });
    renderRoute();
  },
  "activity-reset": () => {
    resetListQuery(activitiesQuery, { method: "", scope: "" });
    renderRoute();
  },

  /* 数据管理 */
  "export-json": () => {
    download(exportFilename(), store.exportJson());
    store.state.meta.lastExportAt = new Date().toISOString();
    toast("已导出 JSON 备份文件", "success");
    renderRoute();
  },

  "copy-json": async () => {
    const text = store.exportJson();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
      }
      toast("JSON 已复制到剪贴板", "success");
    } catch (error) {
      toast("复制失败，请改用「导出 JSON」下载文件", "danger");
    }
  },

  "import-json": () => {
    if (importFile) importFile.click();
  },

  "clear-data": () =>
    confirmDialog({
      title: "清空全部数据",
      message: "将删除所有客户、联系人、线索、商机与跟进记录，且不可撤销。建议先导出备份。",
      confirmLabel: "确认清空",
      onConfirm: () => {
        store.clearAll();
        toast("数据已清空", "success");
      },
    }),

  "reset-demo": () =>
    confirmDialog({
      title: "恢复演示数据",
      message: "将用内置的演示数据集替换当前全部数据，当前数据会丢失。建议先导出备份。",
      confirmLabel: "确认恢复",
      variant: "btn--primary",
      onConfirm: () => {
        store.resetDemo();
        toast("已恢复演示数据", "success");
      },
    }),
};

/* 阶段顺序：商机「上一阶段 / 下一阶段」按钮依赖它 */
const stageValues = DEAL_STAGES.map((stage) => stage.value);
const stageLabelText = (value) => stageOf(value).label;

/* ---------------- 事件绑定 ---------------- */

/** 统一处理 [data-action] 点击。 */
function onActionClick(event, node) {
  const action = node.dataset.action;
  if (!action) return;
  if (action === "modal-close") {
    event.preventDefault();
    closeModal();
    return;
  }
  if (action === "open-data-panel") {
    event.preventDefault();
    toggleDataPanel(true);
    return;
  }
  // 文件选择框保持浏览器原生行为，导入逻辑由 change 事件处理
  if (action === "import-file") return;
  const handler = actions[action];
  if (!handler) return;
  event.preventDefault();
  handler(node.dataset.id, node);
}

/** 处理模态框底部按钮。 */
function onModalFootClick(event, node) {
  const action = node.dataset.modalAction;
  if (!action) return;
  if (action === "cancel") {
    closeModal();
    return;
  }
  if (action === "confirm") {
    if (typeof modalConfirm === "function") modalConfirm();
  }
}

/** 展开/收起数据面板。 */
function toggleDataPanel(open) {
  if (!dataPanel) return;
  const next = typeof open === "boolean" ? open : dataPanel.hidden;
  toggleHidden(dataPanel, !next);
  if (btnData) btnData.setAttribute("aria-expanded", String(next));
}

/** 视图内的排序、分页与筛选控件。 */
function onViewClick(event, node) {
  const sortField = node.dataset.sort;
  if (sortField) {
    applySort(sortField);
    return true;
  }
  const page = node.dataset.page;
  if (page) {
    applyPage(page);
    return true;
  }
  return false;
}

/** 排序：同一字段切换方向，不同字段重置为升序。 */
function applySort(field) {
  const route = parseRoute();
  const queries = {
    customers: customersQuery,
    leads: leadsQuery,
    deals: dealsQuery,
    activities: activitiesQuery,
  };
  const query = queries[route.name];
  if (!query || !("sort" in query)) return;
  if (query.sort === field) {
    query.direction = query.direction === "asc" ? "desc" : "asc";
  } else {
    query.sort = field;
    query.direction = "asc";
  }
  query.page = 1;
  renderRoute();
}

/** 分页：写入对应视图的查询状态。 */
function applyPage(page) {
  const route = parseRoute();
  const queries = {
    customers: customersQuery,
    leads: leadsQuery,
    activities: activitiesQuery,
  };
  const query = queries[route.name];
  if (!query) return;
  query.page = Number(page) || 1;
  renderRoute();
}

/** 筛选控件（输入框与下拉框）。 */
function onFilterEvent(event, node) {
  const key = node.dataset.filter;
  if (!key) return;
  const value = node.type === "checkbox" ? node.checked : node.value;
  // 关键词/状态等同名筛选控件在不同列表页复用，按当前路由决定归属
  const routeName = parseRoute().name;
  switch (key) {
    case "keyword":
      // 关键词输入的归属由当前激活视图决定
      switch (routeName) {
        case "leads":
          leadsQuery.keyword = value;
          leadsQuery.page = 1;
          break;
        case "deals":
          dealsQuery.keyword = value;
          break;
        case "activities":
          activitiesQuery.keyword = value;
          activitiesQuery.page = 1;
          break;
        default:
          customersQuery.keyword = value;
          customersQuery.page = 1;
      }
      break;
    case "status":
      if (routeName === "leads") {
        leadsQuery.status = value;
        leadsQuery.page = 1;
      } else {
        customersQuery.status = value;
        customersQuery.page = 1;
      }
      break;
    case "source":
      customersQuery.source = value;
      customersQuery.page = 1;
      break;
    case "page-size":
      customersQuery.pageSize = Number(value) || DEFAULT_PAGE_SIZE;
      customersQuery.page = 1;
      break;
    case "owner":
      dealsQuery.owner = value;
      break;
    case "customer":
      dealsQuery.customerId = value;
      break;
    case "method":
      activitiesQuery.method = value;
      activitiesQuery.page = 1;
      break;
    case "scope":
      activitiesQuery.scope = value;
      activitiesQuery.page = 1;
      break;
    default:
      return;
  }
  // 文本输入保持焦点，避免每敲一个字符就重绘打断输入
  if (node.tagName === "INPUT" && node.type === "search") {
    scheduleSoftRefresh();
  } else {
    renderRoute();
  }
}

/** 搜索框输入：延迟重绘并恢复焦点与光标位置。 */
let softTimer = 0;
function scheduleSoftRefresh() {
  window.clearTimeout(softTimer);
  softTimer = window.setTimeout(() => {
    const active = document.activeElement;
    const key = active && active.dataset ? active.dataset.filter : "";
    const caret = active && active.selectionStart;
    renderRoute();
    const restored = key ? qs(`[data-filter="${key}"]`) : null;
    if (restored && restored.focus) {
      restored.focus();
      if (typeof caret === "number" && restored.setSelectionRange) {
        restored.setSelectionRange(caret, caret);
      }
    }
  }, 180);
}

/* ---------------- 看板拖拽 ---------------- */

let draggingId = null;

/** 拖拽开始时记录商机 id。 */
function onDragStart(event) {
  const card = event.target.closest(".kanban-card");
  if (!card) return;
  draggingId = card.dataset.dealId;
  card.classList.add("is-dragging");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingId);
  }
}

/** 拖拽结束清理样式。 */
function onDragEnd() {
  document.querySelectorAll(".kanban-card.is-dragging").forEach((card) => card.classList.remove("is-dragging"));
  document.querySelectorAll(".kanban-drop-active").forEach((col) => col.classList.remove("kanban-drop-active"));
  draggingId = null;
}

/** 拖拽经过阶段列时高亮。 */
function onDragOver(event) {
  const column = event.target.closest("[data-drop-stage]");
  if (!column || !draggingId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".kanban-drop-active").forEach((col) => {
    if (col !== column) col.classList.remove("kanban-drop-active");
  });
  column.classList.add("kanban-drop-active");
}

/** 投放：切换商机阶段并提示。 */
function onDrop(event) {
  const column = event.target.closest("[data-drop-stage]");
  if (!column) return;
  event.preventDefault();
  const dealId = draggingId || (event.dataTransfer ? event.dataTransfer.getData("text/plain") : "");
  const stage = column.dataset.dropStage;
  column.classList.remove("kanban-drop-active");
  const deal = store.getDeal(dealId);
  if (!deal || !stage || deal.stage === stage) {
    draggingId = null;
    return;
  }
  store.moveDealStage(dealId, stage);
  toast(`「${deal.title}」已进入「${stageOf(stage).label}」`, "success");
  draggingId = null;
}

/* ---------------- 启动 ---------------- */

/** 绑定全局事件。 */
function bindEvents() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const modalAction = target.closest("[data-modal-action]");
    if (modalAction) return onModalFootClick(event, modalAction);

    const actionNode = target.closest("[data-action]");
    if (actionNode) return onActionClick(event, actionNode);

    if (onViewClick(event, target.closest("[data-sort], [data-page]") || target)) return;
  });

  // 筛选控件：输入框与下拉框
  document.addEventListener("input", (event) => {
    const node = event.target instanceof Element ? event.target.closest("[data-filter]") : null;
    if (node) onFilterEvent(event, node);
  });
  document.addEventListener("change", (event) => {
    const node = event.target instanceof Element ? event.target.closest("[data-filter]") : null;
    if (node) onFilterEvent(event, node);
  });

  // 排序与分页用 change/click 之外的委托已覆盖；这里补充键盘可达性
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && !modal.hidden) closeModal();
  });

  // 看板拖拽
  viewHost.addEventListener("dragstart", onDragStart);
  viewHost.addEventListener("dragend", onDragEnd);
  viewHost.addEventListener("dragover", onDragOver);
  viewHost.addEventListener("drop", onDrop);

  // 移动端导航
  if (navToggle) {
    navToggle.addEventListener("click", () => {
      const open = appNav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
  }
  if (appNav) {
    appNav.addEventListener("click", (event) => {
      if (event.target.closest("a")) closeNav();
    });
  }

  // 数据面板
  if (btnData) btnData.addEventListener("click", () => toggleDataPanel());
  const panelClose = qs("#data-panel-close");
  if (panelClose) panelClose.addEventListener("click", () => toggleDataPanel(false));
  const exportBtn = qs("#btn-export");
  if (exportBtn) exportBtn.addEventListener("click", () => actions["export-json"]());
  const clearBtn = qs("#btn-clear");
  if (clearBtn) clearBtn.addEventListener("click", () => actions["clear-data"]());

  // 顶部「数据」面板提供的导入入口
  if (importFile) {
    importFile.addEventListener("change", () => {
      const file = importFile.files && importFile.files[0];
      importFile.value = "";
      if (!file) return;
      const mode = qs("#import-mode") ? qs("#import-mode").value : "replace";
      readJsonFile(file, (text) => {
        try {
          const counts = store.importJson(text, { mode });
          toast(`导入成功：客户 ${counts.customers} · 商机 ${counts.deals} · 跟进 ${counts.activities}`, "success");
        } catch (error) {
          toast(`导入失败：${error.message}`, "danger");
        }
      });
    });
  }

  // 数据管理页内的文件输入
  const pageImport = qs("#import-file-input");
  if (pageImport) {
    pageImport.addEventListener("change", () => {
      const file = pageImport.files && pageImport.files[0];
      pageImport.value = "";
      if (!file) return;
      const modeSelect = qs("#import-mode");
      readJsonFile(file, (text) => {
        try {
          const counts = store.importJson(text, { mode: modeSelect ? modeSelect.value : "replace" });
          toast(`导入成功：客户 ${counts.customers} · 商机 ${counts.deals} · 跟进 ${counts.activities}`, "success");
        } catch (error) {
          toast(`导入失败：${error.message}`, "danger");
        }
      });
    });
  }

  if (importDealsFile) {
    importDealsFile.addEventListener("change", () => {
      const file = importDealsFile.files && importDealsFile.files[0];
      importDealsFile.value = "";
      if (!file) return;
      const modeSelect = qs("#import-mode");
      readJsonFile(file, (text) => {
        try {
          const counts = store.importJson(text, { mode: modeSelect ? modeSelect.value : "replace" });
          toast(`导入成功：客户 ${counts.customers} · 商机 ${counts.deals} · 跟进 ${counts.activities}`, "success");
        } catch (error) {
          toast(`导入失败：${error.message}`, "danger");
        }
      });
    });
  }
}

/** 应用启动。 */
function boot() {
  store.init();
  store.subscribe(() => {
    // 数据变化后重绘当前视图；模态框打开时保持不动，避免打断编辑
    if (!modal || modal.hidden) renderRoute();
  });
  bindEvents();
  window.addEventListener("hashchange", () => {
    closeNav();
    renderRoute();
  });
  if (!window.location.hash) window.location.hash = ROUTES.dashboard;
  renderRoute();
}

boot();
