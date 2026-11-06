/**
 * store.js — 数据层：localStorage 读写、CRUD、指标统计、JSON 导入导出。
 * 所有数据只保存在浏览器 localStorage 中，不发起任何网络请求。
 */

const STORAGE_KEY = 'crm.data.v1';
const SETTINGS_KEY = 'crm.settings.v1';
const SCHEMA = 'crm-app/1';

export const LEAD_STATUS = ['新建', '跟进中', '已转化', '已流失'];
/** 线索状态流转：新建 → 跟进中 → 已转化 / 已流失 */
export const LEAD_FLOW = {
  '新建': ['跟进中', '已流失'],
  '跟进中': ['已转化', '已流失'],
  '已转化': [],
  '已流失': ['跟进中'],
};

export const DEAL_STAGES = ['初步接洽', '需求确认', '报价', '谈判', '赢单', '输单'];
export const WON_STAGE = '赢单';
export const LOST_STAGE = '输单';

export const CUSTOMER_STATUS = ['潜在', '合作中', '暂停', '已流失'];
export const CUSTOMER_LEVELS = ['A', 'B', 'C'];
export const CUSTOMER_SOURCES = ['官网', '转介绍', '展会', '广告', '电话', '其他'];
export const CONTACT_ROLES = ['决策人', '技术负责人', '采购', '财务', '其他'];

const MAX_LOGS = 200;
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ---------------------------------------------------------------- utilities */

export const today = (ts = Date.now()) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const monthKey = (ts = Date.now()) => today(ts).slice(0, 7);

export const formatDate = (v) => (v ? String(v).slice(0, 10) : '—');

export const formatDateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const formatMoney = (v) => {
  const n = Number(v) || 0;
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
};

/** 金额简写，用于指标卡片与图表标签（如 12.5万） */
export const formatMoneyShort = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 100000000) return `¥${(n / 100000000).toFixed(2)}亿`;
  if (Math.abs(n) >= 10000) return `¥${(n / 10000).toFixed(1)}万`;
  return `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
};

export const todayISO = () => today();

/* -------------------------------------------------------------- normalizers */

const text = (v) => (v == null ? '' : String(v)).trim();
const number = (v) => {
  const n = Number(text(v).replace(/[,\s¥]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
const pick = (v, list, fallback) => (list.includes(text(v)) ? text(v) : fallback);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(text(v)) ? text(v) : '');

const normalizeContact = (c = {}) => ({
  id: text(c.id) || uid('ct'),
  name: text(c.name),
  role: pick(c.role, CONTACT_ROLES, '其他'),
  phone: text(c.phone),
  email: text(c.email),
  wechat: text(c.wechat),
  isPrimary: !!c.isPrimary,
});

const normalizeCustomer = (c = {}) => ({
  id: text(c.id) || uid('cus'),
  name: text(c.name),
  industry: text(c.industry),
  level: pick(c.level, CUSTOMER_LEVELS, 'B'),
  status: pick(c.status, CUSTOMER_STATUS, '潜在'),
  source: pick(c.source, CUSTOMER_SOURCES, '其他'),
  phone: text(c.phone),
  email: text(c.email),
  website: text(c.website),
  address: text(c.address),
  owner: text(c.owner),
  note: text(c.note),
  createdAt: text(c.createdAt) || new Date().toISOString(),
  updatedAt: text(c.updatedAt) || text(c.createdAt) || new Date().toISOString(),
  contacts: Array.isArray(c.contacts) ? c.contacts.map(normalizeContact) : [],
});

const normalizeLead = (l = {}) => ({
  id: text(l.id) || uid('lead'),
  name: text(l.name),
  company: text(l.company),
  phone: text(l.phone),
  email: text(l.email),
  source: pick(l.source, CUSTOMER_SOURCES, '其他'),
  status: pick(l.status, LEAD_STATUS, '新建'),
  owner: text(l.owner),
  note: text(l.note),
  customerId: text(l.customerId) || null,
  createdAt: text(l.createdAt) || new Date().toISOString(),
  updatedAt: text(l.updatedAt) || text(l.createdAt) || new Date().toISOString(),
});

const normalizeDeal = (d = {}) => ({
  id: text(d.id) || uid('deal'),
  title: text(d.title),
  customerId: text(d.customerId) || null,
  leadId: text(d.leadId) || null,
  amount: number(d.amount),
  stage: pick(d.stage, DEAL_STAGES, DEAL_STAGES[0]),
  expectedCloseDate: isoDate(d.expectedCloseDate),
  owner: text(d.owner),
  note: text(d.note),
  createdAt: text(d.createdAt) || new Date().toISOString(),
  updatedAt: text(d.updatedAt) || text(d.createdAt) || new Date().toISOString(),
});

const normalizeFollowup = (f = {}) => ({
  id: text(f.id) || uid('fu'),
  targetType: ['customer', 'lead', 'deal'].includes(text(f.targetType)) ? text(f.targetType) : 'customer',
  targetId: text(f.targetId),
  content: text(f.content),
  operator: text(f.operator),
  at: text(f.at) || new Date().toISOString(),
});

/* ------------------------------------------------------------------- store */

let state = emptyState();
const logs = [];

function emptyState() {
  return { version: SCHEMA, customers: [], leads: [], deals: [], followups: [] };
}

function emptySettings() {
  return { operator: '', seeded: false };
}

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    console.warn('[store] 读取本地存储失败：', err && err.message);
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.warn('[store] 写入本地存储失败：', err && err.message);
    return false;
  }
}

function persist() {
  safeSet(STORAGE_KEY, JSON.stringify(state));
}

function log(type, detail) {
  logs.unshift({ at: new Date().toISOString(), type, detail });
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

/** 清理引用：删除对象后级联删除其跟进记录并解除关联。 */
function cascade() {
  const customerIds = new Set(state.customers.map((c) => c.id));
  const leadIds = new Set(state.leads.map((l) => l.id));
  const dealIds = new Set(state.deals.map((d) => d.id));
  state.followups = state.followups.filter((f) => {
    if (f.targetType === 'customer') return customerIds.has(f.targetId);
    if (f.targetType === 'lead') return leadIds.has(f.targetId);
    return dealIds.has(f.targetId);
  });
  state.deals = state.deals.map((d) => ({
    ...d,
    customerId: d.customerId && !customerIds.has(d.customerId) ? null : d.customerId,
    leadId: d.leadId && !leadIds.has(d.leadId) ? null : d.leadId,
  }));
  state.leads = state.leads.map((l) =>
    l.customerId && !customerIds.has(l.customerId) ? { ...l, customerId: null } : l);
}

/** 载入本地数据（首次运行返回空数据集，不写入示例数据）。 */
export function init() {
  const raw = safeGet(STORAGE_KEY);
  if (raw) {
    try {
      applySnapshot(JSON.parse(raw));
    } catch (err) {
      console.warn('[store] 本地数据解析失败，已重置：', err && err.message);
      state = emptyState();
    }
  } else {
    state = emptyState();
  }
  cascade();
  return state;
}

/* ------------------------------------------------------------ queries ---- */

export const getSettings = () => {
  const raw = safeGet(SETTINGS_KEY);
  if (!raw) return emptySettings();
  try {
    return { ...emptySettings(), ...JSON.parse(raw) };
  } catch (err) {
    return emptySettings();
  }
};

export const saveSettings = (patch) => {
  const next = { ...getSettings(), ...patch };
  safeSet(SETTINGS_KEY, JSON.stringify(next));
  return next;
};

export const getOperator = () => getSettings().operator || '当前用户';

export const getLogs = () => logs.slice();

export const customers = () => state.customers;
export const leads = () => state.leads;
export const deals = () => state.deals;
export const followups = () => state.followups;

export const findCustomer = (id) => state.customers.find((c) => c.id === id) || null;
export const findLead = (id) => state.leads.find((l) => l.id === id) || null;
export const findDeal = (id) => state.deals.find((d) => d.id === id) || null;

/** 记录归属对象（客户/线索/商机）的显示名，用于跟进记录列表。 */
export function targetOf(f) {
  if (f.targetType === 'customer') {
    const c = findCustomer(f.targetId);
    return { type: 'customer', typeLabel: '客户', name: c ? c.name : '(已删除客户)', url: `#/customers/${f.targetId}` };
  }
  if (f.targetType === 'lead') {
    const l = findLead(f.targetId);
    return { type: 'lead', typeLabel: '线索', name: l ? l.name : '(已删除线索)', url: `#/leads/${f.targetId}` };
  }
  const d = findDeal(f.targetId);
  return { type: 'deal', typeLabel: '商机', name: d ? d.title : '(已删除商机)', url: `#/deals/${f.targetId}` };
}

/* ----------------------------------------------------------- mutations --- */

export function createCustomer(input) {
  const now = new Date().toISOString();
  const customer = normalizeCustomer({ ...input, createdAt: now, updatedAt: now });
  state.customers.unshift(customer);
  persist();
  log('customer.create', customer.name);
  return customer;
}

export function updateCustomer(id, input) {
  const idx = state.customers.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const previous = state.customers[idx];
  const merged = normalizeCustomer({
    ...previous,
    ...input,
    id,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
    contacts: input.contacts || previous.contacts,
  });
  state.customers[idx] = merged;
  persist();
  log('customer.update', merged.name);
  return merged;
}

export function deleteCustomer(id) {
  const target = findCustomer(id);
  if (!target) return false;
  state.customers = state.customers.filter((c) => c.id !== id);
  cascade();
  persist();
  log('customer.delete', target.name);
  return true;
}

export function createLead(input) {
  const now = new Date().toISOString();
  const lead = normalizeLead({ ...input, createdAt: now, updatedAt: now });
  state.leads.unshift(lead);
  persist();
  log('lead.create', lead.name);
  return lead;
}

export function updateLead(id, input) {
  const idx = state.leads.findIndex((l) => l.id === id);
  if (idx < 0) return null;
  const previous = state.leads[idx];
  const merged = normalizeLead({
    ...previous,
    ...input,
    id,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  });
  state.leads[idx] = merged;
  persist();
  log('lead.update', merged.name);
  return merged;
}

/** 修改线索状态，遵循 LEAD_FLOW 定义的流转规则。 */
export function changeLeadStatus(id, status) {
  const lead = findLead(id);
  if (!lead) return { ok: false, reason: '线索不存在' };
  if (!LEAD_STATUS.includes(status)) return { ok: false, reason: '未知状态' };
  if (status === lead.status) return { ok: true, lead };
  const allowed = LEAD_FLOW[lead.status] || [];
  if (!allowed.includes(status)) {
    return { ok: false, reason: `不允许从「${lead.status}」直接变更为「${status}」` };
  }
  const next = updateLead(id, { status });
  log('lead.status', `${lead.name}: ${lead.status} → ${status}`);
  return { ok: true, lead: next };
}

/**
 * 线索转化为客户：新建客户（可覆盖字段），线索标记已转化并双向关联。
 * @returns {{ok:boolean, customer?:object, lead?:object, reason?:string}}
 */
export function convertLeadToCustomer(id, overrides = {}) {
  const lead = findLead(id);
  if (!lead) return { ok: false, reason: '线索不存在' };
  if (lead.status === '已转化' || lead.customerId) return { ok: false, reason: '该线索已转化' };
  if (lead.status === '已流失') return { ok: false, reason: '已流失线索需先回到「跟进中」后再转化' };

  const customer = createCustomer({
    name: overrides.name || lead.company || lead.name,
    industry: overrides.industry || '',
    level: overrides.level || 'B',
    status: overrides.status || '潜在',
    source: overrides.source || lead.source,
    phone: overrides.phone || lead.phone,
    email: overrides.email || lead.email,
    owner: overrides.owner || lead.owner || getOperator(),
    note: overrides.note || `由线索「${lead.name}」转化`,
  });

  if (lead.phone || lead.email) {
    updateCustomer(customer.id, {
      contacts: [{
        id: uid('ct'), name: lead.name, role: '决策人',
        phone: lead.phone, email: lead.email, wechat: '', isPrimary: true,
      }],
    });
  }

  const updated = updateLead(lead.id, { status: '已转化', customerId: customer.id });
  log('lead.convert', `${lead.name} → 客户「${customer.name}」`);
  return { ok: true, customer, lead: updated };
}

export function deleteLead(id) {
  const target = findLead(id);
  if (!target) return false;
  state.leads = state.leads.filter((l) => l.id !== id);
  cascade();
  persist();
  log('lead.delete', target.name);
  return true;
}

export function createDeal(input) {
  const now = new Date().toISOString();
  const deal = normalizeDeal({ ...input, createdAt: now, updatedAt: now });
  state.deals.unshift(deal);
  persist();
  log('deal.create', deal.title);
  return deal;
}

export function updateDeal(id, input) {
  const idx = state.deals.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  const previous = state.deals[idx];
  const merged = normalizeDeal({
    ...previous,
    ...input,
    id,
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  });
  state.deals[idx] = merged;
  persist();
  log('deal.update', merged.title);
  return merged;
}

/** 切换商机阶段（看板按钮与列表共用）。 */
export function moveDealStage(id, stage) {
  if (!DEAL_STAGES.includes(stage)) return null;
  const deal = findDeal(id);
  if (!deal || deal.stage === stage) return deal;
  const next = updateDeal(id, { stage });
  log('deal.stage', `${deal.title}: ${deal.stage} → ${stage}`);
  return next;
}

export function deleteDeal(id) {
  const target = findDeal(id);
  if (!target) return false;
  state.deals = state.deals.filter((d) => d.id !== id);
  cascade();
  persist();
  log('deal.delete', target.title);
  return true;
}

/** 新增跟进记录；operator 缺省取当前操作人。 */
export function addFollowup({ targetType, targetId, content, operator, at }) {
  if (!content || !text(content)) return null;
  const record = normalizeFollowup({
    targetType, targetId, content, at,
    operator: operator || getOperator(),
  });
  state.followups.unshift(record);
  persist();
  log('followup.add', `${record.targetType}:${record.targetId}`);
  return record;
}

export function deleteFollowup(id) {
  const before = state.followups.length;
  state.followups = state.followups.filter((f) => f.id !== id);
  if (state.followups.length === before) return false;
  persist();
  log('followup.delete', id);
  return true;
}

/** 跟进记录：按时间倒序。 */
export function listFollowups(targetType, targetId) {
  return state.followups
    .filter((f) => f.targetType === targetType && f.targetId === targetId)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* -------------------------------------------------------------- metrics -- */

export function metrics() {
  const mk = monthKey();
  const won = state.deals.filter((d) => d.stage === WON_STAGE);
  return {
    monthKey: mk,
    customerTotal: state.customers.length,
    customersNewThisMonth: state.customers.filter((c) => String(c.createdAt).slice(0, 7) === mk).length,
    leadTotal: state.leads.length,
    leadsNewThisMonth: state.leads.filter((l) => String(l.createdAt).slice(0, 7) === mk).length,
    leadsActive: state.leads.filter((l) => l.status === '新建' || l.status === '跟进中').length,
    leadsConverted: state.leads.filter((l) => l.status === '已转化').length,
    leadsLost: state.leads.filter((l) => l.status === '已流失').length,
    dealTotal: state.deals.length,
    dealOpen: state.deals.filter((d) => d.stage !== WON_STAGE && d.stage !== LOST_STAGE).length,
    pipelineAmount: state.deals
      .filter((d) => d.stage !== WON_STAGE && d.stage !== LOST_STAGE)
      .reduce((sum, d) => sum + d.amount, 0),
    wonCount: won.length,
    wonAmount: won.reduce((sum, d) => sum + d.amount, 0),
    lostCount: state.deals.filter((d) => d.stage === LOST_STAGE).length,
    followupTotal: state.followups.length,
  };
}

export function leadStatusCounts() {
  return state.leads.reduce((acc, l) => {
    acc[l.status] = (acc[l.status] || 0) + 1;
    return acc;
  }, {});
}

export function dealStageCounts() {
  return state.deals.reduce((acc, d) => {
    if (!acc[d.stage]) acc[d.stage] = { count: 0, amount: 0 };
    acc[d.stage].count += 1;
    acc[d.stage].amount += d.amount;
    return acc;
  }, {});
}

/* ------------------------------------------------------- import / export - */

function snapshot() {
  return {
    version: SCHEMA,
    exportedAt: new Date().toISOString(),
    customers: state.customers,
    leads: state.leads,
    deals: state.deals,
    followups: state.followups,
  };
}

function applySnapshot(data) {
  const src = data && typeof data === 'object' ? data : {};
  state = {
    version: SCHEMA,
    customers: (Array.isArray(src.customers) ? src.customers : []).map(normalizeCustomer),
    leads: (Array.isArray(src.leads) ? src.leads : []).map(normalizeLead),
    deals: (Array.isArray(src.deals) ? src.deals : []).map(normalizeDeal),
    followups: (Array.isArray(src.followups) ? src.followups : []).map(normalizeFollowup),
  };
}

/** 导出为 JSON 字符串（一键导出备份）。 */
export const exportJSON = () => JSON.stringify(snapshot(), null, 2);

/** 触发浏览器下载 data.json，纯前端实现，无网络请求。 */
export function downloadJSON(filename = `crm-backup-${todayISO()}.json`) {
  const blob = new Blob([exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  log('data.export', filename);
  return filename;
}

/**
 * 导入 JSON：解析并覆盖当前数据（导入前自动留一份本地快照以便撤销）。
 * @param {string} jsonText
 * @param {{mode?:'replace'|'merge'}} [options]
 */
export function importJSON(jsonText, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: 'JSON 解析失败：' + (err && err.message) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '数据格式不正确，应为包含 customers/leads/deals/followups 的对象' };
  }
  const keys = ['customers', 'leads', 'deals', 'followups'];
  if (!keys.some((k) => Array.isArray(parsed[k]))) {
    return { ok: false, reason: '未找到可导入的数据字段（customers/leads/deals/followups）' };
  }

  const previous = snapshot();
  if (options.mode === 'merge') {
    const merged = snapshot();
    keys.forEach((k) => {
      const known = new Set(merged[k].map((row) => row.id));
      (Array.isArray(parsed[k]) ? parsed[k] : []).forEach((row) => {
        if (!row || !row.id || !known.has(row.id)) merged[k].push(row);
      });
    });
    applySnapshot(merged);
  } else {
    safeSet(`${STORAGE_KEY}.undo`, JSON.stringify(previous));
    applySnapshot(parsed);
  }
  cascade();
  persist();
  log('data.import', `${state.customers.length} 客户 / ${state.leads.length} 线索 / ${state.deals.length} 商机`);
  return { ok: true, counts: counts() };
}

/** 导入前的上一次数据快照，可用于撤销导入。 */
export function importUndoSnapshot() {
  const raw = safeGet(`${STORAGE_KEY}.undo`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

export function undoImport() {
  const prev = importUndoSnapshot();
  if (!prev) return false;
  applySnapshot(prev);
  cascade();
  persist();
  log('data.import.undo', '');
  return true;
}

export function counts() {
  return {
    customers: state.customers.length,
    leads: state.leads.length,
    deals: state.deals.length,
    followups: state.followups.length,
  };
}

/** 清空全部数据（二次确认由调用方负责）。 */
export function clearAll() {
  state = emptyState();
  persist();
  log('data.clear', '');
  return state;
}

export const store = {
  init,
  LEAD_STATUS, LEAD_FLOW, DEAL_STAGES, WON_STAGE, LOST_STAGE,
  CUSTOMER_STATUS, CUSTOMER_LEVELS, CUSTOMER_SOURCES, CONTACT_ROLES,
  customers, leads, deals, followups,
  findCustomer, findLead, findDeal, targetOf, listFollowups,
  createCustomer, updateCustomer, deleteCustomer,
  createLead, updateLead, changeLeadStatus, convertLeadToCustomer, deleteLead,
  createDeal, updateDeal, moveDealStage, deleteDeal,
  addFollowup, deleteFollowup,
  metrics, leadStatusCounts, dealStageCounts, counts,
  exportJSON, downloadJSON, importJSON, importUndoSnapshot, undoImport, clearAll,
  getOperator, getSettings, saveSettings, getLogs,
  formatDate, formatDateTime, formatMoney, formatMoneyShort, todayISO,
};

export default store;
