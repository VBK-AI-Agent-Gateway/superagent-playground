/*!
 * js/components/statusbar.js — 顶部固定状态栏
 * 安全规则 2：车速、挡位、告警、时间永远可见，任何浮层都不覆盖本区域。
 */
(function (global) {
  'use strict';

  var statusbar = {
    data: function () {
      return { S: global.CockpitState };
    },
    computed: {
      gearClass: function () {
        return 'g-' + String(this.S.gear).toLowerCase();
      },
      driving: function () { return global.CockpitSafety.isDriving(); },
      warning: function () {
        var v = this.S.data.vehicle;
        if (this.S.data.parking.obstacle.active && this.driving) return '雷达告警';
        if (v.battery <= 20) return '电量低';
        if (v.fuel <= 15) return '油量低';
        if (this.driving) return '行车中';
        return '';
      },
      wifiOn: function () { return this.S.data.system.wifi.on; },
      btOn: function () { return this.S.data.system.bluetooth.on; }
    },
    template:
      '<header class="statusbar" role="banner">' +
        '<div class="sb-left">' +
          '<span class="sb-gear" :class="gearClass">{{ S.gear }}</span>' +
          '<span class="sb-speed"><b>{{ S.data.vehicle.speed }}</b><i>km/h</i></span>' +
        '</div>' +
        '<div class="sb-center">' +
          '<span v-if="warning" class="sb-warn"><c-icon name="warn" :size="16"></c-icon>{{ warning }}</span>' +
        '</div>' +
        '<div class="sb-right">' +
          '<c-icon name="wifi" :size="18" :class="{ dim: !wifiOn }"></c-icon>' +
          '<c-icon name="bt" :size="18" :class="{ dim: !btOn }"></c-icon>' +
          '<span class="sb-time">{{ S.clock.time }}</span>' +
        '</div>' +
      '</header>'
  };

  global.CStatusBar = statusbar;
})(window);
