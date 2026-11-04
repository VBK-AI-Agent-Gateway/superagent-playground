/*!
 * js/components/light-panel.js — 轻量悬浮面板（安全规则 2）
 * 所有二级浮层统一走这里：右侧/中部弹出、半透明、可点外部关闭、无全屏遮罩，
 * 顶部状态栏（车速/挡位/告警）始终保持可见。
 */
(function (global) {
  'use strict';

  var lightPanel = {
    data: function () { return { S: global.CockpitState }; },
    computed: {
      open: function () { return this.S.lightPanel.open; }
    },
    methods: {
      close: function () { this.S.lightPanel.open = false; }
    },
    template:
      '<transition name="panel-slide">' +
        '<aside v-if="open" class="light-panel" role="dialog" aria-modal="false" :aria-label="S.lightPanel.title">' +
          '<header class="lp-head">' +
            '<h3 class="lp-title">{{ S.lightPanel.title }}</h3>' +
            '<button class="lp-close" aria-label="关闭面板" @click="close"><c-icon name="close" :size="20"></c-icon></button>' +
          '</header>' +
          '<div class="lp-body"><slot></slot></div>' +
        '</aside>' +
      '</transition>'
  };

  global.CLightPanel = lightPanel;
})(window);
