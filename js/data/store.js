/**
 * store.js — 统一数据层（唯一的状态变更入口）
 *
 * 设计要点：
 * 1. 全部状态保存在内存 state 中，每次变更后同步写入 localStorage；
 * 2. 视图层只调用 store 暴露的方法，不直接读写 localStorage；
 * 3. subscribe(listener) 用于视图订阅变更，返回取消订阅函数；
 * 4. 实体关系：客户 1—n 联系人 / 商机 / 跟进记录；线索转化后生成客户与商机。
 */

import { createId, nowIso, toAmount, toDate, clone, toText } from "../utils/helpers.js";
import { STORAGE_KEY, DATA_VERSION, CLOSED_STAGES, stageOf, labelOf, CUSTOMER_STATUS } from "../utils/constants.js";
import { buildSeedState } from "./seed.js";

/** 空数据集：新建或清空后使用。 */
function emptyState() {
  return {
    version: DATA_VERSION,
    customers: [],
    contacts: [],
    leads: [],
    deals: [],
    activities: [],
    changes: [],
    meta: { createdAt: nowIso(), updatedAt: nowIso(), seeded: false },
  };
}

/** 保证从 localStorage 读到的结构完整（缺字段时补齐，避免旧数据导致崩溃）。 */
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const listKeys = ["customers", "contacts", "leads", "deals", "activities", "changes"];
  listKeys.forEach((key) => {
    base[key] = Array.isArray(raw[key]) ? raw[key] : [];
  });
  if (raw.meta && typeof raw.meta === "object") {
    base.meta = { ...base.meta, ...raw.meta };
  }
  base.version = Number(raw.version) || DATA_VERSION;
  return base;
}

/** 读取 localStorage，返回规范化后的状态。 */
function readStorage() {
  try {
    const text = window.localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    return normalizeState(JSON.parse(text));
  } catch (error) {
    // 存储被禁用或数据损坏时退回空状态，保证应用可用
    console.warn("[store] 读取本地数据失败，已使用空数据集：", error.message);
    return null;
  }
}

/** 写入 localStorage（失败时只提示，不阻断操作）。 */
function writeStorage(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (error) {
    console.warn("[store] 写入本地数据失败：", error.message);
    return false;
  }
}

/** 通过名称匹配已有客户，用于线索转化时避免重复建档。 */
function findByCustomerName(state, name) {
  const target = toText(name).toLowerCase();
  if (!target) return null;
  return state.customers.find((item) => toText(item.name).toLowerCase() === target) || null;
}

export const store = {
  state: emptyState(),
  listeners: new Set(),

  /** 启动：从 localStorage 载入，没有数据时装载演示数据。 */
  init({ seed = true } = {}) {
    const stored = readStorage();
    if (stored) {
      this.state = stored;
    } else if (seed) {
      this.state = buildSeedState();
      writeStorage(this.state);
    } else {
      this.state = emptyState();
    }
    this.emit("init");
    return this.state;
  },

  /** 订阅状态变更，返回取消订阅函数。 */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },

  /** 广播变更事件，视图据此重绘。 */
  emit(reason = "update") {
    this.state.meta.updatedAt = nowIso();
    this.listeners.forEach((listener) => {
      try {
        listener(this.state, reason);
      } catch (error) {
        console.error("[store] 订阅回调执行失败：", error);
      }
    });
  },

  /** 统一提交入口：写存储 + 广播。 */
  commit(reason, mutate) {
    if (typeof mutate === "function") mutate(this.state);
    const ok = writeStorage(this.state);
    this.emit(reason);
    return ok;
  },

  /** 记录变更日志（保留最近 30 条）。 */
  logChange(action, entity, detail) {
    this.state.changes.unshift({
      id: createId("chg"),
      action,
      entity,
      detail,
      at: nowIso(),
    });
    this.state.changes = this.state.changes.slice(0, 30);
  },

  /* ---------------- 查询 ---------------- */

  /** 按 id 查客户。 */
  getCustomer(id) {
    return this.state.customers.find((item) => item.id === id) || null;
  },

  /** 按 id 查线索。 */
  getLead(id) {
    return this.state.leads.find((item) => item.id === id) || null;
  },

  /** 按 id 查商机。 */
  getDeal(id) {
    return this.state.deals.find((item) => item.id === id) || null;
  },

  /** 按 id 查跟进记录。 */
  getActivity(id) {
    return this.state.activities.find((item) => item.id === id) || null;
  },

  /** 某客户的联系人列表。 */
  contactsOf(customerId) {
    return this.state.contacts.filter((item) => item.customerId === customerId);
  },

  /** 某客户的商机列表。 */
  dealsOf(customerId) {
    return this.state.deals.filter((item) => item.customerId === customerId);
  },

  /** 某客户（可选含其商机）的跟进记录，按下一次跟进时间升序。 */
  activitiesOf(customerId, { includeDeals = true } = {}) {
    const dealIds = includeDeals ? this.dealsOf(customerId).map((deal) => deal.id) : [];
    return this.state.activities
      .filter(
        (item) =>
          (item.targetType === "customer" && item.targetId === customerId) ||
          (item.targetType === "deal" && dealIds.includes(item.targetId))
      )
      .sort((a, b) => sortByDate(a.datetime, b.datetime));
  },

  /** 商机的跟进记录。 */
  activitiesOfDeal(dealId) {
    return this.state.activities
      .filter((item) => item.targetType === "deal" && item.targetId === dealId)
      .sort((a, b) => sortByDate(a.datetime, b.datetime));
  },

  /** 客户或商机的展示名称。 */
  targetName(targetType, targetId) {
    if (targetType === "deal") {
      const deal = this.getDeal(targetId);
      return deal ? deal.title : "（已删除的商机）";
    }
    const customer = this.getCustomer(targetId);
    return customer ? customer.name : "（已删除的客户）";
  },

  /** 商机所属客户名称。 */
  customerNameOfDeal(deal) {
    const customer = deal ? this.getCustomer(deal.customerId) : null;
    return customer ? customer.name : "—";
  },

  /* ---------------- 客户 ---------------- */

  /** 新增客户，返回新客户对象。 */
  createCustomer(input) {
    const now = nowIso();
    const customer = {
      id: createId("cus"),
      name: toText(input.name),
      company: toText(input.company),
      industry: toText(input.industry),
      status: input.status || "potential",
      source: toText(input.source),
      owner: toText(input.owner),
      phone: toText(input.phone),
      email: toText(input.email),
      address: toText(input.address),
      tags: parseTags(input.tags),
      note: toText(input.note),
      nextFollowAt: input.nextFollowAt || "",
      createdAt: now,
      updatedAt: now,
    };
    this.commit("customer:create", (state) => {
      state.customers.unshift(customer);
      this.logChange("新增客户", "customer", customer.name);
    });
    return customer;
  },

  /** 编辑客户基础字段。 */
  updateCustomer(id, patch) {
    const customer = this.getCustomer(id);
    if (!customer) return null;
    this.commit("customer:update", (state) => {
      const target = state.customers.find((item) => item.id === id);
      Object.assign(target, sanitizeCustomerPatch(patch));
      if (patch.tags !== undefined) target.tags = parseTags(patch.tags);
      target.updatedAt = nowIso();
      this.logChange("更新客户", "customer", target.name);
    });
    return this.getCustomer(id);
  },

  /** 删除客户，并级联删除其联系人、商机与跟进记录。 */
  removeCustomer(id) {
    const customer = this.getCustomer(id);
    if (!customer) return false;
    this.commit("customer:remove", (state) => {
      const dealIds = state.deals.filter((deal) => deal.customerId === id).map((deal) => deal.id);
      state.customers = state.customers.filter((item) => item.id !== id);
      state.contacts = state.contacts.filter((item) => item.customerId !== id);
      state.deals = state.deals.filter((item) => item.customerId !== id);
      state.activities = state.activities.filter(
        (item) =>
          !(item.targetType === "customer" && item.targetId === id) &&
          !(item.targetType === "deal" && dealIds.includes(item.targetId))
      );
      this.logChange("删除客户", "customer", customer.name);
    });
    return true;
  },

  /* ---------------- 联系人 ---------------- */

  /** 新增联系人。 */
  createContact(customerId, input) {
    const contact = {
      id: createId("con"),
      customerId,
      name: toText(input.name),
      title: toText(input.title),
      phone: toText(input.phone),
      email: toText(input.email),
      isPrimary: Boolean(input.isPrimary),
      note: toText(input.note),
      createdAt: nowIso(),
    };
    this.commit("contact:create", (state) => {
      state.contacts.push(contact);
      this.logChange("新增联系人", "contact", `${contact.name}`);
    });
    return contact;
  },

  /** 编辑联系人。 */
  updateContact(id, patch) {
    const exists = this.state.contacts.some((item) => item.id === id);
    if (!exists) return null;
    this.commit("contact:update", (state) => {
      const target = state.contacts.find((item) => item.id === id);
      ["name", "title", "phone", "email", "note"].forEach((key) => {
        if (patch[key] !== undefined) target[key] = toText(patch[key]);
      });
      if (patch.isPrimary !== undefined) target.isPrimary = Boolean(patch.isPrimary);
    });
    return this.state.contacts.find((item) => item.id === id);
  },

  /** 删除联系人。 */
  removeContact(id) {
    const exists = this.state.contacts.some((item) => item.id === id);
    if (!exists) return false;
    this.commit("contact:remove", (state) => {
      state.contacts = state.contacts.filter((item) => item.id !== id);
    });
    return true;
  },

  /* ---------------- 线索 ---------------- */

  /** 新增线索。 */
  createLead(input) {
    const now = nowIso();
    const lead = {
      id: createId("lea"),
      name: toText(input.name),
      company: toText(input.company),
      phone: toText(input.phone),
      email: toText(input.email),
      source: toText(input.source),
      owner: toText(input.owner),
      status: input.status || "new",
      note: toText(input.note),
      nextFollowAt: input.nextFollowAt || "",
      convertedCustomerId: "",
      convertedDealId: "",
      createdAt: now,
      updatedAt: now,
    };
    this.commit("lead:create", (state) => {
      state.leads.unshift(lead);
      this.logChange("新增线索", "lead", lead.name);
    });
    return lead;
  },

  /** 编辑线索。 */
  updateLead(id, patch) {
    const lead = this.getLead(id);
    if (!lead) return null;
    this.commit("lead:update", (state) => {
      const target = state.leads.find((item) => item.id === id);
      ["name", "company", "phone", "email", "source", "owner", "note", "status", "nextFollowAt"].forEach((key) => {
        if (patch[key] !== undefined) target[key] = toText(patch[key]);
      });
      target.updatedAt = nowIso();
      this.logChange("更新线索", "lead", target.name);
    });
    return this.getLead(id);
  },

  /** 删除线索。 */
  removeLead(id) {
    const lead = this.getLead(id);
    if (!lead) return false;
    this.commit("lead:remove", (state) => {
      state.leads = state.leads.filter((item) => item.id !== id);
      this.logChange("删除线索", "lead", lead.name);
    });
    return true;
  },

  /**
   * 线索转化：按需求文档生成客户档案，并可同时创建商机。
   * 若已存在同名客户，则复用该客户而不再重复建档。
   * 返回 { customer, deal, reused }。
   */
  convertLead(id, options = {}) {
    const lead = this.getLead(id);
    if (!lead) return null;
    const { createDeal = true, dealTitle = "", dealAmount = 0, dealStage = "contact" } = options;
    let customer = findByCustomerName(this.state, lead.name);
    const reused = Boolean(customer);

    if (!customer) {
      customer = {
        id: createId("cus"),
        name: lead.name,
        company: lead.company,
        industry: "",
        status: "following",
        source: lead.source,
        owner: lead.owner,
        phone: lead.phone,
        email: lead.email,
        address: "",
        tags: ["线索转化"],
        note: lead.note ? `由线索转化：${lead.note}` : "由线索转化",
        nextFollowAt: lead.nextFollowAt || "",
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
    }

    const deal =
      createDeal === false
        ? null
        : {
            id: createId("dea"),
            title: toText(dealTitle) || `${lead.company || lead.name} 商机`,
            customerId: customer.id,
            amount: toAmount(dealAmount),
            stage: dealStage,
            expectedCloseAt: "",
            owner: lead.owner,
            note: `由线索「${lead.name}」转化`,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };

    this.commit("lead:convert", (state) => {
      if (!reused) state.customers.unshift(customer);
      if (deal) state.deals.unshift(deal);
      const target = state.leads.find((item) => item.id === id);
      target.status = "converted";
      target.convertedCustomerId = customer.id;
      target.convertedDealId = deal ? deal.id : "";
      target.updatedAt = nowIso();
      this.logChange("线索转化", "lead", `${lead.name} → ${customer.name}`);
    });
    return { customer, deal, reused };
  },

  /* ---------------- 商机 ---------------- */

  /** 新增商机。 */
  createDeal(input) {
    const now = nowIso();
    const deal = {
      id: createId("dea"),
      title: toText(input.title),
      customerId: toText(input.customerId),
      amount: toAmount(input.amount),
      stage: input.stage || "contact",
      expectedCloseAt: input.expectedCloseAt || "",
      owner: toText(input.owner),
      note: toText(input.note),
      nextFollowAt: input.nextFollowAt || "",
      createdAt: now,
      updatedAt: now,
    };
    this.commit("deal:create", (state) => {
      state.deals.unshift(deal);
      this.logChange("新增商机", "deal", deal.title);
    });
    return deal;
  },

  /** 编辑商机。 */
  updateDeal(id, patch) {
    const deal = this.getDeal(id);
    if (!deal) return null;
    this.commit("deal:update", (state) => {
      const target = state.deals.find((item) => item.id === id);
      ["title", "customerId", "owner", "note", "expectedCloseAt", "stage", "nextFollowAt"].forEach((key) => {
        if (patch[key] !== undefined) target[key] = toText(patch[key]);
      });
      if (patch.amount !== undefined) target.amount = toAmount(patch.amount);
      target.updatedAt = nowIso();
      this.logChange("更新商机", "deal", target.title);
    });
    return this.getDeal(id);
  },

  /** 仅切换商机阶段（看板拖拽与按钮调用）。 */
  moveDealStage(id, stage) {
    const deal = this.getDeal(id);
    if (!deal || deal.stage === stage) return false;
    this.commit("deal:stage", (state) => {
      const target = state.deals.find((item) => item.id === id);
      target.stage = stage;
      target.updatedAt = nowIso();
      this.logChange("商机阶段", "deal", `${target.title} → ${stageOf(stage).label}`);
    });
    return true;
  },

  /** 删除商机，并删除其专属跟进记录。 */
  removeDeal(id) {
    const deal = this.getDeal(id);
    if (!deal) return false;
    this.commit("deal:remove", (state) => {
      state.deals = state.deals.filter((item) => item.id !== id);
      state.activities = state.activities.filter(
        (item) => !(item.targetType === "deal" && item.targetId === id)
      );
      this.logChange("删除商机", "deal", deal.title);
    });
    return true;
  },

  /* ---------------- 跟进记录 ---------------- */

  /** 新增跟进记录（针对客户或商机）。 */
  createActivity(input) {
    const activity = {
      id: createId("act"),
      targetType: input.targetType === "deal" ? "deal" : "customer",
      targetId: toText(input.targetId),
      method: toText(input.method) || "电话",
      datetime: input.datetime || nowIso(),
      content: toText(input.content),
      nextFollowAt: input.nextFollowAt || "",
      owner: toText(input.owner),
      createdAt: nowIso(),
    };
    this.commit("activity:create", (state) => {
      state.activities.unshift(activity);
      // 同步客户/商机的下次跟进时间，保证列表与提醒一致
      const nextAt = activity.nextFollowAt;
      if (nextAt) {
        if (activity.targetType === "customer") {
          const customer = state.customers.find((item) => item.id === activity.targetId);
          if (customer) customer.nextFollowAt = nextAt;
        } else {
          const deal = state.deals.find((item) => item.id === activity.targetId);
          if (deal) deal.nextFollowAt = nextAt;
        }
      }
      this.logChange("新增跟进", "activity", `${activity.method} · ${this.targetName(activity.targetType, activity.targetId)}`);
    });
    return activity;
  },

  /** 编辑跟进记录。 */
  updateActivity(id, patch) {
    const exists = this.getActivity(id);
    if (!exists) return null;
    this.commit("activity:update", (state) => {
      const target = state.activities.find((item) => item.id === id);
      ["method", "datetime", "content", "nextFollowAt", "owner", "targetType", "targetId"].forEach((key) => {
        if (patch[key] !== undefined) target[key] = toText(patch[key]);
      });
    });
    return this.getActivity(id);
  },

  /** 删除跟进记录。 */
  removeActivity(id) {
    const exists = this.getActivity(id);
    if (!exists) return false;
    this.commit("activity:remove", (state) => {
      state.activities = state.activities.filter((item) => item.id !== id);
    });
    return true;
  },

  /* ---------------- 统计（仪表盘数据源） ---------------- */

  /**
   * 汇总指标：客户总数、商机金额、阶段分布与待跟进提醒。
   * 视图层只消费这里的计算结果，不在视图中重复统计逻辑。
   */
  getStats() {
    const state = this.state;
    const openDeals = state.deals.filter((deal) => !CLOSED_STAGES.includes(deal.stage));
    const wonDeals = state.deals.filter((deal) => deal.stage === "won");
    const totalAmount = state.deals.reduce((sum, deal) => sum + toAmount(deal.amount), 0);
    const openAmount = openDeals.reduce((sum, deal) => sum + toAmount(deal.amount), 0);

    const statusCounts = CUSTOMER_STATUS.map((status) => ({
      ...status,
      count: state.customers.filter((item) => item.status === status.value).length,
    }));

    const stageBuckets = stageBucketsOf(state.deals);

    return {
      customerCount: state.customers.length,
      contactCount: state.contacts.length,
      leadCount: state.leads.length,
      openLeadCount: state.leads.filter((lead) => lead.status === "new" || lead.status === "contacted").length,
      convertedLeadCount: state.leads.filter((lead) => lead.status === "converted").length,
      dealCount: state.deals.length,
      openDealCount: openDeals.length,
      wonDealCount: wonDeals.length,
      totalAmount,
      openAmount,
      wonAmount: wonDeals.reduce((sum, deal) => sum + toAmount(deal.amount), 0),
      activityCount: state.activities.length,
      statusCounts,
      stageBuckets,
      reminders: this.getReminders(),
      upcoming: this.getUpcomingFollowUps(7),
    };
  },

  /** 商机阶段分布：数量与金额。 */
  getStageBuckets() {
    return stageBucketsOf(this.state.deals);
  },

  /**
   * 待跟进提醒：客户、线索与跟进记录中设置的下次跟进时间，按日期升序。
   * 已逾期的排在最前，便于销售优先处理。
   */
  getReminders({ includeOverdue = true, limit = 0 } = {}) {
    const rows = [];
    const push = (row) => {
      if (!row.nextFollowAt) return;
      rows.push(row);
    };

    this.state.customers.forEach((customer) => {
      push({
        kind: "customer",
        id: customer.id,
        title: customer.name,
        subtitle: customer.company || "客户",
        nextFollowAt: customer.nextFollowAt,
        href: `#/customers/${customer.id}`,
      });
    });

    this.state.leads.forEach((lead) => {
      if (lead.status === "converted" || lead.status === "dropped") return;
      push({
        kind: "lead",
        id: lead.id,
        title: lead.name,
        subtitle: `线索 · ${labelOf(CUSTOMER_STATUS, "potential", "潜在")}`,
        nextFollowAt: lead.nextFollowAt,
        href: "#/leads",
      });
    });

    this.state.deals.forEach((deal) => {
      push({
        kind: "deal",
        id: deal.id,
        title: deal.title,
        subtitle: `商机 · ${stageOf(deal.stage).label}`,
        nextFollowAt: deal.nextFollowAt,
        href: "#/deals",
      });
    });

    rows.sort((a, b) => sortByDate(a.nextFollowAt, b.nextFollowAt));
    const today = new Date();
    const filtered = includeOverdue
      ? rows
      : rows.filter((row) => {
          const date = toDate(row.nextFollowAt);
          return date && date >= new Date(today.getFullYear(), today.getMonth(), today.getDate());
        });
    return limit > 0 ? filtered.slice(0, limit) : filtered;
  },

  /** 未来 N 天内的待跟进（含今天，不含已逾期）。 */
  getUpcomingFollowUps(days = 7) {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = new Date(start.getTime() + days * 86400000);
    return this.getReminders({ includeOverdue: false })
      .filter((row) => {
        const date = toDate(row.nextFollowAt);
        return date && date <= end;
      })
      .sort((a, b) => sortByDate(a.nextFollowAt, b.nextFollowAt));
  },

  /* ---------------- 导入 / 导出 ---------------- */

  /** 导出为带元信息的 JSON 字符串。 */
  exportJson() {
    const payload = {
      app: "crm-sales-app",
      version: DATA_VERSION,
      exportedAt: nowIso(),
      counts: {
        customers: this.state.customers.length,
        contacts: this.state.contacts.length,
        leads: this.state.leads.length,
        deals: this.state.deals.length,
        activities: this.state.activities.length,
      },
      data: clone({
        customers: this.state.customers,
        contacts: this.state.contacts,
        leads: this.state.leads,
        deals: this.state.deals,
        activities: this.state.activities,
      }),
    };
    return JSON.stringify(payload, null, 2);
  },

  /**
   * 导入 JSON：支持本项目导出格式，也兼容直接给出的数据对象。
   * mode = "replace" 覆盖现有数据；mode = "merge" 追加并重新分配 id 前缀避免冲突。
   */
  importJson(text, { mode = "replace" } = {}) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSON 解析失败：文件内容不是合法的 JSON");
    }
    const data = parsed && parsed.data ? parsed.data : parsed;
    if (!data || typeof data !== "object") {
      throw new Error("数据结构不符合要求：缺少 data 字段");
    }
    const hasAny = ["customers", "contacts", "leads", "deals", "activities"].some(
      (key) => Array.isArray(data[key]) && data[key].length
    );
    if (!hasAny) {
      throw new Error("导入文件中没有可用的业务数据");
    }

    const incoming = normalizeState({
      customers: data.customers,
      contacts: data.contacts,
      leads: data.leads,
      deals: data.deals,
      activities: data.activities,
    });

    this.commit("data:import", (state) => {
      if (mode === "merge") {
        // 合并模式：重新分配 id，保持引用关系一致
        const idMap = new Map();
        const remap = (collection) =>
          collection.map((item) => {
            const nextId = createId(item.id.split("_")[0] || "id");
            idMap.set(item.id, nextId);
            return { ...item, id: nextId };
          });
        const customers = remap(incoming.customers);
        const deals = remap(incoming.deals);
        const contacts = remap(incoming.contacts).map((item) => ({
          ...item,
          customerId: idMap.get(item.customerId) || item.customerId,
        }));
        const activities = remap(incoming.activities).map((item) => ({
          ...item,
          targetId: idMap.get(item.targetId) || item.targetId,
        }));
        state.customers = state.customers.concat(customers);
        state.deals = state.deals.concat(deals);
        state.contacts = state.contacts.concat(contacts);
        state.activities = state.activities.concat(activities);
      } else {
        state.customers = incoming.customers;
        state.contacts = incoming.contacts;
        state.leads = incoming.leads;
        state.deals = incoming.deals;
        state.activities = incoming.activities;
      }
      this.logChange("导入数据", "data", mode === "merge" ? "合并导入" : "覆盖导入");
    });

    return {
      customers: incoming.customers.length,
      contacts: incoming.contacts.length,
      leads: incoming.leads.length,
      deals: incoming.deals.length,
      activities: incoming.activities.length,
    };
  },

  /** 清空全部业务数据（保留结构）。 */
  clearAll() {
    this.commit("data:clear", (state) => {
      state.customers = [];
      state.contacts = [];
      state.leads = [];
      state.deals = [];
      state.activities = [];
      this.logChange("清空数据", "data", "全部业务数据已清空");
    });
  },

  /** 恢复演示数据。 */
  resetDemo() {
    this.state = buildSeedState();
    writeStorage(this.state);
    this.emit("data:seed");
  },

  /** 变更记录（只读快照）。 */
  getChanges(limit = 12) {
    return this.state.changes.slice(0, limit);
  },
};

/* ---------------- 内部工具 ---------------- */

/** 比较两个日期字符串，空值排在最后。 */
function sortByDate(a, b) {
  const dateA = toDate(a);
  const dateB = toDate(b);
  if (!dateA && !dateB) return 0;
  if (!dateA) return 1;
  if (!dateB) return -1;
  return dateA - dateB;
}

/** 标签解析：支持数组或逗号分隔字符串。 */
function parseTags(value) {
  if (Array.isArray(value)) {
    return value.map((item) => toText(item)).filter(Boolean);
  }
  return toText(value)
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 白名单字段写入，避免外部 patch 覆盖 id/时间戳。 */
function sanitizeCustomerPatch(patch = {}) {
  const allowed = [
    "name",
    "company",
    "industry",
    "status",
    "source",
    "owner",
    "phone",
    "email",
    "address",
    "note",
    "nextFollowAt",
  ];
  const out = {};
  allowed.forEach((key) => {
    if (patch[key] !== undefined) out[key] = toText(patch[key]);
  });
  return out;
}

/** 按阶段汇总商机数量与金额。 */
function stageBucketsOf(deals) {
  const buckets = new Map();
  deals.forEach((deal) => {
    const key = deal.stage;
    const current = buckets.get(key) || { count: 0, amount: 0 };
    current.count += 1;
    current.amount += toAmount(deal.amount);
    buckets.set(key, current);
  });
  return buckets;
}
