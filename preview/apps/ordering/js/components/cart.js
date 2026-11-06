/**
 * 模块二：购物车
 * 桌面端为右侧常驻侧栏；移动端为底部吸底栏 + 可展开明细面板。
 * 实时明细、数量增减、总计、角标计数均来自 store 的计算属性。
 */
(function (global) {
  'use strict';

  var S = global.OrderingStore;
  var C = global.OrderingComponents;

  var CartPanel = {
    name: 'CartPanel',
    components: {
      QtyStepper: C.QtyStepper,
      DishThumb: C.DishThumb,
      EmptyState: C.EmptyState,
      SpicyTag: C.SpicyTag
    },
    data: function () {
      return { sheetOpen: false };
    },
    computed: {
      state: function () { return S.state; },
      items: function () { return S.cartItems.value; },
      total: function () { return S.cartTotal.value; },
      count: function () { return S.cartCount.value; },
      empty: function () { return S.cartEmpty.value; },
      canSubmit: function () { return S.canSubmit.value; },
      table: function () { return S.selectedTable.value; }
    },
    methods: {
      add: function (id) { S.addToCart(id, 1); },
      remove: function (id) { S.decreaseFromCart(id); },
      drop: function (id) { S.removeFromCart(id); },
      clear: function () { S.clearCart(); S.showToast('购物车已清空'); },
      submit: function () {
        if (S.submitOrder()) this.sheetOpen = false;
      },
      toggleSheet: function () {
        if (this.empty) return;
        this.sheetOpen = !this.sheetOpen;
      }
    },
    template:
      '<aside class="cart" :class="{ \'cart--open\': sheetOpen }" aria-label="购物车">' +

      /* 移动端底部吸底栏 */
      '  <div class="cart__bar">' +
      '    <button class="cart__barIcon" type="button" @click="toggleSheet"' +
      '            :aria-label="\'购物车，共 \' + count + \' 件\'" :disabled="empty">' +
      '      <span class="cart__emoji" aria-hidden="true">🧺</span>' +
      '      <span v-if="count" class="badge">{{ count }}</span>' +
      '    </button>' +
      '    <div class="cart__barInfo">' +
      '      <span class="cart__barTotal">¥{{ total.toFixed(2) }}</span>' +
      '      <span class="cart__barTable">{{ table ? table.name : \'未选桌台\' }}</span>' +
      '    </div>' +
      '    <button class="btn btn--primary cart__barBtn" type="button" :disabled="!canSubmit" @click="submit">' +
      '      {{ table ? "提交订单" : "请先选桌" }}' +
      '    </button>' +
      '  </div>' +

      /* 明细面板（桌面常驻 / 移动端抽屉） */
      '  <div class="cart__panel">' +
      '    <header class="cart__head">' +
      '      <h2 class="cart__title">购物车' +
      '        <span class="cart__badge badge">{{ count }}</span>' +
      '      </h2>' +
      '      <div class="cart__headRight">' +
      '        <button v-if="!empty" class="link" type="button" @click="clear">清空</button>' +
      '        <button class="link link--mobile" type="button" @click="sheetOpen = false">收起</button>' +
      '      </div>' +
      '    </header>' +

      '    <div class="cart__list" v-if="!empty">' +
      '      <div class="cart__row" v-for="it in items" :key="it.dishId">' +
      '        <dish-thumb :gradient="it.dish.gradient" :name="it.dish.name" size="sm"></dish-thumb>' +
      '        <div class="cart__rowMain">' +
      '          <div class="cart__rowTop">' +
      '            <span class="cart__rowName">{{ it.dish.name }}</span>' +
      '            <spicy-tag :level="it.dish.spicy"></spicy-tag>' +
      '          </div>' +
      '          <div class="cart__rowBottom">' +
      '            <span class="price price--sm"><em>¥</em>{{ it.dish.price }}</span>' +
      '            <qty-stepper :qty="it.qty" size="sm" @add="add(it.dishId)" @remove="remove(it.dishId)"></qty-stepper>' +
      '          </div>' +
      '        </div>' +
      '        <div class="cart__rowSide">' +
      '          <span class="cart__subtotal">¥{{ (it.subtotalCents / 100).toFixed(2) }}</span>' +
      '          <button class="cart__del" type="button" @click="drop(it.dishId)"' +
      '                  :aria-label="\'移除 \' + it.dish.name">×</button>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +

      '    <empty-state v-else icon="🧺" text="购物车还是空的，去挑几道菜吧"></empty-state>' +

      '    <footer class="cart__foot">' +
      '      <div class="cart__sum">' +
      '        <span>合计</span>' +
      '        <strong class="cart__total">¥{{ total.toFixed(2) }}</strong>' +
      '      </div>' +
      '      <p class="cart__tableHint" :class="{ \'cart__tableHint--warn\': !table }">' +
      '        {{ table ? "已选：" + table.name + "（" + table.area + "）" : "请选择桌台后再提交" }}' +
      '      </p>' +
      '      <button class="btn btn--primary btn--block" type="button" :disabled="!canSubmit" @click="submit">' +
      '        {{ table ? "提交订单" : "请先选择桌台" }}' +
      '      </button>' +
      '    </footer>' +
      '  </div>' +

      '  <div class="cart__mask" v-if="sheetOpen" @click="sheetOpen = false"></div>' +
      '</aside>'
  };

  global.OrderingViews = global.OrderingViews || {};
  global.OrderingViews.CartPanel = CartPanel;
})(window);
