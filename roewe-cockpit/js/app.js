/*!
 * js/app.js — 应用装配
 * 注册全部组件、计算当前视图、驱动挡位安全状态机与全局语音唤醒。
 */
(function (global) {
  'use strict';

  var S = global.CockpitState;
  var cfg = global.COCKPIT_CONFIG;

  /* ---------- Dock 项目 ---------- */
  var DOCK = [
    { key: 'home', label: '首页', icon: 'home' },
    { key: 'nav', label: '导航', icon: 'nav' },
    { key: 'climate', label: '空调', icon: 'climate' },
    { key: 'media', label: '媒体', icon: 'media' },
    { key: 'vehicle', label: '车辆', icon: 'vehicle' },
    { key: 'voice', label: '语音', icon: 'voice' },
    { key: 'surround', label: '全景', icon: 'surround' },
    { key: 'parking', label: '泊车', icon: 'parking' },
    { key: 'settings', label: '设置', icon: 'settings' }
  ];

  var VIEW_MAP = {
    home: 'c-home-view',
    nav: 'c-nav-view',
    climate: 'c-climate-view',
    media: 'c-media-view',
    vehicle: 'c-vehicle-view',
    voice: 'c-voice-panel-view',
    surround: 'c-surround-view',
    parking: 'c-parking-view',
    settings: 'c-settings-view'
  };

  var app = {
    data: function () {
      return { S: S, dock: DOCK };
    },
    computed: {
      currentView: function () { return VIEW_MAP[S.view] || 'c-home-view'; },
      transitionName: function () { return S.transitionName; },
      driving: function () { return global.CockpitSafety.isDriving(); },
      themeLabel: function () { return S.theme === 'dark' ? '深色' : '浅色'; }
    },
    mounted: function () {
      var self = this;

      /* 主题与亮度落到 DOM */
      this.applyTheme(S.theme);
      this.applyBrightness(S.brightness);
      this.$watch(function () { return S.theme; }, function (t) { self.applyTheme(t); });
      this.$watch(function () { return S.brightness; }, function (b) { self.applyBrightness(b); });

      /* 启动时按持久化挡位收敛一次视图 */
      global.CockpitSafety.reconcileCurrentView();

      /* 语音唤醒常驻监听（无权限或浏览器不支持时静默降级） */
      global.CockpitVoice.init();

      /* 全局快捷键：Esc 返回，方便调试 */
      this._onKey = function (e) {
        if (e.key === 'Escape') {
          if (S.simulatorOpen) { global.CockpitSimulator.close(); return; }
          if (S.lightPanel.open) { S.lightPanel.open = false; return; }
          if (S.view !== 'home') global.CockpitRouter.back();
        }
      };
      global.addEventListener('keydown', this._onKey);

      /* 待机时钟：驱动首页时间与欢迎语 */
      this._tick = global.setInterval(function () {
        S.booted = true;
      }, 30);
      global.setTimeout(function () { S.booted = true; }, 40);
    },
    beforeUnmount: function () {
      if (this._onKey) global.removeEventListener('keydown', this._onKey);
      if (this._tick) global.clearInterval(this._tick);
    },
    methods: {
      applyTheme: function (t) {
        var el = global.document.documentElement;
        el.classList.toggle('theme-dark', t === 'dark');
        el.classList.toggle('theme-light', t !== 'dark');
        el.setAttribute('data-theme', t);
      },
      applyBrightness: function (b) {
        var v = Math.max(20, Math.min(100, Number(b) || 80));
        global.document.documentElement.style.setProperty('--c-brightness', (v / 100).toFixed(2));
      },
      go: function (view) {
        if (view === 'camera') { this.openCamera(); return; }
        global.CockpitRouter.go(view);
      },
      openCamera: function () {
        if (global.CockpitSafety.isDriving()) {
          global.CockpitSafety.warn('行车中，娱乐功能已限制', 'camera');
          return;
        }
        S.camera.mode = 'front';
        global.CockpitRouter.go('surround');
      },
      openSim: function () { global.CockpitSimulator.open(); }
    },
    template:
      '<div class="app-root" :class="{ booted: S.booted, driving: driving, \'theme-\' + S.theme: true }">' +
        '<status-bar></status-bar>' +
        '<main class="stage">' +
          '<transition :name="transitionName" mode="out-in">' +
            '<component :is="currentView" :key="S.view"></component>' +
          '</transition>' +
        '</main>' +
        '<dock-bar :items="dock" :active="S.view" @go="go" @sim="openSim"></dock-bar>' +
        '<simulator-panel v-if="S.simulatorOpen"></simulator-panel>' +
        '<light-panel v-if="S.lightPanel.open"></light-panel>' +
        '<voice-orb></voice-orb>' +
        '<gear-guard></gear-guard>' +
        '<toast-host></toast-host>' +
      '</div>'
  };

  /* ---------- 注册组件 ---------- */
  var COMPONENTS = {
    'c-icon': global.CIcon,
    'c-card': global.CCard,
    'status-bar': global.CStatusBar,
    'dock-bar': global.CDock,
    'car-model': global.CCarModel,
    'simulator-panel': global.CSimulatorPanel,
    'light-panel': global.CLightPanel,
    'voice-orb': global.CVoiceOrb,
    'gear-guard': global.CGearGuard,
    'toast-host': global.CToastHost,
    'c-home-view': global.CHomeView,
    'c-nav-view': global.CNavView,
    'c-climate-view': global.CClimateView,
    'c-media-view': global.CMediaView,
    'c-vehicle-view': global.CVehicleView,
    'c-voice-panel-view': global.CVoicePanelView,
    'c-surround-view': global.CSurroundView,
    'c-parking-view': global.CParkingView,
    'c-settings-view': global.CSettingsView
  };

  var missing = [];
  Object.keys(COMPONENTS).forEach(function (k) {
    if (!COMPONENTS[k]) missing.push(k);
  });
  if (missing.length) {
    global.console && global.console.warn('[cockpit] 缺少组件：' + missing.join(', '));
  }

  /* ---------- 启动 ---------- */
  global.CockpitApp = app;
  global.COCKPIT_DOCK = DOCK;

  function boot() {
    if (!global.Vue) {
      global.document.getElementById('app').innerHTML =
        '<p style="padding:24px;color:#fff">Vue 未加载，请确认 vendor/vue.global.prod.js 存在。</p>';
      return;
    }
    global.Vue.createApp(app).mount('#app');
  }

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
