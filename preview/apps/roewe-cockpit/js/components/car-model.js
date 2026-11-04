/*!
 * 车辆 3D 卡片：优先 Three.js CDN 简易 3D 车模，
 * 加载失败 / 不可用时降级为高质量 SVG + CSS 3D 动效（卡片始终有立体呈现）。
 * 两种实现都会被「驾驶状态模拟器」驱动：车速越快，模型旋转越快。
 */
(function (global) {
  'use strict';

  var THREE_CDN = [
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js',
    'https://unpkg.com/three@0.160.0/build/three.min.js'
  ];

  function buildCar(THREE, renderer) {
    var group = new THREE.Group();
    var bodyMat = new THREE.MeshStandardMaterial({ color: 0x1f6feb, metalness: 0.85, roughness: 0.28 });
    var glassMat = new THREE.MeshStandardMaterial({ color: 0x0a1626, metalness: 0.9, roughness: 0.1, transparent: true, opacity: 0.85 });
    var trimMat = new THREE.MeshStandardMaterial({ color: 0x11161f, metalness: 0.5, roughness: 0.6 });

    /* 车身 */
    var body = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.52, 4.5), bodyMat);
    body.position.y = 0.62;
    group.add(body);

    /* 车顶 */
    var roof = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.5, 2.3), glassMat);
    roof.position.set(0, 1.0, -0.15);
    group.add(roof);

    /* 前后灯 */
    var headMat = new THREE.MeshStandardMaterial({ color: 0xdff1ff, emissive: 0x6fb7ff, emissiveIntensity: 1.2 });
    var tailMat = new THREE.MeshStandardMaterial({ color: 0xff5a5a, emissive: 0xff2d2d, emissiveIntensity: 0.9 });
    [-0.62, 0.62].forEach(function (x) {
      var h = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.1), headMat);
      h.position.set(x, 0.68, 2.24);
      group.add(h);
      var t = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.13, 0.1), tailMat);
      t.position.set(x, 0.72, -2.24);
      group.add(t);
    });

    /* 车轮 */
    var wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.26, 24);
    [-1.02, 1.02].forEach(function (x) {
      [-1.45, 1.5].forEach(function (z) {
        var w = new THREE.Mesh(wheelGeo, trimMat);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, 0.36, z);
        group.add(w);
      });
    });

    /* 底盘阴影 */
    var shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.6, 5.2),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    group.add(shadow);

    /* 地面反光圆盘 */
    var ring = new THREE.Mesh(
      new THREE.RingGeometry(2.6, 3.2, 48),
      new THREE.MeshBasicMaterial({ color: 0x2b6cff, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);

    return group;
  }

  /* ---------------- Vue 组件 ---------------- */
  var CarModel3D = {
    name: 'CarModel3D',
    props: {
      speed: { type: Number, default: 0 },
      gear: { type: String, default: 'P' },
      battery: { type: Number, default: 72 }
    },
    data: function () {
      return { engine: 'css', ready: false };
    },
    computed: {
      spinDuration: function () {
        /* CSS 降级模式：车速越高旋转越快，P 挡缓慢展示 */
        var s = Math.max(this.speed, 0);
        var sec = s > 0 ? Math.max(2.2, 16 - s * 0.12) : 26;
        return sec + 's';
      },
      tilt: function () {
        return this.gear === 'D' ? '-8deg' : '-14deg';
      }
    },
    mounted: function () {
      this.boot();
    },
    beforeUnmount: function () {
      this.dispose();
    },
    methods: {
      boot: function () {
        var self = this;
        var urls = THREE_CDN.slice();
        (function tryNext() {
          if (!urls.length || !self.$el || !self.$el.isConnected) {
            self.engine = 'css';
            return;
          }
          var url = urls.shift();
          global.RoeweMap.loadScript(url, 6000)
            .then(function () { self.initThree(); })
            .catch(function () { tryNext(); });
        })();
      },
      initThree: function () {
        var THREE = global.THREE;
        if (!THREE) { this.engine = 'css'; return; }
        try {
          var host = this.$refs.stage;
          if (!host) { this.engine = 'css'; return; }
          var width = host.clientWidth || 640;
          var height = host.clientHeight || 360;

          this.scene = new THREE.Scene();
          this.camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
          this.camera.position.set(4.6, 3.2, 6.4);
          this.camera.lookAt(0, 0.7, 0);

          this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
          this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
          this.renderer.setSize(width, height);
          host.appendChild(this.renderer.domElement);

          this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
          var key = new THREE.DirectionalLight(0xffffff, 1.5);
          key.position.set(5, 8, 5);
          this.scene.add(key);
          var rim = new THREE.PointLight(0x2b6cff, 1.6, 30);
          rim.position.set(-5, 4, -6);
          this.scene.add(rim);

          this.car = buildCar(THREE, this.renderer);
          this.scene.add(this.car);

          this.engine = 'three';
          this.ready = true;
          this.clock = new THREE.Clock();
          var self = this;
          (function loop() {
            if (!self.renderer || self.disposed) return;
            self.raf = requestAnimationFrame(loop);
            var dt = self.clock.getDelta();
            if (self.car) {
              var spd = Math.max(self.speed, self.gear === 'D' ? 6 : 2);
              self.car.rotation.y += dt * (0.12 + spd * 0.012);
            }
            self.renderer.render(self.scene, self.camera);
          })();
          if (global.ResizeObserver) {
            this.ro = new ResizeObserver(function () { self.resize(); });
            this.ro.observe(host);
          }
        } catch (e) {
          this.engine = 'css';
        }
      },
      resize: function () {
        if (this.engine !== 'three' || !this.renderer) return;
        var host = this.$refs.stage;
        var width = host.clientWidth || 640;
        var height = host.clientHeight || 360;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
      },
      dispose: function () {
        this.disposed = true;
        if (this.raf) cancelAnimationFrame(this.raf);
        if (this.ro) this.ro.disconnect();
        if (this.renderer) {
          try { this.renderer.dispose(); } catch (e) {}
          if (this.renderer.domElement && this.renderer.domElement.parentNode) {
            this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
          }
        }
      }
    },
    template: [
      '<div class="car-model" :data-engine="engine">',
      '  <div ref="stage" class="car-model__stage" v-show="engine === \'three\'"></div>',
      '  <div v-if="engine !== \'three\'" class="car-model__css">',
      '    <div class="car-css3d" :style="{ animationDuration: spinDuration }">',
      '      <div class="car-css3d__ring"></div>',
      '      <svg class="car-css3d__body" :style="{ transform: \'rotateX(64deg) rotateZ(-24deg)\' }" viewBox="0 0 420 620" aria-hidden="true">',
      '        <defs>',
      '          <linearGradient id="bodyGrad" x1="0" y1="0" x2="1" y2="1">',
      '            <stop offset="0%" stop-color="#4d9bff"/><stop offset="55%" stop-color="#1f6feb"/><stop offset="100%" stop-color="#0b3f8f"/>',
      '          </linearGradient>',
      '          <linearGradient id="glassGrad" x1="0" y1="0" x2="0" y2="1">',
      '            <stop offset="0%" stop-color="#9ed4ff" stop-opacity="0.95"/><stop offset="100%" stop-color="#0a1a2c" stop-opacity="0.95"/>',
      '          </linearGradient>',
      '        </defs>',
      '        <ellipse cx="210" cy="310" rx="190" ry="270" fill="#0b1220" opacity="0.55"/>',
      '        <path d="M60 300 q10 -150 60 -170 l180 0 q50 20 60 170 q4 130 -20 170 l-260 0 q-24 -40 -20 -170z" fill="url(#bodyGrad)" stroke="#7fb9ff" stroke-width="3"/>',
      '        <path d="M105 250 q18 -110 105 -118 q87 8 105 118 z" fill="url(#glassGrad)" stroke="#bfe0ff" stroke-width="2"/>',
      '        <path d="M120 320 h180 M120 420 h180" stroke="#dff1ff" stroke-width="2" opacity="0.35"/>',
      '        <rect x="88" y="196" width="46" height="16" rx="8" fill="#e9f6ff"/>',
      '        <rect x="286" y="196" width="46" height="16" rx="8" fill="#e9f6ff"/>',
      '        <rect x="88" y="470" width="52" height="15" rx="7" fill="#ff5a5a"/>',
      '        <rect x="280" y="470" width="52" height="15" rx="7" fill="#ff5a5a"/>',
      '      </svg>',
      '    </div>',
      '    <div class="car-model__ground"></div>',
      '  </div>',
      '  <div class="car-model__badge">',
      '    <span class="dot"></span>{{ engine === \'three\' ? \'3D 实时模型\' : \'SVG 立体模型\' }}',
      '  </div>',
      '</div>'
    ].join('\n')
  };

  global.CarModel3D = CarModel3D;
})(window);
