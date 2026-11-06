/**
 * helpers.js — 通用工具函数（纯函数，无副作用，可单独测试）
 * 约定：所有函数命名使用小驼峰，导出的函数不依赖 DOM。
 */

/** 生成带前缀的唯一 id（时间戳 + 随机串，避免同毫秒内碰撞）。 */
export function createId(prefix = "id") {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}${rand}`;
}

/** 返回当前时间的 ISO 字符串（统一的时间存储格式）。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 把任意输入转成去掉首尾空格的字符串。 */
export function toText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** 金额解析：非法输入返回 0，保留两位小数。 */
export function toAmount(value) {
  const num = Number(String(value ?? "").replace(/[,\s¥￥]/g, ""));
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100) / 100;
}

/** 本地日期字符串 YYYY-MM-DD（用于日期输入框与按天比较）。 */
export function toDateKey(value) {
  const date = toDate(value);
  if (!date) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 把 ISO 字符串、时间戳或 YYYY-MM-DD 解析为 Date，非法返回 null。 */
export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value);
  // 纯日期按本地零点解析，避免 UTC 偏移导致日期偏移一天
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (plain) {
    return new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 今天零点。 */
export function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** 两个日期相差的天数（b - a，按自然日计算）。 */
export function diffInDays(a, b) {
  const dateA = toDate(a);
  const dateB = toDate(b);
  if (!dateA || !dateB) return 0;
  const dayA = new Date(dateA.getFullYear(), dateA.getMonth(), dateA.getDate());
  const dayB = new Date(dateB.getFullYear(), dateB.getMonth(), dateB.getDate());
  return Math.round((dayB - dayA) / 86400000);
}

/** 相对今天的自然语言描述，用于待跟进提醒。 */
export function describeRelativeDay(value) {
  const date = toDate(value);
  if (!date) return "未设置";
  const days = diffInDays(startOfToday(), date);
  if (days === 0) return "今天";
  if (days === 1) return "明天";
  if (days === 2) return "后天";
  if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
  return `${days} 天后`;
}

/** 把 ISO 时间格式化为 YYYY-MM-DD HH:mm（本地时区）。 */
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 同上，只显示到日期。 */
export function formatDate(value) {
  const date = toDate(value);
  if (!date) return "—";
  return toDateKey(date);
}

/** 金额显示：带千分位，默认以元为单位。 */
export function formatAmount(value) {
  const amount = toAmount(value);
  return amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 以「万」为单位显示大额金额，用于仪表盘概览。 */
export function formatAmountShort(value) {
  const amount = toAmount(value);
  if (Math.abs(amount) >= 10000) {
    return `${(amount / 10000).toFixed(2)} 万`;
  }
  return `${amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元`;
}

/** 转义 HTML 文本，避免用户输入破坏结构（唯一允许拼接 HTML 的入口）。 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 截断长文本，超出部分以省略号结尾。 */
export function truncate(value, max = 60) {
  const text = toText(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 取名字首字，用于头像占位与看板简称。 */
export function initialsOf(value) {
  const text = toText(value);
  if (!text) return "?";
  return text.slice(0, 1).toUpperCase();
}

/** 稳定排序：按字段值排序，空值统一排在末尾。 */
export function compareValues(a, b, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA && emptyB) return 0;
  if (emptyA) return 1;
  if (emptyB) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
  return String(a).localeCompare(String(b), "zh-CN") * factor;
}

/** 大小写不敏感的多字段关键词匹配。 */
export function matchesKeyword(keyword, fields) {
  const needle = toText(keyword).toLowerCase();
  if (!needle) return true;
  return fields.some((field) => toText(field).toLowerCase().includes(needle));
}

/** 数组分页，返回当前页切片与分页元信息。 */
export function paginate(items, page, pageSize) {
  const total = items.length;
  const size = Math.max(1, Number(pageSize) || 10);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
  const start = (current - 1) * size;
  return {
    items: items.slice(start, start + size),
    page: current,
    pageSize: size,
    total,
    totalPages,
  };
}

/** 深拷贝：仅处理 JSON 可序列化的数据结构。 */
export function clone(value) {
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      /* 回退到 JSON 拷贝 */
    }
  }
  return JSON.parse(JSON.stringify(value));
}

/** 生成从 start 到 end 的连续整数数组，用于分页页码。 */
export function range(start, end) {
  const out = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}

/** 计算紧凑页码序列，如 [1, '…', 4, 5, 6, '…', 20]。 */
export function pageWindow(current, totalPages, span = 1) {
  if (totalPages <= 7) return range(1, totalPages);
  const pages = new Set([1, totalPages, current]);
  for (let i = 1; i <= span; i += 1) {
    pages.add(current - i);
    pages.add(current + i);
  }
  const sorted = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const page of sorted) {
    if (prev && page - prev > 1) out.push("…");
    out.push(page);
    prev = page;
  }
  return out;
}
