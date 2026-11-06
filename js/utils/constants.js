/**
 * constants.js — 全局枚举、字典与默认配置
 * 集中定义客户状态、线索状态、商机阶段与跟进方式，避免魔法字符串散落各处。
 */

/** 客户状态：潜在 → 跟进中 → 已成交 / 已流失。 */
export const CUSTOMER_STATUS = [
  { value: "potential", label: "潜在客户" },
  { value: "following", label: "跟进中" },
  { value: "won", label: "已成交" },
  { value: "lost", label: "已流失" },
];

/** 客户来源渠道。 */
export const CUSTOMER_SOURCES = [
  "转介绍",
  "展会",
  "官网咨询",
  "电话开发",
  "广告投放",
  "老客户复购",
  "其他",
];

/** 线索状态。 */
export const LEAD_STATUS = [
  { value: "new", label: "待跟进" },
  { value: "contacted", label: "已联系" },
  { value: "converted", label: "已转化" },
  { value: "dropped", label: "已放弃" },
];

/** 商机阶段：需求文档规定的六个阶段，顺序即看板列顺序。 */
export const DEAL_STAGES = [
  { value: "contact", label: "初步接触", tone: "contact" },
  { value: "needs", label: "需求确认", tone: "needs" },
  { value: "quote", label: "报价", tone: "quote" },
  { value: "negotiation", label: "谈判", tone: "negotiation" },
  { value: "won", label: "赢单", tone: "won" },
  { value: "lost", label: "输单", tone: "lost" },
];

/** 关闭态阶段：不再计入进行中的商机统计。 */
export const CLOSED_STAGES = ["won", "lost"];

/** 跟进方式。 */
export const ACTIVITY_METHODS = ["电话", "拜访", "微信", "邮件", "会议", "其他"];

/** 跟进记录的归属类型。 */
export const ACTIVITY_TARGETS = [
  { value: "customer", label: "客户" },
  { value: "deal", label: "商机" },
];

/** 客户列表可排序字段。 */
export const CUSTOMER_SORT_FIELDS = [
  { value: "updatedAt", label: "最近更新" },
  { value: "name", label: "客户名称" },
  { value: "company", label: "公司" },
  { value: "status", label: "状态" },
  { value: "dealAmount", label: "商机总额" },
  { value: "createdAt", label: "创建时间" },
];

/** 客户列表每页条数可选值。 */
export const PAGE_SIZES = [5, 10, 20, 50];

/** 列表默认每页条数。 */
export const DEFAULT_PAGE_SIZE = 10;

/** localStorage 存储键。 */
export const STORAGE_KEY = "crm-sales-app/v1";

/** 数据格式版本，导入时用于兼容性校验。 */
export const DATA_VERSION = 1;

/** 应用内所有 hash 路由。 */
export const ROUTES = {
  dashboard: "#/dashboard",
  customers: "#/customers",
  customerDetail: "#/customers/",
  leads: "#/leads",
  deals: "#/deals",
  activities: "#/activities",
};

/** 根据枚举值取中文标签。 */
export function labelOf(list, value, fallback = "—") {
  const found = list.find((item) => item.value === value);
  return found ? found.label : fallback;
}

/** 根据商机阶段值取阶段定义对象。 */
export function stageOf(value) {
  return DEAL_STAGES.find((stage) => stage.value === value) || DEAL_STAGES[0];
}
