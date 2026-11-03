/* ============================================================
   蜀香居 · 中餐点餐（第一版）
   纯前端单页应用：菜单浏览 → 购物车 → 选桌下单 → 订单确认
   无后端，全部数据在本地模拟。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 分类 ---------- */
  var CATEGORIES = ['凉菜', '热炒', '主食', '汤羹', '饮品'];

  var CATEGORY_HINT = {
    '凉菜': '清爽开胃，先来两碟',
    '热炒': '大火快炒，趁热吃',
    '主食': '米面点心，管饱',
    '汤羹': '一碗热汤，暖胃',
    '饮品': '解辣解腻，冰热都有'
  };

  /* ---------- 图片占位渐变（纯 CSS，不用外部图片） ---------- */
  var GRADIENTS = {
    green:  'linear-gradient(135deg, #7aa05a 0%, #4f7a3c 100%)',
    red:    'linear-gradient(135deg, #c9503c 0%, #8f2b22 100%)',
    amber:  'linear-gradient(135deg, #d79a45 0%, #a4661f 100%)',
    brown:  'linear-gradient(135deg, #a9714a 0%, #6f4325 100%)',
    teal:   'linear-gradient(135deg, #4f9c94 0%, #2c6b65 100%)',
    cream:  'linear-gradient(135deg, #ddb96b 0%, #b98a33 100%)',
    purple: 'linear-gradient(135deg, #94638f 0%, #5f3859 100%)',
    slate:  'linear-gradient(135deg, #8a8071 0%, #574f43 100%)'
  };

  /* ---------- 菜品数据（26 道） ---------- */
  var DISHES = [
    // 凉菜
    { id: 'l01', name: '拍黄瓜',         price: 12, cat: '凉菜', sold: 386, spicy: 1, g: 'green',  ch: '瓜', desc: '蒜香醋香，清脆爽口' },
    { id: 'l02', name: '口水鸡',         price: 32, cat: '凉菜', sold: 254, spicy: 3, g: 'red',    ch: '鸡', desc: '红油麻辣，嫩滑入味' },
    { id: 'l03', name: '凉拌木耳',       price: 18, cat: '凉菜', sold: 197, spicy: 1, g: 'slate',  ch: '耳', desc: '黑木耳配青红椒丝' },
    { id: 'l04', name: '夫妻肺片',       price: 38, cat: '凉菜', sold: 168, spicy: 3, g: 'brown',  ch: '肺', desc: '卤香牛肉牛杂，红油浸润' },
    { id: 'l05', name: '皮蛋豆腐',       price: 16, cat: '凉菜', sold: 142, spicy: 0, g: 'cream',  ch: '豆', desc: '内酯豆腐配溏心皮蛋' },

    // 热炒
    { id: 'h01', name: '宫保鸡丁',       price: 36, cat: '热炒', sold: 512, spicy: 2, g: 'amber',  ch: '宫', desc: '花生米与鸡丁，糊辣荔枝味' },
    { id: 'h02', name: '麻婆豆腐',       price: 26, cat: '热炒', sold: 431, spicy: 3, g: 'red',    ch: '麻', desc: '麻辣鲜香，豆腐嫩而不碎' },
    { id: 'h03', name: '回锅肉',         price: 42, cat: '热炒', sold: 368, spicy: 2, g: 'brown',  ch: '回', desc: '二刀肉配蒜苗，豆瓣香浓' },
    { id: 'h04', name: '鱼香肉丝',       price: 34, cat: '热炒', sold: 402, spicy: 2, g: 'amber',  ch: '鱼', desc: '甜酸微辣，下饭一绝' },
    { id: 'h05', name: '干煸四季豆',     price: 28, cat: '热炒', sold: 287, spicy: 2, g: 'green',  ch: '豆', desc: '干香入味，配肉末更香' },
    { id: 'h06', name: '水煮牛肉',       price: 58, cat: '热炒', sold: 231, spicy: 3, g: 'red',    ch: '牛', desc: '麻辣滚烫，牛肉滑嫩' },
    { id: 'h07', name: '辣子鸡',         price: 46, cat: '热炒', sold: 219, spicy: 3, g: 'red',    ch: '辣', desc: '干辣椒里找鸡块' },
    { id: 'h08', name: '清炒时蔬',       price: 20, cat: '热炒', sold: 176, spicy: 0, g: 'green',  ch: '蔬', desc: '当季青菜，蒜香清炒' },
    { id: 'h09', name: '红烧狮子头',     price: 44, cat: '热炒', sold: 158, spicy: 0, g: 'brown',  ch: '狮', desc: '四喜丸子，浓油赤酱' },
    { id: 'h10', name: '蒜蓉粉丝蒸虾',   price: 68, cat: '热炒', sold: 145, spicy: 0, g: 'teal',   ch: '虾', desc: '鲜虾开背，蒜蓉粉丝垫底' },

    // 主食
    { id: 'z01', name: '扬州炒饭',       price: 22, cat: '主食', sold: 342, spicy: 0, g: 'cream',  ch: '饭', desc: '粒粒分明，配虾仁火腿' },
    { id: 'z02', name: '担担面',         price: 20, cat: '主食', sold: 298, spicy: 2, g: 'amber',  ch: '面', desc: '芝麻酱香，微辣回甜' },
    { id: 'z03', name: '手工水饺（12只）', price: 26, cat: '主食', sold: 213, spicy: 0, g: 'slate',  ch: '饺', desc: '猪肉白菜馅，现包现煮' },
    { id: 'z04', name: '葱油拌面',       price: 18, cat: '主食', sold: 187, spicy: 0, g: 'cream',  ch: '葱', desc: '葱油焦香，简单好吃' },
    { id: 'z05', name: '香米饭',         price: 3,  cat: '主食', sold: 866, spicy: 0, g: 'cream',  ch: '米', desc: '一碗松软喷香的白米饭' },

    // 汤羹
    { id: 't01', name: '番茄蛋花汤',     price: 18, cat: '汤羹', sold: 246, spicy: 0, g: 'red',    ch: '番', desc: '酸甜开胃，蛋花绵软' },
    { id: 't02', name: '酸辣汤',         price: 20, cat: '汤羹', sold: 208, spicy: 2, g: 'purple', ch: '酸', desc: '胡椒酸香，暖身又开胃' },
    { id: 't03', name: '紫菜蛋花汤',     price: 16, cat: '汤羹', sold: 164, spicy: 0, g: 'teal',   ch: '紫', desc: '清淡鲜香，虾皮提味' },

    // 饮品
    { id: 'y01', name: '冰镇酸梅汤',     price: 10, cat: '饮品', sold: 452, spicy: 0, g: 'purple', ch: '梅', desc: '解辣解腻，冰镇更爽' },
    { id: 'y02', name: '鲜榨西瓜汁',     price: 16, cat: '饮品', sold: 183, spicy: 0, g: 'red',    ch: '瓜', desc: '现榨无添加，清甜' },
    { id: 'y03', name: '茉莉花茶',       price: 8,  cat: '饮品', sold: 296, spicy: 0, g: 'green',  ch: '茶', desc: '一壶两杯，可续水' }
  ];

  var MAX_TABLE = 20;
  var RMB = '¥';

  /* ---------- 状态 ---------- */
  var state = {
    category: CATEGORIES[0],
    cart: {},            // dishId -> qty
    table: null,         // 1..20
    lastOrder: null
  };

  /* ---------- DOM ---------- */
  var el = {};
  ['tabs', 'catTitle', 'catHint', 'menuEmpty', 'dishGrid',
   'viewMenu', 'viewCheckout', 'viewConfirm',
   'cartBtn', 'cartCount', 'cartDrawer', 'closeCart', 'overlay',
   'cartEmpty', 'cartList', 'cartTotal', 'goCheckout',
   'checkoutSummary', 'tableGrid', 'submitBtn',
   'orderNo', 'confirmTable', 'orderTime', 'orderList', 'orderTotal'
  ].forEach(function (id) { el[id] = document.getElementById(id); });

  /* ---------- 工具 ---------- */
  function money(n) {
    return RMB + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, '');
  }

  function byId(id) {
    for (var i = 0; i < DISHES.length; i++) {
      if (DISHES[i].id === id) return DISHES[i];
    }
    return null;
  }

  function cartIds() {
    return Object.keys(state.cart).filter(function (id) {
      return state.cart[id] > 0 && byId(id);
    });
  }

  function cartCount() {
    return cartIds().reduce(function (n, id) { return n + state.cart[id]; }, 0);
  }

  function cartTotal() {
    return cartIds().reduce(function (sum, id) {
      return sum + byId(id).price * state.cart[id];
    }, 0);
  }

  function spicyTag(level) {
    if (level <= 0) return { cls: 'tag-mild', text: '不辣' };
    return { cls: 'tag-spicy', text: '辣度 ' + new Array(level + 1).join('🌶') };
  }

  function thumbStyle(dish) {
    return 'background:' + (GRADIENTS[dish.g] || GRADIENTS.slate);
  }

  function setQty(id, qty) {
    if (qty <= 0) delete state.cart[id];
    else state.cart[id] = qty;
  }

  /* ---------- 渲染：分类 tabs ---------- */
  function renderTabs() {
    var frag = document.createDocumentFragment();
    CATEGORIES.forEach(function (cat) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (cat === state.category ? ' is-active' : '');
      b.textContent = cat;
      b.setAttribute('data-cat', cat);
      b.setAttribute('aria-pressed', String(cat === state.category));
      frag.appendChild(b);
    });
    el.tabs.innerHTML = '';
    var inner = document.createElement('div');
    inner.className = 'tabs-inner';
    inner.appendChild(frag);
    el.tabs.appendChild(inner);
  }

  /* ---------- 渲染：菜品卡 ---------- */
  function dishCard(dish) {
    var qty = state.cart[dish.id] || 0;
    var spicy = spicyTag(dish.spicy);

    var card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('data-id', dish.id);

    var thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.setAttribute('style', thumbStyle(dish));
    thumb.setAttribute('aria-hidden', 'true');
    var ch = document.createElement('span');
    ch.className = 'thumb-char';
    ch.textContent = dish.ch;
    thumb.appendChild(ch);

    var body = document.createElement('div');
    body.className = 'card-body';

    var name = document.createElement('h3');
    name.className = 'card-name';
    name.textContent = dish.name;

    var desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = dish.desc;

    var tags = document.createElement('div');
    tags.className = 'tag-row';
    var sold = document.createElement('span');
    sold.className = 'tag tag-sold';
    sold.textContent = '月售 ' + dish.sold;
    var sp = document.createElement('span');
    sp.className = 'tag ' + spicy.cls;
    sp.textContent = spicy.text;
    tags.appendChild(sold);
    tags.appendChild(sp);

    var foot = document.createElement('div');
    foot.className = 'card-foot';
    var price = document.createElement('span');
    price.className = 'price';
    price.innerHTML = '<span class="price-symbol">' + RMB + '</span>' + dish.price;

    var action = document.createElement('div');
    action.className = 'card-action';
    if (qty > 0) {
      action.appendChild(stepper(dish, qty));
    } else {
      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'add-btn';
      add.textContent = '加入';
      add.setAttribute('data-act', 'add');
      add.setAttribute('data-id', dish.id);
      add.setAttribute('aria-label', '将' + dish.name + '加入购物车');
      action.appendChild(add);
    }

    foot.appendChild(price);
    foot.appendChild(action);
    body.appendChild(name);
    body.appendChild(desc);
    body.appendChild(tags);
    body.appendChild(foot);
    card.appendChild(thumb);
    card.appendChild(body);
    return card;
  }

  function stepper(dish, qty) {
    var wrap = document.createElement('div');
    wrap.className = 'stepper';

    var minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'step-btn minus';
    minus.textContent = '−';
    minus.setAttribute('data-act', 'dec');
    minus.setAttribute('data-id', dish.id);
    minus.setAttribute('aria-label', '减少一份' + dish.name);

    var num = document.createElement('span');
    num.className = 'step-qty';
    num.textContent = qty;

    var plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'step-btn plus';
    plus.textContent = '+';
    plus.setAttribute('data-act', 'inc');
    plus.setAttribute('data-id', dish.id);
    plus.setAttribute('aria-label', '增加一份' + dish.name);

    wrap.appendChild(minus);
    wrap.appendChild(num);
    wrap.appendChild(plus);
    return wrap;
  }

  function renderMenu() {
    var list = DISHES.filter(function (d) { return d.cat === state.category; });
    el.dishGrid.innerHTML = '';
    el.catTitle.textContent = state.category;
    el.catHint.textContent = CATEGORY_HINT[state.category] || '';
    el.menuEmpty.hidden = list.length > 0;

    var frag = document.createDocumentFragment();
    list.forEach(function (d) { frag.appendChild(dishCard(d)); });
    el.dishGrid.appendChild(frag);
  }

  /* ---------- 渲染：购物车 ---------- */
  function renderCart() {
    var ids = cartIds();
    var count = cartCount();

    el.cartCount.textContent = count;
    el.cartEmpty.hidden = ids.length > 0;
    el.cartTotal.textContent = money(cartTotal());
    el.goCheckout.disabled = ids.length === 0;

    el.cartList.innerHTML = '';
    var frag = document.createDocumentFragment();
    ids.forEach(function (id) {
      var dish = byId(id);
      var qty = state.cart[id];

      var li = document.createElement('li');
      li.className = 'cart-item';

      var thumb = document.createElement('div');
      thumb.className = 'cart-thumb';
      thumb.setAttribute('style', thumbStyle(dish));
      thumb.textContent = dish.ch;

      var info = document.createElement('div');
      info.className = 'cart-info';
      var nm = document.createElement('div');
      nm.className = 'cart-name';
      nm.textContent = dish.name;
      var un = document.createElement('div');
      un.className = 'cart-unit';
      un.textContent = money(dish.price) + ' / 份';
      info.appendChild(nm);
      info.appendChild(un);

      var st = stepper(dish, qty);

      var line = document.createElement('div');
      line.className = 'cart-line';
      line.textContent = money(dish.price * qty);

      li.appendChild(thumb);
      li.appendChild(info);
      li.appendChild(st);
      li.appendChild(line);
      frag.appendChild(li);
    });
    el.cartList.appendChild(frag);
  }

  function renderBadge() {
    el.cartCount.textContent = cartCount();
  }

  /* ---------- 渲染：结算 / 确认 ---------- */
  function renderCheckout() {
    var n = cartCount();
    el.checkoutSummary.textContent = '共 ' + n + ' 份菜品 · 合计 ' + money(cartTotal()) + '（未含茶位费）';
    el.tableGrid.innerHTML = '';
    var frag = document.createDocumentFragment();
    for (var i = 1; i <= MAX_TABLE; i++) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'table-btn' + (state.table === i ? ' is-selected' : '');
      b.textContent = i + ' 号桌';
      b.setAttribute('data-act', 'table');
      b.setAttribute('data-table', String(i));
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(state.table === i));
      frag.appendChild(b);
    }
    el.tableGrid.appendChild(frag);
    el.submitBtn.disabled = !(state.table && n > 0);
  }

  function renderConfirm() {
    var o = state.lastOrder;
    if (!o) return;
    el.orderNo.textContent = o.no;
    el.confirmTable.textContent = o.table + ' 号桌';
    el.orderTime.textContent = o.time;
    el.orderTotal.textContent = money(o.total);

    el.orderList.innerHTML = '';
    var frag = document.createDocumentFragment();
    o.items.forEach(function (it) {
      var li = document.createElement('li');
      var left = document.createElement('span');
      left.className = 'o-name';
      left.textContent = it.name;
      var mid = document.createElement('span');
      mid.className = 'o-qty';
      mid.textContent = '×' + it.qty;
      var right = document.createElement('span');
      right.className = 'o-price';
      right.textContent = money(it.price * it.qty);
      li.appendChild(left);
      li.appendChild(mid);
      li.appendChild(right);
      frag.appendChild(li);
    });
    el.orderList.appendChild(frag);
  }

  /* ---------- 视图切换 ---------- */
  function showView(which) {
    el.viewMenu.hidden = which !== 'menu';
    el.viewCheckout.hidden = which !== 'checkout';
    el.viewConfirm.hidden = which !== 'confirm';
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ---------- 购物车抽屉 ---------- */
  function openCart() {
    el.cartDrawer.hidden = false;
    el.overlay.hidden = false;
    el.cartDrawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('no-scroll');
    el.closeCart.focus();
  }

  function closeCart() {
    el.cartDrawer.hidden = true;
    el.overlay.hidden = true;
    el.cartDrawer.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('no-scroll');
  }

  function cartOpen() { return !el.cartDrawer.hidden; }

  /* ---------- 业务动作 ---------- */
  function addDish(id) {
    setQty(id, (state.cart[id] || 0) + 1);
    sync();
  }

  function decDish(id) {
    setQty(id, (state.cart[id] || 0) - 1);
    sync();
  }

  function goCheckout() {
    if (cartCount() === 0) return;
    closeCart();
    renderCheckout();
    showView('checkout');
  }

  function submitOrder() {
    if (!state.table || cartCount() === 0) return;
    var now = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    var no = 'SX' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
             pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());

    state.lastOrder = {
      no: no,
      table: state.table,
      time: now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
            ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
      eta: 15,
      total: cartTotal(),
      items: cartIds().map(function (id) {
        var d = byId(id);
        return { name: d.name, price: d.price, qty: state.cart[id] };
      })
    };

    state.cart = {};
    state.table = null;
    sync();
    renderConfirm();
    showView('confirm');
  }

  function newOrder() {
    state.lastOrder = null;
    state.category = CATEGORIES[0];
    renderTabs();
    renderMenu();
    showView('menu');
  }

  /* ---------- 统一刷新 ---------- */
  function sync() {
    renderMenu();
    renderCart();
    renderCheckout();
  }

  /* ---------- 事件（委托） ---------- */
  function handleClick(e) {
    var t = e.target.closest('[data-act], .tab');
    if (!t) return;

    if (t.classList.contains('tab')) {
      state.category = t.getAttribute('data-cat');
      renderTabs();
      renderMenu();
      return;
    }

    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');

    switch (act) {
      case 'add':      addDish(id); break;
      case 'inc':      addDish(id); break;
      case 'dec':      decDish(id); break;
      case 'cart':     openCart(); break;
      case 'closeCart':closeCart(); break;
      case 'checkout': goCheckout(); break;
      case 'back':     showView('menu'); break;
      case 'table':
        state.table = parseInt(t.getAttribute('data-table'), 10);
        renderCheckout();
        break;
      case 'submit':   submitOrder(); break;
      case 'neworder': newOrder(); break;
    }
  }

  function handleKey(e) {
    if (e.key === 'Escape' && cartOpen()) closeCart();
  }

  /* ---------- 启动 ---------- */
  function init() {
    renderTabs();
    renderMenu();
    renderCart();
    renderCheckout();
    showView('menu');

    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    el.overlay.addEventListener('click', closeCart);

    // 供自动化测试/调试使用（只读快照）
    window.__ORDERING__ = {
      dishes: DISHES,
      categories: CATEGORIES,
      maxTable: MAX_TABLE,
      getState: function () {
        return {
          category: state.category,
          cart: JSON.parse(JSON.stringify(state.cart)),
          table: state.table,
          cartCount: cartCount(),
          cartTotal: cartTotal(),
          lastOrder: state.lastOrder
        };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
