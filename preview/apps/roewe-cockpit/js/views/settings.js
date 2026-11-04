/*!
 * 系统设置模块
 * 规格：亮度、主题、WiFi、蓝牙、OTA 版本、关于
 * 另承载「行车状态模拟器」：D/P 挡切换 + 车速滑块（交付验证依赖它）
 */
(function (global) {
  'use strict';

  var THEMES = [
    { key: 'dark', label: '深色模式', desc: '夜间行车默认' },
    { key: 'light', label: '浅色模式', desc: '日间强光更清晰' }
  ];

  global.SettingsView = {
    name: 'SettingsView',
    inject: ['ctx'],
    data: function () {
      return { themes: THEMES, otaBusy: false, otaDone: false };
    },
    computed: {
      state: function () { return this.ctx.state; },
      sys: function () { return this.ctx.state.system; },
      about: function () { return this.ctx.state.system.about; },
      theme: function () { return this.ctx.state.theme; },
      gear: function () { return this.ctx.state.gear; },
      restricted: function () { return this.ctx.state.isDriving(); },
      restrictionText: function () {
        if (!this.restricted) return 'P 挡或低速状态，娱乐与视频功能不受限制';
        return '行车中，娱乐功能已限制（车速 ' + this.state.speed + ' km/h）';
      },
      batteryText: function () { return this.state.vehicle.battery + '%'; }
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('深色模式', ['切换到深色模式', '深色模式', '夜间模式'], function () { self.setTheme('dark'); }, '设置');
      R.say('浅色模式', ['切换到浅色模式', '浅色模式', '白天模式'], function () { self.setTheme('light'); }, '设置');
      R.say('主题切换', ['切换主题', '换肤'], function () { self.ctx.toggleTheme(); }, '设置');
      R.say('WLAN 开关', ['打开无线网络', '关闭无线网络', 'WiFi'], function () { self.toggle('wifi'); }, '设置');
      R.say('蓝牙开关', ['打开蓝牙', '关闭蓝牙'], function () { self.toggle('bluetooth'); }, '设置');
      R.say('亮度调节', ['屏幕亮度调到 90', '调亮屏幕', '调暗屏幕'], function () { self.sys.brightness = 90; }, '设置');
      R.say('系统升级', ['检查系统更新', '升级系统', 'OTA'], function () { self.checkOta(); }, '设置');
      R.say('切换前进挡', ['挂前进挡', '切换到 D 挡', '开始行驶'], function () { self.setGear('D'); }, '设置');
      R.say('切换驻车挡', ['挂驻车挡', '切换到 P 挡', '停车'], function () { self.setGear('P'); }, '设置');
    },
    methods: {
      setTheme: function (key) {
        this.ctx.setTheme(key);
      },
      toggle: function (key) {
        this.sys[key] = !this.sys[key];
        var label = key === 'wifi' ? '无线网络' : key === 'bluetooth' ? '蓝牙' : key;
        this.ctx.toast.show(label + (this.sys[key] ? '已开启' : '已关闭'), 'info');
      },
      setBrightness: function (v) {
        this.sys.brightness = Number(v);
      },
      /* ---------- 行车状态模拟器 ---------- */
      setGear: function (g) {
        this.ctx.simulator.setGear(g);
      },
      setSpeed: function (v) {
        this.ctx.simulator.setSpeed(Number(v));
      },
      quickSpeed: function (v) {
        this.ctx.simulator.setSpeed(v);
      },
      /* ---------- OTA ---------- */
      checkOta: function () {
        var self = this;
        if (this.otaBusy) return;
        this.otaBusy = true;
        this.otaDone = false;
        this.ctx.toast.show('正在检查更新…', 'info');
        setTimeout(function () {
          self.otaBusy = false;
          self.otaDone = true;
          self.sys.otaNew = true;
          self.ctx.toast.show('发现新版本 OS 3.3.0，可预约升级', 'info');
        }, 1400);
      },
      installOta: function () {
        var self = this;
        if (this.otaBusy) return;
        this.otaBusy = true;
        this.ctx.toast.show('升级包下载中，请勿断电', 'warn');
        setTimeout(function () {
          self.otaBusy = false;
          self.sys.otaNew = false;
          self.sys.otaVersion = 'OS 3.3.0';
          self.ctx.toast.show('已升级至 OS 3.3.0', 'info');
        }, 2200);
      }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 行车状态模拟器（安全规则 4） ---------- */
      '    <card-panel class="col-6" title="行车状态模拟器" icon="sim" tone="accent">',
      '      <div class="sim">',
      '        <div class="sim__gear">',
      '          <button class="sim__gear-btn" :class="gear === \'P\' ? \'is-on\' : \'\'" @click="setGear(\'P\')">P 驻车</button>',
      '          <button class="sim__gear-btn" :class="gear === \'D\' ? \'is-on\' : \'\'" @click="setGear(\'D\')">D 前进</button>',
      '        </div>',
      '        <div class="sim__speed">',
      '          <div class="strip"><span class="slider__label">车速</span>',
      '            <span class="sim__speed-val">{{ state.speed }} km/h</span></div>',
      '          <input type="range" min="0" max="120" step="1" :value="state.speed" @input="setSpeed($event.target.value)" aria-label="车速">',
      '        </div>',
      '        <div class="strip">',
      '          <button class="btn btn--sm btn--ghost" @click="quickSpeed(0)">0</button>',
      '          <button class="btn btn--sm btn--ghost" @click="quickSpeed(30)">30</button>',
      '          <button class="btn btn--sm btn--ghost" @click="quickSpeed(60)">60</button>',
      '          <button class="btn btn--sm btn--ghost" @click="quickSpeed(90)">90</button>',
      '        </div>',
      '        <div class="sim__note" :class="restricted ? \'is-warn\' : \'\'">{{ restrictionText }}</div>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 显示 ---------- */
      '    <card-panel class="col-3" title="显示与主题" icon="brightness">',
      '      <div class="theme-pick">',
      '        <button v-for="t in themes" :key="t.key" class="theme-card" :class="theme === t.key ? \'is-on\' : \'\'" @click="setTheme(t.key)">',
      '          <span class="theme-card__prev" :class="t.key === \'dark\' ? \'theme-card__prev--dark\' : \'theme-card__prev--light\'">',
      '            <i></i><i></i><i></i>',
      '          </span>',
      '          <span class="list__main"><span class="list__title">{{ t.label }}</span>',
      '            <span class="list__sub">{{ t.desc }}</span></span>',
      '          <rw-icon v-if="theme === t.key" name="check" :size="24"></rw-icon>',
      '        </button>',
      '      </div>',
      '      <div class="brightness-row">',
      '        <rw-icon name="brightness" :size="24"></rw-icon>',
      '        <input type="range" min="20" max="100" step="1" :value="sys.brightness" @input="setBrightness($event.target.value)" aria-label="屏幕亮度">',
      '        <span class="slider__value">{{ sys.brightness }}%</span>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 连接 ---------- */
      '    <card-panel class="col-3" title="连接" icon="wifi">',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggle(\'wifi\')">',
      '        <rw-icon name="wifi" :size="26"></rw-icon>',
      '        <span class="list__main"><span class="list__title">无线网络</span>',
      '          <span class="list__sub">{{ sys.wifi ? sys.wifiName : \'未连接\' }}</span></span>',
      '        <span class="switch" :class="sys.wifi ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <button class="list__item list__item--btn" style="width:100%" @click="toggle(\'bluetooth\')">',
      '        <rw-icon name="bluetooth" :size="26"></rw-icon>',
      '        <span class="list__main"><span class="list__title">蓝牙</span>',
      '          <span class="list__sub">{{ sys.bluetooth ? sys.btName : \'已关闭\' }}</span></span>',
      '        <span class="switch" :class="sys.bluetooth ? \'is-on\' : \'\'"></span>',
      '      </button>',
      '      <div class="kv"><span class="muted">信号强度</span><span>{{ sys.wifi ? \'强 · -52 dBm\' : \'—\' }}</span></div>',
      '    </card-panel>',

      /* ---------- OTA ---------- */
      '    <card-panel class="col-3" title="系统升级 OTA" icon="download" :tone="sys.otaNew ? \'accent\' : \'\'">',
      '      <div class="list__item" style="border:none;padding:0">',
      '        <span class="list__main"><span class="list__title">当前版本</span>',
      '          <span class="list__sub">{{ sys.otaVersion }}</span></span>',
      '        <span class="chip" :class="sys.otaNew ? \'chip--accent\' : \'chip--ok\'">{{ sys.otaNew ? \'有新版本\' : \'已是最新\' }}</span>',
      '      </div>',
      '      <div class="strip" style="margin-top:.16rem">',
      '        <button class="btn btn--sm btn--ghost" @click="checkOta" :disabled="otaBusy">检查更新</button>',
      '        <button class="btn btn--sm btn--primary" @click="installOta" :disabled="otaBusy || !sys.otaNew">立即升级</button>',
      '      </div>',
      '      <div class="bar" style="margin-top:.16rem"><div class="bar__fill" :style="{ width: otaBusy ? \'70%\' : otaDone ? \'100%\' : \'0%\' }"></div></div>',
      '      <div class="card__hint">{{ otaBusy ? \'下载中，请勿断电…\' : otaDone ? \'最新包已就绪\' : \'建议在 P 挡驻车时升级\' }}</div>',
      '    </card-panel>',

      /* ---------- 关于 ---------- */
      '    <card-panel class="col-3" title="关于本机" icon="info">',
      '      <div class="about-grid">',
      '        <div class="kv"><span class="muted">设备</span><span>{{ about.device }}</span></div>',
      '        <div class="kv"><span class="muted">序列号</span><span>{{ about.sn }}</span></div>',
      '        <div class="kv"><span class="muted">芯片</span><span>{{ about.chip }}</span></div>',
      '        <div class="kv"><span class="muted">内存 / 存储</span><span>{{ about.ram }} / {{ about.storage }}</span></div>',
      '        <div class="kv"><span class="muted">系统版本</span><span>{{ sys.otaVersion }}</span></div>',
      '        <div class="kv"><span class="muted">构建号</span><span>{{ about.build }}</span></div>',
      '        <div class="kv"><span class="muted">车型</span><span>{{ state.vehicle.model }}</span></div>',
      '        <div class="kv"><span class="muted">车牌</span><span>{{ state.vehicle.plate }}</span></div>',
      '        <div class="kv"><span class="muted">电池电量</span><span>{{ batteryText }}</span></div>',
      '      </div>',
      '      <div class="card__hint">荣威 RX5 智能座舱 · 网页演示版（零构建，纯前端）</div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };
})(window);
