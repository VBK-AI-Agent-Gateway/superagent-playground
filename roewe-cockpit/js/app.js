/*!
 * 应用外壳 app-shell
 * 负责：装配 store / 安全层 / 语音助手，提供 ctx，渲染状态栏 + 视图 + Dock + 浮层
 */
(function (global) {
  'use strict';

  var VIEW_ORDER = ['home', 'nav', 'climate', 'media', 'vehicle', 'surround', 'parking', 'settings', 'voice'];
  var VIEW_COMPONENTS = {
    home: 'home-view',
    nav: 'nav-view',
    climate: 'climate-view',
    media: 'media-view',
    vehicle: 'vehicle-view',
    surround: 'surround-view',
    parking: 'parking-view',
    settings: 'settings-view',
    voice: 'voice-panel-view'
  };

  global.AppShell = {
    name: 'AppShell',
    data: function () {
      var state = global.createRoeweStore();
      var toast = global.RoeweSafety.createToast(state);
      var gears = global.RoeweSafety.createGearMachine(state, toast);
      var router = global.RoeweSafety.createRouter(state, toast, gears);
      var simulator = global.RoeweSafety.createDriveSimulator(state, gears, toast);
      var ctx = {
        state: state,
        toast: toast,
        gearMachine: gears,
        router: router,
        simulator: simulator,
        voice: null,
        setTheme: null,
        toggleTheme: null
      };
      ctx.voice = global.createVoiceAssistant(ctx);
      ctx.setTheme = function (key) {
        state.theme = key === 'light' ? 'light' : 'dark';
        if (state.system) state.system.theme = state.theme;
      };
      ctx.toggleTheme = function () {
        ctx.setTheme(state.theme === 'dark' ? 'light' : 'dark');
        toast.show(state.theme === 'dark' ? '已切换为深色模式' : '已切换为浅色模式', 'info');
      };
      return {
        ctx: ctx,
        view: 'home',
        viewOrder: VIEW_ORDER,
        components: VIEW_COMPONENTS,
        clockTimer: null,
        /* 路由是普通对象，用本地响应式字段镜像当前视图与方向 */
        routerView: 'home',
        routerDirection: 'forward'
      };
    },
    provide: function () {
      return { ctx: this.ctx };
    },
    computed: {
      state: function () { return this.ctx.state; },
      theme: function () { return this.ctx.state.theme; },
      currentComponent: function () { return VIEW_COMPONENTS[this.routerView] || 'home-view'; },
      pageKey: function () { return this.routerView + '-' + this.routerDirection; },
      transitionName: function () { return 'page'; },
      pageDir: function () { return 'is-' + (this.routerDirection || 'forward'); }
    },
    created: function () {
      this.tickClock();
      this.clockTimer = setInterval(this.tickClock, 1000);
      this.ctx.router.onChange = this.applyView.bind(this);
    },
    mounted: function () {
      this.applyView();
      /* 调试 / 自动化钩子（只读引用，供验收脚本与人工调试使用） */
      global.__app = this;
    },
    beforeUnmount: function () {
      clearInterval(this.clockTimer);
      this.ctx.router.onChange = null;
    },
    methods: {
      applyView: function () {
        this.routerView = this.ctx.router.current || 'home';
        this.routerDirection = this.ctx.router.direction || 'forward';
      },
      tickClock: function () {
        var d = new Date();
        var p = function (n) { return (n < 10 ? '0' : '') + n; };
        this.state.nowText = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
        var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
        this.state.nowDate = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + week;
        this.state.fps = 60;
      },
      onVoiceFloater: function () {
        this.ctx.router.push('voice');
      }
    },
    template: [
      '<div class="shell" :data-theme="theme">',
      '  <status-bar :state="state" :ctx="ctx" :view="routerView"></status-bar>',
      '  <main class="pages">',
      '    <transition :name="transitionName" mode="out-in">',
      '      <component :is="currentComponent" :key="pageKey" :class="pageDir"></component>',
      '    </transition>',
      '  </main>',
      '  <app-dock :state="state" :ctx="ctx" :view="routerView"></app-dock>',
      '  <toast-layer :toast="state.toast"></toast-layer>',
      '  <button class="voice-floater" :class="state.voice.awake ? \'is-awake\' : \'\'" @click="onVoiceFloater" aria-label="语音助手">',
      '    <rw-icon name="mic" :size="34"></rw-icon>',
      '    <span class="sr-only">语音助手</span>',
      '  </button>',
      '</div>'
    ].join('\n')
  };

  /* ------------------------------------------------------------------
   * 启动引导：注册全部组件并挂载到 #app
   * ------------------------------------------------------------------ */
  var COMPONENTS = {
    'app-shell': global.AppShell,
    'rw-icon': global.RoeweIcon,
    'card-panel': global.CardPanel,
    'toast-layer': global.ToastLayer,
    'status-bar': global.StatusBar,
    'app-dock': global.AppDock,
    'car-model-3d': global.CarModel3D,
    'home-view': global.HomeView,
    'nav-view': global.NavView,
    'climate-view': global.ClimateView,
    'media-view': global.MediaView,
    'vehicle-view': global.VehicleView,
    'voice-panel-view': global.VoicePanelView,
    'surround-view': global.SurroundView,
    'parking-view': global.ParkingView,
    'settings-view': global.SettingsView
  };

  function bootstrap() {
    var missing = [];
    for (var name in COMPONENTS) {
      if (COMPONENTS[name]) continue;
      missing.push(name);
    }
    if (missing.length) {
      /* 组件缺失时明确报错，避免出现难以定位的白屏 */
      console.error('[cockpit] 组件未注册：' + missing.join(', '));
      return;
    }
    var app = global.Vue.createApp({ name: 'CockpitRoot', template: '<app-shell></app-shell>' });
    for (var key in COMPONENTS) app.component(key, COMPONENTS[key]);
    app.mount('#app');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})(window);
