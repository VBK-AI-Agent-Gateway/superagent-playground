/*!
 * js/views/voice-panel.js — 模块 6：语音助手
 * 唤醒词【你好，斑马 / 你好荣威】、连续对话窗口、可见即可说指令列表、文字模拟兜底。
 * 语音层状态存放在 CockpitState.voice，本页只做展示与手动输入。
 */
(function (global) {
  'use strict';

  var voicePanel = {
    data: function () { return { S: global.CockpitState, text: '' }; },
    computed: {
      v: function () { return this.S.voice; },
      supported: function () { return global.CockpitVoice.supported; },
      wakeWords: function () { return (global.COCKPIT_CONFIG.voice.wakeWords || []).join(' / '); },
      windowSec: function () { return Math.round((global.COCKPIT_CONFIG.voice.continuousWindowMs || 8000) / 1000); },
      entries: function () { return global.CockpitVoiceRegistry.list(); },
      log: function () { return global.CockpitVoiceLog.slice(-8).reverse(); },
      listening: function () { return !!(this.v.listening || this.v.wake); },
      stateKey: function () { return this.listening ? 'listening' : (this.v.speaking ? 'speaking' : 'idle'); },
      stateText: function () {
        return this.listening ? '正在聆听…' : (this.v.speaking ? '正在播报…' : '待唤醒');
      },
      examples: function () {
        return ['你好，斑马', '打开空调', '把温度调到 24 度', '导航到虹桥火车站', '播放音乐', '打开天窗', '我有点热'];
      }
    },
    mounted: function () {
      var self = this;
      this._uns = [
        global.CockpitVoiceRegistry.register({
          id: 'voice.help', scope: 'voice', label: '语音帮助',
          phrases: ['你能做什么', '语音帮助', '有什么功能', '帮助'],
          handler: function () { return '我支持 ' + global.CockpitVoiceRegistry.count() + ' 条语音指令，可在语音页查看完整列表。'; }
        }),
        global.CockpitVoiceRegistry.register({
          id: 'voice.wake', scope: 'voice', label: '唤醒语音',
          phrases: ['你好斑马', '你好荣威', '你好，斑马', '你好，荣威'],
          handler: function () { global.CockpitVoice.startListening({ manual: true }); return '在的，请说。'; }
        })
      ];
    },
    beforeUnmount: function () { (this._uns || []).forEach(function (fn) { fn(); }); },
    methods: {
      fmtTime: function (t) {
        var d = new Date(t);
        return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
      },
      start: function () { global.CockpitVoice.startListening({ manual: true }); },
      stop: function () { global.CockpitVoice.stopListening(); },
      submit: function () {
        var t = (this.text || '').trim();
        if (!t) return;
        this.text = '';
        global.CockpitVoice.textFallback(t);
      },
      use: function (t) { this.text = t; this.submit(); },
      matchOf: function (t) {
        var hit = global.CockpitVoiceRegistry.match(t);
        return hit ? (hit.label || hit.id) : '未匹配';
      }
    },
    template:
      '<div class="view view-voice">' +
        '<header class="page-head">' +
          '<button class="ph-back" aria-label="返回主页" @click="$root.go(\'home\')"><c-icon name="back" :size="22"></c-icon></button>' +
          '<h2 class="ph-title">语音助手</h2>' +
          '<span class="ph-status"><c-icon name="voice" :size="16"></c-icon>{{ supported ? \'已就绪\' : \'模拟模式\' }}</span>' +
        '</header>' +

        /* ---------- 唤醒与状态 ---------- */
        '<section class="card voice-hero" :class="\'st-\' + stateKey">' +
          '<button class="orb-big" :class="{ live: listening }" :aria-label="listening ? \'停止聆听\' : \'开始聆听\'" @click="listening ? stop() : start()">' +
            '<span class="orb-ring"></span><span class="orb-ring d2"></span>' +
            '<c-icon name="voice" :size="46"></c-icon>' +
          '</button>' +
          '<b class="vh-state">{{ stateText }}</b>' +
          '<small class="vh-wake">唤醒词：{{ wakeWords }}</small>' +
          '<small class="vh-note">连续对话窗口 {{ windowSec }} 秒，{{ supported ? \'已启用浏览器语音识别\' : \'当前浏览器不支持识别，已启用文字模拟\' }}</small>' +
          '<p v-if="v.transcript" class="vh-heard">识别到：“{{ v.transcript }}”</p>' +
          '<p v-if="v.reply" class="vh-reply">{{ v.reply }}</p>' +
        '</section>' +

        /* ---------- 文字输入（兜底，始终可用） ---------- */
        '<section class="card">' +
          '<h3 class="card-title">文字指令（模拟输入）</h3>' +
          '<div class="va-input">' +
            '<input v-model="text" type="text" placeholder="例如：打开空调 / 导航到虹桥火车站" aria-label="语音文字指令" @keyup.enter="submit">' +
            '<button class="btn btn-accent" @click="submit">发送</button>' +
          '</div>' +
          '<div class="chip-row wrap">' +
            '<button v-for="e in examples" :key="e" class="chip" @click="use(e)">{{ e }}</button>' +
          '</div>' +
        '</section>' +

        /* ---------- 可见即可说 ---------- */
        '<section class="card">' +
          '<div class="head-row"><h3 class="card-title">可见即可说（{{ entries.length }}）</h3>' +
            '<button class="mini-btn" @click="S.view = \'home\'">回到主页</button></div>' +
          '<ul class="va-list">' +
            '<li v-for="en in entries" :key="en.id">' +
              '<div class="va-main"><b>{{ en.label }}</b><small>{{ (en.phrases || []).join(\' / \') }}</small></div>' +
              '<span class="va-scope">{{ en.scope || \'全局\' }}</span>' +
              '<button class="ct-call" @click="use(en.phrases[0])">试试</button>' +
            '</li>' +
          '</ul>' +
        '</section>' +

        /* ---------- 对话记录 ---------- */
        '<section class="card">' +
          '<h3 class="card-title">最近对话</h3>' +
          '<ul v-if="log.length" class="va-log">' +
            '<li v-for="(l, i) in log" :key="i" :class="{ me: l.role === \'user\' }">' +
              '<span class="va-who">{{ l.role === \'user\' ? \'我\' : \'车机\' }}</span>' +
              '<div class="va-bubble"><p>{{ l.text }}</p><small>{{ fmtTime(l.at) }}</small></div>' +
            '</li>' +
          '</ul>' +
          '<p v-else class="hint">还没有对话记录，点击上方麦克风或输入文字开始。</p>' +
        '</section>' +
      '</div>'
  };

  global.CVoicePanelView = voicePanel;
})(window);
