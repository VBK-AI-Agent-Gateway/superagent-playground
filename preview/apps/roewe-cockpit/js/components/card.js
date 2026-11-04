/*!
 * js/components/card.js — 通用卡片容器（车载卡片化设计，点击可带语音指令注册）
 */
(function (global) {
  'use strict';

  var card = {
    props: {
      title: { type: String, default: '' },
      icon: { type: String, default: '' },
      tone: { type: String, default: 'default' },   // default | accent | danger | success
      dense: { type: Boolean, default: false },
      locked: { type: Boolean, default: false },
      clickable: { type: Boolean, default: false }
    },
    emits: ['tap'],
    template:
      '<section class="card" :class="[toneClass, { \'is-dense\': dense, \'is-locked\': locked, \'is-clickable\': clickable }]" @click="clickable && $emit(\'tap\')">' +
        '<header v-if="title || $slots.header" class="card-head">' +
          '<c-icon v-if="icon" :name="icon" :size="22"></c-icon>' +
          '<h3 v-if="title" class="card-title">{{ title }}</h3>' +
          '<slot name="header"></slot>' +
        '</header>' +
        '<div class="card-body"><slot></slot></div>' +
        '<footer v-if="$slots.footer" class="card-foot"><slot name="footer"></slot></footer>' +
      '</section>',
    computed: {
      toneClass: function () { return 'tone-' + this.tone; }
    }
  };

  global.CCard = card;
})(window);
