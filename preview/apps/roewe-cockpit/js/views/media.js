/*!
 * js/views/media.js — 模块 4：媒体
 * 在线/本地音乐、蓝牙通话、本地音频播放与音量滑条。
 * 安全规则 1：D 挡进入本页会被挡位状态机拦截（娱乐功能受限）。
 * 安全规则 2：本页所有浮动弹层均为轻量面板，不覆盖顶栏的车速/挡位/告警。
 */
(function (global) {
  'use strict';

  var media = {
    data: function () { return { S: global.CockpitState, tab: 'music', btView: 'devices' }; },
    computed: {
      m: function () { return this.S.data.media; },
      bt: function () { return this.S.data.media.bt; },
      track: function () { return this.m.tracks[this.m.trackIndex] || {}; },
      progressPct: function () {
        var d = this.track.duration || 1;
        return Math.max(0, Math.min(100, Math.round(this.m.progress / d * 100)));
      },
      nowText: function () { return this.fmt(this.m.progress) + ' / ' + this.fmt(this.track.duration || 0); },
      callActive: function () { return this.bt.call && this.bt.call.state !== 'idle'; },
      callText: function () {
        var st = this.bt.call && this.bt.call.state;
        return st === 'dialing' ? '正在呼叫…' : (st === 'talking' ? '通话中 ' + this.bt.call.seconds + 's' : '');
      },
      tabList: function () {
        return [
          { key: 'music', label: '音乐', icon: 'media' },
          { key: 'bt', label: '蓝牙通话', icon: 'phone' },
          { key: 'local', label: '本地音频', icon: 'list' }
        ];
      }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'media.play', scope: 'media', label: '播放音乐',
          phrases: ['播放音乐', '继续播放', '播放', '暂停播放', '暂停'],
          handler: function () { self.togglePlay(); return self.m.playing ? '正在播放：' + self.track.title : '音乐已暂停。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.next', scope: 'media', label: '下一首',
          phrases: ['下一首', '切歌', '换一首'],
          handler: function () { self.next(); return '已切换：' + self.track.title; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.prev', scope: 'media', label: '上一首',
          phrases: ['上一首', '回到上一首'],
          handler: function () { self.prev(); return '已切换：' + self.track.title; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.volUp', scope: 'media', label: '调大音量',
          phrases: ['调大音量', '声音大一点', '音量加'],
          handler: function () { self.bumpVol(5); return '音量已调整为 ' + self.m.volume + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.volDown', scope: 'media', label: '调小音量',
          phrases: ['调小音量', '声音小一点', '音量减'],
          handler: function () { self.bumpVol(-5); return '音量已调整为 ' + self.m.volume + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.mute', scope: 'media', label: '静音',
          phrases: ['静音', '取消静音', '关闭声音'],
          handler: function () { self.m.mute = !self.m.mute; return self.m.mute ? '已静音。' : '已取消静音。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.radio', scope: 'media', label: '打开收音机',
          phrases: ['打开收音机', '听广播', '播放广播'],
          handler: function () { self.setSource('radio'); return '已切换到收音机 ' + self.m.radio.freq + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.call', scope: 'media', label: '拨打电话',
          phrases: ['拨打电话', '打电话给', '呼叫'],
          handler: function () { self.tab = 'bt'; self.dial(self.bt.contacts[0]); return '正在呼叫 ' + self.bt.contacts[0].name + '。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'media.hangup', scope: 'media', label: '挂断电话',
          phrases: ['挂断电话', '挂断', '结束通话'],
          handler: function () { self.hangup(); return '通话已挂断。'; }
        })
      ];
      this._t = global.setInterval(function () {
        if (!self.m.playing || self.m.mute) return;
        self.m.progress += 1;
        if (self.m.progress >= (self.track.duration || 999)) self.next();
      }, 1000);
    },
    beforeUnmount: function () {
      (this._uns || []).forEach(function (fn) { fn(); });
      if (this._t) global.clearInterval(this._t);
    },
    methods: {
      fmt: function (s) {
        var n = Math.max(0, Math.floor(s || 0));
        return Math.floor(n / 60) + ':' + (n % 60 < 10 ? '0' : '') + (n % 60);
      },
      togglePlay: function () { this.m.playing = !this.m.playing; },
      next: function () { this.m.trackIndex = (this.m.trackIndex + 1) % this.m.tracks.length; this.m.progress = 0; },
      prev: function () { this.m.trackIndex = (this.m.trackIndex - 1 + this.m.tracks.length) % this.m.tracks.length; this.m.progress = 0; },
      seek: function (e) {
        var d = this.track.duration || 1;
        this.m.progress = Math.round(d * (e.target.value / 100));
      },
      bumpVol: function (d) { this.m.volume = Math.max(0, Math.min(100, this.m.volume + d)); if (this.m.volume > 0) this.m.mute = false; },
      setSource: function (s) { this.m.source = s; this.tab = s === 'bluetooth' ? 'bt' : (s === 'local' ? 'local' : 'music'); },
      pickTrack: function (i) { this.m.trackIndex = i; this.m.progress = 0; this.m.playing = true; },
      dial: function (c) {
        if (!c) return;
        this.bt.call = { state: 'dialing', name: c.name, number: c.number, seconds: 0 };
        var self = this;
        global.setTimeout(function () {
          if (self.bt.call && self.bt.call.state === 'dialing') self.bt.call.state = 'talking';
        }, 1800);
      },
      hangup: function () { this.bt.call = { state: 'idle', name: '', number: '', seconds: 0 }; }
    },
    template:
      '<div class="view view-media">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">媒体</h2>' +
          '<div class="ph-tabs">' +
            '<button v-for="t in tabList" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">' +
              '<c-icon :name="t.icon" :size="16"></c-icon>{{ t.label }}' +
            '</button>' +
          '</div>' +
        '</header>' +

        /* ---------- 音乐 ---------- */
        '<template v-if="tab === \'music\'">' +
          '<section class="card now-card" :class="{ playing: m.playing }">' +
            '<div class="album" :class="{ spin: m.playing }">' +
              '<c-icon name="media" :size="46"></c-icon>' +
            '</div>' +
            '<div class="now-info">' +
              '<b class="now-title">{{ track.title }}</b>' +
              '<span class="now-artist">{{ track.artist }}</span>' +
              '<span class="now-src">{{ m.source === \'radio\' ? \'收音机\' : (m.source === \'local\' ? \'本地音频\' : \'在线音乐\') }}</span>' +
            '</div>' +
          '</section>' +

          '<section class="card player-card">' +
            '<input class="seek" type="range" min="0" max="100" :value="progressPct" aria-label="播放进度" @input="seek">' +
            '<div class="times"><span>{{ fmt(m.progress) }}</span><span>{{ fmt(track.duration || 0) }}</span></div>' +
            '<div class="transport">' +
              '<button class="tp" aria-label="上一首" @click="prev"><c-icon name="prev" :size="26"></c-icon></button>' +
              '<button class="tp tp-play" :aria-label="m.playing ? \'暂停\' : \'播放\'" @click="togglePlay"><c-icon :name="m.playing ? \'pause\' : \'play\'" :size="32"></c-icon></button>' +
              '<button class="tp" aria-label="下一首" @click="next"><c-icon name="next" :size="26"></c-icon></button>' +
            '</div>' +
          '</section>' +

          '<section class="card vol-card">' +
            '<button class="vol-mute" :class="{ on: m.mute }" aria-label="静音" @click="m.mute = !m.mute"><c-icon :name="m.mute ? \'mute\' : \'volume\'" :size="22"></c-icon></button>' +
            '<input class="vol-range" type="range" min="0" max="100" v-model.number="m.volume" aria-label="音量">' +
            '<b class="vol-val">{{ m.volume }}</b>' +
          '</section>' +

          '<section class="card list-card">' +
            '<h3 class="card-title">播放列表</h3>' +
            '<ul class="track-list">' +
              '<li v-for="(t, i) in m.tracks" :key="i" :class="{ on: i === m.trackIndex }" @click="pickTrack(i)">' +
                '<span class="tl-idx">{{ i + 1 }}</span>' +
                '<div class="tl-main"><b>{{ t.title }}</b><small>{{ t.artist }}</small></div>' +
                '<span class="tl-dur">{{ fmt(t.duration) }}</span>' +
                '<c-icon :name="i === m.trackIndex && m.playing ? \'pause\' : \'play\'" :size="18"></c-icon>' +
              '</li>' +
            '</ul>' +
          '</section>' +
        '</template>' +

        /* ---------- 蓝牙通话 ---------- */
        '<template v-if="tab === \'bt\'">' +
          '<section class="card bt-card">' +
            '<div class="bt-head">' +
              '<span class="bt-ico"><c-icon name="bt" :size="24"></c-icon></span>' +
              '<div class="bt-info">' +
                '<b>{{ bt.device || \'未连接设备\' }}</b>' +
                '<small>{{ bt.connected ? \'已连接 · 电量 \' + bt.battery + \'%\' : \'蓝牙未连接\' }}</small>' +
              '</div>' +
              '<button class="bt-toggle" :class="{ on: bt.connected }" @click="bt.connected = !bt.connected">{{ bt.connected ? \'断开\' : \'连接\' }}</button>' +
            '</div>' +
          '</section>' +

          '<section v-if="callActive" class="card call-card live">' +
            '<span class="call-av"><c-icon name="phone" :size="26"></c-icon></span>' +
            '<div class="call-info"><b>{{ bt.call.name }}</b><small>{{ bt.call.number }} · {{ callText }}</small></div>' +
            '<button class="call-end" aria-label="挂断" @click="hangup"><c-icon name="phone" :size="22"></c-icon></button>' +
          '</section>' +

          '<section class="card list-card">' +
            '<h3 class="card-title">联系人</h3>' +
            '<ul class="contact-list">' +
              '<li v-for="(c, i) in bt.contacts" :key="i">' +
                '<span class="ct-av">{{ c.name.slice(0, 1) }}</span>' +
                '<div class="ct-main"><b>{{ c.name }}</b><small>{{ c.number }}</small></div>' +
                '<button class="ct-call" aria-label="拨打电话" @click="dial(c)"><c-icon name="phone" :size="18"></c-icon>拨打</button>' +
              '</li>' +
            '</ul>' +
          '</section>' +

          '<section class="card list-card">' +
            '<h3 class="card-title">最近通话</h3>' +
            '<ul class="record-list">' +
              '<li v-for="(r, i) in bt.recent" :key="i">' +
                '<c-icon :name="r.type === \'in\' ? \'phone\' : \'phone\'" :size="18"></c-icon>' +
                '<div class="ct-main"><b>{{ r.name }}</b><small>{{ r.time }}</small></div>' +
                '<span class="rc-type" :class="\'t-\' + r.type">{{ r.type === \'in\' ? \'呼入\' : (r.type === \'out\' ? \'呼出\' : \'未接\') }}</span>' +
              '</li>' +
            '</ul>' +
          '</section>' +
        '</template>' +

        /* ---------- 本地音频 ---------- */
        '<template v-if="tab === \'local\'">' +
          '<section class="card radio-card" :class="{ on: m.source === \'radio\' }">' +
            '<div class="rd-head"><c-icon name="radio" :size="24"></c-icon><div><b>收音机</b><small>{{ m.radio.name }}</small></div></div>' +
            '<div class="rd-freq">{{ m.radio.freq }}<i>MHz</i></div>' +
            '<div class="rd-actions">' +
              '<button class="btn" @click="setSource(\'radio\')">收听</button>' +
              '<button class="btn" @click="m.source = \'local\'">本地音频</button>' +
            '</div>' +
          '</section>' +

          '<section class="card list-card">' +
            '<h3 class="card-title">本地音频（U 盘 / 车机存储）</h3>' +
            '<ul class="track-list">' +
              '<li v-for="(t, i) in m.tracks" :key="i" :class="{ on: i === m.trackIndex && m.source === \'local\' }" @click="setSource(\'local\'); pickTrack(i)">' +
                '<span class="tl-idx">{{ i + 1 }}</span>' +
                '<div class="tl-main"><b>{{ t.title }}</b><small>{{ t.artist }} · MP3 320kbps</small></div>' +
                '<span class="tl-dur">{{ fmt(t.duration) }}</span>' +
                '<c-icon name="play" :size="18"></c-icon>' +
              '</li>' +
            '</ul>' +
          '</section>' +
        '</template>' +
      '</div>'
  };

  global.CMediaView = media;
})(window);
