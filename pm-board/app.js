/* app.js — 轻量项目管理页全部业务逻辑（原生 ES6，无框架、无构建、无网络请求）。
 *
 * 数据流：state（内存中的唯一数据源）→ render()（整体重绘三个板块）
 *         → save()（写入 localStorage）
 * 三个板块之所以永远一致，是因为它们都从同一个 state 派生，
 * 任何操作都只改 state 再调用 commit()，不做局部手工同步。
 *
 * 函数分区：
 *   A. 通用工具      —— id / 转义 / 时间格式化 / 颜色
 *   B. 持久化        —— load / save / 重置
 *   C. 查询与统计    —— 成员、任务、在办任务数
 *   D. 业务动作      —— 任务增删移、成员增删（写 state + 写活动）
 *   E. 渲染          —— 看板 / 成员 / 时间线 / 下拉框 / 顶部信息
 *   F. 事件绑定与初始化
 */
(function () {
  'use strict';

  /* ================================================================== *
   * A. 通用工具
   * ================================================================== */

  /** 生成本地唯一 id（时间戳 + 随机串，足够单页使用）。 */
  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** HTML 转义：所有用户输入在拼接模板前必须经过这里，避免注入与破版。 */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 时间戳 → 可读文案（今天 / 昨天 / MM-DD + HH:mm）。 */
  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = pad(d.getHours()) + ':' + pad(d.getMinutes());

    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);

    if (dayDiff === 0) return '今天 ' + hhmm;
    if (dayDiff === 1) return '昨天 ' + hhmm;
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hhmm;
  }

  /** 日期字符串（YYYY-MM-DD）→ 可读文案；无效值原样返回。 */
  function formatDate(value) {
    if (!value) return '未设置';
    const d = new Date(value + 'T00:00:00');
    if (isNaN(d.getTime())) return value;
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 是否已过期：截止日期早于今天，且任务未完成。 */
  function isOverdue(task) {
    if (!task.dueDate || task.status === 'done') return false;
    const d = new Date(task.dueDate + 'T23:59:59');
    return !isNaN(d.getTime()) && d.getTime() < Date.now();
  }

  /** 依据名字稳定地取一个头像底色，保证同一成员每次渲染颜色一致。 */
  function colorFor(name) {
    const palette = ['var(--c0)', 'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)'];
    let hash = 0;
    const text = String(name || '?');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 100000;
    return palette[hash % palette.length];
  }

  /** 取姓名首字母：优先首个字母/汉字，中英混排也能给出占位字符。 */
  function initialOf(name) {
    const text = String(name || '').trim();
    if (!text) return '?';
    return text.replace(/\s+/g, '').charAt(0).toUpperCase();
  }

  /** 头像占位 HTML（颜色随姓名稳定变化）。 */
  function avatarHtml(name, size) {
    return '<span class="avatar avatar--' + size + '" style="background:' + colorFor(name) + '">'
      + escapeHtml(initialOf(name)) + '</span>';
  }

  /** 底部提示条。 */
  let toastTimer = null;
  function toast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('toast--show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('toast--show'), 2200);
  }

  /* ================================================================== *
   * B. 状态与持久化
   * ================================================================== */

  /** 深拷贝初始 mock 数据，避免运行时修改污染 data.js 中的常量。 */
  function seedState() {
    return {
      members: SEED_MEMBERS.map((m) => Object.assign({}, m)),
      tasks: SEED_TASKS.map((t) => Object.assign({}, t)),
      activities: SEED_ACTIVITIES.map((a) => Object.assign({}, a)),
      updatedAt: Date.now()
    };
  }

  /** 从 localStorage 读取；数据损坏或缺失时回退到初始 mock 数据。 */
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return seedState();
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.members) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.activities)) {
        return seedState();
      }
      return parsed;
    } catch (err) {
      console.warn('[pm-board] 本地数据不可用，已回退到初始演示数据：', err);
      return seedState();
    }
  }

  /** 写入 localStorage；失败（隐私模式 / 配额）时提示但是不中断使用。 */
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn('[pm-board] 保存到 localStorage 失败：', err);
      toast('本地存储不可用，本次修改仅保存在内存中');
      return false;
    }
  }

  /** 查询：本地是否已有持久化数据（用于顶部说明文案）。 */
  function hasSavedState() {
    try {
      return localStorage.getItem(STORAGE_KEY) !== null;
    } catch (err) {
      return false;
    }
  }

  /** 统一提交入口：更新时间戳 → 持久化 → 整体重绘。 */
  function commit() {
    state.updatedAt = Date.now();
    saveState();
    render();
  }

  const state = loadState();

  /* ================================================================== *
   * C. 查询与统计
   * ================================================================== */

  function findTask(taskId) {
    return state.tasks.find((t) => t.id === taskId) || null;
  }

  function findMember(memberId) {
    return state.members.find((m) => m.id === memberId) || null;
  }

  function memberName(memberId) {
    const member = findMember(memberId);
    return member ? member.name : '未指派';
  }

  function columnTitle(status) {
    const column = COLUMNS.find((c) => c.id === status);
    return column ? column.title : status;
  }

  function priorityLabel(value) {
    const item = PRIORITIES.find((p) => p.value === value);
    return item ? item.label : value;
  }

  function tasksOfMember(memberId) {
    return state.tasks.filter((t) => t.ownerId === memberId);
  }

  /** 在办任务数：待办 + 进行中（口径见 ACTIVE_STATUSES）。 */
  function activeTaskCount(memberId) {
    return tasksOfMember(memberId).filter((t) => ACTIVE_STATUSES.indexOf(t.status) !== -1).length;
  }

  /* ================================================================== *
   * D. 业务动作（唯一改动 state 的地方，每个动作同时写入一条活动记录）
   * ================================================================== */

  /** 追加一条活动记录（记录瞬间的时间戳，读取时再倒序排序）。 */
  function addActivity(type, text) {
    state.activities.push({ id: uid('a'), at: Date.now(), type: type, text: text });
  }

  /** 新增任务：校验标题与负责人，成功后立即出现在所选列。 */
  function addTask(input) {
    const title = String(input.title || '').trim();
    if (!title) { toast('请填写任务标题'); return false; }

    const ownerId = findMember(input.ownerId) ? input.ownerId : (state.members[0] ? state.members[0].id : '');
    const priority = PRIORITIES.some((p) => p.value === input.priority) ? input.priority : 'medium';
    const status = COLUMNS.some((c) => c.id === input.status) ? input.status : 'todo';
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || '')) ? input.dueDate : '';

    state.tasks.push({ id: uid('t'), title: title, ownerId: ownerId, priority: priority, dueDate: dueDate, status: status });
    addActivity('task_create', '创建任务「' + title + '」（负责人：' + memberName(ownerId) + '，优先级：' + priorityLabel(priority)
      + '，截止：' + formatDate(dueDate) + '，初始状态：' + columnTitle(status) + '）');
    commit();
    toast('已新增任务：' + title);
    return true;
  }

  /** 移动任务到目标列：状态、负责人计数、时间线因同一次 commit() 一起更新。 */
  function moveTask(taskId, targetStatus) {
    const task = findTask(taskId);
    if (!task) return false;
    if (!COLUMNS.some((c) => c.id === targetStatus)) return false;
    if (task.status === targetStatus) { toast('任务已在「' + columnTitle(targetStatus) + '」列'); return false; }

    const from = columnTitle(task.status);
    const to = columnTitle(targetStatus);
    task.status = targetStatus;
    addActivity('task_move', '任务「' + task.title + '」从「' + from + '」移动到「' + to + '」');
    commit();
    return true;
  }

  /** 删除任务：看板卡片与时间线同步变化（成员计数随之减少）。 */
  function deleteTask(taskId) {
    const task = findTask(taskId);
    if (!task) return false;
    if (!window.confirm('确定删除任务「' + task.title + '」吗？')) return false;

    state.tasks = state.tasks.filter((t) => t.id !== taskId);
    addActivity('task_delete', '删除任务「' + task.title + '」（负责人：' + memberName(task.ownerId) + '，原状态：' + columnTitle(task.status) + '）');
    commit();
    toast('已删除任务：' + task.title);
    return true;
  }

  /** 新增成员：姓名必填、不可重名。 */
  function addMember(input) {
    const name = String(input.name || '').trim();
    if (!name) { toast('请填写成员姓名'); return false; }
    if (state.members.some((m) => m.name === name)) { toast('成员「' + name + '」已存在'); return false; }

    const role = String(input.role || '').trim() || '成员';
    state.members.push({ id: uid('m'), name: name, role: role });
    addActivity('member_add', '新增成员「' + name + '」（' + role + '）');
    commit();
    toast('已新增成员：' + name);
    return true;
  }

  /** 移除成员：存在在办任务时阻止，并提示先改派。 */
  function removeMember(memberId) {
    const member = findMember(memberId);
    if (!member) return false;

    const active = activeTaskCount(memberId);
    if (active > 0) {
      toast('「' + member.name + '」还有 ' + active + ' 个在办任务，请先改派或完成后再移除');
      return false;
    }
    if (!window.confirm('确定移除成员「' + member.name + '」吗？')) return false;

    state.members = state.members.filter((m) => m.id !== memberId);
    addActivity('member_remove', '移除成员「' + member.name + '」（' + member.role + '）');
    commit();
    toast('已移除成员：' + member.name);
    return true;
  }

  /** 清空本地数据并恢复初始 mock 数据。 */
  function resetState() {
    if (!window.confirm('将清空本地数据并恢复初始演示数据，确定继续吗？')) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.warn('[pm-board] 清除本地数据失败：', err);
    }
    const fresh = seedState();
    state.members = fresh.members;
    state.tasks = fresh.tasks;
    state.activities = fresh.activities;
    commit();
    toast('已恢复初始演示数据');
  }

  /* ================================================================== *
   * E. 渲染（三个板块全部从 state 派生，保证数据联动一致）
   * ================================================================== */

  /** 渲染看板三列：每列内部按优先级/截止日期排序，卡片带移动与删除操作。 */
  function renderBoard() {
    const board = document.getElementById('board');
    board.innerHTML = COLUMNS.map((column) => {
      const tasks = state.tasks
        .filter((t) => t.status === column.id)
        .sort(compareTasks);

      const cards = tasks.length
        ? tasks.map((task) => renderCard(task, column)).join('')
        : '<p class="column__empty">暂无任务，可拖拽任务到此列</p>';

      return ''
        + '<section class="column" data-column="' + column.id + '">'
        +   '<header class="column__head">'
        +     '<h3 class="column__title">' + escapeHtml(column.title) + '</h3>'
        +     '<span class="column__count">' + tasks.length + '</span>'
        +   '</header>'
        +   '<div class="column__list" data-column-list="' + column.id + '">' + cards + '</div>'
        + '</section>';
    }).join('');

    document.getElementById('board-meta').textContent =
      '共 ' + state.tasks.length + ' 个任务 · 可拖拽卡片或使用「推进 / 退回」按钮';
  }

  /** 看板排序：优先级高→低，其次截止日期早→晚，最后按标题稳定排序。 */
  function compareTasks(a, b) {
    const order = { high: 0, medium: 1, low: 2 };
    const pa = order[a.priority] == null ? 3 : order[a.priority];
    const pb = order[b.priority] == null ? 3 : order[b.priority];
    if (pa !== pb) return pa - pb;

    const da = a.dueDate || '9999-12-31';
    const db = b.dueDate || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;

    return String(a.title).localeCompare(String(b.title));
  }

  /** 单张任务卡片 HTML。 */
  function renderCard(task, column) {
    const index = COLUMNS.findIndex((c) => c.id === column.id);
    const prev = COLUMNS[index - 1];
    const next = COLUMNS[index + 1];
    const overdue = isOverdue(task);

    return ''
      + '<article class="card card--p-' + escapeHtml(task.priority) + '" draggable="true" data-task-id="' + escapeHtml(task.id) + '">'
      +   '<h4 class="card__title">' + escapeHtml(task.title) + '</h4>'
      +   '<div class="card__meta">'
      +     '<span class="tag">' + avatarHtml(memberName(task.ownerId), 'sm') + escapeHtml(memberName(task.ownerId)) + '</span>'
      +     '<span class="tag tag--' + escapeHtml(task.priority) + '">优先级 ' + escapeHtml(priorityLabel(task.priority)) + '</span>'
      +     '<span class="tag' + (overdue ? ' tag--overdue' : '') + '">截止 ' + escapeHtml(formatDate(task.dueDate)) + (overdue ? ' · 已逾期' : '') + '</span>'
      +   '</div>'
      +   '<div class="card__actions">'
      +     (prev ? '<button type="button" class="mini" data-action="move" data-task-id="' + escapeHtml(task.id) + '" data-status="' + prev.id + '">← ' + escapeHtml(prev.title) + '</button>' : '')
      +     (next ? '<button type="button" class="mini" data-action="move" data-task-id="' + escapeHtml(task.id) + '" data-status="' + next.id + '">' + escapeHtml(next.title) + ' →</button>' : '')
      +     '<span class="card__spacer"></span>'
      +     '<button type="button" class="mini mini--danger" data-action="delete" data-task-id="' + escapeHtml(task.id) + '">删除</button>'
      +   '</div>'
      + '</article>';
  }

  /** 渲染成员列表：头像占位 + 姓名 + 角色 + 在办任务数 + 移除按钮。 */
  function renderMembers() {
    const list = document.getElementById('members');
    if (!state.members.length) {
      list.innerHTML = '<li class="column__empty">暂无成员，请先新增成员</li>';
    } else {
      list.innerHTML = state.members.map((member) => {
        const active = activeTaskCount(member.id);
        return ''
          + '<li class="member" data-member-id="' + escapeHtml(member.id) + '">'
          +   avatarHtml(member.name, 'lg')
          +   '<div class="member__body">'
          +     '<div class="member__name">' + escapeHtml(member.name) + '</div>'
          +     '<div class="member__role">' + escapeHtml(member.role || '成员') + '</div>'
          +   '</div>'
          +   '<span class="member__count">在办 ' + active + ' 个</span>'
          +   '<button type="button" class="mini mini--danger" data-action="remove-member" data-member-id="' + escapeHtml(member.id) + '"'
          +     (active > 0 ? ' disabled title="该成员仍有在办任务，先改派后再移除"' : '') + '>移除</button>'
          + '</li>';
      }).join('');
    }

    document.getElementById('members-meta').textContent = state.members.length + ' 人';
  }

  /** 渲染活动时间线：按时间倒序，逐条给出时间戳与描述。 */
  function renderTimeline() {
    const list = document.getElementById('timeline');
    const events = state.activities.slice().sort((a, b) => b.at - a.at);

    list.innerHTML = events.length
      ? events.map((event) => ''
        + '<li class="event event--' + escapeHtml(event.type) + '">'
        +   '<span class="event__dot"></span>'
        +   '<div class="event__body">'
        +     '<div class="event__time">' + escapeHtml(formatTime(event.at)) + '</div>'
        +     '<div class="event__text">' + escapeHtml(event.text) + '</div>'
        +   '</div>'
        + '</li>').join('')
      : '<li class="column__empty">暂无活动记录</li>';

    document.getElementById('timeline-meta').textContent = events.length + ' 条记录 · 最新在前';
  }

  /** 填充“负责人 / 所在列”下拉框；保留用户当前选择，避免重绘后跳回第一项。 */
  function renderOwnerOptions() {
    const ownerSelect = document.getElementById('task-owner');
    const previous = ownerSelect.value;
    ownerSelect.innerHTML = state.members.length
      ? state.members.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.name) + '</option>').join('')
      : '<option value="">（暂无成员）</option>';
    if (previous && findMember(previous)) ownerSelect.value = previous;
  }

  function renderStatusOptions() {
    const statusSelect = document.getElementById('task-status');
    if (!statusSelect.options.length) {
      statusSelect.innerHTML = COLUMNS.map((c) => '<option value="' + c.id + '">' + escapeHtml(c.title) + '</option>').join('');
    }
  }

  function renderPriorityOptions() {
    const prioritySelect = document.getElementById('task-priority');
    if (!prioritySelect.options.length) {
      prioritySelect.innerHTML = PRIORITIES.map((p) => '<option value="' + p.value + '">优先级 ' + escapeHtml(p.label) + '</option>').join('');
      prioritySelect.value = 'medium';
    }
  }

  /** 顶部说明：明确“数据保留在 localStorage，可用重置按钮回退到初始数据”。 */
  function renderHeaderNote() {
    document.getElementById('storage-note').textContent = hasSavedState()
      ? '数据已保存在本机 localStorage，刷新后保留'
      : '当前展示初始演示数据';
  }

  /** 整体重绘入口。 */
  function render() {
    renderOwnerOptions();
    renderBoard();
    renderMembers();
    renderTimeline();
    renderHeaderNote();
  }

  /* ================================================================== *
   * F. 事件绑定与初始化
   * ================================================================== */

  /** 绑定“新增任务”表单。 */
  function bindTaskForm() {
    document.getElementById('task-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const ok = addTask({
        title: document.getElementById('task-title').value,
        ownerId: document.getElementById('task-owner').value,
        priority: document.getElementById('task-priority').value,
        dueDate: document.getElementById('task-due').value,
        status: document.getElementById('task-status').value
      });
      if (ok) {
        event.target.reset();
        document.getElementById('task-priority').value = 'medium';
        document.getElementById('task-status').value = 'todo';
        renderOwnerOptions();
        document.getElementById('task-title').focus();
      }
    });
  }

  /** 绑定“新增成员”表单。 */
  function bindMemberForm() {
    document.getElementById('member-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const ok = addMember({
        name: document.getElementById('member-name').value,
        role: document.getElementById('member-role').value
      });
      if (ok) {
        event.target.reset();
        document.getElementById('member-name').focus();
      }
    });
  }

  /** 看板事件委托：按钮（推进 / 退回 / 删除）与拖拽放列统一在这里处理。 */
  function bindBoard() {
    const board = document.getElementById('board');

    // 1) 点击按钮
    board.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const taskId = button.dataset.taskId;
      if (button.dataset.action === 'move') moveTask(taskId, button.dataset.status);
      else if (button.dataset.action === 'delete') deleteTask(taskId);
    });

    // 2) 拖拽：dragstart 记录任务，dragover 允许放置，drop 触发移动
    board.addEventListener('dragstart', (event) => {
      const card = event.target.closest('.card');
      if (!card) return;
      dragTaskId = card.dataset.taskId;
      card.classList.add('card--dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragTaskId);
      }
    });

    board.addEventListener('dragend', (event) => {
      const card = event.target.closest('.card');
      if (card) card.classList.remove('card--dragging');
      clearDropHighlight();
      dragTaskId = null;
    });

    board.addEventListener('dragover', (event) => {
      const column = event.target.closest('.column');
      if (!column) return;
      event.preventDefault();                       // 必须阻止默认行为才允许 drop
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      highlightColumn(column);
    });

    board.addEventListener('dragleave', (event) => {
      const column = event.target.closest('.column');
      if (column && !column.contains(event.relatedTarget)) column.classList.remove('column--over');
    });

    board.addEventListener('drop', (event) => {
      const column = event.target.closest('.column');
      if (!column) return;
      event.preventDefault();
      const taskId = dragTaskId || (event.dataTransfer ? event.dataTransfer.getData('text/plain') : '');
      clearDropHighlight();
      dragTaskId = null;
      if (taskId) moveTask(taskId, column.dataset.column);
    });
  }

  /** 成员列表事件委托：移除成员。 */
  function bindMembers() {
    document.getElementById('members').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action="remove-member"]');
      if (button) removeMember(button.dataset.memberId);
    });
  }

  /** 只高亮当前悬停的列。 */
  function highlightColumn(column) {
    document.querySelectorAll('.column--over').forEach((el) => {
      if (el !== column) el.classList.remove('column--over');
    });
    column.classList.add('column--over');
  }

  function clearDropHighlight() {
    document.querySelectorAll('.column--over').forEach((el) => el.classList.remove('column--over'));
  }

  /** 拖拽过程中的临时状态。 */
  let dragTaskId = null;

  /** 页面初始化：静态下拉框 → 首次渲染 → 绑定事件。 */
  function init() {
    renderPriorityOptions();
    renderStatusOptions();
    render();
    bindTaskForm();
    bindMemberForm();
    bindBoard();
    bindMembers();
    document.getElementById('reset-btn').addEventListener('click', resetState);
    console.log('[pm-board] 初始化完成：三板块数据同源，变更即时联动');
  }

  // DOM 就绪后启动（script 位于 body 末尾，正常已就绪；此处做兼容兜底）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
