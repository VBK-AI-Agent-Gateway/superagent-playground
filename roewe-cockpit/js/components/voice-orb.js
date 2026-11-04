/*!
 * js/components/voice-orb.js — 全局语音悬浮入口
 * 常驻屏幕右下侧（不遮挡车速与挡位），点按开始/结束聆听；
 * 支持唤醒词监听、连续对话，不支持 Web Speech API 时提示切换文字指令。
 */
(function (global) {
  'use strict';

  var voiceOrb = {
    data: function () { return { S: global.CockpitState, text: '', showInput: false }; },
    computed: {
      listening: function () { return this.S.voice.listening; },
      speaking: function () { return this.S.voice.speaking; },
      available: function () { return this.S.voice.available; },
      tip: function () {
        if (!this.available) return '当前浏览器不支持语音识别，已切换为文字指令';
        if (this.listening) return this.S.voice.transcript || '正在聆听…';
        if (this.speaking) return this.S.voice.reply;
        return '点按说话 · 或说“你好，斑马”';
      },
      wakeLabel: function () { return (global.COCKPIT_CONFIG.voice.wakeWords || []).join(' / '); }
    },
    methods: {
      toggle: function () {
        if (this.listening) { global.CockpitVoice.stopListening(); return; }
        global.CockpitVoice.startListening();
      },
      openText: function () { this.showInput = true; this.$nextTick(function () { if (this.$refs.input) this.$refs.input.focus(); }); },
      submitText: function () {
        var t = (this.text || '').trim();
        if (!t) return;
        global.CockpitVoice.handle(t);
        this.text = '';
      },
      goPanel: function () { global.CockpitRouter.go('voice'); }
    },
    template:
      '<div class="voice-orb-host">' +
        '<transition name="orb-pop">' +
          '<div v-if="listening || speaking" class="orb-bubble">' +
            '<span class="orb-dot"></span>' +
            '<span class="orb-text">{{ tip }}</span>' +
          '</div>' +
        '</transition>' +

        '<div class="orb-actions">' +
          '<button class="orb-mini" :title="\'打开语音助手（唤醒词：\' + wakeLabel + \'）\'" aria-label="打开语音助手" @click="goPanel">' +
            '<c-icon name="mic" :size="18"></c-icon>' +
          '</button>' +
          '<button class="orb-mini" title="文字指令（无麦克风时可用）" aria-label="文字指令" @click="openText">' +
            '<c-icon name="list" :size="18"></c-icon>' +
          '</button>' +
        '</div>' +

        '<button class="voice-orb" :class="{ listening: listening, speaking: speaking, off: !available }" ' +
                :aria-label="listening ? \'结束聆听\' : \'开始语音指令\'" @click="toggle">' +
          '<c-icon :name="listening ? \'wave\' : \'mic\'" :size="30"></c-icon>' +
          '<span class="orb-ring"></span>' +
        '</button>' +

        '<transition name="orb-pop">' +
          '<div v-if="showInput" class="orb-input">' +
            '<input ref="input" v-model="text" class="orb-field" type="text" placeholder="例如：打开空调 24 度" @keyup.enter="submitText">' +
            '<button class="orb-send" @click="submitText"><c-icon name="chevron" :size="18"></c-icon></button>' +
            '<button class="orb-cancel" aria-label="关闭" @click="showInput = false"><c-icon name="close" :size="16"></c-icon></button>' +
          '</div>' +
        '</transition>' +
      '</div>'
  };

  global.CVoiceOrb = voiceOrb;
})(window);
