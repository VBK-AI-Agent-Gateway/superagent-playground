/**
 * 通用小组件：辣度标记、渐变占位图、数量步进器、空状态。
 * 全部通过 window.OrderingComponents 注册为全局组件，供 index.html 使用。
 */
(function (global) {
  'use strict';

  var SPICY_LABEL = ['不辣', '微辣', '中辣', '特辣'];

  /** 🔥 辣度标记 —— 0 显示灰色「不辣」，1-3 显示对应数量的辣椒 */
  var SpicyTag = {
    name: 'SpicyTag',
    props: {
      level: { type: Number, default: 0 }
    },
    computed: {
      label: function () { return SPICY_LABEL[this.level] || '不辣'; },
      peppers: function () { return this.level > 0 ? new Array(this.level).fill('🌶') : []; }
    },
    template:
      '<span class="spicy" :class="\'spicy--\' + level" :title="label">' +
      '  <template v-if="level > 0">' +
      '    <span class="spicy__icon" v-for="(p, i) in peppers" :key="i">🌶</span>' +
      '  </template>' +
      '  <span class="spicy__text">{{ label }}</span>' +
      '</span>'
  };

  /** CSS 渐变占位图（不依赖任何图片资源） */
  var DishThumb = {
    name: 'DishThumb',
    props: {
      gradient: { type: String, default: 'linear-gradient(135deg,#f0e6d2,#c9b998)' },
      name: { type: String, default: '' },
      size: { type: String, default: 'md' }
    },
    computed: {
      initial: function () { return this.name ? this.name.slice(0, 1) : '菜'; }
    },
    template:
      '<div class="thumb" :class="\'thumb--\' + size" :style="{ backgroundImage: gradient }" aria-hidden="true">' +
      '  <span class="thumb__initial">{{ initial }}</span>' +
      '</div>'
  };

  /** 数量步进器：0 时只显示「+」，>0 时显示 −/数量/+ */
  var QtyStepper = {
    name: 'QtyStepper',
    props: {
      qty: { type: Number, required: true },
      size: { type: String, default: 'md' }
    },
    emits: ['add', 'remove'],
    template:
      '<div class="stepper" :class="\'stepper--\' + size">' +
      '  <button v-if="qty > 0" class="stepper__btn" type="button" @click="$emit(\'remove\')"' +
      '          :aria-label="\'减少一份\'">−</button>' +
      '  <span v-if="qty > 0" class="stepper__qty" aria-live="polite">{{ qty }}</span>' +
      '  <button class="stepper__btn stepper__btn--add" type="button" @click="$emit(\'add\')"' +
      '          :aria-label="\'增加一份\'">+</button>' +
      '</div>'
  };

  /** 空状态占位 */
  var EmptyState = {
    name: 'EmptyState',
    props: {
      icon: { type: String, default: '🍽' },
      text: { type: String, default: '暂无内容' }
    },
    template:
      '<div class="empty">' +
      '  <div class="empty__icon">{{ icon }}</div>' +
      '  <p class="empty__text">{{ text }}</p>' +
      '</div>'
  };

  global.OrderingComponents = {
    SpicyTag: SpicyTag,
    DishThumb: DishThumb,
    QtyStepper: QtyStepper,
    EmptyState: EmptyState
  };
})(window);
