/*!
 * js/views/vehicle.js — 模块 5：车辆设置
 * 灯光、后视镜、门锁、天窗、驾驶模式、倒车影像模拟窗口。
 * 所有控制项直接写入 CockpitState.data.settings / vehicle，状态栏与首页即时联动。
 */
(function (global) {
  'use strict';

  var vehicle = {
    data: function () { return { S: global.CockpitState, section: 'light', cameraOpen: false }; },
    computed: {
      v: function () { return this.S.data.vehicle; },
      st: function () { return this.S.data.settings; },
      sections: function () {
        return [
          { key: 'light', label: '灯光', icon: 'light' },
          { key: 'mirror', label: '后视镜', icon: 'mirror' },
          { key: 'lock', label: '门锁', icon: 'lock' },
          { key: 'sunroof', label: '天窗', icon: 'sunroof' },
          { key: 'drive', label: '驾驶模式', icon: 'speed' },
          { key: 'camera', label: '倒车影像', icon: 'camera' }
        ];
      },
      doorList: function () {
        var d = this.v.doors || {};
        return [
          { key: 'fl', label: '左前门' }, { key: 'fr', label: '右前门' },
          { key: 'rl', label: '左后门' }, { key: 'rr', label: '右后门' },
          { key: 'trunk', label: '后备箱' }
        ].map(function (x) { return { key: x.key, label: x.label, open: !!d[x.key] }; });
      },
      windowList: function () {
        var w = this.v.windows || {};
        return [
          { key: 'fl', label: '左前窗' }, { key: 'fr', label: '右前窗' },
          { key: 'rl', label: '左后窗' }, { key: 'rr', label: '右后窗' }
        ].map(function (x) { return { key: x.key, label: x.label, open: !!w[x.key] }; });
      },
      lightList: function () {
        var l = this.v.lights || {};
        return [
          { key: 'low', label: '近光灯', icon: 'light' },
          { key: 'high', label: '远光灯', icon: 'light' },
          { key: 'position', label: '示宽灯', icon: 'light' },
          { key: 'fog', label: '雾灯', icon: 'light' },
          { key: 'hazard', label: '双闪', icon: 'warn' }
        ].map(function (x) { return { key: x.key, label: x.label, icon: x.icon, on: !!l[x.key] }; });
      },
      driveModes: function () { return ['舒适', '运动', '经济', '雪地']; },
      driveModeLabel: function () {
        var map = { comfort: '舒适', sport: '运动', eco: '经济', snow: '雪地' };
        return map[this.st.driving.mode] || '舒适';
      },
      anyDoorOpen: function () { return this.doorList.some(function (d) { return d.open; }); },
      anyWindowOpen: function () { return this.windowList.some(function (w) { return w.open; }); }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.lock', scope: 'vehicle', label: '车门锁',
          phrases: ['锁车', '解锁车辆', '打开车门锁', '锁上车门'],
          handler: function () { global.CockpitSafety.toggleLock(); return self.v.lock ? '车辆已上锁。' : '车辆已解锁。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.sunroof', scope: 'vehicle', label: '天窗',
          phrases: ['打开天窗', '关闭天窗', '天窗'],
          handler: function () { self.toggleSunroof(); return self.v.sunroof > 0 ? '天窗已开启。' : '天窗已关闭。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.mirror', scope: 'vehicle', label: '后视镜折叠',
          phrases: ['折叠后视镜', '展开后视镜', '收起后视镜'],
          handler: function () { self.v.mirrorFolded = !self.v.mirrorFolded; return self.v.mirrorFolded ? '后视镜已折叠。' : '后视镜已展开。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.low', scope: 'vehicle', label: '近光灯',
          phrases: ['打开近光灯', '关闭近光灯', '开大灯'],
          handler: function () { global.CockpitSafety.toggleLight('low'); return self.v.lights.low ? '近光灯已打开。' : '近光灯已关闭。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.hazard', scope: 'vehicle', label: '双闪',
          phrases: ['打开双闪', '关闭双闪', '危险报警灯'],
          handler: function () { global.CockpitSafety.toggleLight('hazard'); return self.v.lights.hazard ? '双闪已打开。' : '双闪已关闭。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.mode', scope: 'vehicle', label: '驾驶模式',
          phrases: ['切换驾驶模式', '运动模式', '经济模式', '舒适模式'],
          handler: function (text) {
            var t = String(text || '');
            var pick = t.indexOf('运动') >= 0 ? '运动' : (t.indexOf('经济') >= 0 ? '经济' : (t.indexOf('雪地') >= 0 ? '雪地' : '舒适'));
            self.setMode(pick);
            return '驾驶模式已切换为' + pick + '模式。';
          }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'vehicle.camera', scope: 'vehicle', label: '倒车影像',
          phrases: ['打开倒车影像', '关闭倒车影像', '看倒车影像'],
          handler: function () { self.cameraOpen = !self.cameraOpen; self.section = 'camera'; return self.cameraOpen ? '倒车影像已打开。' : '倒车影像已关闭。'; }
        })
      ];
    },
    beforeUnmount: function () { (this._uns || []).forEach(function (fn) { fn(); }); },
    methods: {
      toggleLight: function (k) { global.CockpitSafety.toggleLight(k); },
      toggleDoor: function (k) {
        this.v.doors[k] = !this.v.doors[k];
        global.CockpitSafety.notify({ text: (this.v.doors[k] ? '已打开' : '已关闭') + '车门', icon: 'door' });
      },
      toggleWindow: function (k) {
        this.v.windows[k] = !this.v.windows[k];
        global.CockpitSafety.notify({ text: (this.v.windows[k] ? '已打开' : '已关闭') + '车窗', icon: 'door' });
      },
      toggleSunroof: function () { this.v.sunroof = this.v.sunroof > 0 ? 0 : 1; },
      setMode: function (m) {
        var key = { '舒适': 'comfort', '运动': 'sport', '经济': 'eco', '雪地': 'snow' }[m] || 'comfort';
        this.st.driving.mode = key;
        this.v.driveMode = key;
        global.CockpitSafety.notify({ text: '驾驶模式：' + m, icon: 'speed', level: 'ok' });
      },
      closeAllWindows: function () {
        var self = this;
        Object.keys(this.v.windows).forEach(function (k) { self.v.windows[k] = false; });
        global.CockpitSafety.notify({ text: '车窗已全部关闭', icon: 'door', level: 'ok' });
      }
    },
    template:
      '<div class="view view-vehicle">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">车辆设置</h2>' +
          '<span class="ph-status"><c-icon :name="v.lock ? \'lock\' : \'unlock\'" :size="16"></c-icon>{{ v.lock ? \'已上锁\' : \'已解锁\' }}</span>' +
        '</header>' +

        '<nav class="seg-tabs" aria-label="车辆设置分类">' +
          '<button v-for="s in sections" :key="s.key" :class="{ on: section === s.key }" @click="section = s.key">' +
            '<c-icon :name="s.icon" :size="18"></c-icon><span>{{ s.label }}</span>' +
          '</button>' +
        '</nav>' +

        /* ---------- 灯光 ---------- */
        '<template v-if="section === \'light\'">' +
          '<section class="card">' +
            '<h3 class="card-title">外部灯光</h3>' +
            '<div class="tile-grid">' +
              '<button v-for="l in lightList" :key="l.key" class="tile" :class="{ on: l.on }" @click="toggleLight(l.key)">' +
                '<c-icon :name="l.icon" :size="26"></c-icon><span>{{ l.label }}</span>' +
                '<small>{{ l.on ? \'已开启\' : \'已关闭\' }}</small>' +
              '</button>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">车内灯光</h3>' +
            '<div class="row-list">' +
              '<div class="row"><c-icon name="light" :size="20"></c-icon><span>氛围灯</span>' +
                '<button class="sw" :class="{ on: st.lights.ambient === \'blue\' }" @click="st.lights.ambient = st.lights.ambient === \'blue\' ? \'off\' : \'blue\'"><i></i></button></div>' +
              '<div class="row"><c-icon name="light" :size="20"></c-icon><span>迎宾灯</span>' +
                '<button class="sw" :class="{ on: st.lights.welcome }" @click="st.lights.welcome = !st.lights.welcome"><i></i></button></div>' +
            '</div>' +
          '</section>' +
        '</template>' +

        /* ---------- 后视镜 ---------- */
        '<template v-if="section === \'mirror\'">' +
          '<section class="card">' +
            '<h3 class="card-title">后视镜</h3>' +
            '<div class="row-list">' +
              '<div class="row"><c-icon name="mirror" :size="20"></c-icon><span>电动折叠</span>' +
                '<button class="sw" :class="{ on: v.mirrorFolded }" @click="v.mirrorFolded = !v.mirrorFolded"><i></i></button></div>' +
              '<div class="row"><c-icon name="mirror" :size="20"></c-icon><span>倒车自动下翻</span>' +
                '<button class="sw" :class="{ on: st.mirror.reverseTilt }" @click="st.mirror.reverseTilt = !st.mirror.reverseTilt"><i></i></button></div>' +
              '<div class="row"><c-icon name="mirror" :size="20"></c-icon><span>锁车自动折叠</span>' +
                '<button class="sw" :class="{ on: st.mirror.autoFold }" @click="st.mirror.autoFold = !st.mirror.autoFold"><i></i></button></div>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">镜面调节</h3>' +
            '<div class="pad-grid">' +
              '<button class="pad" @click="$forceUpdate()"><c-icon name="arrowUp" :size="22"></c-icon></button>' +
              '<button class="pad pad-mid" @click="$forceUpdate()"><c-icon name="mirror" :size="20"></c-icon></button>' +
              '<button class="pad" @click="$forceUpdate()"><c-icon name="arrowUp" :size="22" style="transform:rotate(180deg)"></c-icon></button>' +
            '</div>' +
            '<p class="hint">上下左右调节外后视镜角度（模拟）。</p>' +
          '</section>' +
        '</template>' +

        /* ---------- 门锁 ---------- */
        '<template v-if="section === \'lock\'">' +
          '<section class="card">' +
            '<div class="lock-hero" :class="{ locked: v.lock }">' +
              '<button class="lock-big" :aria-label="v.lock ? \'解锁车辆\' : \'上锁车辆\'" @click="CockpitSafety.toggleLock()">' +
                '<c-icon :name="v.lock ? \'lock\' : \'unlock\'" :size="40"></c-icon>' +
              '</button>' +
              '<div class="lock-text"><b>{{ v.lock ? \'车辆已上锁\' : \'车辆已解锁\' }}</b><small>{{ anyDoorOpen ? \'有车门未关闭\' : \'所有车门已关闭\' }}</small></div>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">车门状态</h3>' +
            '<div class="tile-grid">' +
              '<button v-for="d in doorList" :key="d.key" class="tile" :class="{ on: d.open }" @click="toggleDoor(d.key)">' +
                '<c-icon name="door" :size="24"></c-icon><span>{{ d.label }}</span><small>{{ d.open ? \'已打开\' : \'已关闭\' }}</small>' +
              '</button>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<div class="head-row"><h3 class="card-title">车窗状态</h3>' +
              '<button class="mini-btn" @click="closeAllWindows">一键关窗</button></div>' +
            '<div class="tile-grid">' +
              '<button v-for="w in windowList" :key="w.key" class="tile" :class="{ on: w.open }" @click="toggleWindow(w.key)">' +
                '<c-icon name="door" :size="24"></c-icon><span>{{ w.label }}</span><small>{{ w.open ? \'已打开\' : \'已关闭\' }}</small>' +
              '</button>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<div class="row-list">' +
              '<div class="row"><c-icon name="lock" :size="20"></c-icon><span>行车自动落锁</span>' +
                '<button class="sw" :class="{ on: st.lock.autoLock }" @click="st.lock.autoLock = !st.lock.autoLock"><i></i></button></div>' +
              '<div class="row"><c-icon name="lock" :size="20"></c-icon><span>驻车自动解锁</span>' +
                '<button class="sw" :class="{ on: st.lock.speedLock }" @click="st.lock.speedLock = !st.lock.speedLock"><i></i></button></div>' +
            '</div>' +
          '</section>' +
          '<p v-if="anyWindowOpen" class="warn-line"><c-icon name="warn" :size="16"></c-icon>检测到车窗未关闭，锁车时请注意。</p>' +
        '</template>' +

        /* ---------- 天窗 ---------- */
        '<template v-if="section === \'sunroof\'">' +
          '<section class="card">' +
            '<h3 class="card-title">天窗</h3>' +
            '<div class="roof-vis" :class="{ open: v.sunroof > 0 }">' +
              '<div class="roof-panel" :style="{ transform: \'translateY(\' + (v.sunroof > 0 ? -8 : 0) + \'px)\' }"></div>' +
              '<span class="roof-label">{{ v.sunroof > 0 ? \'天窗已开启\' : \'天窗已关闭\' }}</span>' +
            '</div>' +
            '<div class="roof-actions">' +
              '<button class="btn" @click="v.sunroof = 0">关闭</button>' +
              '<button class="btn" @click="v.sunroof = 1">换气</button>' +
              '<button class="btn btn-accent" @click="v.sunroof = 2">全开</button>' +
            '</div>' +
          '</section>' +
        '</template>' +

        /* ---------- 驾驶模式 ---------- */
        '<template v-if="section === \'drive\'">' +
          '<section class="card">' +
            '<h3 class="card-title">驾驶模式</h3>' +
            '<div class="mode-grid">' +
              '<button v-for="m in driveModes" :key="m" class="mode" :class="{ on: driveModeLabel === m }" @click="setMode(m)">' +
                '<c-icon name="speed" :size="26"></c-icon><span>{{ m }}</span>' +
              '</button>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">车辆状态</h3>' +
            '<div class="stat-grid">' +
              '<div class="stat"><small>胎压（前）</small><b>{{ v.tirePressure[0] }} / {{ v.tirePressure[1] }} bar</b></div>' +
              '<div class="stat"><small>胎压（后）</small><b>{{ v.tirePressure[2] }} / {{ v.tirePressure[3] }} bar</b></div>' +
              '<div class="stat"><small>冷却液</small><b>{{ v.coolant }} °C</b></div>' +
              '<div class="stat"><small>总里程</small><b>{{ v.odometer }} km</b></div>' +
              '<div class="stat"><small>车外温度</small><b>{{ v.outsideTemp }} °C</b></div>' +
              '<div class="stat"><small>VIN</small><b class="mono">{{ S.data.about.vin || \'LSJA24U60MN000000\' }}</b></div>' +
            '</div>' +
          '</section>' +
        '</template>' +

        /* ---------- 倒车影像 ---------- */
        '<template v-if="section === \'camera\'">' +
          '<section class="card">' +
            '<div class="head-row"><h3 class="card-title">倒车影像（模拟）</h3>' +
              '<button class="mini-btn" :class="{ on: cameraOpen }" @click="cameraOpen = !cameraOpen">{{ cameraOpen ? \'关闭\' : \'打开\' }}</button></div>' +
            '<div class="rev-cam" :class="{ live: cameraOpen }">' +
              '<svg v-if="cameraOpen" class="rev-svg" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice">' +
                '<rect width="480" height="300" fill="#0a121b"/>' +
                '<path d="M0 300 L200 120 L280 120 L480 300 Z" fill="#13212f"/>' +
                '<g stroke="#2ee6a8" stroke-width="3" fill="none" opacity="0.85">' +
                  '<path d="M120 300 L215 128"/><path d="M360 300 L265 128"/>' +
                '</g>' +
                '<g stroke="#2ee6a8" stroke-width="2" fill="none" opacity="0.5">' +
                  '<path d="M150 250 H330"/><path d="M175 210 H305"/><path d="M196 176 H284"/>' +
                '</g>' +
                '<rect x="212" y="150" width="56" height="70" rx="8" fill="#1b2c3d" stroke="#3a5872"/>' +
                '<circle cx="120" cy="70" r="14" fill="#ff5a5f" opacity="0.85"/>' +
                '<circle cx="360" cy="70" r="14" fill="#ff5a5f" opacity="0.85"/>' +
              '</svg>' +
              '<div v-else class="rev-off"><c-icon name="camera" :size="42"></c-icon><span>倒车影像未开启</span></div>' +
              '<div v-if="cameraOpen" class="rev-tip"><c-icon name="warn" :size="16"></c-icon>请注意车后盲区，倒车时保持低速</div>' +
            '</div>' +
          '</section>' +
        '</template>' +
      '</div>'
  };

  global.CVehicleView = vehicle;
})(window);
