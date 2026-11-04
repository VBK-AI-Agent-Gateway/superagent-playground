/*!
 * 轻量化非阻塞弹窗层
 * 规则 2：悬浮面板不遮挡导航与关键驾驶信息（车速、挡位、告警永远可见）
 * —— 本层固定在顶部安全区与底部 Dock 之上之间的「低信息区」，高度受限、半透明、不拦截除自身以外的操作。
 */
(function (global) {
  'use strict';

  global.ToastLayer = {
    name: 'ToastLayer',
    props: {
      toast: { type: Object, required: true }
    },
    computed: {
      cls: function () {
        return 'toast toast--' + (this.toast.level || 'info') + (this.toast.show ? ' is-show' : '');
      }
    },
    template: [
      '<div class="toast-layer" role="status" aria-live="polite">',
      '  <transition name="toast-pop">',
      '    <div v-if="toast.show" :key="toast.id" :class="cls">',
      '      <rw-icon :name="toast.level === \'warn\' ? \'warn\' : \'info\'" :size="26"></rw-icon>',
      '      <span>{{ toast.text }}</span>',
      '    </div>',
      '  </transition>',
      '</div>'
    ].join('\n')
  };
})(window);
