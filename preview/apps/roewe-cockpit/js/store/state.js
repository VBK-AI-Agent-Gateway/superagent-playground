/*!
 * js/store/state.js — 全局响应式状态（零构建：普通对象交给 Vue.reactive）
 * 所有页面共享同一份状态，替代传统 store 库。
 */
(function (global) {
  'use strict';

  var cfg = global.COCKPIT_CONFIG || {};
  var defaults = cfg.defaults || {};

  function readStore(key, fallback) {
    try {
      var raw = global.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeStore(key, value) {
    try { global.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式忽略 */ }
  }

  var mock = global.cloneMock(global.CockpitMock);

  var state = {
    /* ---------- 运行态 ---------- */
    booted: false,
    view: 'home',
    prevView: 'home',
    transitionName: 'view-slide-up',
    viewStack: ['home'],

    /* ---------- 主题与座舱 ---------- */
    theme: readStore('rx5.theme', defaults.theme || 'dark'),
    brightness: readStore('rx5.brightness', defaults.brightness || 80),
    autoBrightness: true,

    /* ---------- 挡位 / 驾驶状态（安全规则 1 & 4） ---------- */
    gear: readStore('rx5.gear', (cfg.simulator && cfg.simulator.gear) || 'P'),
    speed: 0,
    simulatorOpen: false,
    gearGuardVisible: false,
    gearGuardReason: '',
    gearGuardFeature: '',

    /* ---------- 轻量弹层（安全规则 2） ---------- */
    toast: { visible: false, text: '', icon: 'info', level: 'info', seq: 0 },
    lightPanel: { open: false, kind: '', title: '', payload: null },

    /* ---------- 语音 ---------- */
    voice: { listening: false, speaking: false, transcript: '', reply: '', available: true, wake: false },

    /* ---------- 数据 ---------- */
    data: mock,

    /* ---------- 导航运行时 ---------- */
    navRuntime: {
      mapReady: false,
      mapMode: 'fallback',   // amap | fallback
      routeId: 'r1',
      searching: false,
      keyword: '',
      poiType: 'charge',
      navigating: false,
      mute: false,
      zoom: 14
    },

    /* ---------- 360 / 泊车视图 ---------- */
    camera: { angle: 0, mode: 'front', autoRotate: true },

    /* ---------- 空调面板展开态 ---------- */
    climateExpanded: false,

    /* ---------- 应用内计时器 ---------- */
    clock: { time: '--:--', date: '' }
  };

  global.CockpitState = Vue.reactive(state);
  global.CockpitStore = {
    read: readStore,
    write: writeStore,
    persistTheme: function (t) { writeStore('rx5.theme', t); },
    persistBrightness: function (b) { writeStore('rx5.brightness', b); },
    persistGear: function (g) { writeStore('rx5.gear', g); }
  };

  /* ---------- 时钟（顶栏与主页时间卡片共用） ---------- */
  (function tickClock() {
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    function update() {
      var d = new Date();
      state.clock.time = pad(d.getHours()) + ':' + pad(d.getMinutes());
      var wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
      state.clock.date = d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 ' + wd;
    }
    update();
    global.setInterval(update, 10000);
  })();
})(window);
