/*!
 * js/core/voice.js — 语音助手核心
 * 优先使用 Web Speech API（SpeechRecognition 识别 + SpeechSynthesis 播报）；
 * 浏览器不支持（如 Firefox / 无网络）时自动降级为文字模拟对话，交互逻辑完全一致。
 */
(function (global) {
  'use strict';

  var cfg = global.COCKPIT_CONFIG || {};
  var vcfg = cfg.voice || {};
  var S = global.CockpitState;
  var registry = global.CockpitVoiceRegistry;

  var SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;
  var synth = global.speechSynthesis || null;

  var recog = null;
  var continuousTimer = null;
  var restarting = false;

  /* ---------- 内置兜底问答（未命中「可见即可说」指令时） ---------- */
  var FALLBACK = [
    { k: ['你好', '您好', '嗨'],                       a: function () { return '你好，我在。可以说“打开空调”“导航去虹桥”“下一首”。'; } },
    { k: ['能做什么', '会什么', '帮助', '功能'],       a: function () { return '我能控制空调、媒体、导航、车灯与车窗，也能打开 360 全景和泊车辅助。'; } },
    { k: ['时间', '几点'],                             a: function () { return '现在是 ' + S.clock.time + '。'; } },
    { k: ['天气'],                                     a: function () { var w = S.data.weather; return w.city + '，' + w.text + '，' + w.now + '℃，最高 ' + w.high + '℃。'; } },
    { k: ['电量', '续航'],                             a: function () { var v = S.data.vehicle; return '当前电量 ' + v.battery + '%，剩余续航约 ' + v.range + ' 公里。'; } },
    { k: ['油量', '油耗'],                             a: function () { var v = S.data.vehicle; return '油量 ' + v.fuel + '%，百公里油耗 ' + v.fuelPer100 + ' 升。'; } },
    { k: ['车速', '速度'],                             a: function () { return '当前车速 ' + S.data.vehicle.speed + ' 公里每小时，挡位 ' + S.gear + ' 挡。'; } },
    { k: ['挡位', '档位'],                             a: function () { return '当前是 ' + S.gear + ' 挡。'; } },
    { k: ['谢谢', '感谢'],                             a: function () { return '不客气。'; } },
    { k: ['再见', '退下', '关闭语音'],                 a: function () { global.setTimeout(function () { voice.stopListening(); }, 600); return '好的，先退下了。'; } }
  ];

  function pickFallback(text) {
    var t = String(text || '');
    for (var i = 0; i < FALLBACK.length; i++) {
      for (var j = 0; j < FALLBACK[i].k.length; j++) {
        if (t.indexOf(FALLBACK[i].k[j]) !== -1) return FALLBACK[i].a();
      }
    }
    return null;
  }

  var voice = {
    supported: !!SR,
    synthSupported: !!synth,

    init: function () {
      if (!SR) {
        S.voice.available = false;
        return false;
      }
      try {
        recog = new SR();
        recog.lang = vcfg.lang || 'zh-CN';
        recog.continuous = true;
        recog.interimResults = true;
        recog.maxAlternatives = 1;

        recog.onstart = function () {
          S.voice.listening = true;
          S.voice.wake = true;
        };
        recog.onend = function () {
          S.voice.listening = false;
          if (restarting && S.voice.wake) {
            restarting = false;
            try { recog.start(); } catch (e) { /* 忽略重复 start */ }
          }
        };
        recog.onerror = function (ev) {
          S.voice.listening = false;
          if (ev && ev.error === 'not-allowed') {
            S.voice.available = false;
            global.CockpitSafety.notify({ text: '麦克风权限未开启，已切换文字指令', icon: 'mic', level: 'warn' });
          } else if (ev && (ev.error === 'network' || ev.error === 'service-not-allowed')) {
            S.voice.available = false;
            global.CockpitSafety.notify({ text: '语音服务不可用，已切换文字模拟对话', icon: 'mic', level: 'warn' });
          }
        };
        recog.onresult = function (ev) {
          var interim = '', final = '';
          for (var i = ev.resultIndex; i < ev.results.length; i++) {
            var r = ev.results[i];
            if (r.isFinal) final += r[0].transcript;
            else interim += r[0].transcript;
          }
          S.voice.transcript = (final || interim).trim();
          if (final) {
            if (isWake(S.voice.transcript)) {
              S.voice.transcript = '';
              voice.speak('我在，请讲。');
              return;
            }
            voice.handle(S.voice.transcript);
          }
        };
        S.voice.available = true;
        return true;
      } catch (e) {
        S.voice.available = false;
        return false;
      }
    },

    /* ---------- 唤醒词 ---------- */
    isWake: function (t) { return isWake(t); },

    startListening: function (opts) {
      opts = opts || {};
      S.voice.wake = true;
      if (!recog) {
        S.voice.listening = false;
        return false;
      }
      try {
        recog.start();
        S.voice.listening = true;
        return true;
      } catch (e) {
        /* 已在监听中 */
        S.voice.listening = true;
        return true;
      } finally {
        if (opts.keepAlive !== false) this.scheduleContinuous();
      }
    },

    stopListening: function () {
      restarting = false;
      if (continuousTimer) { global.clearTimeout(continuousTimer); continuousTimer = null; }
      S.voice.listening = false;
      S.voice.wake = false;
      if (recog) { try { recog.stop(); } catch (e) { /* noop */ } }
    },

    /* 连续对话：回答后保持聆听窗口 */
    scheduleContinuous: function () {
      if (continuousTimer) global.clearTimeout(continuousTimer);
      var self = this;
      continuousTimer = global.setTimeout(function () {
        if (S.voice.listening || S.voice.speaking) return;   // 还在对话中，不打扰
      }, vcfg.continuousWindowMs || 8000);
    },

    /* ---------- 语音 → 指令 ---------- */
    handle: function (text) {
      var t = String(text || '').trim();
      if (!t) return { ok: false, reply: '没有听清，请再说一次。' };
      S.voice.transcript = t;
      global.CockpitVoiceLog.push({ role: 'user', text: t, at: Date.now() });

      var hit = registry ? registry.match(t) : null;
      var reply;
      if (hit) {
        try {
          reply = hit.entry.handler();
        } catch (e) {
          reply = '这个操作暂时不可用。';
        }
        if (typeof reply !== 'string') reply = hit.entry.label + ' 已执行';
      } else {
        reply = pickFallback(t);
        if (!reply) {
          reply = '暂时不支持“' + t + '”。可以说“打开空调”“导航去虹桥火车站”“打开 360 全景”。';
        }
      }
      global.CockpitVoiceLog.push({ role: 'assistant', text: reply, at: Date.now() });
      S.voice.reply = reply;
      this.speak(reply);
      return { ok: true, reply: reply, matched: !!hit, command: hit ? hit.entry.label : null };
    },

    /* ---------- 播报 ---------- */
    speak: function (text) {
      S.voice.reply = text;
      if (!synth || !text) return;
      try {
        synth.cancel();
        var u = new global.SpeechSynthesisUtterance(text);
        u.lang = vcfg.lang || 'zh-CN';
        u.rate = 1.05;
        u.pitch = 1;
        u.onstart = function () { S.voice.speaking = true; };
        u.onend = function () { S.voice.speaking = false; };
        u.onerror = function () { S.voice.speaking = false; };
        synth.speak(u);
      } catch (e) { /* 忽略播报失败 */ }
    },

    /* ---------- 无 Web Speech API 时的文字模拟入口 ---------- */
    textFallback: function (text) { return this.handle(text); }
  };

  function isWake(t) {
    var words = vcfg.wakeWords || [];
    var s = String(t || '').replace(/[\s,，。.、!！?？]/g, '');
    for (var i = 0; i < words.length; i++) {
      if (s.indexOf(words[i].replace(/[\s,，。.、!！?？]/g, '')) !== -1) return true;
    }
    return false;
  }

  /* 对话记录（浮层与语音页共用） */
  global.CockpitVoiceLog = [];

  global.CockpitVoice = voice;
})(window);
