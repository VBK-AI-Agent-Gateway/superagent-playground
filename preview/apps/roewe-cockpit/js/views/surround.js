/*!
 * 360° 全景影像模块
 * 规格：四路摄像头切换、视角切换、雷达分区、障碍物报警动画、轨迹线
 */
(function (global) {
  'use strict';

  var CAMS = [
    { key: 'front', label: '前视', icon: 'camera' },
    { key: 'rear', label: '后视', icon: 'camera' },
    { key: 'left', label: '左视', icon: 'camera' },
    { key: 'right', label: '右视', icon: 'camera' },
    { key: 'top', label: '俯视', icon: 'compass' }
  ];
  var VIEWS = [
    { key: '3d', label: '3D 环视' },
    { key: '2d', label: '2D 俯视' },
    { key: 'wide', label: '超广角' }
  ];

  global.SurroundView = {
    name: 'SurroundView',
    inject: ['ctx'],
    data: function () {
      return {
        cams: CAMS,
        views: VIEWS
      };
    },
    computed: {
      state: function () { return this.ctx.state; },
      sc: function () { return this.ctx.state.surround; },
      restricted: function () { return this.ctx.state.isDriving(); },
      /* 雷达六点：前左、前右、后左、后右、侧左、侧右（cm） */
      zones: function () {
        var r = this.sc.radar || [];
        return [
          { key: 'fl', label: '前左', val: r[0] },
          { key: 'fr', label: '前右', val: r[1] },
          { key: 'rl', label: '后左', val: r[2] },
          { key: 'rr', label: '后右', val: r[3] },
          { key: 'sl', label: '侧左', val: r[4] },
          { key: 'sr', label: '侧右', val: r[5] }
        ];
      },
      minDist: function () {
        return Math.min.apply(null, this.sc.radar || [999]);
      },
      alarmLevel: function () {
        var d = this.minDist;
        if (d <= 40) return 3;
        if (d <= 80) return 2;
        if (d <= 140) return 1;
        return 0;
      },
      alarmText: function () {
        var map = { 0: '安全', 1: '注意', 2: '警示', 3: '危险' };
        return map[this.alarmLevel];
      },
      alarmClass: function () {
        return this.alarmLevel >= 3 ? 'is-alarm' : this.alarmLevel >= 2 ? 'is-warn' : '';
      },
      obstacles: function () {
        var labels = { car: '后方车辆', pillar: '立柱 / 墙角', pedestrian: '行人', wall: '墙壁' };
        return ((global.ROEWE_MOCK && global.ROEWE_MOCK.obstacles) || []).map(function (o) {
          return {
            id: o.id,
            label: labels[o.type] || o.type,
            type: o.type,
            x: o.x,
            y: o.y,
            level: o.level
          };
        });
      }
    },
    created: function () {
      var self = this;
      /* 雷达随车速变化：低速时距离收紧，形成实时报警动画 */
      this._timer = setInterval(function () {
        var s = self.state;
        var base = s.speed > 0 ? Math.max(24, 150 - s.speed * 3) : 150;
        self.sc.radar = self.sc.radar.map(function (v, i) {
          var jitter = (Math.random() - 0.45) * 24;
          var val = Math.max(18, Math.min(200, i === 0 ? base + jitter : v + jitter * 0.6));
          return Math.round(val);
        });
        self.sc.alarmLevel = self.alarmLevel;
      }, 700);
    },
    beforeUnmount: function () {
      clearInterval(this._timer);
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('切换摄像头', ['切换到前视', '切换摄像头', '看后面', '看左侧'], function () { self.setCam('front'); }, '全景');
      R.say('切换视角', ['切换到 2D 视角', '3D 环视', '切换视角'], function () { self.setView('3d'); }, '全景');
      R.say('轨迹线', ['打开轨迹线', '关闭轨迹线'], function () { self.sc.trajectory = !self.sc.trajectory; }, '全景');
      R.say('自动泊车', ['开始自动泊车', '自动泊车'], function () { self.toggleParking(); }, '全景');
    },
    methods: {
      setCam: function (key) {
        this.sc.camera = key;
        this.ctx.toast.show('已切换至' + this.camLabel(key), 'info');
      },
      camLabel: function (key) {
        var c = CAMS.filter(function (x) { return x.key === key; })[0];
        return c ? c.label : key;
      },
      setView: function (key) {
        this.sc.view = key;
      },
      zoneClass: function (d) {
        if (d === undefined || d === null) return '';
        if (d <= 40) return 'is-alarm';
        if (d <= 80) return 'is-warn';
        return '';
      },
      toggleParking: function () {
        if (this.sc.autoParking) {
          this.sc.autoParking = false;
          this.ctx.toast.show('已退出自动泊车', 'info');
          return;
        }
        if (this.restricted) {
          /* 规则 1：行车中不允许启动自动泊车 */
          this.ctx.toast.restricted();
          return;
        }
        this.sc.autoParking = true;
        this.ctx.toast.show('自动泊车已启动，请松开方向盘', 'info');
        this.ctx.router.push('parking');
      }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 报警横幅 ---------- */
      '    <div class="col-6 alarm-banner" :class="alarmLevel >= 2 ? \'is-alarm\' : \'\'" v-if="alarmLevel >= 1" role="status">',
      '      <rw-icon name="warn" :size="30"></rw-icon>',
      '      <span class="grow">障碍物接近 · 最近 {{ minDist }} cm（{{ alarmText }}）</span>',
      '      <span class="tag tag--danger">{{ state.speed }} km/h</span>',
      '    </div>',

      /* ---------- 全景舞台 ---------- */
      '    <card-panel class="col-4" :title="\'360° 全景 · \' + camLabel(sc.camera)" icon="camera">',
      '      <div class="surround-stage">',
      '        <div class="surround-car" :style="{ transform: \'rotate(\' + (sc.view === \'2d\' ? 0 : sc.camera === \'rear\' ? 180 : sc.camera === \'left\' ? -90 : sc.camera === \'right\' ? 90 : 0) + \'deg)\' }">',
      '          <svg viewBox="0 0 120 200" aria-label="车辆俯视示意">',
      '            <rect x="14" y="10" width="92" height="180" rx="26" fill="rgba(86,160,255,.18)" stroke="rgba(86,160,255,.7)" stroke-width="3"/>',
      '            <rect x="26" y="34" width="68" height="52" rx="14" fill="rgba(200,225,255,.22)"/>',
      '            <rect x="26" y="118" width="68" height="46" rx="12" fill="rgba(200,225,255,.14)"/>',
      '            <circle cx="34" cy="14" r="6" fill="#eaf2ff" opacity=".8"/>',
      '            <circle cx="86" cy="14" r="6" fill="#eaf2ff" opacity=".8"/>',
      '          </svg>',
      '          <svg v-if="sc.trajectory" class="trajectory" viewBox="0 0 140 260" aria-hidden="true">',
      '            <path d="M30 240 L52 100 L88 100 L110 240" fill="none" stroke="#22c55e" stroke-width="4" opacity=".8"/>',
      '            <path d="M40 180 L100 180" fill="none" stroke="#f59e0b" stroke-width="5" opacity=".85"/>',
      '            <path d="M22 240 L118 240" fill="none" stroke="#ef4444" stroke-width="6"/>',
      '          </svg>',
      '        </div>',
      '        <div v-for="(o, i) in obstacles" :key="o.id" class="obstacle"',
      '             :style="{ left: (50 + o.x * 14) + \'%\', top: (12 + o.y * 7) + \'%\',',
      '                       background: o.level >= 3 ? \'#ef4444\' : o.level === 2 ? \'#f59e0b\' : \'#22c55e\' }"',
      '             :title="o.type">',
      '          <rw-icon name="warn" :size="18"></rw-icon>',
      '        </div>',
      '        <span class="cam-tabs__label" style="position:absolute;left:.2rem;bottom:.2rem">{{ sc.view.toUpperCase() }} · 轨迹线{{ sc.trajectory ? \'开\' : \'关\' }}</span>',
      '      </div>',
      '      <div class="cam-tabs">',
      '        <button v-for="c in cams" :key="c.key" class="btn btn--sm"',
      '                :class="sc.camera === c.key ? \'btn--on\' : \'btn--ghost\'" @click="setCam(c.key)">{{ c.label }}</button>',
      '      </div>',
      '      <div class="cam-tabs">',
      '        <button v-for="v in views" :key="v.key" class="btn btn--sm"',
      '                :class="sc.view === v.key ? \'btn--on\' : \'btn--ghost\'" @click="setView(v.key)">{{ v.label }}</button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 雷达 ---------- */
      '    <card-panel class="col-2" title="泊车雷达" icon="radar" :tone="alarmLevel >= 2 ? \'warn\' : \'\'">',
      '      <div class="radar-grid">',
      '        <div v-for="z in zones" :key="z.key" class="radar-zone" :class="zoneClass(z.val)">',
      '          <span class="radar-zone__label">{{ z.label }}</span>',
      '          <span class="radar-zone__val">{{ z.val }}<i>cm</i></span>',
      '        </div>',
      '      </div>',
      '      <div class="strip">',
      '        <span class="chip" :class="alarmLevel >= 3 ? \'chip--danger\' : alarmLevel === 2 ? \'chip--warn\' : \'chip--ok\'">',
      '          雷达 {{ alarmText }}',
      '        </span>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 障碍物与轨迹控制 ---------- */
      '    <card-panel class="col-3" title="障碍物识别" icon="warn">',
      '      <ul class="list">',
      '        <li v-for="o in obstacles" :key="o.id" class="list__item" style="flex-direction:row">',
      '          <span class="dot" :style="{ background: o.level >= 3 ? \'#ef4444\' : o.level === 2 ? \'#f59e0b\' : \'#22c55e\' }"></span>',
      '          <span class="list__main">',
      '            <span class="list__title">{{ o.label }}</span>',
      '            <span class="list__sub">方位 {{ o.x }}m · 距离 {{ o.y }}m</span>',
      '          </span>',
      '          <span class="chip" :class="o.level >= 3 ? \'chip--danger\' : o.level === 2 ? \'chip--warn\' : \'chip--ok\'">',
      '            {{ o.level >= 3 ? \'高\' : o.level === 2 ? \'中\' : \'低\' }}风险',
      '          </span>',
      '        </li>',
      '      </ul>',
      '      <button class="btn btn--sm btn--block" :class="sc.trajectory ? \'btn--on\' : \'btn--ghost\'" @click="sc.trajectory = !sc.trajectory">',
      '        <rw-icon name="route" :size="20"></rw-icon>动态轨迹线 {{ sc.trajectory ? \'已开启\' : \'已关闭\' }}',
      '      </button>',
      '    </card-panel>',

      /* ---------- 自动泊车入口 ---------- */
      '    <card-panel class="col-3" title="自动泊车" icon="parking" :tone="sc.autoParking ? \'accent\' : \'\'">',
      '      <div class="center stack" style="align-items:center;gap:.14rem">',
      '        <div class="voice-orb" :class="sc.autoParking ? \'is-awake\' : \'\'" style="width:1.1rem;height:1.1rem">',
      '          <rw-icon name="parking" :size="48"></rw-icon>',
      '        </div>',
      '        <span class="chip" :class="sc.autoParking ? \'chip--accent\' : \'\'">{{ sc.autoParking ? \'泊车进行中\' : \'待启动\' }}</span>',
      '        <button class="btn btn--primary btn--block" @click="toggleParking">',
      '          {{ sc.autoParking ? \'退出自动泊车\' : \'开始自动泊车\' }}',
      '        </button>',
      '        <button class="btn btn--ghost btn--sm btn--block" @click="ctx.router.push(\'parking\')">进入泊车辅助页</button>',
      '      </div>',
      '      <div class="card__hint" v-if="restricted">行车中不可启动自动泊车，请先停车挂 P 挡</div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };
})(window);
