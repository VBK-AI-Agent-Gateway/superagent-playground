/*!
 * js/components/gear-guard.js — 挡位限制提示条（安全规则 1 的可见反馈）
 * 出现在屏幕中下部，半透明、非阻塞、3.2 秒自动收起，
 * 文案固定为「行车中，娱乐功能已限制」，并标注被限制的功能名。
 */
(function (global) {
  'use strict';

  var gearGuard = {
    data: function () { return { S: global.CockpitState }; },
    computed: {
      gear: function () { return this.S.gear; }
    },
    template:
      '<transition name="guard-in">' +
        '<div v-if="S.gearGuardVisible" class="gear-guard" role="alert">' +
          '<div class="gg-inner">' +
            '<span class="gg-badge"><c-icon name="shield" :size="18"></c-icon>{{ gear }} 挡</span>' +
            '<div class="gg-text">' +
              '<strong>{{ S.gearGuardReason || \'行车中，娱乐功能已限制\' }}</strong>' +
              '<small v-if="S.gearGuardFeature">受限功能：{{ S.gearGuardFeature }} · 停车挂 P 挡后自动解锁</small>' +
              '<small v-else>停车挂 P 挡后自动解锁</small>' +
            '</div>' +
            '<button class="gg-close" aria-label="关闭提示" @click="S.gearGuardVisible = false">' +
              '<c-icon name="close" :size="18"></c-icon>' +
            '</button>' +
          '</div>' +
        '</div>' +
      '</transition>'
  };

  global.CGearGuard = gearGuard;
})(window);
