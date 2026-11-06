/**
 * 全局状态仓库（原生实现，无外部依赖）。
 * 通过 Vue.reactive 建立响应式对象，所有组件共享同一份状态。
 * 价格一律以「分」为单位计算，避免浮点误差。
 */
(function (global) {
  'use strict';

  var Vue = global.Vue;
  var D = global.OrderingData;

  var state = Vue.reactive({
    /** 当前选中的分类；'all' 表示全部 */
    activeCategory: 'all',
    /** 搜索关键字 */
    keyword: '',
    /** 购物车：[{ dishId, qty }] */
    cart: [],
    /** 已选桌台 id；空串表示未选 */
    selectedTableId: '',
    /** 'menu' | 'order' */
    view: 'menu',
    /** 最近一次提交的订单 */
    order: null,
    /** 订单号自增基数 */
    orderSeq: 1000,
    /** 轻提示 */
    toast: '',
    /** 提交中标记（防止重复提交） */
    submitting: false
  });

  var toastTimer = null;

  /* ------------------------------------------------------------------ */
  /* 基础查询                                                            */
  /* ------------------------------------------------------------------ */

  function allDishes() {
    return D.DISHES;
  }

  function findDish(id) {
    for (var i = 0; i < D.DISHES.length; i++) {
      if (D.DISHES[i].id === id) return D.DISHES[i];
    }
    return null;
  }

  function findTable(id) {
    for (var i = 0; i < D.TABLES.length; i++) {
      if (D.TABLES[i].id === id) return D.TABLES[i];
    }
    return null;
  }

  function dishesByCategory(categoryId) {
    if (!categoryId || categoryId === 'all') return D.DISHES.slice();
    return D.DISHES.filter(function (d) { return d.categoryId === categoryId; });
  }

  /** 按分类统计菜品数量，用于分类标签上的角标 */
  function categoryCount(categoryId) {
    if (categoryId === 'all') return D.DISHES.length;
    return D.DISHES.filter(function (d) { return d.categoryId === categoryId; }).length;
  }

  /* ------------------------------------------------------------------ */
  /* 购物车                                                              */
  /* ------------------------------------------------------------------ */

  function cartLine(dishId) {
    for (var i = 0; i < state.cart.length; i++) {
      if (state.cart[i].dishId === dishId) return state.cart[i];
    }
    return null;
  }

  function qtyOf(dishId) {
    var line = cartLine(dishId);
    return line ? line.qty : 0;
  }

  function addToCart(dishId, step) {
    var dish = findDish(dishId);
    if (!dish) return;
    var line = cartLine(dishId);
    if (line) {
      line.qty += (step || 1);
    } else {
      state.cart.push({ dishId: dishId, qty: step || 1 });
    }
    showToast('已加入「' + dish.name + '」');
  }

  function decreaseFromCart(dishId) {
    var line = cartLine(dishId);
    if (!line) return;
    line.qty -= 1;
    if (line.qty <= 0) removeFromCart(dishId);
  }

  function removeFromCart(dishId) {
    state.cart = state.cart.filter(function (l) { return l.dishId !== dishId; });
  }

  function clearCart() {
    state.cart = [];
  }

  /** 购物车明细：附带菜品信息与小计（分为单位） */
  var cartItems = Vue.computed(function () {
    return state.cart.map(function (line) {
      var dish = findDish(line.dishId);
      return {
        dishId: line.dishId,
        dish: dish,
        qty: line.qty,
        subtotalCents: dish ? dish.price * 100 * line.qty : 0
      };
    }).filter(function (l) { return !!l.dish; });
  });

  /** 角标计数：商品件数合计 */
  var cartCount = Vue.computed(function () {
    return state.cart.reduce(function (sum, l) { return sum + l.qty; }, 0);
  });

  /** 合计金额（元），保留两位小数 */
  var cartTotal = Vue.computed(function () {
    var cents = cartItems.value.reduce(function (sum, l) { return sum + l.subtotalCents; }, 0);
    return Math.round(cents) / 100;
  });

  var cartEmpty = Vue.computed(function () { return cartItems.value.length === 0; });

  /** 未选桌台时提交按钮禁用 */
  var canSubmit = Vue.computed(function () {
    return !cartEmpty.value && !!state.selectedTableId && !state.submitting;
  });

  var selectedTable = Vue.computed(function () {
    return state.selectedTableId ? findTable(state.selectedTableId) : null;
  });

  /* ------------------------------------------------------------------ */
  /* 提示                                                                */
  /* ------------------------------------------------------------------ */

  function showToast(text) {
    state.toast = text;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { state.toast = ''; }, 1600);
  }

  /* ------------------------------------------------------------------ */
  /* 下单                                                                */
  /* ------------------------------------------------------------------ */

  function pickCategory(id) {
    state.activeCategory = id;
  }

  function selectTable(id) {
    state.selectedTableId = id;
  }

  function orderNo(seq) {
    var d = new Date();
    var pad = function (n, len) {
      var s = String(n);
      while (s.length < len) s = '0' + s;
      return s;
    };
    return 'ZS' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + pad(seq, 4);
  }

  /** 预计等待时间：基础 12 分钟 + 每 3 件 1 分钟，上限 40 分钟 */
  function estimateWait(count) {
    var minutes = 12 + Math.ceil(count / 3);
    return Math.min(minutes, 40);
  }

  function submitOrder() {
    if (!canSubmit.value) return false;
    state.submitting = true;
    var table = selectedTable.value;
    var items = cartItems.value.map(function (l) {
      return {
        dishId: l.dishId,
        name: l.dish.name,
        price: l.dish.price,
        qty: l.qty,
        spicy: l.dish.spicy,
        gradient: l.dish.gradient,
        subtotal: l.subtotalCents / 100
      };
    });
    var total = Math.round(items.reduce(function (s, it) { return s + it.subtotal * 100; }, 0)) / 100;
    var count = items.reduce(function (s, it) { return s + it.qty; }, 0);
    state.orderSeq += 1;
    state.order = {
      no: orderNo(state.orderSeq),
      tableId: table ? table.id : '',
      tableName: table ? table.name : '',
      tableArea: table ? table.area : '',
      items: items,
      count: count,
      total: total,
      waitMinutes: estimateWait(count),
      createdAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      status: '待接单'
    };
    state.cart = [];
    state.submitting = false;
    state.view = 'order';
    return true;
  }

  function backToMenu() {
    state.view = 'menu';
  }

  /** 再来一单：把上一单的菜品重新放入购物车 */
  function reorder() {
    if (!state.order) return;
    state.cart = state.order.items.map(function (it) {
      return { dishId: it.dishId, qty: it.qty };
    });
    state.selectedTableId = state.order.tableId;
    state.view = 'menu';
    showToast('已重新加入购物车');
  }

  global.OrderingStore = {
    state: state,
    /* 数据 */
    allDishes: allDishes,
    findDish: findDish,
    findTable: findTable,
    dishesByCategory: dishesByCategory,
    categoryCount: categoryCount,
    /* 购物车 */
    qtyOf: qtyOf,
    addToCart: addToCart,
    decreaseFromCart: decreaseFromCart,
    removeFromCart: removeFromCart,
    clearCart: clearCart,
    cartItems: cartItems,
    cartCount: cartCount,
    cartTotal: cartTotal,
    cartEmpty: cartEmpty,
    canSubmit: canSubmit,
    selectedTable: selectedTable,
    /* 行为 */
    showToast: showToast,
    pickCategory: pickCategory,
    selectTable: selectTable,
    submitOrder: submitOrder,
    backToMenu: backToMenu,
    reorder: reorder
  };
})(window);
