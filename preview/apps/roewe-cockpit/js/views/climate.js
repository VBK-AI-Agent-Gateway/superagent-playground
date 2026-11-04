/*!
 * 空调模块
 * 规格：双温区温度、风量、内外循环、AC、前后除霜、座椅加热
 */
(function (global) {
  'use strict';

  global.ClimateView = {
    name: 'ClimateView',
    inject: ['ctx'],
    data: function () {
      return { side: 'L' };
    },
    computed: {
      state: function () { return this.ctx.state; },
      climate: function () { return this.ctx.state.climate; },
      /* 温度环百分比：16~32℃ 映射 0~100 */
      pctL: function () { return this.tempPct(this.climate.tempL); },
      pctR: function () { return this.tempPct(this.climate.tempR); },
      fanDuration: function () {
        var f = Math.max(1, this.climate.fan);
        return (4.2 - Math.min(6, f) * 0.55).toFixed(2) + 's';
      },
      seatHeatText: function () {
        var lv = this.climate.seatHeatL || 0;
        return lv === 0 ? '关闭' : lv + ' 挡';
      }
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('空调开关', ['打开空调', '关闭空调'], function () { self.togglePower(); }, '空调');
      R.say('主驾温度', ['温度调到 22 度', '主驾温度 22', '调低温度', '调高温度'], function () {
        self.setTemp('L', 22);
      }, '空调');
      R.say('副驾温度', ['副驾温度调到 24 度', '副驾温度 24'], function () { self.setTemp('R', 24); }, '空调');
      R.say('前除霜', ['打开前除霜', '前挡除霜'], function () { self.toggle('defrostFront'); }, '空调');
      R.say('后除霜', ['打开后除霜', '后挡除霜'], function () { self.toggle('defrostRear'); }, '空调');
      R.say('内循环', ['打开内循环', '切换内循环'], function () { self.toggle('recirculation'); }, '空调');
      R.say('座椅加热', ['打开座椅加热', '座椅加热'], function () { self.seatHeat(1); }, '空调');
    },
    methods: {
      tempPct: function (t) { return Math.round(((t - 16) / 16) * 100); },
      setTemp: function (side, value) {
        var k = side === 'L' ? 'tempL' : 'tempR';
        var v = Math.max(16, Math.min(32, value));
        this.climate[k] = v;
        if (!this.climate.dual) this.climate[side === 'L' ? 'tempR' : 'tempL'] = v;
        this.ctx.toast.show((side === 'L' ? '主驾' : '副驾') + '温度 ' + v + '℃', 'info');
      },
      step: function (side, delta) {
        this.setTemp(side, (side === 'L' ? this.climate.tempL : this.climate.tempR) + delta);
      },
      setFan: function (delta) {
        this.climate.fan = Math.max(0, Math.min(7, this.climate.fan + delta));
      },
      toggle: function (key) {
        this.climate[key] = !this.climate[key];
        if (key === 'power' && !this.climate.power) {
          this.ctx.toast.show('空调已关闭', 'info');
        }
      },
      togglePower: function () {
        this.climate.power = !this.climate.power;
        this.ctx.toast.show(this.climate.power ? '空调已开启' : '空调已关闭', 'info');
      },
      toggleDual: function () {
        this.climate.dual = !this.climate.dual;
        this.ctx.toast.show(this.climate.dual ? '双温区已开启' : '双温区已关闭（主副驾同步）', 'info');
        if (!this.climate.dual) this.climate.tempR = this.climate.tempL;
      },
      seatHeat: function (delta) {
        this.climate.seatHeatL = (this.climate.seatHeatL + delta + 4) % 4;
        this.climate.seatHeatR = this.climate.seatHeatL;
        this.ctx.toast.show('座椅加热 ' + this.seatHeatText, 'info');
      },
      seatHeatSide: function (side) {
        var k = side === 'L' ? 'seatHeatL' : 'seatHeatR';
        this.climate[k] = (this.climate[k] + 1) % 4;
        this.ctx.toast.show((side === 'L' ? '主驾' : '副驾') + '座椅加热 ' + (this.climate[k] === 0 ? '关闭' : this.climate[k] + ' 挡'), 'info');
      }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 双温区温度 ---------- */
      '    <card-panel class="col-6" title="双温区空调" icon="climate"',
      '                say="打开空调面板" :say-phrases="[\'空调\', \'调整温度\']">',
      '      <div class="climate-stage">',
      '        <div class="knob">',
      '          <div class="knob__ring" :style="{ \'--pct\': pctL + \'%\' }">',
      '            <span class="knob__inner">',
      '              <span class="knob__value">{{ climate.tempL }}</span>',
      '              <span class="knob__unit">℃ 主驾</span>',
      '            </span>',
      '          </div>',
      '          <div class="knob__btns">',
      '            <button class="knob__btn" @click="step(\'L\', -1)" :disabled="!climate.power" aria-label="主驾降温">',
      '              <rw-icon name="minus" :size="22"></rw-icon>',
      '            </button>',
      '            <button class="knob__btn" @click="step(\'L\', 1)" :disabled="!climate.power" aria-label="主驾升温">',
      '              <rw-icon name="plus" :size="22"></rw-icon>',
      '            </button>',
      '          </div>',
      '        </div>',
      '        <div class="knob">',
      '          <div class="knob__ring" :style="{ \'--pct\': pctR + \'%\' }">',
      '            <span class="knob__inner">',
      '              <span class="knob__value">{{ climate.tempR }}</span>',
      '              <span class="knob__unit">℃ 副驾</span>',
      '            </span>',
      '          </div>',
      '          <div class="knob__btns">',
      '            <button class="knob__btn" @click="step(\'R\', -1)" :disabled="!climate.power" aria-label="副驾降温">',
      '              <rw-icon name="minus" :size="22"></rw-icon>',
      '            </button>',
      '            <button class="knob__btn" @click="step(\'R\', 1)" :disabled="!climate.power" aria-label="副驾升温">',
      '              <rw-icon name="plus" :size="22"></rw-icon>',
      '            </button>',
      '          </div>',
      '        </div>',
      '      </div>',
      '      <div class="strip">',
      '        <span class="chip" :class="climate.dual ? \'chip--accent\' : \'\'">{{ climate.dual ? \'双温区独立\' : \'主副驾同步\' }}</span>',
      '        <button class="btn btn--sm" :class="climate.dual ? \'btn--on\' : \'btn--ghost\'" @click="toggleDual">双温区</button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 风量与循环 ---------- */
      '    <card-panel class="col-3" title="风量" icon="fan">',
      '      <div class="climate-fan">',
      '        <div class="fan-blades" :class="climate.power && climate.fan > 0 ? \'is-spinning\' : \'\'" :style="{ \'--fan-dur\': fanDuration }">',
      '          <svg viewBox="0 0 100 100" aria-hidden="true">',
      '            <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(86,160,255,.28)" stroke-width="2"/>',
      '            <g fill="var(--accent-2)" opacity=".9">',
      '              <path d="M50 50 C50 30 58 18 50 6 C42 18 50 30 50 50 Z"/>',
      '              <path d="M50 50 C50 30 58 18 50 6 C42 18 50 30 50 50 Z" transform="rotate(120 50 50)"/>',
      '              <path d="M50 50 C50 30 58 18 50 6 C42 18 50 30 50 50 Z" transform="rotate(240 50 50)"/>',
      '            </g>',
      '            <circle cx="50" cy="50" r="9" fill="var(--surface-3)"/>',
      '          </svg>',
      '        </div>',
      '        <div class="strip">',
      '          <button class="media-btn" style="width:.7rem;height:.7rem" @click="setFan(-1)" aria-label="减小风量">',
      '            <rw-icon name="minus" :size="22"></rw-icon>',
      '          </button>',
      '          <span class="gauge__value">{{ climate.fan }}<span class="gauge__unit">挡</span></span>',
      '          <button class="media-btn" style="width:.7rem;height:.7rem" @click="setFan(1)" aria-label="增大风量">',
      '            <rw-icon name="plus" :size="22"></rw-icon>',
      '          </button>',
      '        </div>',
      '      </div>',
      '    </card-panel>',

      '    <card-panel class="col-3" title="空气与除霜" icon="fan">',
      '      <div class="quick" style="grid-template-columns:repeat(2,minmax(0,1fr))">',
      '        <button class="ctrl" :class="climate.power ? \'is-on\' : \'\'" @click="togglePower">',
      '          <rw-icon name="power" :size="30"></rw-icon><span class="ctrl__label">空调</span>',
      '        </button>',
      '        <button class="ctrl" :class="climate.ac ? \'is-on\' : \'\'" @click="toggle(\'ac\')">',
      '          <rw-icon name="snow" :size="30"></rw-icon><span class="ctrl__label">A/C</span>',
      '        </button>',
      '        <button class="ctrl" :class="climate.recirculation ? \'is-on\' : \'\'" @click="toggle(\'recirculation\')">',
      '          <rw-icon name="loop" :size="30"></rw-icon>',
      '          <span class="ctrl__label">{{ climate.recirculation ? \'内循环\' : \'外循环\' }}</span>',
      '        </button>',
      '        <button class="ctrl" :class="climate.defrostFront ? \'is-on\' : \'\'" @click="toggle(\'defrostFront\')">',
      '          <rw-icon name="defrost" :size="30"></rw-icon><span class="ctrl__label">前除霜</span>',
      '        </button>',
      '        <button class="ctrl" :class="climate.defrostRear ? \'is-on\' : \'\'" @click="toggle(\'defrostRear\')">',
      '          <rw-icon name="defrost" :size="30"></rw-icon><span class="ctrl__label">后除霜</span>',
      '        </button>',
      '        <button class="ctrl" :class="climate.seatHeatL ? \'is-on\' : \'\'" @click="seatHeat(1)">',
      '          <rw-icon name="seat" :size="30"></rw-icon>',
      '          <span class="ctrl__label">座椅加热 {{ seatHeatText }}</span>',
      '        </button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 座椅分区 ---------- */
      '    <card-panel class="col-6" title="座椅与舒适" icon="seat">',
      '      <div class="seat-map">',
      '        <button class="ctrl" :class="climate.seatHeatL ? \'is-on\' : \'\'" @click="seatHeatSide(\'L\')">',
      '          <rw-icon name="seat" :size="30"></rw-icon>',
      '          <span class="ctrl__label">主驾加热 · {{ climate.seatHeatL === 0 ? \'关\' : climate.seatHeatL + \'挡\' }}</span>',
      '        </button>',
      '        <button class="ctrl" :class="climate.seatHeatR ? \'is-on\' : \'\'" @click="seatHeatSide(\'R\')">',
      '          <rw-icon name="seat" :size="30"></rw-icon>',
      '          <span class="ctrl__label">副驾加热 · {{ climate.seatHeatR === 0 ? \'关\' : climate.seatHeatR + \'挡\' }}</span>',
      '        </button>',
      '      </div>',
      '      <div class="card__hint">行车中调整空调不会弹出遮挡面板，车速与挡位始终可见</div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };
})(window);
