/**
 * 模块三：下单流程
 * 桌台选择（16 桌）→ 提交 → 订单确认页（订单号 / 菜品列表 / 总计 / 预计等待）。
 */
(function (global) {
  'use strict';

  var S = global.OrderingStore;
  var C = global.OrderingComponents;
  var D = global.OrderingData;

  var TablePicker = {
    name: 'TablePicker',
    computed: {
      tables: function () { return D.TABLES; },
      selected: function () { return S.state.selectedTableId; },
      /** 按区域分组：大厅 A 区 / 包厢 B 区 */
      areas: function () {
        var map = {};
        var order = [];
        D.TABLES.forEach(function (t) {
          if (!map[t.area]) { map[t.area] = []; order.push(t.area); }
          map[t.area].push(t);
        });
        return order.map(function (name) { return { name: name, list: map[name] }; });
      },
      selectedTable: function () { return S.selectedTable.value; }
    },
    methods: {
      pick: function (id) { S.selectTable(id); }
    },
    template:
      '<section class="tables" aria-label="桌台选择">' +
      '  <div class="tables__head">' +
      '    <h2 class="section__title"><span class="section__bar"></span>选择桌台</h2>' +
      '    <p class="tables__hint">共 {{ tables.length }} 桌 · 请选择您的就餐位置</p>' +
      '  </div>' +
      '  <div class="tables__area" v-for="a in areas" :key="a.name">' +
      '    <h3 class="tables__areaName">{{ a.name }}</h3>' +
      '    <div class="tables__grid">' +
      '      <button v-for="t in a.list" :key="t.id" type="button" class="table"' +
      '              :class="{ \'table--active\': selected === t.id }"' +
      '              :aria-pressed="selected === t.id" @click="pick(t.id)">' +
      '        <span class="table__name">{{ t.name }}</span>' +
      '        <span class="table__seats">{{ t.seats }} 人位</span>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      '  <p class="tables__chosen" v-if="selectedTable">' +
      '    已选桌台：<strong>{{ selectedTable.name }}</strong> · {{ selectedTable.area }} · {{ selectedTable.seats }} 人位' +
      '  </p>' +
      '  <p class="tables__chosen tables__chosen--warn" v-else>尚未选择桌台，提交按钮保持禁用</p>' +
      '</section>'
  };

  var OrderConfirm = {
    name: 'OrderConfirm',
    components: {
      DishThumb: C.DishThumb,
      SpicyTag: C.SpicyTag
    },
    computed: {
      order: function () { return S.state.order; }
    },
    methods: {
      back: function () { S.backToMenu(); },
      reorder: function () { S.reorder(); }
    },
    template:
      '<section class="confirm" v-if="order" aria-label="订单确认">' +
      '  <div class="confirm__card">' +
      '    <div class="confirm__hero">' +
      '      <div class="confirm__check" aria-hidden="true">✓</div>' +
      '      <h1 class="confirm__title">下单成功</h1>' +
      '      <p class="confirm__sub">订单已送达后厨，请耐心等候</p>' +
      '    </div>' +

      '    <dl class="confirm__meta">' +
      '      <div class="confirm__metaItem">' +
      '        <dt>订单号</dt><dd class="confirm__no">{{ order.no }}</dd>' +
      '      </div>' +
      '      <div class="confirm__metaItem">' +
      '        <dt>桌台</dt><dd>{{ order.tableName }}（{{ order.tableArea }}）</dd>' +
      '      </div>' +
      '      <div class="confirm__metaItem">' +
      '        <dt>下单时间</dt><dd>{{ order.createdAt }}</dd>' +
      '      </div>' +
      '      <div class="confirm__metaItem">' +
      '        <dt>预计等待</dt><dd class="confirm__wait">约 {{ order.waitMinutes }} 分钟</dd>' +
      '      </div>' +
      '    </dl>' +

      '    <h2 class="section__title confirm__listTitle"><span class="section__bar"></span>菜品清单' +
      '      <small class="section__sub">共 {{ order.count }} 件</small></h2>' +
      '    <ul class="confirm__list">' +
      '      <li class="confirm__item" v-for="it in order.items" :key="it.dishId">' +
      '        <dish-thumb :gradient="it.gradient" :name="it.name" size="sm"></dish-thumb>' +
      '        <div class="confirm__itemMain">' +
      '          <span class="confirm__itemName">{{ it.name }}</span>' +
      '          <span class="confirm__itemMeta">' +
      '            <spicy-tag :level="it.spicy"></spicy-tag>' +
      '            <span class="confirm__itemUnit">¥{{ it.price }} × {{ it.qty }}</span>' +
      '          </span>' +
      '        </div>' +
      '        <span class="confirm__itemSum">¥{{ it.subtotal.toFixed(2) }}</span>' +
      '      </li>' +
      '    </ul>' +

      '    <div class="confirm__total">' +
      '      <span>合计</span>' +
      '      <strong class="confirm__totalValue">¥{{ order.total.toFixed(2) }}</strong>' +
      '    </div>' +

      '    <div class="confirm__actions">' +
      '      <button class="btn btn--ghost" type="button" @click="reorder">再来一单</button>' +
      '      <button class="btn btn--primary" type="button" @click="back">返回菜单继续点餐</button>' +
      '    </div>' +
      '  </div>' +
      '</section>'
  };

  global.OrderingViews = global.OrderingViews || {};
  global.OrderingViews.TablePicker = TablePicker;
  global.OrderingViews.OrderConfirm = OrderConfirm;
})(window);
