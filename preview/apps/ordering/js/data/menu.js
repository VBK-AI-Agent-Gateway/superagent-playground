/**
 * 菜单模拟数据 —— 全站唯一的菜品数据源。
 * 新增/修改菜品只需编辑本文件；界面按 categoryId 自动分组渲染。
 *
 * 字段说明：
 *   id          菜品唯一编号
 *   name        菜名
 *   categoryId  所属分类（见 CATEGORIES）
 *   price       单价（元）
 *   monthlySales 月售（份）
 *   spicy       辣度 0-3（0 不辣 / 1 微辣 / 2 中辣 / 3 特辣）
 *   desc        一句话简介
 *   tags        标签（招牌 / 时令 ...）
 *   gradient    卡片占位图所用的 CSS 渐变（无图片依赖，纯 CSS 渲染）
 */
(function (global) {
  'use strict';

  var CATEGORIES = [
    { id: 'cold', name: '凉菜', icon: '🥢' },
    { id: 'hot', name: '热炒', icon: '🍳' },
    { id: 'staple', name: '主食', icon: '🍚' },
    { id: 'soup', name: '汤羹', icon: '🍲' },
    { id: 'drink', name: '饮品', icon: '🍵' }
  ];

  var DISHES = [
    // ---------- 凉菜 ----------
    {
      id: 'd101', name: '口水鸡', categoryId: 'cold', price: 28, monthlySales: 486, spicy: 2,
      desc: '红油藤椒，麻辣鲜香', tags: ['招牌'],
      gradient: 'linear-gradient(135deg,#f2c14e 0%,#e0653a 55%,#a8321f 100%)'
    },
    {
      id: 'd102', name: '拍黄瓜', categoryId: 'cold', price: 12, monthlySales: 731, spicy: 1,
      desc: '蒜香爽脆，解腻首选', tags: [],
      gradient: 'linear-gradient(135deg,#bcd97b 0%,#6f9e4b 100%)'
    },
    {
      id: 'd103', name: '凉拌木耳', categoryId: 'cold', price: 16, monthlySales: 342, spicy: 1,
      desc: '山野脆木耳，醋香开胃', tags: [],
      gradient: 'linear-gradient(135deg,#8d8f96 0%,#3f4148 100%)'
    },
    {
      id: 'd104', name: '夫妻肺片', categoryId: 'cold', price: 32, monthlySales: 268, spicy: 3,
      desc: '红油厚重，麻辣过瘾', tags: ['招牌'],
      gradient: 'linear-gradient(135deg,#e0653a 0%,#8c1d14 100%)'
    },
    {
      id: 'd105', name: '皮蛋豆腐', categoryId: 'cold', price: 18, monthlySales: 395, spicy: 0,
      desc: '嫩豆腐配溏心皮蛋', tags: [],
      gradient: 'linear-gradient(135deg,#f7f3e8 0%,#c9c2ad 100%)'
    },

    // ---------- 热炒 ----------
    {
      id: 'd201', name: '宫保鸡丁', categoryId: 'hot', price: 38, monthlySales: 902, spicy: 2,
      desc: '糊辣荔枝口，花生酥脆', tags: ['招牌'],
      gradient: 'linear-gradient(135deg,#f4a259 0%,#c1440e 100%)'
    },
    {
      id: 'd202', name: '鱼香肉丝', categoryId: 'hot', price: 34, monthlySales: 655, spicy: 1,
      desc: '咸甜酸辣，下饭一绝', tags: [],
      gradient: 'linear-gradient(135deg,#e8a06a 0%,#9c3b1b 100%)'
    },
    {
      id: 'd203', name: '麻婆豆腐', categoryId: 'hot', price: 26, monthlySales: 588, spicy: 2,
      desc: '麻辣烫嫩，一勺豆瓣香', tags: [],
      gradient: 'linear-gradient(135deg,#e94f37 0%,#8a1c1c 100%)'
    },
    {
      id: 'd204', name: '回锅肉', categoryId: 'hot', price: 42, monthlySales: 477, spicy: 1,
      desc: '二刀肉爆香，灯盏窝', tags: ['招牌'],
      gradient: 'linear-gradient(135deg,#c96f3a 0%,#6f2a12 100%)'
    },
    {
      id: 'd205', name: '干锅花菜', categoryId: 'hot', price: 30, monthlySales: 361, spicy: 2,
      desc: '干香带劲，锅气十足', tags: [],
      gradient: 'linear-gradient(135deg,#d7cdae 0%,#7d7a4b 100%)'
    },
    {
      id: 'd206', name: '清炒时蔬', categoryId: 'hot', price: 22, monthlySales: 289, spicy: 0,
      desc: '当日鲜蔬，少油少盐', tags: ['时令'],
      gradient: 'linear-gradient(135deg,#a8d672 0%,#3f7a35 100%)'
    },

    // ---------- 主食 ----------
    {
      id: 'd301', name: '扬州炒饭', categoryId: 'staple', price: 24, monthlySales: 812, spicy: 0,
      desc: '粒粒分明，虾仁火腿', tags: [],
      gradient: 'linear-gradient(135deg,#f6e27a 0%,#c99b1f 100%)'
    },
    {
      id: 'd302', name: '担担面', categoryId: 'staple', price: 20, monthlySales: 673, spicy: 3,
      desc: '红油芽菜，麻辣浓香', tags: ['招牌'],
      gradient: 'linear-gradient(135deg,#f0b357 0%,#a33d16 100%)'
    },
    {
      id: 'd303', name: '手工水饺（12只）', categoryId: 'staple', price: 26, monthlySales: 449, spicy: 0,
      desc: '现包现煮，猪肉白菜', tags: [],
      gradient: 'linear-gradient(135deg,#fbf3e0 0%,#cbb894 100%)'
    },
    {
      id: 'd304', name: '葱油拌面', categoryId: 'staple', price: 18, monthlySales: 520, spicy: 0,
      desc: '本帮葱油，香气扑鼻', tags: [],
      gradient: 'linear-gradient(135deg,#e8d9a0 0%,#96742a 100%)'
    },
    {
      id: 'd305', name: '米饭', categoryId: 'staple', price: 3, monthlySales: 1680, spicy: 0,
      desc: '东北珍珠米，现蒸', tags: [],
      gradient: 'linear-gradient(135deg,#ffffff 0%,#ded7c4 100%)'
    },

    // ---------- 汤羹 ----------
    {
      id: 'd401', name: '西红柿蛋汤', categoryId: 'soup', price: 16, monthlySales: 611, spicy: 0,
      desc: '酸甜清爽，蛋花细嫩', tags: [],
      gradient: 'linear-gradient(135deg,#f2937a 0%,#c33f27 100%)'
    },
    {
      id: 'd402', name: '酸辣汤', categoryId: 'soup', price: 20, monthlySales: 402, spicy: 2,
      desc: '酸辣浓稠，胡椒暖胃', tags: [],
      gradient: 'linear-gradient(135deg,#d98b45 0%,#7a3413 100%)'
    },
    {
      id: 'd403', name: '老火例汤', categoryId: 'soup', price: 28, monthlySales: 233, spicy: 0,
      desc: '每日一款，慢炖三小时', tags: ['时令'],
      gradient: 'linear-gradient(135deg,#e5d3a8 0%,#8a6a34 100%)'
    },
    {
      id: 'd404', name: '玉米排骨汤', categoryId: 'soup', price: 32, monthlySales: 198, spicy: 0,
      desc: '清甜不油腻，老少皆宜', tags: [],
      gradient: 'linear-gradient(135deg,#f7e58a 0%,#c39a2c 100%)'
    },

    // ---------- 饮品 ----------
    {
      id: 'd501', name: '酸梅汤', categoryId: 'drink', price: 10, monthlySales: 980, spicy: 0,
      desc: '古法熬制，冰镇解辣', tags: ['招牌'],
      gradient: 'linear-gradient(135deg,#9b3b52 0%,#3f1420 100%)'
    },
    {
      id: 'd502', name: '茉莉花茶', categoryId: 'drink', price: 12, monthlySales: 356, spicy: 0,
      desc: '清香回甘，可续壶', tags: [],
      gradient: 'linear-gradient(135deg,#e9f0cf 0%,#93a95c 100%)'
    },
    {
      id: 'd503', name: '鲜榨橙汁', categoryId: 'drink', price: 18, monthlySales: 287, spicy: 0,
      desc: '当天现榨，不加糖', tags: [],
      gradient: 'linear-gradient(135deg,#ffc857 0%,#e07a1f 100%)'
    },
    {
      id: 'd504', name: '冰镇豆奶', categoryId: 'drink', price: 8, monthlySales: 645, spicy: 0,
      desc: '豆香醇厚，解辣神器', tags: [],
      gradient: 'linear-gradient(135deg,#fdf6e3 0%,#cbbfa1 100%)'
    }
  ];

  /** 桌台：大厅 A 区 8 桌 + 包厢 B 区 8 桌，共 16 桌（>=15） */
  var TABLES = [];
  (function buildTables() {
    for (var i = 1; i <= 8; i++) {
      TABLES.push({
        id: 'A' + i,
        name: 'A' + i + ' 桌',
        area: '大厅 A 区',
        seats: i <= 4 ? 2 : 4
      });
    }
    for (var j = 1; j <= 8; j++) {
      TABLES.push({
        id: 'B' + j,
        name: 'B' + j + ' 桌',
        area: '包厢 B 区',
        seats: j <= 4 ? 6 : 10
      });
    }
  })();

  global.OrderingData = {
    RESTAURANT: {
      name: '朱砂小馆',
      slogan: '地道中餐 · 扫码即点',
      notice: '本店所有菜品现点现做，高峰期预计等待 15-25 分钟，感谢耐心。'
    },
    CATEGORIES: CATEGORIES,
    DISHES: DISHES,
    TABLES: TABLES
  };
})(window);
