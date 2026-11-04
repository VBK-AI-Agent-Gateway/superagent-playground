/*!
 * 主页模块
 * 规格：Dock（底部，由 AppDock 提供）+ 3D 车模卡片 + 速度/电量/油量仪表 + 时间与天气 + D 挡时导航优先
 */
(function (global) {
  'use strict';

  global.HomeView = {
    name: 'HomeView',
    inject: ['ctx'],
    data: function () {
      return { quickSeat: 0 };
    },
    computed: {
      state: function () { return this.ctx.state; },
      restricted: function () { return this.ctx.state.isDriving(); },
      speedPct: function () {
        return Math.max(4, Math.min(100, (this.state.speed / 180) * 100));
      },
      battPct: function () { return this.state.vehicle.battery; },
      fuelPct: function () { return this.state.vehicle.fuel; },
      /* D 挡行车时，导航信息在主页最优先 */
      navFirst: function () { return this.state.gear === 'D'; },
      navCue: function () {
        var n = this.state.nav;
        return n.nextManeuver || '请设置目的地';
      },
      weatherIcon: function () { return this.state.weather.icon || 'cloudy'; }
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('导航优先条', ['导航优先', '主页导航'], function () { self.openNav(); }, '主页');
      R.say('打开天气详情', ['天气怎么样', '今天天气'], function () {
        self.ctx.toast.show('今日 ' + self.state.weather.desc + ' ' + self.state.weather.low + '~' + self.state.weather.high + '℃', 'info');
      }, '主页');
      R.say('车辆状态', ['车辆状态', '胎压', '电量'], function () {
        var v = self.state.vehicle;
        self.ctx.toast.show('电量 ' + v.battery + '% · 续航 ' + v.range + 'km · 胎压 ' + v.tirePressure.join('/'), 'info');
      }, '主页');
    },
    methods: {
      openNav: function () { this.ctx.router.push('nav'); },
      open: function (view) { this.ctx.router.push(view); },
      toggleTheme: function () { this.ctx.toggleTheme(); },
      toggleSunroof: function () {
        var s = this.state.settings;
        s.sunroof = s.sunroof > 0 ? 0 : 60;
        this.ctx.toast.show(s.sunroof > 0 ? '天窗已打开' : '天窗已关闭', 'info');
      },
      lockToggle: function () {
        var v = this.state.vehicle;
        v.locked = !v.locked;
        this.ctx.toast.show(v.locked ? '车门已上锁' : '车门已解锁', v.locked ? 'info' : 'warn');
      }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 3D 车模卡片 ---------- */
      '    <card-panel class="col-6 hero" tone="accent" :title="\'\'" v-slot:default>',
      '      <div class="hero__stage">',
      '        <div class="hero__top">',
      '          <div>',
      '            <div class="hero__model">{{ state.vehicle.model }}</div>',
      '            <div class="hero__sub">已行驶 {{ state.vehicle.odo }} km · {{ state.vehicle.vin.slice(-6) }}</div>',
      '          </div>',
      '          <div class="stack" style="align-items:flex-end">',
      '            <span class="hero__plate"><rw-icon name="car" :size="18"></rw-icon>{{ state.vehicle.plate }}</span>',
      '            <span class="chip" :class="state.vehicle.locked ? \'chip--ok\' : \'chip--warn\'">',
      '              <rw-icon :name="state.vehicle.locked ? \'lock\' : \'door\'" :size="16"></rw-icon>',
      '              {{ state.vehicle.locked ? \'已上锁\' : \'未上锁\' }}',
      '            </span>',
      '          </div>',
      '        </div>',
      '        <car-model-3d :speed="state.speed" :gear="state.gear" :battery="state.vehicle.battery"></car-model-3d>',
      '        <div class="hero__nav-cue" v-if="navFirst" @click="openNav">',
      '          <span class="arrow"><rw-icon name="nav" :size="30"></rw-icon></span>',
      '          <span class="grow">',
      '            <span class="t1">{{ navCue }}</span>',
      '            <span class="t2">D 挡行车 · 导航优先显示 · 预计 {{ state.nav.eta }} 分钟到达 {{ state.nav.destination }}</span>',
      '          </span>',
      '          <rw-icon name="back" :size="24" style="transform:rotate(180deg)"></rw-icon>',
      '        </div>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 导航优先卡片（P 挡时提供入口） ---------- */
      '    <card-panel class="col-3" title="导航" icon="nav" openable view="nav" tone="accent"',
      '                say="打开导航" :say-phrases="[\'去导航\', \'导航地图\']">',
      '      <div class="strip">',
      '        <span class="gauge__value">{{ state.nav.eta }}<span class="gauge__unit">分钟</span></span>',
      '        <span class="engine-pill" :class="state.nav.engine === \'amap\' ? \'is-live\' : \'\'">',
      '          {{ state.nav.engine === \'amap\' ? \'高德实时\' : \'离线示意图\' }}',
      '        </span>',
      '      </div>',
      '      <div class="muted" style="font-size:.21rem">{{ state.nav.destination }} · {{ state.nav.distance }} km · {{ state.nav.traffic }}</div>',
      '      <div class="nav-lanes">',
      '        <span class="nav-lane" v-for="l in 4" :key="l" :class="l === 3 ? \'is-active\' : \'\'">',
      '          <rw-icon name="route" :size="20"></rw-icon>',
      '        </span>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 时间 + 天气 ---------- */
      '    <card-panel class="col-3" title="时间 · 天气" icon="cloud"',
      '                say="查看天气" :say-phrases="[\'今天天气\', \'天气怎么样\']">',
      '      <div class="weather-now">',
      '        <div>',
      '          <div class="weather-now__temp">{{ state.nowText }}</div>',
      '          <div class="weather-now__desc">{{ state.nowDate }}</div>',
      '        </div>',
      '        <span class="weather-icon"><rw-icon :name="weatherIcon" :size="64"></rw-icon></span>',
      '      </div>',
      '      <div class="strip">',
      '        <span style="font-size:.24rem">{{ state.weather.city }} · {{ state.weather.desc }}</span>',
      '        <span class="accent" style="font-size:.3rem">{{ state.weather.temp }}℃</span>',
      '      </div>',
      '      <div class="weather-now__meta">',
      '        <span class="chip"><rw-icon name="sun" :size="16"></rw-icon>{{ state.weather.low }}~{{ state.weather.high }}℃</span>',
      '        <span class="chip">湿度 {{ state.weather.humidity }}%</span>',
      '        <span class="chip">{{ state.weather.wind }}</span>',
      '        <span class="chip" :class="state.weather.aqi <= 50 ? \'chip--ok\' : \'chip--warn\'">AQI {{ state.weather.aqi }}</span>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 仪表：速度 / 电量 / 油量 ---------- */
      '    <card-panel class="col-6" title="行车仪表" icon="car">',
      '      <div class="gauges">',
      '        <div class="gauge">',
      '          <div class="gauge-ring" :style="{ \'--pct\': speedPct + \'%\', \'--ring-color\': \'#56a0ff\' }">',
      '            <span class="gauge-ring__inner">',
      '              <span class="gauge-ring__val">{{ state.speed }}</span>',
      '              <span class="gauge-ring__unit">km/h</span>',
      '            </span>',
      '          </div>',
      '          <span class="gauge__label">车速</span>',
      '        </div>',
      '        <div class="gauge">',
      '          <div class="gauge-ring" :style="{ \'--pct\': battPct + \'%\', \'--ring-color\': battPct > 20 ? \'#22c55e\' : \'#ef4444\' }">',
      '            <span class="gauge-ring__inner">',
      '              <span class="gauge-ring__val">{{ battPct }}</span>',
      '              <span class="gauge-ring__unit">% 电量</span>',
      '            </span>',
      '          </div>',
      '          <span class="gauge__label">续航 {{ state.vehicle.range }} km</span>',
      '        </div>',
      '        <div class="gauge">',
      '          <div class="gauge-ring" :style="{ \'--pct\': fuelPct + \'%\', \'--ring-color\': \'#f59e0b\' }">',
      '            <span class="gauge-ring__inner">',
      '              <span class="gauge-ring__val">{{ fuelPct }}</span>',
      '              <span class="gauge-ring__unit">% 油量</span>',
      '            </span>',
      '          </div>',
      '          <span class="gauge__label">{{ state.vehicle.charging ? \'充电中\' : \'混动油箱\' }}</span>',
      '        </div>',
      '      </div>',
      '      <div class="strip">',
      '        <span class="chip" :class="state.gear === \'D\' ? \'chip--accent\' : \'chip--ok\'">挡位 {{ state.gear }}</span>',
      '        <span class="chip">{{ driveModeText }}</span>',
      '        <span class="chip">胎压 {{ state.vehicle.tirePressure.join(\'/\') }} bar</span>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 快捷控制 ---------- */
      '    <card-panel class="col-6" title="快捷控制" icon="settings">',
      '      <div class="quick">',
      '        <button class="quick__btn" :class="state.climate.power ? \'is-on\' : \'\'" @click="open(\'climate\')"',
      '                aria-label="空调">',
      '          <rw-icon name="climate" :size="34"></rw-icon><span>{{ state.climate.tempL }}℃</span>',
      '        </button>',
      '        <button class="quick__btn" :class="state.media.playing ? \'is-on\' : \'\'" @click="open(\'media\')"',
      '                aria-label="多媒体">',
      '          <rw-icon name="media" :size="34"></rw-icon><span>{{ state.media.playing ? \'播放中\' : \'音乐\' }}</span>',
      '        </button>',
      '        <button class="quick__btn" :class="state.settings.sunroof > 0 ? \'is-on\' : \'\'" @click="toggleSunroof"',
      '                aria-label="天窗">',
      '          <rw-icon name="sunroof" :size="34"></rw-icon><span>天窗</span>',
      '        </button>',
      '        <button class="quick__btn" :class="state.vehicle.locked ? \'is-on\' : \'\'" @click="lockToggle"',
      '                aria-label="车门锁">',
      '          <rw-icon name="lock" :size="34"></rw-icon><span>{{ state.vehicle.locked ? \'已锁\' : \'解锁\' }}</span>',
      '        </button>',
      '        <button class="quick__btn" @click="open(\'surround\')" aria-label="全景影像">',
      '          <rw-icon name="camera" :size="34"></rw-icon><span>全景</span>',
      '        </button>',
      '        <button class="quick__btn" @click="open(\'vehicle\')" aria-label="车辆设置">',
      '          <rw-icon name="car" :size="34"></rw-icon><span>车辆</span>',
      '        </button>',
      '        <button class="quick__btn" @click="open(\'settings\')" aria-label="系统设置">',
      '          <rw-icon name="settings" :size="34"></rw-icon><span>设置</span>',
      '        </button>',
      '        <button class="quick__btn" :class="state.theme === \'light\' ? \'is-on\' : \'\'" @click="toggleTheme"',
      '                aria-label="主题切换">',
      '          <rw-icon name="sun" :size="34"></rw-icon><span>{{ state.theme === \'light\' ? \'浅色\' : \'深色\' }}</span>',
      '        </button>',
      '      </div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n'),
    computed2: null
  };

  /* 追加计算属性（保持对象字面量可读性） */
  global.HomeView.computed.driveModeText = function () {
    var map = { comfort: '舒适模式', eco: '节能模式', sport: '运动模式', snow: '雪地模式' };
    return map[this.state.driveMode] || '舒适模式';
  };
})(window);
