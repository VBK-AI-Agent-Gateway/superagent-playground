/*!
 * 顶部常驻状态栏
 * 规则 2：车速、挡位、告警永远可见 —— 本组件在任何页面之上，且不可被覆盖。
 */
(function (global) {
  'use strict';

  global.StatusBar = {
    name: 'StatusBar',
    props: {
      state: { type: Object, required: true },
      ctx: { type: Object, required: true },
      view: { type: String, default: 'home' }
    },
    computed: {
      gearCls: function () {
        return this.state.gear === 'D' ? 'is-d' : 'is-p';
      },
      restricted: function () {
        return this.state.isDriving();
      },
      warnCount: function () {
        var n = 0;
        if (this.state.vehicle.doorOpen) n += 1;
        if (!this.state.vehicle.locked) n += 1;
        if (this.state.surround.alarmLevel >= 2) n += 1;
        if (this.state.vehicle.battery < 20) n += 1;
        return n;
      },
      clock: function () {
        return this.state.nowText || '';
      },
      wifiName: function () {
        return this.state.system.wifiName;
      }
    },
    methods: {
      theme: function () {
        this.ctx.toggleTheme();
      },
      openVoice: function () {
        this.ctx.voice.toggleMic();
      },
      warnTap: function () {
        if (this.state.surround.alarmLevel >= 2) {
          this.ctx.router.push('parking');
          return;
        }
        this.ctx.toast.warn(this.state.vehicle.locked ? '车辆状态正常' : '车门未上锁，请确认');
      }
    },
    template: [
      '<header class="statusbar" :class="{ \'is-restricted\': restricted }">',
      '  <div class="statusbar__left">',
      '    <span class="statusbar__clock">{{ clock }}</span>',
      '    <span class="statusbar__chip" :class="gearCls">挡位 {{ state.gear }}</span>',
      '    <span class="statusbar__chip statusbar__chip--speed">',
      '      <b>{{ state.speed }}</b><i>km/h</i>',
      '    </span>',
      '  </div>',
      '  <div class="statusbar__mid" v-if="restricted">',
      '    <rw-icon name="warn" :size="22"></rw-icon>',
      '    <span>行车中，娱乐功能已限制</span>',
      '  </div>',
      '  <div class="statusbar__right">',
      '    <button class="statusbar__icon" @click="warnTap" :aria-label="\'告警 \' + warnCount">',
      '      <rw-icon name="warn" :size="24"></rw-icon>',
      '      <i v-if="warnCount" class="badge">{{ warnCount }}</i>',
      '    </button>',
      '    <span class="statusbar__chip statusbar__chip--net">',
      '      <rw-icon name="wifi" :size="20"></rw-icon>{{ wifiName }}',
      '    </span>',
      '    <span class="statusbar__chip statusbar__chip--battery">',
      '      <rw-icon name="charge" :size="18"></rw-icon>{{ state.vehicle.battery }}%',
      '    </span>',
      '    <button class="statusbar__icon" @click="theme" aria-label="切换主题">',
      '      <rw-icon :name="state.theme === \'dark\' ? \'sun\' : \'cloud\'" :size="24"></rw-icon>',
      '    </button>',
      '    <button class="statusbar__icon" @click="openVoice" aria-label="语音助手">',
      '      <rw-icon name="mic" :size="24"></rw-icon>',
      '    </button>',
      '  </div>',
      '</header>'
    ].join('\n')
  };
})(window);
