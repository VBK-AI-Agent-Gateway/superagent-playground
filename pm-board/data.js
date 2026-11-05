/* data.js — 初始 mock 数据与配置常量（零依赖，普通 script 标签加载）。
 * 说明：本文件只提供“数据形状”和默认常量，不包含任何业务逻辑；
 *      页面首次打开（localStorage 中无数据）时用这里的内容初始化。
 * 时间字段一律使用 Date.now() 毫秒时间戳，便于排序与格式化。 */

/* ------------------------------------------------------------------ *
 * 常量配置
 * ------------------------------------------------------------------ */

/** localStorage 存储键（刷新页面后用于恢复数据）。 */
var STORAGE_KEY = 'pm-board-state-v1';

/** 看板列定义：顺序即页面展示顺序。 */
var COLUMNS = [
  { id: 'todo', title: '待办' },
  { id: 'inprogress', title: '进行中' },
  { id: 'done', title: '已完成' }
];

/** 优先级定义：value 为存储值，label 为展示文案。 */
var PRIORITIES = [
  { value: 'high', label: '高' },
  { value: 'medium', label: '中' },
  { value: 'low', label: '低' }
];

/** “在办任务数”统计口径：待办 + 进行中 视为在办。 */
var ACTIVE_STATUSES = ['todo', 'inprogress'];

/* ------------------------------------------------------------------ *
 * 初始 mock 数据
 * ------------------------------------------------------------------ */

/** 初始成员（id 为固定字符串，便于 mock 数据互相引用）。 */
var SEED_MEMBERS = [
  { id: 'm1', name: '张伟', role: '产品经理' },
  { id: 'm2', name: '李娜', role: '前端工程师' },
  { id: 'm3', name: '王强', role: '后端工程师' },
  { id: 'm4', name: '赵敏', role: '测试工程师' }
];

/** 初始任务：ownerId 必须存在于 SEED_MEMBERS 中。 */
var SEED_TASKS = [
  { id: 't1', title: '梳理需求清单并确定本期范围', ownerId: 'm1', priority: 'high', dueDate: '2026-11-10', status: 'todo' },
  { id: 't2', title: '搭建看板页面骨架', ownerId: 'm2', priority: 'high', dueDate: '2026-11-08', status: 'inprogress' },
  { id: 't3', title: '成员列表接口联调', ownerId: 'm3', priority: 'medium', dueDate: '2026-11-14', status: 'todo' },
  { id: 't4', title: '活动时间线组件开发', ownerId: 'm2', priority: 'medium', dueDate: '2026-11-12', status: 'inprogress' },
  { id: 't5', title: '整理第一版验收用例', ownerId: 'm4', priority: 'low', dueDate: '2026-11-18', status: 'todo' },
  { id: 't6', title: '交付物目录结构与说明文档', ownerId: 'm1', priority: 'low', dueDate: '2026-11-06', status: 'done' }
];

/** 初始活动记录：按时间倒序传入也可以，渲染前会统一排序。 */
var SEED_ACTIVITIES = [
  { id: 'a1', at: Date.parse('2026-11-04T10:20:00'), type: 'seed', text: '初始化演示数据：4 名成员、6 个任务' },
  { id: 'a2', at: Date.parse('2026-11-04T10:30:00'), type: 'task_create', text: '创建任务「梳理需求清单并确定本期范围」（负责人：张伟）' },
  { id: 'a3', at: Date.parse('2026-11-04T11:05:00'), type: 'task_create', text: '创建任务「搭建看板页面骨架」（负责人：李娜）' },
  { id: 'a4', at: Date.parse('2026-11-04T11:40:00'), type: 'task_move', text: '任务「搭建看板页面骨架」从「待办」移动到「进行中」' },
  { id: 'a5', at: Date.parse('2026-11-04T14:10:00'), type: 'task_create', text: '创建任务「成员列表接口联调」（负责人：王强）' },
  { id: 'a6', at: Date.parse('2026-11-04T15:25:00'), type: 'task_move', text: '任务「活动时间线组件开发」从「待办」移动到「进行中」' },
  { id: 'a7', at: Date.parse('2026-11-04T16:50:00'), type: 'task_create', text: '创建任务「整理第一版验收用例」（负责人：赵敏）' },
  { id: 'a8', at: Date.parse('2026-11-05T09:15:00'), type: 'member_remove', text: '移除成员「临时访客」' },
  { id: 'a9', at: Date.parse('2026-11-05T09:20:00'), type: 'member_add', text: '新增成员「赵敏」（测试工程师）' },
  { id: 'a10', at: Date.parse('2026-11-05T10:00:00'), type: 'task_move', text: '任务「交付物目录结构与说明文档」从「进行中」移动到「已完成」' }
];
