/*!
 * js/views/settings.js — 模块 8：设置
 * 亮度、主题、WiFi、蓝牙、OTA 版本与关于信息；同时提供驾驶状态模拟器入口。
 */
(function (global) {
  'use strict';

  var settings = {
    data: function () { return { S: global.CockpitState, tab: 'display', wifiBusy: '' }; },
    computed: {
      sys: function () { return this.S.data.system; },
      about: function () { return this.S.data.about; },
      cfg: function () { return global.COCKPIT_CONFIG; },
      tabs: function () {
        return [
          { key: 'display', label: '显示', icon: 'brightness' },
          { key: 'network', label: '网络', icon: 'wifi' },
          { key: 'bluetooth', label: '蓝牙', icon: 'bt' },
          { key: 'ota', label: '系统升级', icon: 'ota' },
          { key: 'about', label: '关于', icon: 'info' }
        ];
      },
      brightness: function () { return this.S.brightness; },
      theme: function () { return this.S.theme; },
      wifi: function () { return this.sys.wifi; },
      wifiList: function () { return this.sys.wifiList || []; },
      bt: function () { return this.S.data.media.bt; },
      ota: function () { return this.sys.ota; },
      storagePct: function () {
        var st = this.sys.storage || { used: 0, total: 1 };
        return Math.round((st.used / st.total) * 100);
      },
      amapConfigured: function () { return !!(this.cfg.amapKey && String(this.cfg.amapKey).trim()); }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'settings.theme', scope: 'settings', label: '切换主题',
          phrases: ['切换主题', '打开深色模式', '打开浅色模式', '换个主题'],
          handler: function () {
            var t = String(arguments[0] || '');
            if (t.indexOf('浅') >= 0 || t.indexOf('亮') >= 0) self.setTheme('light');
            else if (t.indexOf('深') >= 0 || t.indexOf('暗') >= 0) self.setTheme('dark');
            else self.setTheme(self.theme === 'dark' ? 'light' : 'dark');
            return '已切换为' + (self.theme === 'dark' ? '深色' : '浅色') + '主题。';
          }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'settings.brightnessUp', scope: 'settings', label: '调高亮度',
          phrases: ['调高亮度', '屏幕亮一点', '亮度加'],
          handler: function () { self.bumpBright(10); return '亮度已调整为 ' + self.brightness + '%。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'settings.brightnessDown', scope: 'settings', label: '调低亮度',
          phrases: ['调低亮度', '屏幕暗一点', '亮度减'],
          handler: function () { self.bumpBright(-10); return '亮度已调整为 ' + self.brightness + '%。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'settings.wifi', scope: 'settings', label: 'WiFi 开关',
          phrases: ['打开无线网络', '关闭无线网络', '打开wifi', '关闭wifi'],
          handler: function () {
            self.toggleWifi();
            return '无线网络已' + (self.wifi.on ? '打开' : '关闭') + '。';
          }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'settings.bluetooth', scope: 'settings', label: '蓝牙开关',
          phrases: ['打开蓝牙', '关闭蓝牙'],
          handler: function () {
            self.toggleBt();
            return '蓝牙已' + (self.sys.bluetooth.on ? '打开' : '关闭') + '。';
          }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'settings.ota', scope: 'settings', label: '检查升级',
          phrases: ['检查系统升级', '检查更新', '有没有新版本'],
          handler: function () { self.tab = 'ota'; self.checkOta(); return '正在检查系统升级。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'settings.simulator', scope: 'settings', label: '驾驶状态模拟器',
          phrases: ['打开模拟器', '驾驶模拟器', '切换挡位', '模拟行车'],
          handler: function () { global.CockpitSimulator.open(); return '驾驶状态模拟器已打开。'; }
        })
      ];
    },
    beforeUnmount: function () { (this._uns || []).forEach(function (fn) { fn(); }); },
    methods: {
      setBrightness: function (v) {
        this.S.brightness = Math.max(20, Math.min(100, Number(v) || 0));
        global.CockpitStore.persistBrightness(this.S.brightness);
      },
      bumpBright: function (d) { this.setBrightness(this.S.brightness + d); },
      setTheme: function (t) {
        this.S.theme = t;
        global.CockpitStore.persistTheme(t);
        global.CockpitMap.setTheme(t);
      },
      toggleWifi: function () {
        this.wifi.on = !this.wifi.on;
        global.CockpitSafety.notify({ text: '无线网络已' + (this.wifi.on ? '开启' : '关闭'), icon: 'wifi' });
      },
      connect: function (net) {
        var self = this;
        if (!this.wifi.on) { global.CockpitSafety.notify({ text: '请先开启无线网络', icon: 'wifi', level: 'warn' }); return; }
        if (net.saved) { this.wifi.ssid = net.ssid; this.wifi.signal = net.signal; global.CockpitSafety.notify({ text: '已连接 ' + net.ssid, icon: 'wifi', level: 'ok' }); return; }
        this.wifiBusy = net.ssid;
        global.setTimeout(function () {
          self.wifiBusy = '';
          net.saved = true;
          self.wifi.ssid = net.ssid;
          self.wifi.signal = net.signal;
          global.CockpitSafety.notify({ text: '已连接 ' + net.ssid, icon: 'wifi', level: 'ok' });
        }, 1200);
      },
      toggleBt: function () {
        this.sys.bluetooth.on = !this.sys.bluetooth.on;
        global.CockpitSafety.notify({ text: '蓝牙已' + (this.sys.bluetooth.on ? '开启' : '关闭'), icon: 'bt' });
      },
      forgetBt: function () {
        this.bt.connected = false;
        global.CockpitSafety.notify({ text: '已断开 ' + (this.bt.device || '设备'), icon: 'bt', level: 'warn' });
      },
      setLanguage: function (l) {
        this.sys.language = l;
        global.CockpitSafety.notify({ text: l === 'zh-CN' ? '语言已切换为中文' : 'Language switched to English', icon: 'info', level: 'ok' });
      },
      checkOta: function () {
        var self = this;
        this.ota.lastCheck = this.nowText();
        global.CockpitSafety.notify({ text: '正在检查更新…', icon: 'ota' });
        global.setTimeout(function () {
          global.CockpitSafety.notify({
            text: self.ota.available ? '发现新版本 ' + self.ota.available.version : '当前已是最新版本',
            icon: 'ota', level: 'ok'
          });
        }, 1400);
      },
      nowText: function () {
        var d = new Date();
        var p = function (n) { return ('0' + n).slice(-2); };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      },
      openSim: function () { global.CockpitSimulator.open(); },
      resetAll: function () {
        this.S.theme = 'dark';
        this.S.brightness = 80;
        global.CockpitStore.persistTheme('dark');
        global.CockpitStore.persistBrightness(80);
        global.CockpitMap.setTheme('dark');
        global.CockpitSafety.notify({ text: '显示设置已恢复默认', icon: 'check', level: 'ok' });
      }
    },
    template:
      '<div class="view view-settings">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">设置</h2>' +
          '<span class="ph-status"><c-icon name="settings" :size="16"></c-icon>{{ cfg.vehicle.model }}</span>' +
        '</header>' +

        '<nav class="seg-tabs" aria-label="设置分类">' +
          '<button v-for="t in tabs" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">' +
            '<c-icon :name="t.icon" :size="18"></c-icon><span>{{ t.label }}</span>' +
          '</button>' +
        '</nav>' +

        /* ---------- 显示 ---------- */
        '<template v-if="tab === \'display\'">' +
          '<section class="card">' +
            '<h3 class="card-title">屏幕亮度</h3>' +
            '<div class="bright-row">' +
              '<button class="rnd" aria-label="降低亮度" @click="bumpBright(-10)"><c-icon name="minus" :size="20"></c-icon></button>' +
              '<input class="slider" type="range" min="20" max="100" step="1" :value="brightness" aria-label="屏幕亮度" @input="setBrightness($event.target.value)">' +
              '<button class="rnd" aria-label="提高亮度" @click="bumpBright(10)"><c-icon name="plus" :size="20"></c-icon></button>' +
              '<span class="bright-val">{{ brightness }}%</span>' +
            '</div>' +
            '<p class="hint">夜间行车建议保持 60% 以下亮度，减少眩光干扰。</p>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">外观主题</h3>' +
            '<div class="theme-grid">' +
              '<button class="theme-card dark" :class="{ on: theme === \'dark\' }" @click="setTheme(\'dark\')">' +
                '<span class="tc-prev"><i></i><i></i><i></i></span><b>深色模式</b><small>夜间 / 隧道推荐</small>' +
              '</button>' +
              '<button class="theme-card light" :class="{ on: theme === \'light\' }" @click="setTheme(\'light\')">' +
                '<span class="tc-prev"><i></i><i></i><i></i></span><b>浅色模式</b><small>白天高对比度</small>' +
              '</button>' +
            '</div>' +
          '</section>' +
          '<section class="card">' +
            '<div class="row-list">' +
              '<div class="row"><c-icon name="sun" :size="20"></c-icon><span>自动亮度</span>' +
                '<button class="sw" :class="{ on: S.autoBrightness }" @click="S.autoBrightness = !S.autoBrightness"><i></i></button></div>' +
              '<div class="row"><c-icon name="info" :size="20"></c-icon><span>语言</span>' +
                '<span class="seg-mini">' +
                  '<button :class="{ on: sys.language === \'zh-CN\' }" @click="setLanguage(\'zh-CN\')">中文</button>' +
                  '<button :class="{ on: sys.language === \'en-US\' }" @click="setLanguage(\'en-US\')">EN</button>' +
                '</span></div>' +
            '</div>' +
            '<div class="row-actions"><button class="btn" @click="resetAll">恢复默认显示设置</button></div>' +
          '</section>' +
        '</template>' +

        /* ---------- 网络 ---------- */
        '<template v-if="tab === \'network\'">' +
          '<section class="card">' +
            '<div class="head-row"><h3 class="card-title">无线网络</h3>' +
              '<button class="sw" :class="{ on: wifi.on }" @click="toggleWifi"><i></i></button></div>' +
            '<div class="net-now"><c-icon name="wifi" :size="20"></c-icon>' +
              '<div class="net-text"><b>{{ wifi.on ? wifi.ssid : \'无线网络已关闭\' }}</b>' +
                '<small>{{ wifi.on ? \'IP \' + wifi.ip + \' · 信号 \' + wifi.signal + \'/4\' : \'打开后可搜索附近热点\' }}</small></div>' +
            '</div>' +
            '<ul class="net-list">' +
              '<li v-for="n in wifiList" :key="n.ssid" :class="{ on: n.ssid === wifi.ssid && wifi.on }">' +
                '<c-icon name="wifi" :size="18"></c-icon>' +
                '<div class="net-text"><b>{{ n.ssid }}</b><small>{{ n.secure ? \'加密网络\' : \'开放网络\' }}{{ n.saved ? \' · 已保存\' : \'\' }}</small></div>' +
                '<span class="sig">{{ n.signal }}/4</span>' +
                '<button class="ct-call" :disabled="wifiBusy === n.ssid" @click="connect(n)">' +
                  '{{ wifiBusy === n.ssid ? \'连接中…\' : (n.ssid === wifi.ssid && wifi.on ? \'已连接\' : \'连接\') }}' +
                '</button>' +
              '</li>' +
            '</ul>' +
          '</section>' +
          '<section class="card">' +
            '<div class="row-list">' +
              '<div class="row"><c-icon name="wifi" :size="20"></c-icon><span>车机热点</span>' +
                '<button class="sw" :class="{ on: sys.hotspot }" @click="sys.hotspot = !sys.hotspot"><i></i></button></div>' +
            '</div>' +
          '</section>' +
        '</template>' +

        /* ---------- 蓝牙 ---------- */
        '<template v-if="tab === \'bluetooth\'">' +
          '<section class="card">' +
            '<div class="head-row"><h3 class="card-title">蓝牙</h3>' +
              '<button class="sw" :class="{ on: sys.bluetooth.on }" @click="toggleBt"><i></i></button></div>' +
            '<div v-if="bt.connected" class="bt-now">' +
              '<c-icon name="phone" :size="26"></c-icon>' +
              '<div class="net-text"><b>{{ bt.device }}</b><small>已连接 · 电量 {{ bt.battery }}% · 信号 {{ bt.signal }}/4</small></div>' +
              '<button class="mini-btn" @click="forgetBt">断开</button>' +
            '</div>' +
            '<p v-else class="hint">暂无已连接设备，请在手机端搜索 “{{ cfg.vehicle.plate }}” 进行配对。</p>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">已配对设备</h3>' +
            '<ul class="net-list">' +
              '<li :class="{ on: bt.connected }">' +
                '<c-icon name="bt" :size="18"></c-icon>' +
                '<div class="net-text"><b>{{ bt.device }}</b><small>{{ bt.connected ? \'已连接\' : \'未连接\' }}</small></div>' +
                '<button class="ct-call" @click="bt.connected ? forgetBt() : (bt.connected = true)">{{ bt.connected ? \'断开\' : \'连接\' }}</button>' +
              '</li>' +
            '</ul>' +
          '</section>' +
        '</template>' +

        /* ---------- OTA ---------- */
        '<template v-if="tab === \'ota\'">' +
          '<section class="card">' +
            '<h3 class="card-title">当前版本</h3>' +
            '<div class="stat-grid">' +
              '<div class="stat"><small>系统版本</small><b>{{ ota.version }}</b></div>' +
              '<div class="stat"><small>构建号</small><b class="mono">{{ ota.build }}</b></div>' +
              '<div class="stat"><small>硬件平台</small><b>{{ ota.hardware }}</b></div>' +
              '<div class="stat"><small>更新通道</small><b>{{ ota.channel }}</b></div>' +
            '</div>' +
            '<div class="row-actions">' +
              '<button class="btn btn-accent" @click="checkOta"><c-icon name="ota" :size="18"></c-icon>检查更新</button>' +
              '<span class="mini-tag">上次检查 {{ ota.lastCheck }}</span>' +
            '</div>' +
          '</section>' +
          '<section v-if="ota.available" class="card ota-card">' +
            '<div class="ota-hero"><c-icon name="ota" :size="26"></c-icon>' +
              '<div class="net-text"><b>发现新版本 {{ ota.available.version }}</b><small>安装包 {{ ota.available.size }} · {{ ota.available.note }}</small></div>' +
            '</div>' +
            '<p class="hint">为保证行车安全，请在 P 挡且车辆静止时进行升级。本演示不会真正下载。</p>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">存储空间</h3>' +
            '<div class="store-row"><div class="store-track"><i :style="{ width: storagePct + \'%\' }"></i></div>' +
              '<span>{{ sys.storage.used }} GB / {{ sys.storage.total }} GB</span></div>' +
          '</section>' +
        '</template>' +

        /* ---------- 关于 ---------- */
        '<template v-if="tab === \'about\'">' +
          '<section class="card about-card">' +
            '<div class="about-logo"><c-icon name="car" :size="34"></c-icon></div>' +
            '<b class="about-model">{{ about.model }}</b>' +
            '<small class="about-plate">{{ cfg.vehicle.plate }} · VIN {{ about.vin }}</small>' +
            '<div class="stat-grid">' +
              '<div class="stat"><small>屏幕</small><b>{{ cfg.vehicle.screen }}</b></div>' +
              '<div class="stat"><small>软件版本</small><b>{{ about.software }}</b></div>' +
              '<div class="stat"><small>MCU</small><b>{{ about.mcu }}</b></div>' +
              '<div class="stat"><small>IMEI</small><b class="mono">{{ about.imei }}</b></div>' +
              '<div class="stat"><small>SN</small><b class="mono">{{ about.sn }}</b></div>' +
              '<div class="stat"><small>地图服务</small><b>{{ amapConfigured ? \'高德在线\' : \'内置示意图（未配置 Key）\' }}</b></div>' +
            '</div>' +
            '<p class="hint">本车机为网页版演示系统，所有车辆数据、媒体与雷达信息均为模拟数据。</p>' +
          '</section>' +
          '<section class="card">' +
            '<h3 class="card-title">驾驶状态模拟器</h3>' +
            '<p class="hint">切换 P / R / N / D 挡位并调节车速，用于验证行车安全限制。</p>' +
            '<div class="row-actions"><button class="btn btn-accent" @click="openSim"><c-icon name="speed" :size="18"></c-icon>打开模拟器</button></div>' +
          '</section>' +
        '</template>' +
      '</div>'
  };

  global.CSettingsView = settings;
})(window);
