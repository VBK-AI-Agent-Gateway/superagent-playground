/**
 * dom.js — 轻量 DOM 辅助函数
 * 只做「查询 + 事件委托 + 表单读写」这几件事，视图层不直接操作 document。
 */

/** 查询单个元素，scope 缺省为 document。 */
export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

/** 查询多个元素并返回真实数组（方便 map/filter）。 */
export function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}

/**
 * 事件委托：在 root 上监听事件类型，命中 selector 时调用 handler。
 * handler 接收 (event, matchedElement, root)。
 */
export function delegate(root, type, selector, handler, options = {}) {
  root.addEventListener(
    type,
    (event) => {
      const target = event.target instanceof Element ? event.target.closest(selector) : null;
      if (!target || !root.contains(target)) return;
      handler(event, target, root);
    },
    options
  );
}

/** 用 HTML 字符串设置元素内容（内容需已转义）。 */
export function setHtml(element, html) {
  if (element) element.innerHTML = html;
}

/** 显示/隐藏元素（使用 hidden 属性，样式表负责 display 规则）。 */
export function toggleHidden(element, hidden) {
  if (element) element.hidden = Boolean(hidden);
}

/** 读取表单字段值，统一转字符串。 */
export function readFields(scope) {
  const data = {};
  qsa("[name]", scope).forEach((field) => {
    if (field.type === "checkbox") {
      data[field.name] = field.checked;
    } else if (field.type === "radio") {
      if (field.checked) data[field.name] = field.value;
    } else {
      data[field.name] = field.value;
    }
  });
  return data;
}

/** 把数据写回表单字段。 */
export function writeFields(scope, data = {}) {
  qsa("[name]", scope).forEach((field) => {
    const value = data[field.name];
    if (value === undefined || value === null) return;
    if (field.type === "checkbox") {
      field.checked = Boolean(value);
    } else {
      field.value = String(value);
    }
  });
}

/** 重置表单并清空错误提示。 */
export function resetForm(form) {
  if (!form) return;
  form.reset();
  qsa(".field__error", form).forEach((node) => {
    node.textContent = "";
  });
}

/** 在表单上按 name 显示校验错误。 */
export function showFieldError(form, name, message) {
  const node = qs(`[data-error-for="${name}"]`, form);
  if (node) node.textContent = message;
}

/** 清空表单全部校验错误。 */
export function clearFieldErrors(form) {
  qsa("[data-error-for]", form).forEach((node) => {
    node.textContent = "";
  });
}

/** 滚动到页面顶部（切换视图时使用）。 */
export function scrollTop() {
  window.scrollTo({ top: 0, behavior: "auto" });
}

/** 渲染下拉选项列表。 */
export function optionsHtml(list, selected, { placeholder = "" } = {}) {
  const head = placeholder ? `<option value="">${placeholder}</option>` : "";
  return (
    head +
    list
      .map((item) => {
        const value = typeof item === "string" ? item : item.value;
        const label = typeof item === "string" ? item : item.label;
        const isSelected = String(value) === String(selected ?? "") ? " selected" : "";
        return `<option value="${value}"${isSelected}>${label}</option>`;
      })
      .join("")
  );
}

/** 生成 `<option>` 列表的原始文本（label 需已转义）。 */
export function rawOptionsHtml(items, selected) {
  return items
    .map((item) => {
      const isSelected = String(item.value) === String(selected ?? "") ? " selected" : "";
      return `<option value="${item.value}"${isSelected}>${item.label}</option>`;
    })
    .join("");
}
