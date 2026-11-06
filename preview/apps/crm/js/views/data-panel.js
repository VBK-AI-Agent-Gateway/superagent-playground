/**
 * data-panel.js — 数据管理视图
 * 提供 JSON 导出、导入（覆盖 / 合并两种模式）、清空数据与恢复演示数据。
 */

import { store } from "../data/store.js";
import { escapeHtml, formatDateTime, formatAmount } from "../utils/helpers.js";
import { pageHead, card, emptyState } from "./ui.js";

/** 数据统计概览。 */
function overview() {
  const stats = store.getStats();
  const lastExport = store.state.meta && store.state.meta.lastExportAt;
  const items = [
    ["客户", `${stats.customerCount} 位`],
    ["联系人", `${stats.contactCount} 位`],
    ["线索", `${stats.leadCount} 条`],
    ["商机", `${stats.dealCount} 个 · ¥${formatAmount(stats.totalAmount)}`],
    ["跟进记录", `${stats.activityCount} 条`],
    ["数据版本", `v${store.state.version || 1}`],
    ["最近导出", lastExport ? formatDateTime(lastExport) : "尚未导出"],
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

/** 最近变更记录。 */
function changeList() {
  const changes = store.getChanges(12);
  if (!changes.length) return emptyState("暂无操作记录", "对数据进行增删改后，这里会保留最近 30 条操作日志");
  const actionLabel = { create: "新增", update: "更新", delete: "删除", import: "导入", clear: "清空", reset: "重置" };
  return `<ul class="list">${changes
    .map(
      (change) => `
      <li class="list__item change-row">
        <div class="list__main">
          <div class="list__title"><span class="badge badge--muted">${escapeHtml(actionLabel[change.action] || change.action)}</span> ${escapeHtml(change.entity)}</div>
          <div class="list__sub">${escapeHtml(change.detail || "")}</div>
        </div>
        <div class="list__side"><time class="list__date">${escapeHtml(formatDateTime(change.at))}</time></div>
      </li>`
    )
    .join("")}</ul>`;
}

/** 渲染数据管理页。 */
export function renderDataPanel() {
  const importOptions = `
    <div class="form-grid">
      <div class="field form-grid--full">
        <label class="field__label" for="import-mode">导入模式</label>
        <select class="select" id="import-mode">
          <option value="replace">覆盖：清空当前数据后写入文件内容</option>
          <option value="merge">合并：保留现有数据，追加文件内容（自动重编号避免冲突）</option>
        </select>
        <div class="field__hint">导入文件应为本站导出的 JSON；格式不符时会给出提示且不修改现有数据。</div>
      </div>
      <div class="field form-grid--full">
        <label class="field__label" for="import-file-input">选择 JSON 文件</label>
        <input class="input" type="file" id="import-file-input" accept="application/json,.json" data-action="import-file" />
      </div>
    </div>
  `;

  return `
    ${pageHead({
      title: "数据管理",
      subtitle: "所有数据保存在浏览器本地（localStorage），可导出备份或导入恢复",
    })}
    <div class="stack">
      <div class="grid-2">
        ${card({
          title: "数据概览",
          body: overview(),
        })}
        ${card({
          title: "导出备份",
          subtitle: "导出为 JSON 文件，用于备份或换设备迁移",
          body: `
            <p class="field__hint">文件包含客户、联系人、线索、商机与跟进记录的全部字段。</p>
            <div class="btn-row">
              <button type="button" class="btn btn--primary" data-action="export-json">导出 JSON</button>
              <button type="button" class="btn btn--ghost" data-action="copy-json">复制到剪贴板</button>
            </div>
          `,
        })}
      </div>
      ${card({ title: "导入数据", subtitle: "支持覆盖与合并两种模式", body: importOptions })}
      ${card({
        title: "危险操作",
        subtitle: "以下操作不可撤销，请先导出备份",
        body: `
          <div class="btn-row">
            <button type="button" class="btn btn--ghost" data-action="reset-demo">恢复演示数据</button>
            <button type="button" class="btn btn--danger" data-action="clear-data">清空全部数据</button>
          </div>
        `,
      })}
      ${card({ title: "最近操作", subtitle: "仅保留最近 30 条", body: changeList() })}
    </div>
  `;
}
