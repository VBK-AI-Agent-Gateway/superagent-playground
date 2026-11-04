/*!
 * 高德地图 JS API 2.0 加载器
 * - config.js 填了 key 时真实加载高德地图
 * - 未填 key / 加载失败 / 超时：自动降级为内置示意图（fallback）
 *   fallback 下路线规划、车道引导、路况、充电/加油站搜索的 UI 与交互逻辑完整保留。
 */
(function (global) {
  'use strict';

  var AMAP_SRC = 'https://webapi.amap.com/maps';
  var LOAD_TIMEOUT = 8000;

  function loadAmap(cfg) {
    return new Promise(function (resolve, reject) {
      if (!cfg || !cfg.key) {
        reject(new Error('NO_KEY'));
        return;
      }
      if (global.AMap && global.AMap.Map) {
        resolve(global.AMap);
        return;
      }
      /* 安全密钥（2021-12-02 之后申请的 key 必须配置） */
      if (cfg.securityJsCode) {
        global._AMapSecurityConfig = { securityJsCode: cfg.securityJsCode };
      }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('TIMEOUT'));
      }, cfg.timeout || LOAD_TIMEOUT);

      var script = document.createElement('script');
      script.src = AMAP_SRC + '?v=' + (cfg.version || '2.0') + '&key=' + encodeURIComponent(cfg.key);
      script.async = true;
      script.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (global.AMap && global.AMap.Map) resolve(global.AMap);
        else reject(new Error('LOAD_FAILED'));
      };
      script.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('LOAD_FAILED'));
      };
      document.head.appendChild(script);
    });
  }

  /* 加载第三方脚本（Three.js 等），失败时静默降级 */
  function loadScript(src, timeout) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('TIMEOUT'));
      }, timeout || 6000);
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      s.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('LOAD_FAILED'));
      };
      document.head.appendChild(s);
    });
  }

  global.RoeweMap = { loadAmap: loadAmap, loadScript: loadScript };
})(window);
