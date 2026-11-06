/**
 * seed.js — 可选示例数据（仅在用户点击仪表盘「载入示例数据」时调用，不自动写入）。
 */
import * as store from './store.js';

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString();
};
const date = (offset) => day(offset).slice(0, 10);

/** 追加演示数据，返回新增条数。 */
export function seedDemoData() {
  const customerA = store.createCustomer({
    name: '杭州云启智能科技有限公司', industry: '智能制造', level: 'A', status: '合作中',
    source: '展会', phone: '0571-8888 1234', email: 'contact@yunqi-demo.example',
    address: '浙江省杭州市滨江区江南大道 588 号', owner: '张伟',
    note: '年度框架协议客户，重点关注产能扩张项目。',
    createdAt: day(-40), updatedAt: day(-3),
  });
  store.updateCustomer(customerA.id, {
    contacts: [
      { id: 'ct_demo_1', name: '李明', role: '决策人', phone: '13800001111', email: 'liming@yunqi-demo.example', wechat: 'liming-demo', isPrimary: true },
      { id: 'ct_demo_2', name: '王芳', role: '采购', phone: '13800002222', email: 'wangfang@yunqi-demo.example', wechat: '', isPrimary: false },
    ],
  });

  const customerB = store.createCustomer({
    name: '成都锦城医疗器械有限公司', industry: '医疗器械', level: 'B', status: '潜在',
    source: '官网', phone: '028-6666 8888', email: 'hello@jincheng-demo.example',
    address: '四川省成都市高新区天府大道 199 号', owner: '刘洋',
    note: '正在评估供应商，需提供合规资质材料。',
    createdAt: day(-12), updatedAt: day(-6),
  });

  const leadA = store.createLead({
    name: '陈强', company: '苏州精锐精密机械有限公司', phone: '13900003333',
    email: 'chenqiang@jingrui-demo.example', source: '转介绍', owner: '张伟',
    note: '同行推荐，计划三季度更换现有系统。', createdAt: day(-9), updatedAt: day(-2),
  });

  const leadB = store.createLead({
    name: '赵敏', company: '武汉光谷软件服务有限公司', phone: '13700004444',
    email: 'zhaomin@guanggu-demo.example', source: '广告', owner: '刘洋',
    note: '官网表单留资，尚未完成需求确认。', createdAt: day(-4), updatedAt: day(-4),
  });

  store.changeLeadStatus(leadA.id, '跟进中');
  store.convertLeadToCustomer(store.createLead({
    name: '孙涛', company: '南京恒信物流有限公司', phone: '13600005555',
    email: 'suntao@hengxin-demo.example', source: '电话', owner: '张伟',
    status: '跟进中', note: '已确认预算，等待商务报价。', createdAt: day(-20), updatedAt: day(-5),
  }).id, { industry: '物流运输', level: 'B', status: '合作中' });

  const dealA = store.createDeal({
    title: '云启智能 · 生产管理系统年度授权', customerId: customerA.id, amount: 480000,
    stage: '谈判', expectedCloseDate: date(20), owner: '张伟',
    note: '商务条款已确认，等待法务审核。', createdAt: day(-30), updatedAt: day(-2),
  });
  const dealB = store.createDeal({
    title: '锦城医疗 · 客户管理系统试点', customerId: customerB.id, amount: 120000,
    stage: '报价', expectedCloseDate: date(45), owner: '刘洋',
    note: '需补充数据合规说明后推进。', createdAt: day(-10), updatedAt: day(-4),
  });
  const dealC = store.createDeal({
    title: '精锐精密 · 销售管理系统', leadId: leadA.id, amount: 260000,
    stage: '需求确认', expectedCloseDate: date(60), owner: '张伟',
    note: '已安排下周现场调研。', createdAt: day(-8), updatedAt: day(-1),
  });
  const converted = store.customers().find((c) => c.name === '南京恒信物流有限公司');
  store.createDeal({
    title: '恒信物流 · 客户档案模块', customerId: converted ? converted.id : '', leadId: '',
    amount: 90000, stage: '赢单', expectedCloseDate: date(-5), owner: '张伟',
    note: '已签约并完成首期交付。', createdAt: day(-50), updatedAt: day(-5),
  });

  store.addFollowup({ targetType: 'customer', targetId: customerA.id, content: '电话沟通产能扩张计划，客户确认本季度内完成选型。', operator: '张伟', at: day(-3) });
  store.addFollowup({ targetType: 'customer', targetId: customerA.id, content: '发送年度框架协议草稿，客户法务审阅中。', operator: '张伟', at: day(-10) });
  store.addFollowup({ targetType: 'customer', targetId: customerB.id, content: '发送合规资质清单，等待客户反馈。', operator: '刘洋', at: day(-6) });
  store.addFollowup({ targetType: 'lead', targetId: leadA.id, content: '完成首次需求访谈，整理调研提纲并发给客户确认。', operator: '张伟', at: day(-2) });
  store.addFollowup({ targetType: 'lead', targetId: leadB.id, content: '首次电话联系，客户希望下周再约时间。', operator: '刘洋', at: day(-4) });
  store.addFollowup({ targetType: 'deal', targetId: dealA.id, content: '商务条款确认，折扣方案已提交审批。', operator: '张伟', at: day(-2) });
  store.addFollowup({ targetType: 'deal', targetId: dealB.id, content: '提交报价单，客户正在比价。', operator: '刘洋', at: day(-4) });
  store.addFollowup({ targetType: 'deal', targetId: dealC.id, content: '约定现场调研时间，准备演示环境。', operator: '张伟', at: day(-1) });

  return store.counts();
}

export default { seedDemoData };
