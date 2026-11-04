/*!
 * js/core/simulator.js — 驾驶状态模拟器（安全规则 4）
 * 在 Dock 与设置页提供「P/D 挡切换 + 车速滑块」，用于随时验证 D 挡限制逻辑。
 * 所有状态变更都通过 CockpitSafety，保证与全局状态机一致。
 */
(function (global) {
  'use strict';

  var S = global.CockpitState;
  var safety = global.CockpitSafety;

  var tickTimer = null;

  var simulator = {
    gears: [
      { key: 'P', label: 'P 驻车', desc: '解锁全部娱乐功能' },
      { key: 'R', label: 'R 倒车', desc: '倒车影像 / 泊车辅助可用' },
      { key: 'N', label: 'N 空挡', desc: '娱乐功能可用' },
      { key: 'D', label: 'D 行车', desc: '限制视频与娱乐类页面' }
    ],

    open: function () { S.simulatorOpen = true; },
    close: function () { S.simulatorOpen = false; },
    toggle: function () { S.simulatorOpen = !S.simulatorOpen; },

    setGear: function (g) { safety.setGear(g); },
    setSpeed: function (v) { safety.setSpeed(v); },

    /** 一键进入行车态，便于快速验证 D 挡限制 */
    driveNow: function () {
      safety.setGear('D');
      safety.setSpeed(60);
      safety.notify({ text: '已模拟行车：D 挡 60 km/h', icon: 'car', level: 'ok' });
    },

    /** 一键回到驻车态 */
    parkNow: function () {
      safety.setSpeed(0);
      safety.setGear('P');
      safety.notify({ text: '已模拟驻车：P 挡 0 km/h', icon: 'park', level: 'ok' });
    },

    /** 行车时车速自然波动，让 3D 卡片与指标有真实感（仅在 D/R 挡运行） */
    startTicker: function () {
      if (tickTimer) return;
      tickTimer = global.setInterval(function () {
        if (S.gear === 'D' && S.speed > 5) {
          var drift = (Math.random() - 0.5) * 4;
          safety.setSpeed(Math.max(5, Math.min(120, S.speed + drift)));
        }
      }, 2500);
    },

    stopTicker: function () {
      if (tickTimer) { global.clearInterval(tickTimer); tickTimer = null; }
    }
  };

  global.CockpitSimulator = simulator;
})(window);
