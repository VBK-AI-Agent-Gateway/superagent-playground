/**
 * dashboard.js — 仪表盘视图
 * 展示：核心指标、商机阶段分布（原生 CSS 条形图）、即将到来的跟进提醒。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatAmount, formatAmountShort, describeRelativeDay, toText } from "../utils/helpers.js";
import { DEAL_STAGES, CLOSED_STAGES } from "../utils/constants.js";
import { pageHead, card, emptyState } from "./ui.js";

/** 单个指标卡。 */
function stat({ label, value, hint = "", tone = "" }) {
  return `
    <div class="stat${tone ? ` stat--${tone}` : ""}">
      <div class="stat__label">${escapeHtml(label)}</div>
      <div class="stat__value">${escapeHtml(value)}</div>
      ${hint ? `<div class="stat__hint">${escapeHtml(hint)}</div>` : ""}
    </div>
  `;
}

/** 阶段分布条形图（纯 CSS 宽度百分比，不依赖图表库）。 */
function stageChart(buckets, totalAmount) {
  const rows = DEAL_STAGES.map((stage) => {
    const bucket = buckets.get(stage.value) || { count: 0, amount: 0 };
    const percent = totalAmount > 0 ? Math.round((bucket.amount / totalAmount) * 100) : 0;
    return `
      <div class="chart__row">
        <div class="chart__label">
          <span class="badge badge--dot stage-badge stage-badge--${stage.tone}">${escapeHtml(stage.label)}</span>
          <span class="chart__count">${bucket.count} 个商机</span>
        </div>
        <div class="chart__track" role="img" aria-label="${escapeHtml(stage.label)} 金额占比 ${percent}%">
          <div class="chart__bar chart__bar--${stage.tone}" style="width:${percent}%"></div>
        </div>
        <div class="chart__value num">¥${escapeHtml(formatAmount(bucket.amount))}<span class="chart__percent">${percent}%</span></div>
      </div>
    `;
  }).join("");
  return `<div class="chart">${rows}</div>`;
}

/** 客户状态分布（横向进度条）。 */
function statusChart(statusCounts, total) {
  if (!total) return emptyState("暂无客户数据", "创建第一个客户后这里会显示状态分布");
  return `<div class="chart">${statusCounts
    .map((item) => {
      const percent = Math.round((item.count / total) * 100);
      return `
        <div class="chart__row">
          <div class="chart__label"><span class="chart__count">${escapeHtml(item.label)}</span></div>
          <div class="chart__track" role="img" aria-label="${escapeHtml(item.label)} 占比 ${percent}%">
            <div class="chart__bar chart__bar--brand" style="width:${percent}%"></div>
          </div>
          <div class="chart__value num">${item.count} 位<span class="chart__percent">${percent}%</span></div>
        </div>
      `;
    })
    .join("")}</div>`;
}

/** 待跟进提醒列表，按日期升序，逾期项高亮。 */
function reminderList(reminders) {
  if (!reminders.length) {
    return emptyState("暂无待跟进事项", "在客户、线索或跟进记录中填写「下次跟进日期」后会自动出现在这里");
  }
  return `<ul class="list">${reminders
    .slice(0, 12)
    .map((row) => {
      const relative = describeRelativeDay(row.nextFollowAt);
      const overdue = relative === "已逾期";
      return `
        <li class="list__item reminder${overdue ? " reminder--overdue" : ""}">
          <div class="list__main">
            <a class="list__title" href="${escapeHtml(row.href)}">${escapeHtml(row.title)}</a>
            <div class="list__sub">${escapeHtml(row.subtitle)}</div>
          </div>
          <div class="list__side">
            <span class="badge ${overdue ? "badge--danger" : "badge--warn"}">${escapeHtml(relative)}</span>
            <time class="list__date">${escapeHtml(toText(row.nextFollowAt))}</time>
          </div>
        </li>
      `;
    })
    .join("")}</ul>`;
}

/** 渲染仪表盘。 */
export function renderDashboard() {
  const stats = store.getStats();
  const buckets = new Map(stats.stageBuckets);
  const openStages = DEAL_STAGES.filter((stage) => !CLOSED_STAGES.includes(stage.value));
  const openCount = openStages.reduce((sum, stage) => sum + ((buckets.get(stage.value) || {}).count || 0), 0);
  const winRate = stats.dealCount ? Math.round((stats.wonDealCount / stats.dealCount) * 100) : 0;

  const metrics = `
    <div class="stat-grid">
      ${stat({ label: "客户总数", value: String(stats.customerCount), hint: `${stats.contactCount} 位联系人` })}
      ${stat({ label: "商机金额总计", value: `¥${formatAmount(stats.totalAmount)}`, hint: `进行中 ¥${formatAmount(stats.openAmount)}` })}
      ${stat({ label: "进行中商机", value: String(openCount), hint: `共 ${stats.dealCount} 个商机` })}
      ${stat({ label: "赢单金额", value: `¥${formatAmountShort(stats.wonAmount)}`, hint: `赢单率 ${winRate}%`, tone: "ok" })}
      ${stat({ label: "线索待转化", value: String(stats.openLeadCount), hint: `已转化 ${stats.convertedLeadCount} 条` })}
      ${stat({ label: "跟进记录", value: String(stats.activityCount), hint: `待跟进 ${stats.reminders.length} 项` })}
    </div>
  `;

  const body = `
    <div class="stack">
      ${metrics}
      <div class="grid-2">
        ${card({
          title: "商机阶段分布",
          subtitle: "按预计金额占比统计",
          body: stageChart(buckets, stats.totalAmount),
        })}
        ${card({
          title: "客户状态分布",
          subtitle: "按客户数量统计",
          body: statusChart(stats.statusCounts, stats.customerCount),
        })}
      </div>
      ${card({
        title: "即将到来的跟进提醒",
        subtitle: "按下一次跟进日期升序排列，逾期项已标红",
        actions: `<a class="btn btn--ghost btn--sm" href="#/activities">去记录跟进</a>`,
        body: reminderList(stats.reminders),
      })}
    </div>
  `;

  return `
    ${pageHead({
      title: "仪表盘",
      subtitle: "销售全局概览与待办提醒",
      actions: `
        <a class="btn btn--ghost" href="#/leads">录入线索</a>
        <a class="btn btn--primary" href="#/customers">客户管理</a>
      `,
    })}
    ${body}
  `;
}
