/*!
 * js/store/safety.js — 车机安全交互规则引擎（最高优先级）
 *
 * 规则 1 挡位状态机：D 挡（或车速 > 阈值）限制娱乐类页面进入，给出轻量提示；
 *                   P 挡解锁全部娱乐功能。
 * 规则 2 弹窗轻量化：统一出口，浮层永不含遮挡车速/挡位/告警的模型，见 CSS 安全区。
 * 规则 3 页面切换流畅：由 transitionName 驱动车载级过渡。
 * 规则 4 驾驶状态模拟器：setGear / setSpeed 供设置页与 Dock 调用。
 */
(function (global) {
  'use strict';

  var cfg = global.COCKPIT_CONFIG || {};
  var simCfg = cfg.simulator || {};
  var S = global.CockpitState;

  /* 娱乐类（受限）页面：D 挡 / 行车中禁止进入 */
  var ENTERTAINMENT_VIEWS = ['media', 'surround', 'parking'];
  /* 页面中文名，用于提示文案 */
  var VIEW_LABEL = {
    home: '主页', nav: '导航', climate: '空调', media: '多媒体',
    vehicle: '车辆设置', voice: '语音助手', surround: '360 全景', parking: '泊车辅助', settings: '设置'
  };

  var safety = {
    ENTERTAINMENT_VIEWS: ENTERTAINMENT_VIEWS,
    VIEW_LABEL: VIEW_LABEL,

    /* ---------- 状态判定 ---------- */
    isDriving: function () {
      var th = simCfg.drivingSpeedThreshold || 5;
      return S.gear === 'D' || S.gear === 'R' || S.speed >= th;
    },
    isParked: function () { return !this.isDriving(); },
    isEntertainment: function (view) { return ENTERTAINMENT_VIEWS.indexOf(view) !== -1; },

    /** 页面是否被允许进入 */
    canEnter: function (view) {
      return !(this.isDriving() && this.isEntertainment(view));
    },

    /** 页面是否整体置灰（Dock / 主页卡片用） */
    isLocked: function (view) { return this.isDriving() && this.isEntertainment(view); },

    lockReason: function () {
      return '行车中，娱乐功能已限制';
    },

    /* ---------- 规则 4：驾驶状态模拟器 ---------- */
    setGear: function (gear) {
      var g = String(gear || 'P').toUpperCase();
      if (['P', 'R', 'N', 'D'].indexOf(g) === -1) return;
      S.gear = g;
      global.CockpitStore.persistGear(g);
      if (g === 'D' && S.speed < 5) S.speed = 30;
      if (g === 'P' || g === 'N') S.speed = 0;
      this.reconcileCurrentView();
    },

    setSpeed: function (v) {
      var n = Math.max(0, Math.min(180, Math.round(Number(v) || 0)));
      S.speed = n;
      S.data.vehicle.speed = n;
      S.data.vehicle.power = Math.round(n * 0.42);
      /* 车速升高时同步挡位语义：非 P 挡下车速与挡位保持一致 */
      if (n >= 5 && S.gear === 'P') { S.gear = 'D'; global.CockpitStore.persistGear('D'); }
      if (n < 5 && S.gear === 'D') { S.gear = 'R'; global.CockpitStore.persistGear('R'); }
      this.reconcileCurrentView();
    },

    /** 当前页面在新状态下变得不可进入时，退回主页并提示 */
    reconcileCurrentView: function () {
      if (this.isLocked(S.view)) {
        this.warn(this.lockReason(), VIEW_LABEL[S.view] || '该功能');
        global.CockpitRouter.go('home', { force: true, guard: true });
      }
    },

    /* ---------- 轻量提示（规则 2：非阻塞、不遮挡关键信息） ---------- */
    warn: function (text, feature) {
      this.notify({ text: text, level: 'warn', icon: 'shield' });
      S.gearGuardVisible = true;
      S.gearGuardReason = text;
      S.gearGuardFeature = feature || '';
      if (this._guardTimer) global.clearTimeout(this._guardTimer);
      var self = this;
      this._guardTimer = global.setTimeout(function () {
        S.gearGuardVisible = false;
      }, 3200);
    },

    notify: function (opt) {
      S.toast.text = opt.text || '';
      S.toast.icon = opt.icon || 'info';
      S.toast.level = opt.level || 'info';
      S.toast.seq += 1;
      S.toast.visible = true;
      if (this._toastTimer) global.clearTimeout(this._toastTimer);
      this._toastTimer = global.setTimeout(function () { S.toast.visible = false; }, 3200);
    },

    /* ---------- 灯光/锁止等快捷动作（被语音「可见即可说」复用） ---------- */
    toggleLock: function () {
      var v = S.data.vehicle;
      v.lock = !v.lock;
      this.notify({ text: v.lock ? '车辆已上锁' : '车辆已解锁', icon: v.lock ? 'lock' : 'unlock', level: v.lock ? 'ok' : 'warn' });
      return v.lock;
    },
    toggleLight: function (key) {
      var l = S.data.vehicle.lights;
      l[key] = !l[key];
      this.notify({ text: '车灯状态已更新', icon: 'light' });
    }
  };

  global.CockpitSafety = safety;

  /* ---------- 路由：带挡位守卫的页面切换 ---------- */
  global.CockpitRouter = {
    go: function (view, opt) {
      opt = opt || {};
      if (!S.booted && !opt.force) { /* 首帧允许 */ }
      if (!opt.force && !global.CockpitSafety.canEnter(view)) {
        global.CockpitSafety.warn(global.CockpitSafety.lockReason(), global.CockpitSafety.VIEW_LABEL[view]);
        return false;
      }
      if (S.view === view) return true;
      S.prevView = S.view;
      S.transitionName = this.pickTransition(S.view, view);
      S.view = view;
      S.viewStack.push(view);
      if (S.viewStack.length > 12) S.viewStack.shift();
      return true;
    },

    /* 规则 3：车载级过渡——卡片滑入 / 缩放，避免生硬跳转 */
    pickTransition: function (from, to) {
      var order = ['home', 'nav', 'climate', 'media', 'vehicle', 'voice', 'surround', 'parking', 'settings'];
      var a = order.indexOf(from), b = order.indexOf(to);
      if (a === -1 || b === -1) return 'view-fade-scale';
      return b > a ? 'view-slide-left' : 'view-slide-right';
    },

    back: function () {
      if (S.viewStack.length <= 1) return;
      S.viewStack.pop();
      var prev = S.viewStack[S.viewStack.length - 1];
      S.transitionName = this.pickTransition(S.view, prev);
      S.view = prev;
    }
  };
})(window);
