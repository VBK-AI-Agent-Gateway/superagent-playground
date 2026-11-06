/*!
 * js/views/parking.js — 模块 7b：泊车辅助
 * 前后雷达距离条、侧面距离、障碍物方位告警动画、倒车轨迹线、自动泊车就绪状态。
 * 安全规则 2：本页为驾驶辅助视图，顶栏车速/挡位/警告保持可见。
 * 安全规则 1：D 挡进入本页会被挡位状态机拦截并提示。
 */
(function (global) {
  'use strict';

  var parking = {
    data: function () { return { S: global.CockpitState, guide: true, beep: false }; },
    computed: {
      p: function () { return this.S.data.parking; },
      front: function () { return (this.p.radar && this.p.radar.front) || []; },
      rear: function () { return (this.p.radar && this.p.radar.rear) || []; },
      obs: function () { return this.p.obstacle || { active: false, level: 'ok', distance: 999, bearing: '' }; },
      nearest: function () {
        var all = this.front.concat(this.rear);
        return all.length ? Math.min.apply(null, all) : 999;
      },
      level: function () {
        var d = this.nearest;
        if (d < 60) return 'bad';
        if (d < 110) return 'warn';
        return 'ok';
      },
      levelText: function () {
        return this.level === 'bad' ? '距离过近，请立即停车' : (this.level === 'warn' ? '请注意周边障碍物' : '周边安全');
      },
      bearingText: function () {
        var m = {
          'left-front': '左前方', 'front': '正前方', 'right-front': '右前方',
          'left-rear': '左后方', 'rear': '正后方', 'right-rear': '右后方',
          'left': '左侧', 'right': '右侧'
        };
        return m[this.obs.bearing] || '车后';
      },
      /* 每格代表 20cm，上限 5 格 */
      frontBars: function () { return this.decorate(this.front); },
      rearBars: function () { return this.decorate(this.rear); },
      sideList: function () {
        var s = this.p.side || {};
        return [
          { key: 'left', label: '左侧', value: s.left },
          { key: 'right', label: '右侧', value: s.right }
        ].map(function (x) { return { key: x.key, label: x.label, value: x.value, tone: x.value < 60 ? 'bad' : (x.value < 110 ? 'warn' : 'ok') }; });
      }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'parking.open', scope: 'parking', label: '打开泊车辅助',
          phrases: ['打开泊车辅助', '自动泊车', '帮我停车', '泊车'],
          handler: function () { global.CockpitRouter.go('parking'); return '已打开泊车辅助。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'parking.auto', scope: 'parking', label: '自动泊车就绪',
          phrases: ['开始自动泊车', '自动泊车开始', '泊入车位'],
          handler: function () {
            if (self.S.gear !== 'P') { global.CockpitSafety.warn('请先挂 P 挡再使用自动泊车', 'parking'); return '请先挂 P 挡。'; }
            return self.p.autoParkReady ? '自动泊车已就绪，请松开方向盘。' : '当前环境不满足自动泊车条件。';
          }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'parking.guide', scope: 'parking', label: '倒车轨迹线',
          phrases: ['打开轨迹线', '关闭轨迹线', '显示倒车轨迹'],
          handler: function () { self.guide = !self.guide; return self.guide ? '倒车轨迹线已显示。' : '倒车轨迹线已关闭。'; }
        })
      ];
      this._beep = global.setInterval(function () {
        self.beep = self.nearest < 60;
      }, 700);
    },
    beforeUnmount: function () {
      (this._uns || []).forEach(function (fn) { fn(); });
      if (this._beep) global.clearInterval(this._beep);
    },
    methods: {
      decorate: function (arr) {
        return (arr || []).map(function (d, i) {
          return {
            i: i, d: d,
            pct: Math.max(6, Math.min(100, 100 - (d / 220) * 100)),
            tone: d < 60 ? 'bad' : (d < 110 ? 'warn' : 'ok')
          };
        });
      },
      autoPark: function () {
        if (this.S.gear !== 'P') {
          global.CockpitSafety.warn('请先挂 P 挡再使用自动泊车', 'parking');
          return;
        }
        global.CockpitSafety.notify({
          text: this.p.autoParkReady ? '自动泊车已就绪，请松开方向盘' : '当前环境不满足自动泊车条件',
          icon: 'parking',
          level: this.p.autoParkReady ? 'ok' : 'warn'
        });
      }
    },
    template:
      '<div class="view view-parking">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">泊车辅助</h2>' +
          '<span class="ph-status" :class="level"><c-icon name="warn" :size="16"></c-icon>{{ nearest >= 999 ? \'--\' : nearest + \' cm\' }}</span>' +
        '</header>' +

        /* ---------- 雷达总览 ---------- */
        '<section class="card radar-card" :class="level">' +
          '<div class="radar-stage" :class="{ alarm: beep }">' +
            '<div class="rs-row rs-front">' +
              '<span v-for="b in frontBars" :key="\'f\' + b.i" class="rs-cell" :class="b.tone" :style="{ opacity: b.pct / 100 }"></span>' +
            '</div>' +
            '<div class="rs-car"><c-icon name="car" :size="46"></c-icon></div>' +
            '<div class="rs-row rs-rear">' +
              '<span v-for="b in rearBars" :key="\'r\' + b.i" class="rs-cell" :class="b.tone" :style="{ opacity: b.pct / 100 }"></span>' +
            '</div>' +
          '</div>' +
          '<p class="radar-msg" :class="level">{{ levelText }}</p>' +
        '</section>' +

        /* ---------- 障碍物告警 ---------- */
        '<section v-if="obs.active" class="card obs-card" :class="obs.level">' +
          '<div class="obs-hero">' +
            '<span class="obs-pulse"></span>' +
            '<c-icon name="warn" :size="30"></c-icon>' +
            '<div class="obs-text"><b>{{ bearingText }}有障碍物</b><small>距离约 {{ obs.distance }} cm，请减速停车</small></div>' +
          '</div>' +
          '<div class="chip-row"><span class="mini-tag bad">报警中</span><span class="mini-tag">{{ p.obstacle.bearing }}</span></div>' +
        '</section>' +

        /* ---------- 雷达明细 ---------- */
        '<section class="card">' +
          '<h3 class="card-title">前雷达</h3>' +
          '<div class="bar-list">' +
            '<div v-for="b in frontBars" :key="\'fb\' + b.i" class="bar-row">' +
              '<span class="br-idx">{{ b.i + 1 }}</span>' +
              '<div class="br-track"><i :class="b.tone" :style="{ width: b.pct + \'%\' }"></i></div>' +
              '<span class="br-val">{{ b.d }} cm</span>' +
            '</div>' +
          '</div>' +
          '<h3 class="card-title mt">后雷达</h3>' +
          '<div class="bar-list">' +
            '<div v-for="b in rearBars" :key="\'rb\' + b.i" class="bar-row">' +
              '<span class="br-idx">{{ b.i + 1 }}</span>' +
              '<div class="br-track"><i :class="b.tone" :style="{ width: b.pct + \'%\' }"></i></div>' +
              '<span class="br-val">{{ b.d }} cm</span>' +
            '</div>' +
          '</div>' +
        '</section>' +

        /* ---------- 侧面 ---------- */
        '<section class="card">' +
          '<h3 class="card-title">侧面距离</h3>' +
          '<div class="side-grid">' +
            '<div v-for="s in sideList" :key="s.key" class="side-cell" :class="s.tone">' +
              '<small>{{ s.label }}</small><b>{{ s.value }} cm</b>' +
            '</div>' +
          '</div>' +
        '</section>' +

        /* ---------- 倒车轨迹与自动泊车 ---------- */
        '<section class="card">' +
          '<div class="head-row"><h3 class="card-title">倒车轨迹线</h3>' +
            '<button class="sw" :class="{ on: guide }" @click="guide = !guide"><i></i></button></div>' +
          '<div class="traj" :class="{ off: !guide }">' +
            '<svg viewBox="0 0 320 200" preserveAspectRatio="none">' +
              '<rect width="320" height="200" fill="#0d1822"/>' +
              '<g v-if="guide" stroke="#2ee6a8" stroke-width="3" fill="none" opacity="0.9">' +
                '<path d="M60 200 L132 60"/><path d="M260 200 L188 60"/>' +
              '</g>' +
              '<g v-if="guide" stroke="#e8c05a" stroke-width="2" fill="none" stroke-dasharray="6 6" opacity="0.9">' +
                '<path d="M100 200 L152 60"/><path d="M220 200 L168 60"/>' +
              '</g>' +
              '<g v-if="guide" stroke="#ffffff" stroke-width="1.5" fill="none" opacity="0.35">' +
                '<path d="M88 160 H232"/><path d="M104 128 H216"/><path d="M120 100 H200"/>' +
              '</g>' +
              '<rect x="140" y="150" width="40" height="50" rx="6" fill="#1b2c3d" stroke="#3a5872"/>' +
            '</svg>' +
            '<span v-if="!guide" class="traj-off-text">轨迹线已关闭</span>' +
          '</div>' +
          '<div class="park-actions">' +
            '<button class="btn" @click="autoPark">' +
              '<c-icon name="parking" :size="18"></c-icon>自动泊车' +
            '</button>' +
            '<span class="mini-tag" :class="p.autoParkReady ? \'ok\' : \'warn\'">{{ p.autoParkReady ? \'环境就绪\' : \'环境不满足\' }}</span>' +
          '</div>' +
          '<p class="hint">倒车影像与雷达数据均为模拟，仅用于功能演示。</p>' +
        '</section>' +
      '</div>'
  };

  global.CParkingView = parking;
})(window);
