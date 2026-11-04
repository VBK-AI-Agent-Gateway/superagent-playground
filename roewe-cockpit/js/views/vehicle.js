/*!
 * 车辆设置模块
 * 规格：灯光、后视镜、门锁、天窗、驾驶模式、倒车影像模拟窗口
 */
(function (global) {
  'use strict';

  var HEADLIGHTS = [
    { key: 'off', label: '关闭' },
    { key: 'auto', label: '自动' },
    { key: 'low', label: '近光' },
    { key: 'high', label: '远光' }
  ];
  var MIRRORS = [
    { key: 'left', label: '左' },
    { key: 'center', label: '中' },
    { key: 'right', label: '右' }
  ];
  var MODES = [
    { key: 'comfort', label: '舒适', icon: 'car' },
    { key: 'eco', label: '节能', icon: 'leaf' },
    { key: 'sport', label: '运动', icon: 'bolt' },
    { key: 'snow', label: '雪地', icon: 'snow' }
  ];

  global.VehicleView = {
    name: 'VehicleView',
    inject: ['ctx'],
    data: function () {
      return { headlights: HEADLIGHTS, mirrors: MIRRORS, modes: MODES, showCam: true };
    },
    computed: {
      state: function () { return this.ctx.state; },
      s: function () { return this.ctx.state.settings; },
      v: function () { return this.ctx.state.vehicle; },
      sunroofPct: function () { return this.s.sunroof; },
      modeLabel: function () {
        var m = this.modes.filter(function (x) { return x.key === this.s.drivingMode; }, this);
        return (m[0] || this.modes[0]).label;
      }
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('打开天窗', ['打开天窗', '关闭天窗'], function () { self.toggleSunroof(); }, '车辆');
      R.say('车门上锁', ['锁车', '车门上锁', '解锁车门'], function () { self.toggleLock(); }, '车辆');
      R.say('驾驶模式', ['切换到运动模式', '驾驶模式', '节能模式'], function () { self.setMode('sport'); }, '车辆');
      R.say('打开倒车影像', ['打开倒车影像', '倒车影像'], function () { self.showCam = true; }, '车辆');
      R.say('后视镜折叠', ['折叠后视镜', '后视镜'], function () { self.toggle('mirrorFold'); }, '车辆');
    },
    methods: {
      toggle: function (key) {
        this.s[key] = !this.s[key];
        var label = key === 'mirrorFold' ? '后视镜折叠' : key === 'doorAutoLock' ? '行车自动落锁'
          : key === 'doorChildLock' ? '儿童锁' : key === 'trunk' ? '后备厢' : key;
        this.ctx.toast.show(label + (this.s[key] ? '已开启' : '已关闭'), 'info');
      },
      setHeadlight: function (key) {
        this.s.headlight = key;
        var l = HEADLIGHTS.filter(function (h) { return h.key === key; })[0];
        this.ctx.toast.show('大灯：' + (l ? l.label : key), 'info');
      },
      setMirror: function (key) {
        this.s.mirrorAdjust = key;
        this.ctx.toast.show('后视镜调节：' + key, 'info');
      },
      setMode: function (key) {
        this.s.drivingMode = key;
        this.state.driveMode = key;
        var l = MODES.filter(function (m) { return m.key === key; })[0];
        this.ctx.toast.show('驾驶模式：' + (l ? l.label : key), 'info');
      },
      setSunroof: function (val) {
        this.s.sunroof = Number(val);
      },
      toggleSunroof: function () {
        this.s.sunroof = this.s.sunroof > 0 ? 0 : 60;
        this.ctx.toast.show(this.s.sunroof > 0 ? '天窗已打开' : '天窗已关闭', 'info');
      },
      toggleShade: function () {
        this.s.sunroofShade = this.s.sunroofShade > 0 ? 0 : 100;
        this.ctx.toast.show(this.s.sunroofShade > 0 ? '遮阳帘已打开' : '遮阳帘已关闭', 'info');
      },
      toggleLock: function () {
        this.v.locked = !this.v.locked;
        this.ctx.toast.show(this.v.locked ? '车门已上锁' : '车门已解锁', this.v.locked ? 'info' : 'warn');
      },
      toggleDoor: function () {
        this.v.doorOpen = !this.v.doorOpen;
        if (this.v.doorOpen) this.ctx.toast.show('检测到车门未关闭', 'warn');
      },
      cycleHeadlightDelay: function () {
        var opts = [0, 15, 30, 60];
        var i = opts.indexOf(this.s.headlightDelay);
        this.s.headlightDelay = opts[(i + 1) % opts.length];
        this.ctx.toast.show('大灯延时关闭 ' + (this.s.headlightDelay === 0 ? '已关闭' : this.s.headlightDelay + ' 秒'), 'info');
      }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 倒车影像模拟窗口 ---------- */
      '    <card-panel class="col-6" title="倒车影像（模拟）" icon="camera"',
      '                :tone="v.doorOpen ? \'warn\' : \'\'">',
      '      <div class="rear-cam" v-show="showCam">',
      '        <div class="rear-cam__scene">',
      '          <svg viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" aria-label="倒车影像模拟画面">',
      '            <defs>',
      '              <linearGradient id="rcSky" x1="0" y1="0" x2="0" y2="1">',
      '                <stop offset="0%" stop-color="#151d2e"/><stop offset="100%" stop-color="#0a0f1c"/>',
      '              </linearGradient>',
      '              <linearGradient id="rcRoad" x1="0" y1="0" x2="0" y2="1">',
      '                <stop offset="0%" stop-color="#1b2436"/><stop offset="100%" stop-color="#2a3448"/>',
      '              </linearGradient>',
      '            </defs>',
      '            <rect width="640" height="360" fill="url(#rcSky)"/>',
      '            <rect y="150" width="640" height="210" fill="url(#rcRoad)"/>',
      '            <path d="M300 150 L340 150 L430 360 L210 360 Z" fill="rgba(120,150,190,.18)"/>',
      '            <g stroke="rgba(255,255,255,.35)" stroke-width="3" stroke-dasharray="18 16">',
      '              <path d="M318 170 L280 340"/><path d="M322 170 L360 340"/>',
      '            </g>',
      '            <g fill="#1c2537" stroke="rgba(255,255,255,.12)" stroke-width="2">',
      '              <rect x="40" y="90" width="90" height="150" rx="6"/>',
      '              <rect x="510" y="80" width="100" height="160" rx="6"/>',
      '            </g>',
      '            <g fill="rgba(255,214,102,.15)">',
      '              <rect x="0" y="200" width="640" height="8"/><rect x="0" y="280" width="640" height="8"/>',
      '            </g>',
      '          </svg>',
      '        </div>',
      '        <svg class="rear-cam__guide" viewBox="0 0 640 360" aria-hidden="true">',
      '          <g v-if="s.reversingCamera" stroke-width="4" fill="none">',
      '            <path d="M250 352 L300 190 L340 190 L390 352 Z" stroke="#22c55e" opacity=".85"/>',
      '            <path d="M268 300 L372 300" stroke="#f59e0b" stroke-width="6" opacity=".9"/>',
      '            <path d="M243 352 L397 352" stroke="#ef4444" stroke-width="8"/>',
      '          </g>',
      '        </svg>',
      '        <span class="rear-cam__badge"><span class="dot"></span>REC · 倒车辅助线</span>',
      '        <span class="rear-cam__badge" style="left:auto;right:.18rem">距离障碍 1.2m</span>',
      '      </div>',
      '      <div class="strip">',
      '        <button class="btn btn--sm" :class="s.reversingCamera ? \'btn--on\' : \'btn--ghost\'" @click="toggle(\'reversingCamera\')">',
      '          <rw-icon name="camera" :size="20"></rw-icon>辅助线',
      '        </button>',
      '        <button class="btn btn--sm btn--ghost" @click="showCam = !showCam">{{ showCam ? \'隐藏画面\' : \'显示画面\' }}</button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 灯光 ---------- */
      '    <card-panel class="col-2" title="灯光" icon="bulb">',
      '      <div class="quick" style="grid-template-columns:repeat(2,minmax(0,1fr))">',
      '        <button v-for="h in headlights" :key="h.key" class="ctrl" :class="s.headlight === h.key ? \'is-on\' : \'\'"',
      '                @click="setHeadlight(h.key)">',
      '          <rw-icon name="bulb" :size="28"></rw-icon><span class="ctrl__label">{{ h.label }}</span>',
      '        </button>',
      '      </div>',
      '      <button class="list__item list__item--btn" style="width:100%;margin-top:.14rem" @click="cycleHeadlightDelay">',
      '        <span class="list__main"><span class="list__title">大灯延时关闭</span>',
      '          <span class="list__sub">伴我回家功能</span></span>',
      '        <span class="list__value">{{ s.headlightDelay === 0 ? \'关闭\' : s.headlightDelay + \'s\' }}</span>',
      '      </button>',
      '    </card-panel>',

      /* ---------- 后视镜 ---------- */
      '    <card-panel class="col-2" title="后视镜" icon="mirror">',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggle(\'mirrorFold\')">',
      '        <span class="list__main"><span class="list__title">锁车自动折叠</span>',
      '          <span class="list__sub">熄火后视镜收折</span></span>',
      '        <span class="switch" :class="s.mirrorFold ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <div class="strip" style="margin-top:.14rem">',
      '        <span class="slider__label">调节选择</span>',
      '        <button v-for="m in mirrors" :key="m.key" class="btn btn--sm"',
      '                :class="s.mirrorAdjust === m.key ? \'btn--on\' : \'btn--ghost\'" @click="setMirror(m.key)">{{ m.label }}</button>',
      '      </div>',
      '      <div class="card__hint">支持后视镜加热与倒车自动下翻（模拟）</div>',
      '    </card-panel>',

      /* ---------- 门锁 ---------- */
      '    <card-panel class="col-3" title="门锁" icon="lock" :tone="!v.locked ? \'warn\' : \'\'">',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggleLock">',
      '        <rw-icon :name="v.locked ? \'lock\' : \'door\'" :size="26"></rw-icon>',
      '        <span class="list__main"><span class="list__title">{{ v.locked ? \'车门已上锁\' : \'车门未上锁\' }}</span>',
      '          <span class="list__sub">点击切换中控锁状态</span></span>',
      '        <span class="switch" :class="v.locked ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggle(\'doorAutoLock\')">',
      '        <span class="list__main"><span class="list__title">行车自动落锁</span>',
      '          <span class="list__sub">车速 &gt; 15km/h 自动上锁</span></span>',
      '        <span class="switch" :class="s.doorAutoLock ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggle(\'doorChildLock\')">',
      '        <span class="list__main"><span class="list__title">后排儿童锁</span>',
      '          <span class="list__sub">禁止后排从内部开门</span></span>',
      '        <span class="switch" :class="s.doorChildLock ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggleDoor">',
      '        <span class="list__main"><span class="list__title">车门状态模拟</span>',
      '          <span class="list__sub">{{ v.doorOpen ? \'有车门未关闭\' : \'全部车门已关闭\' }}</span></span>',
      '        <span class="chip" :class="v.doorOpen ? \'chip--danger\' : \'chip--ok\'">{{ v.doorOpen ? \'未关\' : \'正常\' }}</span>',
      '      </button>',
      '    </card-panel>',

      /* ---------- 天窗 ---------- */
      '    <card-panel class="col-3" title="天窗" icon="sunroof">',
      '      <div class="slider">',
      '        <div class="strip"><span class="slider__label">天窗开度</span>',
      '          <span class="slider__value">{{ sunroofPct }}%</span></div>',
      '        <input type="range" min="0" max="100" step="5" :value="s.sunroof" @input="setSunroof($event.target.value)" aria-label="天窗开度">',
      '      </div>',
      '      <div class="quick" style="grid-template-columns:repeat(2,minmax(0,1fr))">',
      '        <button class="ctrl" :class="s.sunroof > 0 ? \'is-on\' : \'\'" @click="toggleSunroof">',
      '          <rw-icon name="sunroof" :size="28"></rw-icon>',
      '          <span class="ctrl__label">{{ s.sunroof > 0 ? \'关闭天窗\' : \'打开天窗\' }}</span>',
      '        </button>',
      '        <button class="ctrl" :class="s.sunroofShade > 0 ? \'is-on\' : \'\'" @click="toggleShade">',
      '          <rw-icon name="blinds" :size="28"></rw-icon>',
      '          <span class="ctrl__label">遮阳帘 {{ s.sunroofShade }}%</span>',
      '        </button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 驾驶模式 ---------- */
      '    <card-panel class="col-3" title="驾驶模式" icon="bolt">',
      '      <div class="quick" style="grid-template-columns:repeat(2,minmax(0,1fr))">',
      '        <button v-for="m in modes" :key="m.key" class="ctrl" :class="s.drivingMode === m.key ? \'is-on\' : \'\'"',
      '                @click="setMode(m.key)">',
      '          <rw-icon :name="m.icon" :size="28"></rw-icon><span class="ctrl__label">{{ m.label }}</span>',
      '        </button>',
      '      </div>',
      '      <div class="card__hint">当前：{{ modeLabel }}模式 · 影响动力响应与能量回收</div>',
      '    </card-panel>',

      /* ---------- 后备厢 ---------- */
      '    <card-panel class="col-3" title="后备厢与车身" icon="car">',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggle(\'trunk\')">',
      '        <rw-icon name="trunk" :size="26"></rw-icon>',
      '        <span class="list__main"><span class="list__title">电动后备厢</span>',
      '          <span class="list__sub">{{ s.trunk ? \'已开启\' : \'已关闭\' }}</span></span>',
      '        <span class="switch" :class="s.trunk ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <div class="kv" style="margin-top:.16rem"><span class="muted">车架号 VIN</span><span>{{ v.vin }}</span></div>',
      '      <div class="kv"><span class="muted">胎压监测</span><span>{{ v.tirePressure.join(\' / \') }} bar</span></div>',
      '      <div class="kv"><span class="muted">总里程</span><span>{{ v.odo }} km</span></div>',
      '      <div class="kv"><span class="muted">保养提醒</span><span class="accent">剩余 3200 km</span></div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };
})(window);
