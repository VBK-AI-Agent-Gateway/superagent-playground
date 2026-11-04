/*!
 * 导航模块
 * 规格：高德 AMap JS API 2.0（key 配置在 config.js）；未配置 key 或加载失败时自动降级为
 *       内置示意地图，路线规划 / 车道指引 / 路况 / 充电站 UI 全部保留。
 * 规则 1：D 挡行车时不弹出遮挡式面板，导航信息始终为最高优先级。
 */
(function (global) {
  'use strict';

  var MANEUVERS = ['沿中环路高架直行 1.2km 后靠右驶出', '前方 300m 右转进入虹桥路', '保持左侧车道，直行 2.4km', '到达目的地附近，注意右侧停车区'];

  global.NavView = {
    name: 'NavView',
    inject: ['ctx'],
    data: function () {
      return {
        query: '',
        searchFocused: false,
        routeIndex: 0,
        routes: (global.ROEWE_MOCK && global.ROEWE_MOCK.routes) || [],
        places: (global.ROEWE_MOCK && global.ROEWE_MOCK.places) || [],
        charging: [
          { name: '虹桥枢纽 P3 充电站', dist: '1.2 km', free: 6, power: '120 kW' },
          { name: '中环路漕宝路快充站', dist: '3.8 km', free: 2, power: '60 kW' },
          { name: '申长路超充站', dist: '6.4 km', free: 11, power: '180 kW' }
        ],
        engineTried: false
      };
    },
    computed: {
      state: function () { return this.ctx.state; },
      nav: function () { return this.ctx.state.nav; },
      restricted: function () { return this.ctx.state.isDriving(); },
      filtered: function () {
        var q = this.query.trim();
        if (!q) return this.places.slice(0, 5);
        return this.places.filter(function (p) {
          return p.name.indexOf(q) >= 0 || p.address.indexOf(q) >= 0;
        }).slice(0, 6);
      },
      lanes: function () {
        return (global.ROEWE_MOCK && global.ROEWE_MOCK.lanes) || ['left', 'straight', 'straight', 'right'];
      },
      laneIcon: function () {
        var map = { left: 'route', straight: 'route', right: 'route' };
        return map[this.nav.lane] || 'route';
      },
      etaText: function () {
        return this.nav.eta + ' 分钟';
      },
      batteryLow: function () { return this.state.vehicle.battery < 30; }
    },
    mounted: function () {
      this.bootEngine();
    },
    beforeUnmount: function () {
      if (this._amap) {
        try { this._amap.destroy(); } catch (e) { /* ignore */ }
        this._amap = null;
      }
    },
    methods: {
      /* 尝试加载高德 JS API 2.0；失败则保留内置示意图 */
      bootEngine: function () {
        var self = this;
        if (this.engineTried) return;
        this.engineTried = true;
        if (!global.RoeweMap) return;
        global.RoeweMap.loadAmap(global.ROEWE_CONFIG.amap).then(function (AMap) {
          self.nav.engine = 'amap';
          self.nav.configured = true;
          self.$nextTick(function () { self.mountAmap(AMap); });
          self.ctx.toast.show('高德地图已加载', 'info');
        }).catch(function (err) {
          self.nav.engine = 'fallback';
          self.nav.configured = false;
          var reason = err && err.message === 'NO_KEY' ? '未配置高德 Key，已使用内置示意地图' : '在线地图不可用，已切换内置示意地图';
          self.ctx.toast.show(reason, 'warn');
        });
      },
      mountAmap: function (AMap) {
        var el = this.$refs.amap;
        if (!el || this._amap) return;
        try {
          this._amap = new AMap.Map(el, {
            zoom: 12,
            center: [121.36, 31.2],
            mapStyle: 'amap://styles/darkblue',
            viewMode: '2D'
          });
          var driving = new AMap.Driving({ map: this._amap, policy: AMap.DrivingPolicy.LEAST_TIME });
          driving.search([{ keyword: '上海' }, { keyword: this.nav.destination }], function (status) {
            if (status !== 'complete') return;
          });
        } catch (e) {
          this.nav.engine = 'fallback';
          this._amap = null;
        }
      },
      /* ---------- 目的地与路线 ---------- */
      pick: function (place) {
        this.nav.destination = place.name;
        this.nav.distance = place.distance;
        this.nav.eta = place.eta;
        this.routeIndex = 0;
        this.query = '';
        this.ctx.toast.show('已设置目的地：' + place.name, 'info');
      },
      pickRoute: function (idx) {
        var r = this.routes[idx];
        if (!r) return;
        this.routeIndex = idx;
        this.nav.distance = r.distance;
        this.nav.eta = r.eta;
        this.nav.traffic = r.traffic;
        this.ctx.toast.show('已选择「' + r.name + '」', 'info');
      },
      startNav: function () {
        this.ctx.simulator.setGear('D');
        this.ctx.toast.show('开始导航前往 ' + this.nav.destination, 'info');
      },
      /* 行车中模拟前进：推进进度、剩余距离与车道/路况 */
      tick: function () {
        var n = this.nav;
        n.progress = Math.min(100, n.progress + 2);
        n.remainDistance = Math.max(0, +(n.distance * (1 - n.progress / 100)).toFixed(1));
        n.eta = Math.max(1, Math.round(n.eta));
      }
    },
    template: [
      '<div class="page-scroll page-scroll--flush">',
      '  <div class="grid">',

      /* ---------- 地图区（高度优先） ---------- */
      '    <div class="col-6 nav-map">',
      '      <div class="nav-map__amap" ref="amap" v-show="nav.engine === \'amap\'"></div>',
      '      <div class="nav-map__fallback" v-show="nav.engine !== \'amap\'">',
      '        <svg viewBox="0 0 1000 1000" preserveAspectRatio="xMidYMid slice" aria-label="内置示意地图">',
      '          <defs>',
      '            <linearGradient id="navBg" x1="0" y1="0" x2="1" y2="1">',
      '              <stop offset="0%" stop-color="#0a1630"/><stop offset="100%" stop-color="#050a18"/>',
      '            </linearGradient>',
      '            <linearGradient id="navRoad" x1="0" y1="0" x2="1" y2="0">',
      '              <stop offset="0%" stop-color="#2b6cff"/><stop offset="100%" stop-color="#56a0ff"/>',
      '            </linearGradient>',
      '          </defs>',
      '          <rect width="1000" height="1000" fill="url(#navBg)"/>',
      '          <g stroke="rgba(120,160,220,.10)" stroke-width="2">',
      '            <path v-for="i in 16" :key="\'h\'+i" :d="\'M0 \'+(i*62)+\'H1000\'"/>',
      '            <path v-for="i in 16" :key="\'v\'+i" :d="\'M\'+(i*62)+\' 0V1000\'"/>',
      '          </g>',
      '          <g fill="rgba(43,108,255,.10)">',
      '            <rect x="60" y="90" width="180" height="130" rx="12"/>',
      '            <rect x="680" y="140" width="240" height="170" rx="12"/>',
      '            <rect x="110" y="620" width="210" height="150" rx="12"/>',
      '            <rect x="620" y="660" width="290" height="200" rx="12"/>',
      '          </g>',
      '          <g stroke="rgba(150,180,220,.35)" stroke-width="14" fill="none">',
      '            <path d="M60 500H940"/><path d="M300 60V940"/><path d="M700 60V940"/>',
      '          </g>',
      '          <path d="M120 880 L300 700 L300 500 L520 380 L700 380 L820 200"',
      '                stroke="url(#navRoad)" stroke-width="18" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
      '          <path d="M120 880 L300 700 L300 500 L520 380 L700 380 L820 200"',
      '                stroke="#eaf2ff" stroke-width="4" fill="none" stroke-dasharray="16 18" stroke-linecap="round" opacity=".85"/>',
      '          <g>',
      '            <circle cx="120" cy="880" r="16" fill="#22c55e"/>',
      '            <circle cx="120" cy="880" r="30" fill="none" stroke="rgba(34,197,94,.45)" stroke-width="4"/>',
      '          </g>',
      '          <g transform="translate(820 200)">',
      '            <path d="M0 -30 C18 -30 30 -16 30 2 C30 24 0 52 0 52 C0 52 -30 24 -30 2 C-30 -16 -18 -30 0 -30 Z" fill="#ef4444"/>',
      '            <circle cx="0" cy="0" r="11" fill="#fff"/>',
      '          </g>',
      '          <g fill="#6c7f9e" font-size="22" font-family="sans-serif">',
      '            <text x="330" y="140">中环路高架</text>',
      '            <text x="330" y="330">虹桥路</text>',
      '            <text x="330" y="900">沪闵路</text>',
      '          </g>',
      '        </svg>',
      '      </div>',

      /* 顶部状态：引擎、目的地、路况 */
      '      <div style="position:absolute;left:.24rem;right:.24rem;top:.24rem;display:flex;gap:.14rem;align-items:center;flex-wrap:wrap">',
      '        <span class="engine-pill" :class="nav.engine === \'amap\' ? \'is-live\' : \'\'">',
      '          <rw-icon name="route" :size="16"></rw-icon>',
      '          {{ nav.engine === \'amap\' ? \'高德 AMap 2.0\' : \'内置示意地图\' }}',
      '        </span>',
      '        <span class="chip" :class="weatherChip">路况 {{ nav.traffic }}</span>',
      '        <span class="chip">剩余 {{ nav.remainDistance }} km</span>',
      '      </div>',

      /* 底部导航浮层：转向卡 + 车道指引 */
      '      <div class="nav-overlay">',
      '        <div class="nav-lanes">',
      '          <span class="nav-lane" v-for="(l, i) in lanes" :key="i" :class="l === \'straight\' && i === 1 ? \'is-active\' : \'\'">',
      '            <rw-icon :name="laneIcon" :size="22" :style="l === \'left\' ? \'transform:rotate(-90deg)\' : (l === \'right\' ? \'transform:rotate(90deg)\' : \'\')"></rw-icon>',
      '          </span>',
      '          <span class="grow muted" style="font-size:.2rem">车道指引 · {{ nav.lane }}</span>',
      '          <span class="tag tag--ok">电子眼 300m</span>',
      '        </div>',
      '        <div class="nav-banner">',
      '          <span class="nav-banner__arrow"><rw-icon name="route" :size="40"></rw-icon></span>',
      '          <span class="grow">',
      '            <span class="nav-banner__main">{{ nav.nextManeuver.split(\' \')[0] }}</span>',
      '            <span class="nav-banner__sub">{{ nav.nextManeuver }}</span>',
      '          </span>',
      '          <span class="nav-banner__eta"><b>{{ nav.eta }}</b><span>分钟 · {{ nav.remainDistance }} km</span></span>',
      '        </div>',
      '      </div>',
      '    </div>',

      /* ---------- 目的地搜索 ---------- */
      '    <card-panel class="col-6" title="目的地" icon="search">',
      '      <div class="voice-input">',
      '        <input type="text" v-model="query" placeholder="搜索目的地，例如：虹桥火车站" aria-label="搜索目的地">',
      '        <button class="btn btn--primary btn--sm" @click="startNav">开始导航</button>',
      '      </div>',
      '      <ul class="list">',
      '        <li v-for="p in filtered" :key="p.name">',
      '          <button class="list__item list__item--btn" style="width:100%" @click="pick(p)">',
      '            <span class="list__main">',
      '              <span class="list__title">{{ p.name }}</span>',
      '              <span class="list__sub">{{ p.address }}</span>',
      '            </span>',
      '            <span class="list__value">{{ p.distance }}km · {{ p.eta }}min</span>',
      '          </button>',
      '        </li>',
      '      </ul>',
      '    </card-panel>',

      /* ---------- 路线规划 ---------- */
      '    <card-panel class="col-4" title="路线规划" icon="route">',
      '      <div class="stack">',
      '        <button v-for="(r, i) in routes" :key="r.name" class="list__item list__item--btn"',
      '                :class="i === routeIndex ? \'is-active\' : \'\'" style="flex-direction:column;align-items:stretch" @click="pickRoute(i)">',
      '          <span class="route-item">',
      '            <span class="route-item__head">',
      '              <span class="route-item__name">{{ r.name }}</span>',
      '              <span class="list__value">{{ r.eta }} 分钟</span>',
      '            </span>',
      '            <span class="route-item__meta">',
      '              <span>{{ r.distance }} km</span>',
      '              <span :class="r.traffic === \'畅通\' ? \'accent\' : \'muted\'">{{ r.traffic }}</span>',
      '            </span>',
      '            <span class="route-item__road">{{ r.road }}</span>',
      '          </span>',
      '        </button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 充电站（续航焦虑与低电量提醒） ---------- */
      '    <card-panel class="col-2" title="沿途充电" icon="charge" :tone="batteryLow ? \'warn\' : \'\'">',
      '      <div class="stack">',
      '        <div v-for="c in charging" :key="c.name" class="list__item" style="flex-direction:column;align-items:stretch;gap:.06rem">',
      '          <span class="list__title" style="font-size:.21rem">{{ c.name }}</span>',
      '          <span class="route-item__meta">',
      '            <span>{{ c.dist }}</span><span>{{ c.power }}</span>',
      '            <span :class="c.free > 3 ? \'accent\' : \'muted\'">空闲 {{ c.free }}</span>',
      '          </span>',
      '        </div>',
      '      </div>',
      '      <div class="card__hint" v-if="batteryLow">电量偏低，建议沿途补能</div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };

  global.NavView.computed.weatherChip = function () {
    if (this.nav.traffic === '畅通') return 'chip--ok';
    if (this.nav.traffic === '缓行') return 'chip--warn';
    return 'chip--danger';
  };
})(window);
