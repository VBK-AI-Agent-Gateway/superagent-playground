/*!
 * js/views/surround.js — 模块 7a：360° 全景影像
 * 通过 Canvas 绘制等距柱状投影的伪全景视图，支持拖动环视与四路视角切换。
 * 安全规则 2：本页为全屏驾驶辅助视图，顶栏车速/挡位/警告保持可见。
 * 安全规则 1：D 挡进入本页会被挡位状态机拦截。
 */
(function (global) {
  'use strict';

  var CAMERAS = [
    { key: 'front', label: '前视', yaw: 0 },
    { key: 'right', label: '右视', yaw: 90 },
    { key: 'rear', label: '后视', yaw: 180 },
    { key: 'left', label: '左视', yaw: 270 }
  ];

  var surround = {
    data: function () {
      return { S: global.CockpitState, yaw: 0, pitch: 0, dragging: false, autoSpin: true, cam: 'front' };
    },
    computed: {
      p: function () { return this.S.data.parking; },
      heading: function () { return ((Math.round(this.yaw) % 360) + 360) % 360; },
      compass: function () {
        var dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
        return dirs[Math.round(this.heading / 45) % 8];
      },
      cams: function () { return CAMERAS; },
      nearest: function () {
        var all = (this.p.radar.front || []).concat(this.p.radar.rear || []);
        return all.length ? Math.min.apply(null, all) : 999;
      },
      nearestText: function () { return this.nearest >= 999 ? '无遮挡' : this.nearest + ' cm'; }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'surround.open', scope: 'surround', label: '打开 360 全景',
          phrases: ['打开360全景', '打开全景', '看全景影像', '三百六十度'],
          handler: function () { global.CockpitRouter.go('surround'); return '已打开 360 全景影像。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'surround.front', scope: 'surround', label: '前视影像',
          phrases: ['前视影像', '看前面', '前方画面'],
          handler: function () { self.look('front'); return '已切换到前视影像。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'surround.rear', scope: 'surround', label: '后视影像',
          phrases: ['后视影像', '看后面', '后方画面'],
          handler: function () { self.look('rear'); return '已切换到后视影像。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'surround.left', scope: 'surround', label: '左视影像',
          phrases: ['左视影像', '看左边'],
          handler: function () { self.look('left'); return '已切换到左视影像。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'surround.right', scope: 'surround', label: '右视影像',
          phrases: ['右视影像', '看右边'],
          handler: function () { self.look('right'); return '已切换到右视影像。'; }
        })
      ];
      this._raf = global.setInterval(function () {
        if (!self.autoSpin || self.dragging) return;
        self.yaw = (self.yaw + 0.35) % 360;
        self.paint();
      }, 40);
      this.$nextTick(this.paint);
    },
    beforeUnmount: function () {
      (this._uns || []).forEach(function (fn) { fn(); });
      if (this._raf) global.clearInterval(this._raf);
    },
    methods: {
      look: function (key) {
        var c = CAMERAS.filter(function (x) { return x.key === key; })[0];
        if (!c) return;
        this.cam = key;
        this.yaw = c.yaw;
        this.autoSpin = false;
        this.paint();
      },
      onDown: function (e) { this.dragging = true; this._x = this._pt(e).x; this._y = this._pt(e).y; },
      onMove: function (e) {
        if (!this.dragging) return;
        var pt = this._pt(e);
        this.yaw = (this.yaw + (this._x - pt.x) * 0.35 + 360) % 360;
        this.pitch = Math.max(-20, Math.min(20, this.pitch + (this._y - pt.y) * 0.12));
        this._x = pt.x; this._y = pt.y;
        this.paint();
      },
      onUp: function () { this.dragging = false; },
      _pt: function (e) {
        var t = e.touches && e.touches[0] ? e.touches[0] : e;
        return { x: t.clientX || 0, y: t.clientY || 0 };
      },
      paint: function () {
        var cv = this.$refs.cv;
        if (!cv) return;
        var ctx = cv.getContext('2d');
        if (!ctx) return;
        var W = cv.width, H = cv.height;
        var horizon = H * (0.52 + this.pitch / 200);
        var yaw = this.yaw * Math.PI / 180;

        var sky = ctx.createLinearGradient(0, 0, 0, horizon);
        sky.addColorStop(0, '#0d1b2a');
        sky.addColorStop(1, '#274b6d');
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, W, horizon);

        var ground = ctx.createLinearGradient(0, horizon, 0, H);
        ground.addColorStop(0, '#1b2a35');
        ground.addColorStop(1, '#0a1119');
        ctx.fillStyle = ground;
        ctx.fillRect(0, horizon, W, H - horizon);

        /* 远景建筑群：按 yaw 相位循环 */
        var cols = 26;
        for (var i = 0; i < cols; i++) {
          var ang = (i / cols) * Math.PI * 2 + yaw;
          var sx = ((Math.sin(ang) * 0.5 + 0.5) * W);
          var depth = (Math.cos(ang) * 0.5 + 0.5);
          var bh = 40 + depth * (H * 0.34);
          var bw = W / cols * 1.35;
          var shade = Math.round(24 + depth * 58);
          ctx.fillStyle = 'rgb(' + shade + ',' + (shade + 16) + ',' + (shade + 34) + ')';
          ctx.fillRect(sx - bw / 2, horizon - bh, bw, bh);
          /* 窗户 */
          ctx.fillStyle = 'rgba(255,214,140,' + (0.06 + depth * 0.22).toFixed(2) + ')';
          for (var wy = horizon - bh + 8; wy < horizon - 6; wy += 14) {
            ctx.fillRect(sx - bw / 2 + 5, wy, bw - 10, 3);
          }
        }

        /* 路面 */
        ctx.fillStyle = '#16222c';
        ctx.beginPath();
        ctx.moveTo(0, H);
        ctx.lineTo(W * 0.34, horizon);
        ctx.lineTo(W * 0.66, horizon);
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fill();

        var lane = ((yaw / (Math.PI * 2)) % 1 + 1) % 1;
        ctx.strokeStyle = 'rgba(230,240,255,0.55)';
        ctx.lineWidth = 4;
        for (var k = 0; k < 6; k++) {
          var t0 = ((k / 6) + lane * 2) % 1;
          var t1 = Math.min(1, t0 + 0.09);
          var y0 = horizon + (H - horizon) * t0 * t0;
          var y1 = horizon + (H - horizon) * t1 * t1;
          var xw0 = W * (0.5 - (1 - t0) * 0.0);
          var spread0 = (y0 - horizon) / (H - horizon) * W * 0.16;
          var spread1 = (y1 - horizon) / (H - horizon) * W * 0.16;
          ctx.beginPath();
          ctx.moveTo(xw0 - spread0, y0);
          ctx.lineTo(xw0 - spread1, y1);
          ctx.stroke();
        }

        /* 本车示意 */
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.beginPath();
        ctx.ellipse(W / 2, H * 0.86, W * 0.17, H * 0.045, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e8f1ff';
        ctx.beginPath();
        ctx.moveTo(W / 2, H * 0.70);
        ctx.lineTo(W / 2 + W * 0.075, H * 0.90);
        ctx.lineTo(W / 2 - W * 0.075, H * 0.90);
        ctx.closePath();
        ctx.fill();

        /* 四角盲区标示 */
        ctx.strokeStyle = 'rgba(46,230,168,0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 8]);
        ctx.strokeRect(W * 0.06, H * 0.10, W * 0.88, H * 0.80);
        ctx.setLineDash([]);
      }
    },
    template:
      '<div class="view view-surround">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">360° 全景影像</h2>' +
          '<span class="ph-status"><c-icon name="nav" :size="16"></c-icon>{{ compass }} {{ heading }}°</span>' +
        '</header>' +

        '<section class="card pano-card">' +
          '<canvas ref="cv" class="pano-canvas" width="720" height="520" ' +
            '@mousedown="onDown" @mousemove="onMove" @mouseup="onUp" @mouseleave="onUp" ' +
            '@touchstart.prevent="onDown" @touchmove.prevent="onMove" @touchend.prevent="onUp"></canvas>' +
          '<div class="pano-hud"><span class="hud-dot"></span>拖动画面环视车辆四周</div>' +
          '<button class="pano-spin" :class="{ on: autoSpin }" @click="autoSpin = !autoSpin">' +
            '<c-icon name="wave" :size="16"></c-icon>{{ autoSpin ? \'自动环视中\' : \'自动环视\' }}' +
          '</button>' +
        '</section>' +

        '<section class="card">' +
          '<h3 class="card-title">视角切换</h3>' +
          '<div class="cam-grid">' +
            '<button v-for="c in cams" :key="c.key" class="cam" :class="{ on: cam === c.key }" @click="look(c.key)">' +
              '<c-icon name="camera" :size="24"></c-icon><span>{{ c.label }}</span>' +
            '</button>' +
          '</div>' +
        '</section>' +

        '<section class="card">' +
          '<div class="head-row"><h3 class="card-title">周边距离</h3>' +
            '<span class="mini-tag" :class="nearest < 60 ? \'bad\' : (nearest < 100 ? \'warn\' : \'ok\')">最近 {{ nearestText }}</span></div>' +
          '<div class="range-grid">' +
            '<div class="rg rg-front"><small>前方最近</small><b>{{ Math.min.apply(null, p.radar.front) }} cm</b></div>' +
            '<div class="rg rg-rear"><small>后方最近</small><b>{{ Math.min.apply(null, p.radar.rear) }} cm</b></div>' +
            '<div class="rg rg-left"><small>左侧</small><b>{{ p.side.left }} cm</b></div>' +
            '<div class="rg rg-right"><small>右侧</small><b>{{ p.side.right }} cm</b></div>' +
          '</div>' +
          '<p class="hint">全景影像为模拟渲染，仅用于功能演示。</p>' +
        '</section>' +
      '</div>'
  };

  global.CSurroundView = surround;
})(window);
