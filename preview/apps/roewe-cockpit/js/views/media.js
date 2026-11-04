/*!
 * 多媒体模块
 * 规格：在线音乐、蓝牙电话、本地音频、音量滑块
 * 规则 1：D 挡行车中（车速 > 5km/h）娱乐功能受限，页面整体锁定并提示「行车中，娱乐功能已限制」
 */
(function (global) {
  'use strict';

  var SOURCES = [
    { key: 'netease', label: '在线音乐', icon: 'media' },
    { key: 'bluetooth', label: '蓝牙电话', icon: 'phone' },
    { key: 'local', label: '本地音频', icon: 'folder' },
    { key: 'radio', label: '收音机', icon: 'signal' }
  ];

  global.MediaView = {
    name: 'MediaView',
    inject: ['ctx'],
    data: function () {
      return {
        sources: SOURCES,
        dial: '',
        tracks: (global.ROEWE_MOCK && global.ROEWE_MOCK.tracks) || [],
        devices: (global.ROEWE_MOCK && global.ROEWE_MOCK.btDevices) || []
      };
    },
    computed: {
      state: function () { return this.ctx.state; },
      media: function () { return this.ctx.state.media; },
      restricted: function () { return this.ctx.state.isDriving(); },
      track: function () { return this.tracks[this.media.trackIndex] || this.tracks[0] || {}; },
      progressPct: function () {
        return Math.min(100, Math.round((this.media.progress / Math.max(1, this.media.duration)) * 100));
      },
      progressText: function () { return this.fmt(this.media.progress); },
      durationText: function () { return this.fmt(this.media.duration); },
      coverStyle: function () {
        var c = this.track.cover || '#2b6cff';
        return { background: 'linear-gradient(150deg, ' + c + ' 0%, rgba(6,12,26,.95) 100%)' };
      },
      callActive: function () { return this.media.call && this.media.call.active; }
    },
    created: function () {
      var self = this;
      /* 播放进度计时器（仅前台播放时推进） */
      this._timer = setInterval(function () {
        if (!self.media.playing || self.restricted) return;
        self.media.progress += 1;
        if (self.media.progress >= self.media.duration) self.next();
      }, 1000);
    },
    beforeUnmount: function () {
      clearInterval(this._timer);
    },
    mounted: function () {
      var self = this;
      var R = global.RoeweVoiceRegistry;
      R.say('播放音乐', ['播放音乐', '放首歌', '开始播放'], function () { self.play(); }, '多媒体');
      R.say('暂停播放', ['暂停播放', '停止播放', '暂停'], function () { self.pause(); }, '多媒体');
      R.say('下一首', ['下一首', '切歌'], function () { self.next(); }, '多媒体');
      R.say('上一首', ['上一首', '返回上一首'], function () { self.prev(); }, '多媒体');
      R.say('音量调节', ['音量调到 60', '声音大一点', '静音'], function () { self.setVolume(60); }, '多媒体');
      R.say('蓝牙连接', ['连接蓝牙', '打开蓝牙音乐'], function () { self.connectBt(self.devices[0]); }, '多媒体');
    },
    methods: {
      fmt: function (sec) {
        var s = Math.max(0, Math.floor(sec || 0));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return m + ':' + (r < 10 ? '0' : '') + r;
      },
      /* 受限守卫：所有播放相关操作先经过规则 1 检查 */
      guard: function () {
        if (this.restricted) {
          this.ctx.toast.restricted();
          return false;
        }
        return true;
      },
      setSource: function (key) {
        if (key !== 'bluetooth' && !this.guard()) return;
        if (key === 'bluetooth' && this.restricted) {
          this.ctx.toast.restricted();
          return;
        }
        this.media.source = key;
        if (key === 'bluetooth') this.media.playing = false;
      },
      play: function () {
        if (!this.guard()) return;
        if (this.media.source === 'bluetooth') {
          this.ctx.toast.show('蓝牙音源请使用手机播放', 'info');
          return;
        }
        this.media.playing = true;
        this.ctx.toast.show('正在播放：' + this.track.title, 'info');
      },
      pause: function () {
        this.media.playing = false;
      },
      next: function () {
        if (!this.guard()) return;
        this.media.trackIndex = (this.media.trackIndex + 1) % this.tracks.length;
        this.media.duration = this.track.duration || 245;
        this.media.progress = 0;
      },
      prev: function () {
        if (!this.guard()) return;
        this.media.trackIndex = (this.media.trackIndex - 1 + this.tracks.length) % this.tracks.length;
        this.media.duration = this.track.duration || 245;
        this.media.progress = 0;
      },
      pickTrack: function (i) {
        if (!this.guard()) return;
        this.media.trackIndex = i;
        this.media.duration = this.track.duration || 245;
        this.media.progress = 0;
        this.media.playing = true;
      },
      seek: function (e) {
        if (!this.guard()) return;
        this.media.progress = Number(e.target.value);
      },
      setVolume: function (v) {
        this.media.volume = Math.max(0, Math.min(100, Number(v)));
        this.media.muted = this.media.volume === 0;
      },
      toggleMute: function () {
        this.media.muted = !this.media.muted;
        this.ctx.toast.show(this.media.muted ? '已静音' : '已取消静音', 'info');
      },
      connectBt: function (d) {
        if (!this.guard()) return;
        var b = this.media.bluetooth;
        b.connected = !b.connected;
        b.device = d ? d.name : 'iPhone 15 Pro';
        this.ctx.toast.show(b.connected ? '已连接 ' + b.device : '已断开蓝牙连接', 'info');
      },
      dialNumber: function (num) {
        if (!this.guard()) return;
        var n = (num || this.dial || '').trim();
        if (!n) {
          this.ctx.toast.show('请输入号码或选择联系人', 'warn');
          return;
        }
        var b = this.media.bluetooth;
        b.connected = true;
        b.dialing = true;
        this.media.call = { active: true, name: n, number: n, seconds: 0 };
        var self = this;
        clearInterval(this._callTimer);
        this._callTimer = setInterval(function () {
          if (self.media.call.active) self.media.call.seconds += 1;
        }, 1000);
        this.ctx.toast.show('正在呼叫 ' + n, 'info');
      },
      hangUp: function () {
        clearInterval(this._callTimer);
        this.media.bluetooth.dialing = false;
        this.media.call = { active: false, name: '', number: '', seconds: 0 };
        this.ctx.toast.show('通话已结束', 'info');
      },
      callTime: function () { return this.fmt(this.media.call ? this.media.call.seconds : 0); }
    },
    beforeUnmount2: null,
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 行车受限横幅 ---------- */
      '    <div v-if="restricted" class="col-6 alarm-banner is-warn" role="status">',
      '      <rw-icon name="warn" :size="30"></rw-icon>',
      '      <span class="grow">行车中，娱乐功能已限制（{{ state.speed }} km/h）</span>',
      '      <span class="tag tag--warn">P 挡解锁</span>',
      '    </div>',

      /* ---------- 播放器 ---------- */
      '    <card-panel class="col-4" title="正在播放" icon="media" :class="restricted ? \'is-locked\' : \'\'">',
      '      <div class="media-cover" :style="coverStyle" :class="restricted ? \'is-locked\' : \'\'">',
      '        <span class="media-cover__disc" v-if="media.playing && !restricted"></span>',
      '        <span class="media-cover__title">{{ track.title || \'未选择曲目\' }}</span>',
      '      </div>',
      '      <div class="muted center" style="font-size:.21rem">{{ track.artist || \'—\' }} · {{ track.album || \'—\' }}</div>',
      '      <div class="slider">',
      '        <input type="range" min="0" :max="media.duration" step="1" :value="media.progress"',
      '               @input="seek" :disabled="restricted" aria-label="播放进度">',
      '        <div class="strip"><span class="slider__label">{{ progressText }}</span>',
      '          <span class="slider__label">{{ durationText }}</span></div>',
      '      </div>',
      '      <div class="media-controls">',
      '        <button class="media-btn" @click="prev" :disabled="restricted" aria-label="上一首">',
      '          <rw-icon name="prev" :size="30"></rw-icon>',
      '        </button>',
      '        <button class="media-btn media-btn--play" @click="media.playing ? pause() : play()"',
      '                :disabled="restricted" aria-label="播放或暂停">',
      '          <rw-icon :name="media.playing ? \'pause\' : \'play\'" :size="38"></rw-icon>',
      '        </button>',
      '        <button class="media-btn" @click="next" :disabled="restricted" aria-label="下一首">',
      '          <rw-icon name="next" :size="30"></rw-icon>',
      '        </button>',
      '      </div>',
      '      <div class="strip">',
      '        <span class="chip">{{ SOURCE_LABEL }}</span>',
      '        <span class="chip" v-if="restricted">受限</span>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 音源与曲库 ---------- */
      '    <card-panel class="col-2" title="音源" icon="signal">',
      '      <div class="stack">',
      '        <button v-for="s in sources" :key="s.key" class="list__item list__item--btn"',
      '                :class="media.source === s.key ? \'is-active\' : \'\'" @click="setSource(s.key)">',
      '          <rw-icon :name="s.icon" :size="26"></rw-icon>',
      '          <span class="list__main"><span class="list__title">{{ s.label }}</span></span>',
      '          <rw-icon v-if="media.source === s.key" name="check" :size="24"></rw-icon>',
      '        </button>',
      '      </div>',
      '      <div class="slider">',
      '        <div class="strip"><span class="slider__label">音量</span>',
      '          <span class="slider__value">{{ media.muted ? \'静音\' : media.volume + \'%\' }}</span></div>',
      '        <input type="range" min="0" max="100" step="1" :value="media.muted ? 0 : media.volume"',
      '               @input="setVolume($event.target.value)" aria-label="音量">',
      '        <button class="btn btn--sm btn--ghost btn--block" @click="toggleMute" style="margin-top:.1rem">',
      '          <rw-icon :name="media.muted ? \'volume-off\' : \'volume\'" :size="22"></rw-icon>',
      '          {{ media.muted ? \'取消静音\' : \'静音\' }}',
      '        </button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 蓝牙电话 ---------- */
      '    <card-panel class="col-3" title="蓝牙电话" icon="phone" :class="restricted ? \'is-locked\' : \'\'">',
      '      <div class="list__item" style="border:none;padding:0">',
      '        <span class="list__main">',
      '          <span class="list__title">{{ media.bluetooth.device }}</span>',
      '          <span class="list__sub">{{ media.bluetooth.connected ? \'已连接\' : \'未连接\' }}</span>',
      '        </span>',
      '        <button class="btn btn--sm" :class="media.bluetooth.connected ? \'btn--ghost\' : \'btn--primary\'"',
      '                @click="connectBt(devices[0])" :disabled="restricted">',
      '          {{ media.bluetooth.connected ? \'断开\' : \'连接\' }}',
      '        </button>',
      '      </div>',
      '      <div class="voice-input" style="margin-top:.18rem">',
      '        <input type="text" v-model="dial" placeholder="输入号码" :disabled="restricted" aria-label="输入号码">',
      '        <button class="btn btn--primary btn--sm" @click="dialNumber()" :disabled="restricted">呼叫</button>',
      '      </div>',
      '      <div class="stack" style="margin-top:.14rem">',
      '        <button v-for="d in devices" :key="d.name" class="list__item list__item--btn" @click="dialNumber(d.name)"',
      '                :disabled="restricted">',
      '          <rw-icon name="user" :size="24"></rw-icon>',
      '          <span class="list__main"><span class="list__title">{{ d.name }}</span>',
      '            <span class="list__sub">{{ d.number }}</span></span>',
      '        </button>',
      '      </div>',
      '      <div v-if="callActive" class="alarm-banner" style="margin-top:.18rem;background:linear-gradient(160deg,rgba(34,197,94,.9),rgba(21,128,61,.9))">',
      '        <rw-icon name="phone" :size="28"></rw-icon>',
      '        <span class="grow">通话中 · {{ callTime() }}</span>',
      '        <button class="btn btn--danger btn--sm" @click="hangUp">挂断</button>',
      '      </div>',
      '    </card-panel>',

      /* ---------- 播放列表 ---------- */
      '    <card-panel class="col-3" title="播放列表" icon="list">',
      '      <ul class="list">',
      '        <li v-for="(t, i) in tracks" :key="t.title">',
      '          <button class="list__item list__item--btn" style="width:100%"',
      '                  :class="i === media.trackIndex ? \'is-active\' : \'\'" @click="pickTrack(i)">',
      '            <span class="track-item__idx">{{ i + 1 }}</span>',
      '            <span class="track-item__cover" :style="{ background: t.cover }">',
      '              <rw-icon :name="i === media.trackIndex && media.playing ? \'pause\' : \'play\'" :size="20"></rw-icon>',
      '            </span>',
      '            <span class="list__main">',
      '              <span class="list__title">{{ t.title }}</span>',
      '              <span class="list__sub">{{ t.artist }} · {{ fmt(t.duration) }}</span>',
      '            </span>',
      '          </button>',
      '        </li>',
      '      </ul>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };

  global.MediaView.computed.SOURCE_LABEL = function () {
    var map = { netease: '在线音乐', bluetooth: '蓝牙电话', local: '本地音频', radio: '收音机' };
    return map[this.media.source] || '在线音乐';
  };
})(window);
