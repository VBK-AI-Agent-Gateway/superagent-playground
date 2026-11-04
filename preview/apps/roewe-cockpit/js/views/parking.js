/*!
 * 泊车辅助模块
 * 规格：车位识别、方向盘诱导、轨迹线、倒车雷达、自动泊车流程
 */
(function (global) {
  'use strict';

  var STEPS = [
    { key: 'search', label: '搜寻车位', hint: '低速沿车位侧行驶，雷达扫描两侧空间' },
    { key: 'confirm', label: '确认车位', hint: '识别到侧方车位 5.4m，是否开始泊入？' },
    { key: 'reverse', label: '倒车入位', hint: '方向盘自动左打满，请松开双手' },
    { key: 'straight', label: '回正停车', hint: '车身已正，继续倒车至止停线' },
    { key: 'done', label: '泊车完成', hint: '已挂 P 挡，驻车制动已启用' }
  ];

  global.ParkingView = {
    name: 'ParkingView',
    inject: ['ctx'],
    data: function () {
      return {
        steps: STEPS,
        step: 0,
        slot: { length: 5.4, width: 2.3, side: 'right' }
      };
    },
    computed: {
      state: function () { return this.ctx.state; },
      sc: function () { return this.ctx.state.surround; },
      current: function () { return this.steps[this.step]; },
      progressPct: function () { return Math.round((this.step / (this.steps.length - 1)) * 100); },
      minDist: function () { return Math.min.apply(null, this.sc.radar || [999]); },
      alarmText: function () {
        var d = this.minDist;
        return d <= 40 ? '停车' : d <= 80 ? '警示' : d <= 140 ? '注意' : '安全';
      },
      steerAngle: function () {
        var map = [0, 0, -1, 0.4, 0];
        return (map[this.step] || 0) * 420;
      },
      restricted: function () { return this.ctx.state.isDriving(); }
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('开始泊车', ['开始泊车', '自动泊车', '泊入车位'], function () { self.next(); }, '泊车');
      R.say('退出泊车', ['退出泊车', '结束泊车'], function () { self.reset(); }, '泊车');
      R.say('泊车下一步', ['下一步', '继续泊车'], function () { self.next(); }, '泊车');
    },
    beforeUnmount: function () {
      this.sc.autoParking = false;
    },
    methods: {
      next: function () {
        if (this.restricted) {
          this.ctx.toast.restricted();
          return;
        }
        if (this.step >= this.steps.length - 1) {
          this.ctx.toast.show('泊车已完成', 'info');
          return;
        }
        this.step += 1;
        this.sc.autoParking = true;
        var s = this.current;
        this.ctx.toast.show(s.label + '：' + s.hint, 'info');
        if (s.key === 'done') {
          this.ctx.simulator.setGear('P');
          this.sc.autoParking = false;
        }
      },
      reset: function () {
        this.step = 0;
        this.sc.autoParking = false;
        this.ctx.toast.show('已退出泊车辅助', 'info');
      },
      jump: function (i) {
        this.step = i;
      }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 泊车舞台 ---------- */
      '    <card-panel class="col-4" title="泊车辅助 · 侧方车位" icon="parking">',
      '      <div class="parking-stage">',
      '        <div class="parking-stripes"></div>',
      '        <div class="slot" :class="step >= 1 ? \'is-detected\' : \'\'">',
      '          <span class="slot__label" v-if="step >= 1">识别车位 {{ slot.length }}m</span>',
      '          <span class="slot__label" v-else>搜寻中…</span>',
      '        </div>',
      '        <div class="parking-car" :style="{ transform: \'translate(\' + (step * 12) + \'%, \' + (-step * 6) + \'%) rotate(\' + (-step * 7) + \'deg)\' }">',
      '          <svg viewBox="0 0 80 150" aria-label="车辆">',
      '            <rect x="8" y="4" width="64" height="142" rx="20" fill="rgba(86,160,255,.22)" stroke="rgba(120,180,255,.85)" stroke-width="3"/>',
      '            <rect x="18" y="24" width="44" height="40" rx="10" fill="rgba(220,235,255,.28)"/>',
      '            <rect x="18" y="92" width="44" height="34" rx="9" fill="rgba(220,235,255,.18)"/>',
      '          </svg>',
      '          <div class="steer" :style="{ transform: \'rotate(\' + steerAngle + \'deg)\' }"><rw-icon name="wheel" :size="34"></rw-icon></div>',
      '        </div>',
      '        <svg v-if="sc.trajectory" class="trajectory" viewBox="0 0 200 300" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%">',
      '          <path d="M100 292 C100 220 140 190 168 150" fill="none" stroke="#22c55e" stroke-width="5" opacity=".75"/>',
      '          <path d="M100 292 C100 240 120 220 140 200" fill="none" stroke="#f59e0b" stroke-width="5" opacity=".7"/>',
      '        </svg>',
      '        <div class="alarm-banner" :class="minDist <= 80 ? \'is-alarm\' : \'\'" style="position:absolute;left:.2rem;right:.2rem;bottom:.2rem">',
      '          <rw-icon name="warn" :size="26"></rw-icon>',
      '          <span class="grow">最近障碍 {{ minDist }} cm · {{ alarmText }}</span>',
      '        </div>',
      '      </div>',
      '      <div class="bar"><div class="bar__fill" :style="{ width: progressPct + \'%\' }"></div></div>',
      '      <div class="strip"><span class="chip chip--accent">泊车进度 {{ progressPct }}%</span>',
      '        <span class="chip">{{ sc.autoParking ? \'自动泊车中\' : \'待启动\' }}</span></div>',
      '    </card-panel>',

      /* ---------- 流程 ---------- */
      '    <card-panel class="col-2" title="泊车流程" icon="list">',
      '      <ul class="list">',
      '        <li v-for="(s, i) in steps" :key="s.key">',
      '          <button class="list__item list__item--btn" style="width:100%" :class="i === step ? \'is-active\' : \'\'" @click="jump(i)">',
      '            <span class="track-item__idx">{{ i + 1 }}</span>',
      '            <span class="list__main"><span class="list__title">{{ s.label }}</span>',
      '              <span class="list__sub">{{ s.hint }}</span></span>',
      '            <rw-icon v-if="i < step" name="check" :size="22"></rw-icon>',
      '          </button>',
      '        </li>',
      '      </ul>',
      '    </card-panel>',

      /* ---------- 控制 ---------- */
      '    <card-panel class="col-6" title="泊车控制" icon="wheel">',
      '      <div class="alarm-banner" v-if="restricted" :class="\'is-warn\'">',
      '        <rw-icon name="warn" :size="28"></rw-icon>',
      '        <span class="grow">行车中，泊车辅助不可用（{{ state.speed }} km/h）</span>',
      '        <span class="tag tag--warn">请停车挂 P 挡</span>',
      '      </div>',
      '      <div class="strip">',
      '        <button class="btn btn--primary" @click="next" :disabled="restricted">',
      '          <rw-icon name="parking" :size="22"></rw-icon>{{ step >= steps.length - 1 ? \'完成\' : \'下一步\' }}',
      '        </button>',
      '        <button class="btn btn--ghost" @click="reset">重置泊车</button>',
      '        <button class="btn" :class="sc.trajectory ? \'btn--on\' : \'btn--ghost\'" @click="sc.trajectory = !sc.trajectory">轨迹线</button>',
      '        <button class="btn btn--ghost" @click="ctx.router.push(\'surround\')">返回 360° 全景</button>',
      '      </div>',
      '      <div class="card__hint">{{ current.label }} · {{ current.hint }}</div>',
      '      <div class="kv"><span class="muted">车位尺寸</span><span>{{ slot.length }} × {{ slot.width }} m（{{ slot.side === \'right\' ? \'右侧\' : \'左侧\' }}）</span></div>',
      '      <div class="kv"><span class="muted">方向盘转角</span><span>{{ steerAngle }}°</span></div>',
      '      <div class="kv"><span class="muted">驻车制动</span><span>{{ step >= steps.length - 1 ? \'已启用\' : \'未启用\' }}</span></div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };
})(window);
