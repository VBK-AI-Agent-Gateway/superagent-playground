/**
 * 应用入口：注册全局组件、挂载根实例。
 * 依赖顺序：vendor/vue.global.prod.js → js/data/menu.js → js/store.js
 *          → js/components/*.js → js/app.js
 */
(function (global) {
  'use strict';

  var Vue = global.Vue;
  var S = global.OrderingStore;
  var C = global.OrderingComponents;
  var V = global.OrderingViews;
  var D = global.OrderingData;

  var App = {
    name: 'OrderingApp',
    computed: {
      state: function () { return S.state; },
      view: function () { return S.state.view; },
      toast: function () { return S.state.toast; },
      categories: function () { return D.CATEGORIES; },
      cartCount: function () { return S.cartCount.value; }
    },
    methods: {
      goMenu: function () {
        if (S.state.view !== 'menu') S.backToMenu();
      }
    },
    template:
      '<div class="app" :class="\'app--\' + view">' +
      '  <header class="topbar">' +
      '    <button class="topbar__brand" type="button" @click="goMenu" aria-label="返回菜单">' +
      '      <span class="topbar__logo" aria-hidden="true">朱</span>' +
      '      <span class="topbar__name">{{ $root.restaurantName }}</span>' +
      '    </button>' +
      '    <nav class="topbar__nav" aria-label="主导航">' +
      '      <button class="topbar__link" :class="{ \'topbar__link--active\': view === \'menu\' }"' +
      '              type="button" @click="goMenu">菜单</button>' +
      '      <span class="topbar__table" v-if="state.selectedTableId">桌台 {{ state.selectedTableId }}</span>' +
      '    </nav>' +
      '  </header>' +

      '  <main class="layout">' +
      '    <div class="layout__main">' +
      '      <menu-view v-if="view === \'menu\'"></menu-view>' +
      '      <order-confirm v-else></order-confirm>' +
      '    </div>' +
      '    <div class="layout__side" v-if="view === \'menu\'">' +
      '      <table-picker></table-picker>' +
      '      <cart-panel></cart-panel>' +
      '    </div>' +
      '  </main>' +

      '  <transition name="fade">' +
      '    <div class="toast" v-if="toast" role="status">{{ toast }}</div>' +
      '  </transition>' +
      '</div>'
  };

  function boot() {
    if (!global.Vue || !global.OrderingStore || !global.OrderingData) {
      document.body.innerHTML =
        '<p style="font-family:sans-serif;padding:32px">资源加载失败：请确认 vendor/ 与 js/ 目录完整。</p>';
      return;
    }
    var app = Vue.createApp(App);
    app.component('spicy-tag', C.SpicyTag);
    app.component('dish-thumb', C.DishThumb);
    app.component('qty-stepper', C.QtyStepper);
    app.component('empty-state', C.EmptyState);
    app.component('menu-view', V.MenuView);
    app.component('cart-panel', V.CartPanel);
    app.component('table-picker', V.TablePicker);
    app.component('order-confirm', V.OrderConfirm);
    var vm = app.mount('#app');
    // 供 $root 模板读取的静态字段
    vm.restaurantName = D.RESTAURANT.name;
    global.__ORDERING_APP__ = vm;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
