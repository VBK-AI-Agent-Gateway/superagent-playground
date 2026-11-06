/*!
 * js/views/nav.js — 模块 2：导航
 * 高德地图 JS API 2.0（key 见 config.js）；无 key 时优雅降级为内置示意地图。
 * 路径规划、车道级引导、实时路况、充电/加油搜索的交互逻辑在降级模式下同样完整可演示。
 */
(function (global) {
  'use strict';

  var nav = {
    data: function () { return { S: global.CockpitState, query: '', amapError: '' }; },
    computed: {
      n: function () { return this.S.data.nav; },
      rt: function () { return this.S.navRuntime; },
      mapStatusText: function () {
        if (this.rt.mapMode === 'amap') return '高德地图 JS API 2.0 · 在线';
        return '内置示意地图（未配置高德 Key）';
      },
      routes: function () { return this.n.routes; },
      currentRoute: function () {
        var id = this.rt.routeId, list = this.routes;
        for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
        return list[0];
      },
      pois: function () {
        var type = this.rt.poiType;
        return this.n.pois.filter(function (p) { return p.type === type; });
      },
      driving: function () { return global.CockpitSafety.isDriving(); },
      trafficList: function () { return this.n.trafficEvents; }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'nav.searchCharge', scope: 'nav', label: '搜索充电站',
          phrases: ['搜索充电站', '找充电桩', '附近的充电站'],
          handler: function () { self.setPoiType('charge'); return '已为您列出附近的充电站。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'nav.searchFuel', scope: 'nav', label: '搜索加油站',
          phrases: ['搜索加油站', '找加油站', '附近的加油站'],
          handler: function () { self.setPoiType('fuel'); return '已为您列出附近的加油站。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'nav.start', scope: 'nav', label: '开始导航',
          phrases: ['开始导航', '出发', '继续导航'],
          handler: function () { self.start(); return '导航已开始，请沿当前道路行驶。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'nav.avoidJam', scope: 'nav', label: '躲避拥堵',
          phrases: ['躲避拥堵', '换一条路', '重新规划路线'],
          handler: function () { self.pickRoute('r2'); return '已切换为躲避拥堵路线。'; }
        })
      ];
      this.registerMapNodes();
    },
    beforeUnmount: function () {
      (this._uns || []).forEach(function (fn) { fn(); });
      global.CockpitMap.destroy();
    },
    methods: {
      /** 可见即可说：为导航页每个可点击控件注册语音指令 */
      registerMapNodes: function () {
        var self = this;
        this.controls().forEach(function (c) {
          self._uns.push(global.CockpitVoiceRegistry.register({
            id: 'nav.ctl.' + c.id, scope: 'nav', label: c.label,
            phrases: c.phrases, handler: c.run
          }));
        });
      },
      controls: function () {
        var self = this;
        return [
          { id: 'zoomIn', label: '放大地图', phrases: ['放大地图', '放大'], run: function () { self.zoom(1); return '地图已放大。'; } },
          { id: 'zoomOut', label: '缩小地图', phrases: ['缩小地图', '缩小'], run: function () { self.zoom(-1); return '地图已缩小。'; } },
          { id: 'recenter', label: '回到定位', phrases: ['回到定位', '回到车辆位置', '重新定位'], run: function () { self.recenter(); return '已回到车辆当前位置。'; } },
          { id: 'mute', label: '静音播报', phrases: ['静音播报', '关闭导航语音', '打开导航语音'], run: function () { self.toggleMute(); return self.rt.mute ? '导航播报已静音。' : '导航播报已打开。'; } },
          { id: 'lane', label: '车道引导', phrases: ['放大车道指引', '显示车道'], run: function () { self.pulseLane(); return '车道级引导已高亮显示。'; } }
        ];
      },
      /** 尝试挂载真实地图；无 key 或网络失败时保持降级渲染 */
      mountMap: function () {
        var self = this;
        var el = this.$refs.mapCanvas;
        if (!el) return;
        global.CockpitMap.load().then(function (res) {
          var live = (res === 'ready' || res === 'amap');
          self.rt.mapMode = live ? 'amap' : 'fallback';
          self.rt.mapReady = true;
          if (live) {
            global.CockpitMap.mount(el).then(function (ok) {
              if (!ok) { self.rt.mapMode = 'fallback'; self.amapError = '地图初始化失败，已降级'; }
            });
          }
        });
      },
      zoom: function (dir) {
        this._zoom = (this._zoom || 14) + dir;
        this.rt.zoom = this._zoom;
        global.CockpitMap.setZoom(this._zoom);
        global.CockpitSafety.notify({ text: '缩放 ' + this._zoom + ' 级', icon: 'nav' });
      },
      recenter: function () { global.CockpitMap.recenter(); },
      toggleMute: function () { this.rt.mute = !this.rt.mute; },
      pulseLane: function () { this._lanePulse = Date.now(); },
      setPoiType: function (t) { this.rt.poiType = t; this.rt.searching = true; this.rt.keyword = t === 'charge' ? '充电站' : '加油站'; },
      pickRoute: function (id) {
        this.rt.routeId = id;
        global.CockpitSafety.notify({ text: '已切换路线：' + (this.routes.find(function (r) { return r.id === id; }) || {}).name, icon: 'route' });
      },
      start: function () { this.rt.navigating = true; global.CockpitSafety.notify({ text: '导航已开始', icon: 'nav', level: 'ok' }); },
      stop: function () { this.rt.navigating = false; global.CockpitSafety.notify({ text: '导航已结束', icon: 'nav' }); },
      search: function () {
        var q = (this.query || '').trim();
        if (!q) { global.CockpitSafety.notify({ text: '请输入目的地', icon: 'warn', level: 'warn' }); return; }
        this.rt.keyword = q;
        this.rt.searching = true;
        global.CockpitSafety.notify({ text: '正在搜索：' + q, icon: 'search' });
      },
      pickPoi: function (p) {
        this.S.data.nav.destination.name = p.name;
        this.S.data.nav.destination.address = p.address;
        this.S.data.nav.destination.distance = p.distance;
        this.S.data.nav.destination.eta = p.eta;
        global.CockpitSafety.notify({ text: '已设目的地：' + p.name, icon: 'poi', level: 'ok' });
      }
    },
    template:
      '<div class="view view-nav">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">导航</h2>' +
          '<span class="ph-status" :class="{ live: rt.mapMode === \'amap\' }"><c-icon name="route" :size="16"></c-icon>{{ mapStatusText }}</span>' +
        '</header>' +

        '<div class="nav-search card">' +
          '<c-icon name="search" :size="20"></c-icon>' +
          '<input v-model="query" class="ns-input" type="text" placeholder="搜索目的地、充电站或加油站" @keyup.enter="search">' +
          '<button class="ns-btn" @click="search">搜索</button>' +
        '</div>' +

        /* ---------- 地图区（高德 或 内置示意） ---------- */
        '<div class="map-wrap card" ref="mapRoot">' +
          '<div class="map-canvas" ref="mapCanvas" v-show="rt.mapMode === \'amap\'"></div>' +

          '<div v-if="rt.mapMode !== \'amap\'" class="map-fallback" aria-label="内置示意地图">' +
            '<svg class="mf-svg" viewBox="0 0 600 420" preserveAspectRatio="xMidYMid slice">' +
              '<defs>' +
                '<linearGradient id="mfBg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0d1a28"/><stop offset="100%" stop-color="#101f2f"/></linearGradient>' +
              '</defs>' +
              '<rect width="600" height="420" fill="url(#mfBg)"/>' +
              '<g stroke="#1d3348" stroke-width="10" fill="none">' +
                '<path d="M-20 130 H620"/><path d="M-20 300 H620"/><path d="M150 -20 V440"/><path d="M430 -20 V440"/>' +
              '</g>' +
              '<g stroke="#24425c" stroke-width="4" fill="none">' +
                '<path d="M-20 210 H620"/><path d="M290 -20 V440"/><path d="M60 60 H560"/>' +
              '</g>' +
              /* 路线（按所选方案高亮） */
              '<path d="M120 380 C170 300 150 250 230 210 S300 120 470 70" fill="none" stroke="#2b6ea8" stroke-width="14" stroke-linecap="round" opacity="0.35"/>' +
              '<path d="M120 380 C170 300 150 250 230 210 S300 120 470 70" fill="none" stroke="#3fa9ff" stroke-width="7" stroke-linecap="round" stroke-dasharray="26 14" class="mf-route"/>' +
              /* 路况色带 */
              '<g stroke-width="8" stroke-linecap="round" fill="none">' +
                '<path d="M-20 130 H180" stroke="#2ecc71"/><path d="M180 130 H330" stroke="#f1c40f"/><path d="M330 130 H620" stroke="#e74c3c"/>' +
                '<path d="M-20 300 H220" stroke="#2ecc71"/><path d="M220 300 H620" stroke="#f1c40f" opacity="0.8"/>' +
              '</g>' +
              '<circle cx="120" cy="380" r="12" fill="#38bdf8"/><circle cx="120" cy="380" r="22" fill="#38bdf8" opacity="0.22"/>' +
              '<circle cx="470" cy="70" r="13" fill="#ff6b6b"/><circle cx="470" cy="70" r="24" fill="#ff6b6b" opacity="0.2"/>' +
            '</svg>' +
            '<span class="mf-hint">示意地图 · 配置 config.js 中的高德 Key 后自动切换为真实地图</span>' +
            '<div class="mf-zoom">' +
              '<button aria-label="放大地图" @click="zoom(1)"><c-icon name="plus" :size="18"></c-icon></button>' +
              '<button aria-label="缩小地图" @click="zoom(-1)"><c-icon name="minus" :size="18"></c-icon></button>' +
              '<button aria-label="回到定位" @click="recenter"><c-icon name="poi" :size="18"></c-icon></button>' +
            '</div>' +
          '</div>' +

          /* 车道级引导条 */
          '<div class="lane-bar" :class="{ pulse: _lanePulse }">' +
            '<c-icon name="route" :size="22"></c-icon>' +
            '<div class="lb-text">' +
              '<b>{{ n.lane.maneuver }}</b>' +
              '<small>下一步：{{ n.lane.nextManeuver }}</small>' +
            '</div>' +
            '<div class="lb-lanes">' +
              '<span v-for="(r, i) in n.lane.recommend" :key="i" class="lane-cell" :class="{ rec: r === 1 }">' +
                '<svg viewBox="0 0 20 34"><path d="M10 32 V8 M10 8 L4 15 M10 8 L16 15" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
              '</span>' +
            '</div>' +
            '<span class="lb-remain">{{ currentRoute.distance }} km · {{ currentRoute.duration }} min</span>' +
          '</div>' +
        '</div>' +

        /* ---------- 路线方案 ---------- */
        '<section class="card route-card">' +
          '<h3 class="card-title">路线方案</h3>' +
          '<div class="route-list">' +
            '<button v-for="r in routes" :key="r.id" class="route-item" :class="{ on: rt.routeId === r.id }" @click="pickRoute(r.id)">' +
              '<div class="ri-main"><b>{{ r.name }}</b><small>{{ r.via }}</small></div>' +
              '<div class="ri-stat"><b>{{ r.duration }}</b><i>min</i></div>' +
              '<div class="ri-stat"><b>{{ r.distance }}</b><i>km</i></div>' +
              '<span class="ri-tag" :class="\'t-\' + r.traffic">{{ r.traffic === \'clear\' ? \'畅通\' : (r.traffic === \'light\' ? \'缓行\' : \'拥堵\') }}</span>' +
              '<span v-if="r.toll" class="ri-toll">过路费 {{ r.toll }} 元</span>' +
            '</button>' +
          '</div>' +
        '</section>' +

        /* ---------- 沿途搜索 ---------- */
        '<section class="card poi-card">' +
          '<div class="poi-head">' +
            '<h3 class="card-title">沿途服务</h3>' +
            '<div class="poi-tabs">' +
              '<button :class="{ on: rt.poiType === \'charge\' }" @click="setPoiType(\'charge\')"><c-icon name="charge" :size="16"></c-icon>充电站</button>' +
              '<button :class="{ on: rt.poiType === \'fuel\' }" @click="setPoiType(\'fuel\')"><c-icon name="fuel" :size="16"></c-icon>加油站</button>' +
            '</div>' +
          '</div>' +
          '<ul class="poi-list">' +
            '<li v-for="p in pois" :key="p.id" class="poi-item">' +
              '<span class="pi-ico"><c-icon :name="p.type === \'charge\' ? \'charge\' : \'fuel\'" :size="20"></c-icon></span>' +
              '<div class="pi-main"><b>{{ p.name }}</b><small>{{ p.address }} · {{ p.distance }} km</small></div>' +
              '<span class="pi-meta">{{ p.detail }}</span>' +
              '<button class="pi-go" @click="pickPoi(p)">设为途经</button>' +
            '</li>' +
          '</ul>' +
        '</section>' +

        /* ---------- 实时路况 ---------- */
        '<section class="card traffic-card">' +
          '<h3 class="card-title">实时路况</h3>' +
          '<ul class="traffic-list">' +
            '<li v-for="(t, i) in trafficList" :key="i" :class="\'lvl-\' + t.level">' +
              '<span class="tl-dot"></span><span class="tl-text">{{ t.text }}</span><small>{{ Math.round(t.at * 100) }}%</small>' +
            '</li>' +
          '</ul>' +
        '</section>' +

        '<div class="nav-actions">' +
          '<button v-if="!rt.navigating" class="btn btn-accent" @click="start">开始导航</button>' +
          '<button v-else class="btn btn-danger" @click="stop">结束导航</button>' +
          '<button class="btn" :class="{ on: rt.mute }" @click="toggleMute"><c-icon :name="rt.mute ? \'mute\' : \'volume\'" :size="18"></c-icon>{{ rt.mute ? \'播报已关\' : \'语音播报\' }}</button>' +
        '</div>' +
      '</div>'
  };

  /* mounted 需要访问 DOM，包一层以保持对象字面量整洁 */
  var origMounted = nav.mounted;
  nav.mounted = function () {
    origMounted.call(this);
    this.$nextTick(this.mountMap);
  };

  global.CNavView = nav;
})(window);
