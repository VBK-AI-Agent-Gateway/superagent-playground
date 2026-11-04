/*!
 * 语音助手面板
 * 规格：唤醒词「你好，斑马」「你好荣威」、连续对话、每个控件「可见即可说」绑定、
 *       Web Speech API + 文字输入降级方案
 */
(function (global) {
  'use strict';

  global.VoicePanelView = {
    name: 'VoicePanelView',
    inject: ['ctx'],
    data: function () {
      return { text: '' };
    },
    computed: {
      state: function () { return this.ctx.state; },
      voice: function () { return this.ctx.state.voice; },
      commands: function () { return global.RoeweVoiceRegistry.all(); },
      groups: function () {
        var map = {};
        this.commands.forEach(function (c) {
          var g = c.group || '通用';
          (map[g] = map[g] || []).push(c);
        });
        return Object.keys(map).map(function (k) { return { name: k, items: map[k] }; });
      },
      modeText: function () {
        return this.voice.mode === 'text' ? '文字模拟对话' : (this.voice.supported ? '语音识别可用' : '文字模拟对话');
      },
      awakeText: function () { return this.voice.awake ? '已唤醒' : '待唤醒'; }
    },
    mounted: function () {
      this.ctx.voice.addMessage('ai', '你好，我是荣威语音助手。说「你好，斑马」唤醒，或直接输入指令。');
    },
    methods: {
      send: function () {
        var t = this.text.trim();
        if (!t) return;
        this.ctx.voice.submit(t, true);
        this.text = '';
      },
      quick: function (c) {
        this.ctx.voice.submit(c.phrases[0] || c.desc, true);
      },
      wake: function () { this.ctx.voice.wake(); },
      sleep: function () { this.ctx.voice.sleep(); },
      toggleMic: function () { this.ctx.voice.toggleMic(); }
    },
    template: [
      '<div class="page-scroll">',
      '  <div class="grid">',

      /* ---------- 语音状态 ---------- */
      '    <card-panel class="col-3" title="语音助手" icon="mic">',
      '      <div class="center stack" style="align-items:center;gap:.16rem">',
      '        <div class="voice-orb" :class="{ \'is-awake\': voice.awake, \'is-listening\': voice.listening }">',
      '          <span class="voice-orb__ring"></span>',
      '          <rw-icon name="mic" :size="64"></rw-icon>',
      '        </div>',
      '        <div class="voice-wave"><i></i><i></i><i></i><i></i><i></i></div>',
      '        <span class="chip" :class="voice.awake ? \'chip--ok\' : \'\'">{{ awakeText }} · {{ modeText }}</span>',
      '        <div class="strip" style="justify-content:center">',
      '          <button class="btn btn--sm btn--primary" @click="wake">唤醒</button>',
      '          <button class="btn btn--sm btn--ghost" @click="sleep">休眠</button>',
      '          <button class="btn btn--sm" :class="voice.listening ? \'btn--on\' : \'btn--ghost\'" @click="toggleMic">',
      '            <rw-icon name="mic" :size="20"></rw-icon>收音',
      '          </button>',
      '        </div>',
      '      </div>',
      '      <div class="card__hint">唤醒词：你好，斑马 / 你好荣威。唤醒后可连续对话，无需重复唤醒。</div>',
      '    </card-panel>',

      /* ---------- 对话记录 ---------- */
      '    <card-panel class="col-3" title="对话" icon="chat">',
      '      <div class="voice-msgs">',
      '        <div v-if="!voice.messages.length" class="muted center" style="font-size:.2rem">还没有对话，试试说「导航到上海虹桥火车站」</div>',
      '        <div v-for="(m, i) in voice.messages" :key="i" class="voice-bubble" :class="m.role === \'user\' ? \'voice-bubble--user\' : \'voice-bubble--ai\'">',
      '          <span class="muted" style="font-size:.17rem">{{ m.role === \'user\' ? \'我\' : \'荣威\' }} · {{ m.time }}</span>',
      '          <span>{{ m.text }}</span>',
      '        </div>',
      '      </div>',
      '      <div class="voice-input">',
      '        <input type="text" v-model="text" @keyup.enter="send" placeholder="输入指令，例如：打开空调" aria-label="语音指令输入">',
      '        <button class="btn btn--primary btn--sm" @click="send">发送</button>',
      '      </div>',
      '      <div class="card__hint" v-if="!voice.supported">当前环境不支持语音识别，已启用文字模拟对话</div>',
      '    </card-panel>',

      /* ---------- 可见即可说：全量指令 ---------- */
      '    <card-panel class="col-6" title="可见即可说 · 全量指令" icon="list">',
      '      <div v-for="g in groups" :key="g.name" style="margin-bottom:.16rem">',
      '        <div class="strip" style="margin-bottom:.08rem">',
      '          <span class="tag tag--ok">{{ g.name }}</span><span class="muted" style="font-size:.18rem">{{ g.items.length }} 条</span>',
      '        </div>',
      '        <div class="voice-cmds">',
      '          <button v-for="c in g.items" :key="c.id" class="voice-cmd" @click="quick(c)">',
      '            <rw-icon name="mic" :size="20"></rw-icon>',
      '            <span class="grow">{{ c.desc }}</span>',
      '            <span class="muted" style="font-size:.17rem">{{ c.phrases[0] }}</span>',
      '          </button>',
      '        </div>',
      '      </div>',
      '    </card-panel>',

      '  </div>',
      '</div>'
    ].join('\n')
  };
})(window);
