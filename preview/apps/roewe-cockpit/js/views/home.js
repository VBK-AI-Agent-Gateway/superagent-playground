/*!
 * js/views/home.js — 模块 1：主页
 * 常驻 Dock + 车辆 3D 卡片 + 实时速度/电量/油量 + 时间天气卡片。
 * 安全规则 1：D 挡优先显示导航卡片（导航卡片置于首位并放大），P 挡恢复完整卡片布局。
 */
(function (global) {
  'use strict';

  var home = {
    data: function () { return { S: global.CockpitState }; },
    computed: {
      v: function () { return this.S.data.vehicle; },
      w: function () { return this.S.data.weather; },
      driving: function () { return global.CockpitSafety.isDriving(); },
      /** D 挡：导航优先布局；P 挡：完整卡片布局 */
      layout: function () { return this.driving ? 'nav-first' : 'full'; },
      metrics: function () {
        var v = this.v;
        return [
          { key: 'speed', label: '车速', value: v.speed, unit: 'km/h', tone: v.speed > 100 ? 'warn' : 'ok' },
          { key: 'battery', label: '电量', value: v.battery, unit: '%', tone: v.battery <= 20 ? 'bad' : 'ok', sub: '续航 ' + v.range + ' km' },
          { key: 'fuel', label: '油量', value: v.fuel, unit: '%', tone: v.fuel <= 15 ? 'bad' : 'ok', sub: '油耗 ' + v.fuelPer100 + ' L/100km' }
        ];
      },
      statusList: function () {
        var v = this.v;
        var out = [];
        if (!v.lock) out.push({ icon: 'unlock', text: '车门未锁' });
        Object.keys(v.doors).forEach(function (k) {
          if (v.doors[k]) out.push({ icon: 'door', text: ({ fl: '左前门', fr: '右前门', rl: '左后门', rr: '右后门', trunk: '后备箱' })[k] + '未关' });
        });
        if (v.lights.low) out.push({ icon: 'light', text: '近光灯已开' });
        if (v.lights.fog) out.push({ icon: 'light', text: '雾灯已开' });
        if (this.w.aqi > 100) out.push({ icon: 'wind', text: '空气质量较差' });
        return out;
      },
      navSummary: function () { return this.S.data.nav.destination; },
      modelName: function () { return (global.COCKPIT_CONFIG.vehicle || {}).model || '荣威 RX5'; },
      plate: function () { return (global.COCKPIT_CONFIG.vehicle || {}).plate || '沪A·RX520'; },
      driveModeText: function () {
        var m = { eco: '经济', comfort: '舒适', sport: '运动', snow: '雪地' };
        return m[this.S.data.vehicle.driveMode] || '舒适';
      }
    },
    mounted: function () {
      var self = this;
      this.$unregister = global.CockpitVoiceRegistry.register({
        id: 'home.nav', scope: 'home', label: '打开导航',
        phrases: ['打开导航', '去导航', '导航'],
        handler: function () { global.CockpitRouter.go('nav'); return '已打开导航。'; }
      });
      var un2 = global.CockpitVoiceRegistry.register({
        id: 'home.climate', scope: 'home', label: '打开空调',
        phrases: ['打开空调', '开空调', '空调'],
        handler: function () { global.CockpitRouter.go('climate'); return '已打开空调面板。'; }
      });
      var un3 = global.CockpitVoiceRegistry.register({
        id: 'home.voice', scope: 'home', label: '打开语音助手',
        phrases: ['打开语音助手', '语音助手'],
        handler: function () { global.CockpitRouter.go('voice'); return '语音助手已就绪。'; }
      });
      this._uns = [this.$unregister, un2, un3];
      this._t = global.setInterval(function () { self.$forceUpdate(); }, 1000);
    },
    beforeUnmount: function () {
      (this._uns || []).forEach(function (fn) { fn(); });
      if (this._t) global.clearInterval(this._t);
    },
    methods: {
      go: function (view) { global.CockpitRouter.go(view); },
      openSim: function () { global.CockpitSimulator.open(); }
    },
    template:
      '<div class="view view-home" :class="\'layout-\' + layout">' +

        /* ---------- D 挡优先：导航卡片 ---------- */
        '<section v-if="driving" class="card nav-priority" :class="{ locked: false }">' +
          '<div class="np-head">' +
            '<span class="np-badge"><c-icon name="nav" :size="18"></c-icon>行车中 · 导航优先</span>' +
            '<span class="np-eta">{{ navSummary.eta }} 分钟 · {{ navSummary.distance }} km</span>' +
          '</div>' +
          '<div class="np-dest"><c-icon name="poi" :size="20"></c-icon><span>{{ navSummary.name }}</span></div>' +
          '<div class="np-lane">' +
            '<c-icon name="route" :size="22"></c-icon>' +
            '<span>{{ S.data.nav.lane.maneuver }}</span>' +
          '</div>' +
          '<button class="btn btn-accent np-go" @click="go(\'nav\')">继续导航</button>' +
        '</section>' +

        /* ---------- 车辆 3D 卡片 ---------- */
        '<c-card class="car-card" tone="accent">' +
          '<template #header><span class="cc-chip">{{ driveModeText }}模式</span></template>' +
          '<c-car-model :height="driving ? 190 : 250"></c-car-model>' +
          '<div class="car-foot">' +
            '<span class="car-name">{{ modelName }}</span>' +
            '<span class="car-plate">{{ plate }}</span>' +
          '</div>' +
        '</c-card>' +

        /* ---------- 实时指标 ---------- */
        '<section class="metric-row">' +
          '<div v-for="m in metrics" :key="m.key" class="metric" :class="\'tone-\' + m.tone">' +
            '<div class="metric-ico"><c-icon :name="m.key" :size="22"></c-icon></div>' +
            '<div class="metric-val"><b>{{ m.value }}</b><i>{{ m.unit }}</i></div>' +
            '<div class="metric-label">{{ m.label }}</div>' +
            '<div v-if="m.sub" class="metric-sub">{{ m.sub }}</div>' +
          '</div>' +
        '</section>' +

        /* ---------- P 挡完整布局：时间 + 天气 + 快捷 ---------- */
        '<template v-if="!driving">' +
          '<section class="home-row">' +
            '<div class="card time-card">' +
              '<c-icon name="time" :size="22"></c-icon>' +
              '<b class="tc-time">{{ S.clock.time }}</b>' +
              '<span class="tc-date">{{ S.clock.date }}</span>' +
              '<span class="tc-tz">中国标准时间 UTC+8</span>' +
            '</div>' +
            '<div class="card weather-card" @click="go(\'nav\')">' +
              '<div class="wc-top">' +
                '<c-icon :name="w.icon" :size="34"></c-icon>' +
                '<div><b>{{ w.now }}°</b><span>{{ w.text }}</span></div>' +
              '</div>' +
              '<div class="wc-city">{{ w.city }}</div>' +
              '<div class="wc-meta"><span>最高 {{ w.high }}°</span><span>最低 {{ w.low }}°</span><span>AQI {{ w.aqi }} {{ w.aqiText }}</span></div>' +
            '</div>' +
          '</section>' +

          '<section class="card quick-card">' +
            '<div class="quick-grid">' +
              '<button class="quick" @click="go(\'climate\')"><c-icon name="climate" :size="24"></c-icon><span>空调</span><small>{{ S.data.climate.tempL }}°</small></button>' +
              '<button class="quick" @click="go(\'media\')"><c-icon name="media" :size="24"></c-icon><span>音乐</span><small>{{ S.data.media.playing ? \'播放中\' : \'暂停\' }}</small></button>' +
              '<button class="quick" @click="go(\'vehicle\')"><c-icon name="car" :size="24"></c-icon><span>车辆</span><small>{{ driveModeText }}</small></button>' +
              '<button class="quick" @click="go(\'surround\')"><c-icon name="camera" :size="24"></c-icon><span>360 全景</span><small>全景影像</small></button>' +
            '</div>' +
          '</section>' +
        '</template>' +

        /* ---------- 安全状态 ---------- */
        '<section class="card status-card" :class="{ \'has-alert\': statusList.length }">' +
          '<div v-if="!statusList.length" class="sc-ok"><c-icon name="check" :size="20"></c-icon><span>车辆状态正常 · {{ S.data.vehicle.lock ? \'已上锁\' : \'未上锁\' }}</span></div>' +
          '<ul v-else class="sc-list">' +
            '<li v-for="(s, i) in statusList" :key="i"><c-icon :name="s.icon" :size="18"></c-icon>{{ s.text }}</li>' +
          '</ul>' +
          '<button class="sc-sim" @click="openSim"><c-icon name="gear" :size="16"></c-icon>驾驶状态模拟器</button>' +
        '</section>' +
      '</div>'
  };

  global.CHomeView = home;
})(window);
