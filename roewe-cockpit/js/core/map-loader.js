/*!
 * js/core/map-loader.js — 高德地图 JS API 2.0 加载与降级
 * 有 key：加载高德 JS API 2.0 + 插件，渲染真实地图与路线；
 * 无 key / 加载失败 / 离线：自动降级为内置示意地图（UI 与交互逻辑保持一致）。
 */
(function (global) {
  'use strict';

  var cfg = global.COCKPIT_CONFIG || {};
  var S = global.CockpitState;

  var state = {
    status: 'idle',      // idle | loading | ready | fallback
    reason: '',
    map: null,           // AMap.Map 实例
    driving: null        // AMap.Driving 实例
  };

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = global.setTimeout(function () {
        if (!done) { done = true; reject(new Error(label + ' 超时')); }
      }, ms);
      promise.then(function (v) { if (!done) { done = true; global.clearTimeout(t); resolve(v); } },
                   function (e) { if (!done) { done = true; global.clearTimeout(t); reject(e); } });
    });
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(src); };
      s.onerror = function () { reject(new Error('脚本加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }

  var loader = {
    state: state,

    isConfigured: function () {
      return !!(cfg.amapKey && String(cfg.amapKey).trim());
    },

    /** 尝试加载高德；无论成功失败都会 resolve，调用方据 state.status 分支 */
    load: function () {
      var self = this;
      if (state.status === 'ready' || state.status === 'loading') return Promise.resolve(state.status);

      if (!this.isConfigured()) {
        state.status = 'fallback';
        state.reason = '未配置高德 Key（config.js → amapKey），使用内置示意地图';
        S.navRuntime.mapMode = 'fallback';
        S.navRuntime.mapReady = true;
        return Promise.resolve('fallback');
      }

      state.status = 'loading';
      if (cfg.amapSecurityJsCode) {
        global._AMapSecurityConfig = { securityJsCode: cfg.amapSecurityJsCode };
      }
      var url = 'https://webapi.amap.com/maps?v=' + (cfg.amapVersion || '2.0') +
                '&key=' + encodeURIComponent(cfg.amapKey) + '&plugin=' + encodeURIComponent((cfg.amapPlugins || []).join(','));

      return withTimeout(loadScript(url), 8000, '高德 JS API')
        .then(function () {
          if (!global.AMap) throw new Error('AMap 未就绪');
          state.status = 'ready';
          S.navRuntime.mapMode = 'amap';
          S.navRuntime.mapReady = true;
          return 'ready';
        })
        .catch(function (err) {
          state.status = 'fallback';
          state.reason = '高德加载失败（' + err.message + '），已降级为内置示意地图';
          S.navRuntime.mapMode = 'fallback';
          S.navRuntime.mapReady = true;
          global.CockpitSafety.notify({ text: '地图已降级为内置示意图', icon: 'map', level: 'warn' });
          return 'fallback';
        });
    },

    /** 在给定容器内挂载地图（真实或示意），返回 Promise */
    mount: function (el) {
      var self = this;
      if (!el) return Promise.resolve(false);
      if (state.status !== 'ready') return Promise.resolve(false);
      try {
        state.map = new global.AMap.Map(el, {
          zoom: 14,
          center: [121.4737, 31.2304],
          viewMode: '2D',
          theme: S.theme === 'dark' ? 'dark' : 'normal',
          mapStyle: S.theme === 'dark' ? 'amap://styles/darkblue' : 'amap://styles/normal'
        });
        if (global.AMap.Driving) {
          state.driving = new global.AMap.Driving({ map: state.map, policy: global.AMap.DrivingPolicy.LEAST_TIME });
        }
        return Promise.resolve(true);
      } catch (e) {
        state.status = 'fallback';
        state.reason = '地图实例化失败：' + e.message;
        S.navRuntime.mapMode = 'fallback';
        return Promise.resolve(false);
      }
    },

    /** 路线规划（有 key 时调用 AMap.Driving；否则由调用方走内置演示数据） */
    planRoute: function (origin, destination) {
      var self = this;
      if (state.status !== 'ready' || !state.driving) return Promise.resolve(null);
      return new Promise(function (resolve) {
        state.driving.search(origin, destination, function (status, result) {
          if (status === 'complete' && result && result.routes && result.routes.length) {
            var r = result.routes[0];
            resolve({
              distance: r.distance / 1000,
              duration: Math.round(r.time / 60),
              name: '高德路线',
              steps: (r.steps || []).map(function (s) { return s.instruction; })
            });
          } else {
            resolve(null);
          }
        });
      });
    },

    setTheme: function (theme) {
      if (state.map && global.AMap) {
        try {
          state.map.setMapStyle(theme === 'dark' ? 'amap://styles/darkblue' : 'amap://styles/normal');
        } catch (e) { /* 某些版本不支持动态换肤，忽略 */ }
      }
    },

    /** 缩放（降级模式下由视图保留档位，这里仅在真实地图存在时生效） */
    setZoom: function (z) {
      if (state.map) { try { state.map.setZoom(z); } catch (e) { /* noop */ } }
      S.navRuntime.zoom = z;
    },

    /** 回到车辆当前位置 */
    recenter: function () {
      var center = [121.4737, 31.2304];
      if (state.map) {
        try { state.map.setZoomAndCenter(15, center); return; } catch (e) { /* noop */ }
      }
      S.navRuntime.zoom = 15;
    },

    destroy: function () {
      if (state.map) { try { state.map.destroy(); } catch (e) { /* noop */ } }
      state.map = null;
      state.driving = null;
    }
  };

  global.CockpitMap = loader;
})(window);
