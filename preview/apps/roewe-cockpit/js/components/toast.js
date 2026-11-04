/*!
 * js/components/toast.js — 轻量提示浮层（安全规则 2）
 * 位置固定在状态栏下方、Dock 之上，采用玻璃拟态 + 细边框；
 * 不覆盖车速 / 挡位 / 告警区域，不使用阻塞式遮罩。
 */
(function (global) {
  'use strict';

  var toast = {
    data: function () { return { S: global.CockpitState }; },
    computed: {
      cls: function () { return 'toast tone-' + this.S.toast.level; }
    },
    template:
      '<transition name="toast-in">' +
        '<div v-if="S.toast.visible" class="toast-host" role="status" aria-live="polite">' +
          '<div :class="cls">' +
            '<c-icon :name="S.toast.icon || \'info\'" :size="20"></c-icon>' +
            '<span class="toast-text">{{ S.toast.text }}</span>' +
          '</div>' +
        '</div>' +
      '</transition>'
  };

  global.CToast = toast;
})(window);
