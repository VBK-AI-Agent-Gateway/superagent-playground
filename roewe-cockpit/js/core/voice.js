/*!
 * 语音助手：Web Speech API（SpeechRecognition / SpeechSynthesis）
 * 不支持时自动降级为文字模拟对话（同一套指令解析）。
 */
(function (global) {
  'use strict';

  var Registry = global.RoeweVoiceRegistry;

  function createVoiceAssistant(ctx) {
    var state = ctx.state;
    var toast = ctx.toast;
    var router = ctx.router;
    var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
    var synthesis = global.speechSynthesis;

    var recognition = null;
    var restartTimer = null;

    state.voice.supported = !!SR;
    state.voice.mode = SR ? 'speech' : 'text';

    function now() {
      return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
    }

    function addMessage(role, text) {
      state.voice.messages.push({ id: Date.now() + Math.random(), role: role, text: text, at: now() });
      if (state.voice.messages.length > 30) state.voice.messages.shift();
    }

    /* ---------------- 语音播报 ---------------- */
    function speak(text) {
      addMessage('assistant', text);
      if (!synthesis || !text) return;
      try {
        synthesis.cancel();
        var utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN';
        utter.rate = 1.05;
        utter.pitch = 1;
        utter.onstart = function () { state.voice.speaking = true; };
        utter.onend = function () { state.voice.speaking = false; };
        synthesis.speak(utter);
      } catch (e) {
        state.voice.speaking = false;
      }
    }

    /* ---------------- 指令执行 ---------------- */
    function runCommand(text) {
      var normalized = Registry.normalize(text);
      if (!normalized) return false;

      /* 唤醒词 */
      if (/^(你好斑马|你好荣威|你好小威|嗨荣威)/.test(normalized)) {
        state.voice.awake = true;
        return respond('在呢，请讲');
      }
      if (/(退下|再见|关闭语音|休眠)/.test(normalized)) {
        state.voice.awake = false;
        return respond('好的，需要我时喊「你好荣威」');
      }

      /* 特殊业务指令在各自模块注册时已带 run 回调，这里统一派发 */
      var cmd = Registry.match(normalized);
      if (cmd) {
        try { cmd.run(); } catch (e) { /* 单个指令失败不影响对话 */ }
        return respond('好的，' + cmd.desc);
      }

      /* 未命中注册指令时的兜底回应 */
      if (/导航|去|到/.test(normalized)) {
        state.nav.destination = normalized.replace(/^(导航到|导航|我要去|去)/, '') || '上海虹桥火车站';
        router.push('nav');
        return respond('已为你规划到' + state.nav.destination + '的路线');
      }
      return respond('抱歉，我还没学会这条指令，你可以说「' + randomHint() + '」');
    }

    function respond(text) {
      speak(text);
      return true;
    }

    function randomHint() {
      var list = global.ROEWE_MOCK.voiceCommands;
      return list[Math.floor(Math.random() * list.length)];
    }

    /* 外部（文字输入 / 点击快捷指令）统一入口 */
    function submit(text, fromUser) {
      if (!text) return;
      addMessage('user', text);
      state.voice.transcript = text;
      var ok = runCommand(text);
      if (!ok) respond('抱歉，没有听清，请再说一遍');
    }

    /* ---------------- 唤醒词监听 ---------------- */
    function ensureRecognition() {
      if (!SR || recognition) return recognition;
      recognition = new SR();
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = function () {
        state.voice.listening = true;
      };
      recognition.onerror = function (e) {
        state.voice.listening = false;
        if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')) {
          state.voice.mode = 'text';
          state.voice.supported = false;
          toast.warn('浏览器未授权麦克风，已切换为文字模拟对话');
        }
      };
      recognition.onend = function () {
        state.voice.listening = false;
        /* 连续对话：短暂静默后自动重新开始监听 */
        if (state.voice.awake && state.voice.mode === 'speech') {
          if (restartTimer) clearTimeout(restartTimer);
          restartTimer = setTimeout(function () {
            try { recognition.start(); } catch (e) { /* 已在监听 */ }
          }, 700);
        }
      };
      recognition.onresult = function (event) {
        var interim = '';
        var finalText = '';
        for (var i = event.resultIndex; i < event.results.length; i++) {
          var res = event.results[i];
          if (res.isFinal) finalText += res[0].transcript;
          else interim += res[0].transcript;
        }
        state.voice.transcript = finalText || interim;
        if (finalText) {
          var t = Registry.normalize(finalText);
          if (!state.voice.awake) {
            if (/你好斑马|你好荣威|你好小威/.test(t)) {
              state.voice.awake = true;
              respond('在呢，请讲');
            }
          } else {
            submit(finalText, true);
          }
        }
      };
      return recognition;
    }

    function wake() {
      state.voice.awake = true;
      if (state.voice.mode === 'speech') {
        try { ensureRecognition().start(); } catch (e) { /* 忽略重复启动 */ }
      }
      respond('你好，我是斑马，请讲');
    }

    function sleep() {
      state.voice.awake = false;
      if (recognition) { try { recognition.stop(); } catch (e) {} }
    }

    function toggleMic() {
      if (state.voice.mode !== 'speech') {
        toast.info('当前浏览器不支持语音识别，请使用文字输入');
        return;
      }
      if (state.voice.listening) {
        sleep();
      } else {
        wake();
      }
    }

    return {
      submit: submit,
      speak: speak,
      wake: wake,
      sleep: sleep,
      toggleMic: toggleMic,
      runCommand: runCommand,
      addMessage: addMessage
    };
  }

  global.createVoiceAssistant = createVoiceAssistant;
})(window);
