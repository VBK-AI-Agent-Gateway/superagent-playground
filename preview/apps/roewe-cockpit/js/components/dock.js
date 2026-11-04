/*!
 * js/components/dock.js — Dock 常驻快捷栏
 * 常驻 8 大模块入口 + 驾驶状态模拟器开关；受限页面在 D 挡下置灰并给出轻量提示。
 */
(function (global) {
  'use strict';

  var dock = {
    props: {
      items: { type: Array, required: true },
      active: { type: String, default: 'home' }
    },
    emits: ['go'],
    data: function () {
      return { S: global.CockpitState };
    },
    computed: {
      safety: function () { return global.CockpitSafety; }
    },
    methods: {
      isLocked: function (key) { return this.safety.isLocked(key); },
      tap: function (item) {
        if (this.isLocked(item.key)) {
          this.safety.warn(this.safety.lockReason(), item.label);
          return;
        }
        this.$emit('go', item.key);
      },
      toggleSim: function () { global.CockpitSimulator.toggle(); }
    },
    template:
      '<nav class="dock" role="navigation" aria-label="常驻快捷栏">' +
        '<button v-for="it in items" :key="it.key" class="dock-item" :class="{ active: active === it.key, locked: isLocked(it.key) }" ' +
                ':aria-label="it.label" :aria-current="active === it.key ? \'page\' : false" @click="tap(it)">' +
          '<span class="dock-ico"><c-icon :name="it.icon" :size="26"></c-icon>' +
            '<c-icon v-if="isLocked(it.key)" class="dock-lock" name="lock" :size="12"></c-icon>' +
          '</span>' +
          '<span class="dock-label">{{ it.short }}</span>' +
        '</button>' +
        '<button class="dock-item dock-sim" :class="{ active: S.simulatorOpen }" aria-label="驾驶状态模拟器" @click="toggleSim">' +
          '<span class="dock-ico"><c-icon name="gear" :size="26"></c-icon></span>' +
          '<span class="dock-label">模拟器</span>' +
        '</button>' +
      '</nav>'
  };

  global.CDock = dock;
})(window);
