/*!
 * Dock 常驻快捷栏
 * 规则 1：D 挡行车时娱乐入口（多媒体 / 全景）置灰并提示；
 * 规则 2：Dock 固定底部，不遮挡导航与关键驾驶信息。
 */
(function (global) {
  'use strict';

  var ITEMS = [
    { view: 'home', icon: 'home', label: '主页', voice: '回到主页' },
    { view: 'nav', icon: 'nav', label: '导航', voice: '打开导航' },
    { view: 'climate', icon: 'climate', label: '空调', voice: '打开空调' },
    { view: 'media', icon: 'media', label: '多媒体', voice: '打开多媒体', entertainment: true },
    { view: 'vehicle', icon: 'car', label: '车辆', voice: '打开车辆设置' },
    { view: 'surround', icon: 'camera', label: '全景', voice: '打开全景影像', entertainment: true },
    { view: 'settings', icon: 'settings', label: '设置', voice: '打开设置页' }
  ];

  global.AppDock = {
    name: 'AppDock',
    props: {
      state: { type: Object, required: true },
      ctx: { type: Object, required: true },
      view: { type: String, default: 'home' }
    },
    data: function () {
      return { items: ITEMS };
    },
    computed: {
      restricted: function () {
        return this.state.isDriving();
      }
    },
    methods: {
      locked: function (item) {
        return !!(item.entertainment && this.restricted);
      },
      cls: function (item) {
        return {
          'dock__btn': true,
          'is-active': this.view === item.view,
          'is-locked': this.locked(item)
        };
      },
      go: function (item) {
        if (this.locked(item)) {
          /* 规则 1：轻量提示，不弹模态窗 */
          this.ctx.toast.restricted();
          return;
        }
        if (item.view === 'home') this.ctx.router.home();
        else this.ctx.router.push(item.view);
      },
      gearSwitch: function () {
        this.ctx.simulator.setGear(this.state.gear === 'D' ? 'P' : 'D');
      }
    },
    template: [
      '<nav class="dock" aria-label="常驻快捷栏">',
      '  <button v-for="item in items" :key="item.view" :class="cls(item)" @click="go(item)"',
      '          :aria-label="item.label" :aria-current="view === item.view ? \'page\' : false">',
      '    <rw-icon :name="item.icon" :size="34"></rw-icon>',
      '    <span>{{ item.label }}</span>',
      '    <i v-if="locked(item)" class="dock__lock"><rw-icon name="lock" :size="14"></rw-icon></i>',
      '  </button>',
      '  <button class="dock__btn dock__btn--gear" :class="state.gear === \'D\' ? \'is-d\' : \'is-p\'"',
      '          @click="gearSwitch" aria-label="切换挡位">',
      '    <b>{{ state.gear }}</b>',
      '    <span>挡位</span>',
      '  </button>',
      '</nav>'
    ].join('\n')
  };
})(window);
