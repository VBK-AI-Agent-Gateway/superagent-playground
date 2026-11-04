/*!
 * js/components/simulator-panel.js — 驾驶状态模拟器面板（安全规则 4）
 * 挡位切换（P/R/N/D）+ 车速滑块；用于验证 D 挡限制与行车提示。
 */
(function (global) {
  'use strict';

  var sim = {
    data: function () { return { S: global.CockpitState, speed: global.CockpitState.speed }; },
    computed: {
      gears: function () { return global.CockpitSimulator.gears; },
      driving: function () { return global.CockpitSafety.isDriving(); },
      lockList: function () { return ['多媒体', '360 全景', '泊车辅助']; },
      speedHint: function () {
        if (this.S.gear === 'D' && this.S.speed >= 5) return '当前处于行车态：视频与娱乐页面已被限制';
        if (this.S.gear === 'R') return '倒车态：泊车辅助与倒车影像可用';
        return '当前处于驻车态：全部娱乐功能已解锁';
      }
    },
    watch: {
      'S.speed': function (v) { this.speed = v; }
    },
    methods: {
      setGear: function (g) { global.CockpitSimulator.setGear(g); },
      onSpeed: function () { global.CockpitSimulator.setSpeed(this.speed); },
      driveNow: function () { global.CockpitSimulator.driveNow(); },
      parkNow: function () { global.CockpitSimulator.parkNow(); },
      close: function () { global.CockpitSimulator.close(); }
    },
    template:
      '<transition name="panel-pop">' +
        '<div v-if="S.simulatorOpen" class="sim-panel" role="dialog" aria-label="驾驶状态模拟器">' +
          '<header class="sim-head">' +
            '<span class="sim-tag"><c-icon name="gear" :size="18"></c-icon>驾驶状态模拟器</span>' +
            '<button class="sim-close" aria-label="关闭模拟器" @click="close"><c-icon name="close" :size="18"></c-icon></button>' +
          '</header>' +

          '<div class="sim-gears">' +
            '<button v-for="g in gears" :key="g.key" class="sim-gear" :class="{ on: S.gear === g.key }" ' +
                    :aria-pressed="S.gear === g.key" @click="setGear(g.key)">' +
              '<b>{{ g.key }}</b><small>{{ g.label.slice(2) }}</small>' +
            '</button>' +
          '</div>' +

          '<p class="sim-desc">{{ (gears.find(g => g.key === S.gear) || {}).desc }}</p>' +

          '<div class="sim-speed">' +
            '<div class="sim-speed-label"><span>车速</span><b>{{ S.speed }} <i>km/h</i></b></div>' +
            '<input class="sim-range" type="range" min="0" max="120" step="1" v-model.number="speed" @input="onSpeed" aria-label="车速滑块">' +
            '<div class="sim-scale"><span>0</span><span>60</span><span>120</span></div>' +
          '</div>' +

          '<div class="sim-state" :class="{ danger: driving }">' +
            '<c-icon :name="driving ? \'shield\' : \'check\'" :size="16"></c-icon>' +
            '<span>{{ speedHint }}</span>' +
          '</div>' +
          '<ul class="sim-locks"><li v-for="l in lockList" :key="l">{{ l }}<b>{{ driving ? \'已限制\' : \'可用\' }}</b></li></ul>' +

          '<div class="sim-actions">' +
            '<button class="btn btn-accent" @click="driveNow">一键行车（D 挡 60）</button>' +
            '<button class="btn" @click="parkNow">一键驻车（P 挡 0）</button>' +
          '</div>' +
          '<p class="sim-tip">提示：切换到 D 挡后尝试打开「多媒体 / 360 全景 / 泊车辅助」，将出现“行车中，娱乐功能已限制”提示。</p>' +
        '</div>' +
      '</transition>'
  };

  global.CSimulatorPanel = sim;
})(window);
