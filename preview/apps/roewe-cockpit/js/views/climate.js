/*!
 * js/views/climate.js — 模块 3：空调
 * 双温区温度、风量、内循环、AC、前/后除霜、座椅加热、同步。
 * 全部控件支持语音（“可见即可说”）与触控，操作结果即时反馈。
 */
(function (global) {
  'use strict';

  var climate = {
    data: function () { return { S: global.CockpitState }; },
    computed: {
      c: function () { return this.S.data.climate; },
      power: function () { return this.c.power !== false; },
      tempL: function () { return this.c.tempL; },
      tempR: function () { return this.c.tempR; },
      fanLabel: function () { return this.c.fan === 0 ? '关闭' : this.c.fan + ' 档'; },
      seatLabel: function (v) { return v === 0 ? '关闭' : (v === 1 ? '低' : (v === 2 ? '中' : '高')); }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'climate.tempUp', scope: 'climate', label: '调高温度',
          phrases: ['调高温度', '温度高一点', '热一点', '升高温度'],
          handler: function () { self.bumpTemp(0.5); return '温度已调高到 ' + self.tempL + ' 度。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.tempDown', scope: 'climate', label: '调低温度',
          phrases: ['调低温度', '温度低一点', '冷一点', '降低温度'],
          handler: function () { self.bumpTemp(-0.5); return '温度已调低到 ' + self.tempL + ' 度。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.setTemp', scope: 'climate', label: '设定温度',
          phrases: ['把温度调到', '设定温度', '空调温度'],
          handler: function (text) {
            var m = String(text || '').match(/(\d{2})/);
            if (!m) return '请说出目标温度，例如“把温度调到 24 度”。';
            var v = Math.max(16, Math.min(30, parseInt(m[1], 10)));
            self.setTemp('both', v);
            return '温度已设定为 ' + v + ' 度。';
          }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.fanUp', scope: 'climate', label: '调大风量',
          phrases: ['调大风量', '风大一点', '加大风量'],
          handler: function () { self.bumpFan(1); return '风量已调整为 ' + self.fanLabel + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.fanDown', scope: 'climate', label: '调小风量',
          phrases: ['调小风量', '风小一点', '减小风量'],
          handler: function () { self.bumpFan(-1); return '风量已调整为 ' + self.fanLabel + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.ac', scope: 'climate', label: '开关空调',
          phrases: ['打开空调压缩机', '关闭空调', '打开 AC', '关闭 AC', '打开制冷'],
          handler: function () { self.toggle('ac'); return self.c.ac ? 'AC 制冷已打开。' : 'AC 制冷已关闭。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.defrost', scope: 'climate', label: '前除霜',
          phrases: ['前除霜', '打开前除霜', '关闭前除霜', '吹前挡风'],
          handler: function () { self.toggle('defrostFront'); return self.c.defrostFront ? '前除霜已打开。' : '前除霜已关闭。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.defrostRear', scope: 'climate', label: '后除霜',
          phrases: ['后除霜', '打开后除霜', '关闭后除霜'],
          handler: function () { self.toggle('defrostRear'); return self.c.defrostRear ? '后除霜已打开。' : '后除霜已关闭。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.recirc', scope: 'climate', label: '内循环',
          phrases: ['打开内循环', '关闭内循环', '切换内外循环'],
          handler: function () { self.toggle('recirculate'); return self.c.recirculate ? '已切换为内循环。' : '已切换为外循环。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.seat', scope: 'climate', label: '座椅加热',
          phrases: ['打开座椅加热', '关闭座椅加热', '座椅加热'],
          handler: function () { self.cycleSeat(); return '座椅加热已调整为 ' + self.seatLabel(self.c.seatHeatL) + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'climate.auto', scope: 'climate', label: '自动空调',
          phrases: ['自动空调', '打开自动空调', '关闭自动空调'],
          handler: function () { self.toggle('auto'); return self.c.auto ? '已进入自动空调模式。' : '已退出自动空调。'; }
        })
      ];
    },
    beforeUnmount: function () { (this._uns || []).forEach(function (fn) { fn(); }); },
    methods: {
      bumpTemp: function (d) {
        var v = Math.round((this.c.tempL + d) * 2) / 2;
        this.setTemp('both', Math.max(16, Math.min(30, v)));
      },
      setTemp: function (side, v) {
        var val = Math.max(16, Math.min(30, Math.round(v * 2) / 2));
        if (side === 'left' || side === 'both') this.c.tempL = val;
        if (side === 'right' || side === 'both') this.c.tempR = val;
      },
      bumpFan: function (d) { this.c.fan = Math.max(0, Math.min(7, this.c.fan + d)); },
      toggle: function (key) { this.c[key] = !this.c[key]; },
      cycleSeat: function () { this.c.seatHeatL = (this.c.seatHeatL + 1) % 4; },
      syncTemp: function () { this.c.tempR = this.c.tempL; global.CockpitSafety.notify({ text: '双温区已同步', icon: 'climate', level: 'ok' }); },
      togglePower: function () {
        this.c.power = this.c.power === false;
        global.CockpitSafety.notify({ text: this.c.power ? '空调已开启' : '空调已关闭', icon: 'climate' });
      }
    },
    template:
      '<div class="view view-climate" :class="{ off: !power }">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">空调</h2>' +
          '<button class="ph-power" :class="{ on: power }" @click="togglePower"><c-icon name="climate" :size="20"></c-icon>{{ power ? \'已开启\' : \'已关闭\' }}</button>' +
        '</header>' +

        /* ---------- 双温区 ---------- */
        '<section class="card temp-card">' +
          '<div class="tz-row">' +
            '<div class="tz" :class="{ active: true }">' +
              '<span class="tz-user"><c-icon name="seat" :size="18"></c-icon>主驾</span>' +
              '<div class="tz-dial">' +
                '<button class="tz-btn" aria-label="主驾温度降低" @click="setTemp(\'left\', tempL - 0.5)"><c-icon name="minus" :size="22"></c-icon></button>' +
                '<b class="tz-val">{{ tempL }}<i>°C</i></b>' +
                '<button class="tz-btn" aria-label="主驾温度升高" @click="setTemp(\'left\', tempL + 0.5)"><c-icon name="plus" :size="22"></c-icon></button>' +
              '</div>' +
            '</div>' +
            '<div class="tz-sync">' +
              '<button class="sync-btn" :class="{ on: tempL === tempR }" aria-label="同步双温区" @click="syncTemp"><c-icon name="check" :size="18"></c-icon>同步</button>' +
            '</div>' +
            '<div class="tz">' +
              '<span class="tz-user"><c-icon name="seat" :size="18"></c-icon>副驾</span>' +
              '<div class="tz-dial">' +
                '<button class="tz-btn" aria-label="副驾温度降低" @click="setTemp(\'right\', tempR - 0.5)"><c-icon name="minus" :size="22"></c-icon></button>' +
                '<b class="tz-val">{{ tempR }}<i>°C</i></b>' +
                '<button class="tz-btn" aria-label="副驾温度升高" @click="setTemp(\'right\', tempR + 0.5)"><c-icon name="plus" :size="22"></c-icon></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>' +

        /* ---------- 风量与模式 ---------- */
        '<section class="card fan-card">' +
          '<div class="fan-head">' +
            '<span class="fan-ico"><c-icon name="fan" :size="22"></c-icon></span>' +
            '<div class="fan-info"><b>风量</b><small>{{ fanLabel }}</small></div>' +
            '<div class="fan-ctrl">' +
              '<button aria-label="减小风量" @click="bumpFan(-1)"><c-icon name="minus" :size="20"></c-icon></button>' +
              '<span class="fan-bars">' +
                '<i v-for="n in 7" :key="n" :class="{ on: c.fan >= n }"></i>' +
              '</span>' +
              '<button aria-label="增大风量" @click="bumpFan(1)"><c-icon name="plus" :size="20"></c-icon></button>' +
            '</div>' +
          '</div>' +
          '<div class="chip-row">' +
            '<button class="chip" :class="{ on: c.auto }" @click="toggle(\'auto\')"><c-icon name="check" :size="16"></c-icon>自动</button>' +
            '<button class="chip" :class="{ on: c.ac }" @click="toggle(\'ac\')"><c-icon name="snow" :size="16"></c-icon>AC 制冷</button>' +
            '<button class="chip" :class="{ on: c.recirculate }" @click="toggle(\'recirculate\')"><c-icon name="wind" :size="16"></c-icon>内循环</button>' +
          '</div>' +
        '</section>' +

        /* ---------- 除霜与座椅 ---------- */
        '<section class="card aux-card">' +
          '<div class="aux-grid">' +
            '<button class="aux" :class="{ on: c.defrostFront }" @click="toggle(\'defrostFront\')">' +
              '<c-icon name="snow" :size="26"></c-icon><span>前除霜</span><small>吹前挡风</small>' +
            '</button>' +
            '<button class="aux" :class="{ on: c.defrostRear }" @click="toggle(\'defrostRear\')">' +
              '<c-icon name="snow" :size="26"></c-icon><span>后除霜</span><small>加热后窗</small>' +
            '</button>' +
            '<button class="aux" :class="{ on: c.seatHeatL > 0 }" @click="cycleSeat">' +
              '<c-icon name="seat" :size="26"></c-icon><span>座椅加热</span><small>{{ seatLabel(c.seatHeatL) }}</small>' +
            '</button>' +
            '<button class="aux" :class="{ on: c.recirculate }" @click="toggle(\'recirculate\')">' +
              '<c-icon name="wind" :size="26"></c-icon><span>内外循环</span><small>{{ c.recirculate ? \'内循环\' : \'外循环\' }}</small>' +
            '</button>' +
          '</div>' +
        '</section>' +

        /* ---------- 座舱环境 ---------- */
        '<section class="card env-card">' +
          '<div class="env"><span>车外温度</span><b>{{ S.data.vehicle.outsideTemp }}°C</b></div>' +
          '<div class="env"><span>车内湿度</span><b>{{ S.data.weather.humidity }}%</b></div>' +
          '<div class="env"><span>空气质量</span><b>AQI {{ S.data.weather.aqi }} {{ S.data.weather.aqiText }}</b></div>' +
        '</section>' +
      '</div>'
  };

  global.CClimateView = climate;
})(window);
