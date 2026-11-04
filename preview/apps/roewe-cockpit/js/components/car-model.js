/*!
 * js/components/car-model.js — 车辆 3D 模型卡片
 * 优先使用 Three.js CDN 渲染真实 3D 车模；CDN 不可用（离线）或 WebGL 缺失时，
 * 自动降级为高质量 SVG + CSS 3D 立体动效（卡片依然具有立体呈现）。
 */
(function (global) {
  'use strict';

  var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
  var loadState = { tried: false, ok: false, promise: null };

  function loadThree() {
    if (loadState.promise) return loadState.promise;
    loadState.tried = true;
    loadState.promise = new Promise(function (resolve) {
      if (global.THREE) { loadState.ok = true; return resolve(true); }
      var s = document.createElement('script');
      s.src = THREE_URL;
      s.async = true;
      s.onload = function () { loadState.ok = !!global.THREE; resolve(loadState.ok); };
      s.onerror = function () { loadState.ok = false; resolve(false); };
      document.head.appendChild(s);
      global.setTimeout(function () { if (!global.THREE) { loadState.ok = false; resolve(false); } }, 6000);
    });
    return loadState.promise;
  }

  var carModel = {
    props: { height: { type: Number, default: 260 } },
    data: function () {
      return { mode: 'svg', failed: false, S: global.CockpitState, spin: 0 };
    },
    computed: {
      driving: function () { return global.CockpitSafety.isDriving(); },
      carStyle: function () {
        return { transform: 'rotateX(' + (this.driving ? 8 : 14) + 'deg) rotateZ(' + (this.driving ? -18 : -26) + 'deg)' };
      }
    },
    mounted: function () {
      var self = this;
      loadThree().then(function (ok) {
        if (!ok) { self.failed = true; return; }
        try {
          self.initThree();
          self.mode = 'three';
        } catch (e) {
          self.failed = true;
          self.mode = 'svg';
        }
      });
      this._spinTimer = global.setInterval(function () {
        if (self.mode !== 'svg') return;
        self.spin = (self.spin + 0.35) % 360;
      }, 60);
    },
    beforeUnmount: function () {
      if (this._spinTimer) global.clearInterval(this._spinTimer);
      if (this._raf) global.cancelAnimationFrame(this._raf);
      if (this._renderer) { try { this._renderer.dispose(); } catch (e) { /* noop */ } }
    },
    methods: {
      /* ---------- Three.js 真实 3D ---------- */
      initThree: function () {
        var THREE = global.THREE;
        var el = this.$refs.gl;
        if (!el || !THREE) throw new Error('WebGL 容器不可用');

        var w = el.clientWidth || 640, h = this.height;
        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100);
        camera.position.set(4.6, 3.0, 5.4);
        camera.lookAt(0, 0.35, 0);

        var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
        renderer.setSize(w, h, false);
        el.appendChild(renderer.domElement);

        scene.add(new THREE.HemisphereLight(0xdfefff, 0x0a1220, 1.15));
        var key = new THREE.DirectionalLight(0xffffff, 1.5);
        key.position.set(5, 8, 5);
        scene.add(key);
        var rim = new THREE.DirectionalLight(0x38bdf8, 1.1);
        rim.position.set(-6, 3, -5);
        scene.add(rim);

        var group = new THREE.Group();
        var bodyMat = new THREE.MeshStandardMaterial({ color: 0x1b2836, metalness: 0.72, roughness: 0.32 });
        var glassMat = new THREE.MeshStandardMaterial({ color: 0x0a1420, metalness: 0.9, roughness: 0.1, transparent: true, opacity: 0.86 });
        var trimMat = new THREE.MeshStandardMaterial({ color: 0x4ea8ff, metalness: 0.6, roughness: 0.3, emissive: 0x0b3a63 });

        var body = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.82, 1.76), bodyMat);
        body.position.y = 0.72;
        group.add(body);

        var cabin = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.72, 1.56), glassMat);
        cabin.position.set(-0.16, 1.42, 0);
        group.add(cabin);

        var hood = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 1.66), bodyMat);
        hood.position.set(1.2, 1.05, 0);
        group.add(hood);

        // 贯穿式尾灯 / 前大灯
        var tail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 1.5), trimMat);
        tail.position.set(-1.96, 0.86, 0);
        group.add(tail);
        var head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 1.42), trimMat);
        head.position.set(1.96, 0.86, 0);
        group.add(head);

        // 车轮
        var wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.28, 24);
        var wheelMat = new THREE.MeshStandardMaterial({ color: 0x0a0f16, metalness: 0.35, roughness: 0.75 });
        [[1.22, 0.86], [1.22, -0.86], [-1.2, 0.86], [-1.2, -0.86]].forEach(function (p) {
          var wm = new THREE.Mesh(wheelGeo, wheelMat);
          wm.rotation.x = Math.PI / 2;
          wm.position.set(p[0], 0.44, p[1]);
          group.add(wm);
        });

        var ground = new THREE.Mesh(
          new THREE.CircleGeometry(4.6, 48),
          new THREE.MeshBasicMaterial({ color: 0x0d1725, transparent: true, opacity: 0.55 })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = 0.01;
        scene.add(ground);
        scene.add(group);

        this._three = { THREE: THREE, scene: scene, camera: camera, renderer: renderer, group: group };
        this._glEl = el;
        this._sizeW = w;

        var self = this;
        var t = 0;
        (function loop() {
          self._raf = global.requestAnimationFrame(loop);
          t += 0.006;
          // 自转 + 行车时轻微俯仰，强化立体呈现
          group.rotation.y = t;
          group.rotation.z = self.driving ? Math.sin(t * 6) * 0.012 : 0;
          renderer.render(scene, camera);
        })();
      },

      onEnter: function () { if (this.mode === 'three') this.$refs.wrap.classList.add('is-hover'); },
      onLeave: function () { if (this.mode === 'three') this.$refs.wrap.classList.remove('is-hover'); }
    },
    template:
      '<div class="car-model" ref="wrap" :style="{ height: height + \'px\' }" @mouseenter="onEnter" @mouseleave="onLeave">' +
        '<div v-if="mode === \'three\'" class="car-gl" ref="gl" :style="{ height: height + \'px\' }"></div>' +

        '<div v-else class="car-svg-scene" :style="{ height: height + \'px\' }">' +
          '<svg class="car-svg" viewBox="0 0 420 260" :style="carStyle" aria-label="车辆立体模型">' +
            '<defs>' +
              '<linearGradient id="cmBody" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#4b6b8c"/><stop offset="45%" stop-color="#22374d"/><stop offset="100%" stop-color="#0e1a27"/>' +
              '</linearGradient>' +
              '<linearGradient id="cmGlass" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0%" stop-color="#8fd8ff" stop-opacity="0.85"/><stop offset="100%" stop-color="#0b2233" stop-opacity="0.95"/>' +
              '</linearGradient>' +
              '<linearGradient id="cmLight" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#bff0ff"/><stop offset="100%" stop-color="#1e8fff"/>' +
              '</linearGradient>' +
              '<radialGradient id="cmShadow"><stop offset="0%" stop-color="#000" stop-opacity="0.55"/><stop offset="100%" stop-color="#000" stop-opacity="0"/></radialGradient>' +
            '</defs>' +
            '<ellipse cx="210" cy="228" rx="170" ry="26" fill="url(#cmShadow)"/>' +
            '<g class="cm-body-group">' +
              '<path d="M52 176 L70 120 Q78 96 104 92 L300 84 Q332 84 344 108 L366 150 L368 178 Q368 190 354 190 L66 190 Q52 190 52 176 Z" fill="url(#cmBody)" stroke="#5f88ad" stroke-width="1.4"/>' +
              '<path d="M112 118 Q126 74 176 70 L268 68 Q310 70 320 108 L326 124 Z" fill="url(#cmGlass)" stroke="#7fc6ff" stroke-width="1.2" stroke-opacity="0.7"/>' +
              '<path d="M182 72 L180 120 M262 70 L264 122" stroke="#0a1622" stroke-width="3" stroke-opacity="0.8"/>' +
              '<path d="M350 122 L366 150 L368 176 L338 176 L334 124 Z" fill="#16283a" stroke="#4ea8ff" stroke-opacity="0.45"/>' +
              '<rect x="336" y="146" width="34" height="11" rx="5" fill="url(#cmLight)"/>' +
              '<rect x="52" y="146" width="30" height="10" rx="5" fill="#ff5a5f" opacity="0.9"/>' +
              '<circle cx="112" cy="190" r="30" fill="#0a0f16" stroke="#2b3d52" stroke-width="2"/>' +
              '<circle cx="112" cy="190" r="14" fill="#16222f" stroke="#4ea8ff" stroke-opacity="0.5"/>' +
              '<circle cx="312" cy="190" r="30" fill="#0a0f16" stroke="#2b3d52" stroke-width="2"/>' +
              '<circle cx="312" cy="190" r="14" fill="#16222f" stroke="#4ea8ff" stroke-opacity="0.5"/>' +
              '<path d="M104 138 L120 138 L118 160 L106 160 Z" fill="#38bdf8" opacity="0.35"/>' +
              '<path d="M300 138 L316 138 L314 160 L302 160 Z" fill="#38bdf8" opacity="0.35"/>' +
              '<path d="M70 120 L104 92" stroke="#9dc4e6" stroke-width="1" stroke-opacity="0.5"/>' +
              '<path d="M366 150 L344 108" stroke="#9dc4e6" stroke-width="1" stroke-opacity="0.4"/>' +
            '</g>' +
          '</svg>' +
          '<div class="car-svg-glow" :class="{ pulsing: driving }"></div>' +
          '<span class="car-mode-badge">SVG 立体模式</span>' +
        '</div>' +

        '<span v-if="mode === \'three\'" class="car-mode-badge three">Three.js 3D 模式</span>' +
      '</div>'
  };

  global.CCarModel = carModel;
})(window);
