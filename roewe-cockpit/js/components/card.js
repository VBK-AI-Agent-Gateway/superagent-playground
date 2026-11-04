/*!
 * 卡片容器组件：统一车载级卡片外观 + 语音指令绑定（可见即可说）
 */
(function (global) {
  'use strict';

  global.CardPanel = {
    name: 'CardPanel',
    props: {
      title: { type: String, default: '' },
      icon: { type: String, default: '' },
      span: { type: [Number, String], default: 1 },
      openable: { type: Boolean, default: false },
      view: { type: String, default: '' },
      tone: { type: String, default: '' },
      say: { type: String, default: '' },
      sayPhrases: { type: Array, default: function () { return []; } }
    },
    inject: ['ctx'],
    computed: {
      cls: function () {
        return [
          'card',
          this.tone ? 'card--' + this.tone : '',
          this.openable ? 'card--tappable' : ''
        ];
      }
    },
    mounted: function () {
      if (this.say) {
        var self = this;
        global.RoeweVoiceRegistry.say(this.say, this.sayPhrases, function () { self.activate(); });
      }
    },
    methods: {
      activate: function () {
        if (this.openable && this.view) this.ctx.router.push(this.view);
      }
    },
    template: [
      '<section :class="cls" @click="activate">',
      '  <header v-if="title" class="card__head">',
      '    <rw-icon v-if="icon" :name="icon" :size="26"></rw-icon>',
      '    <h3>{{ title }}</h3>',
      '    <slot name="head-right"></slot>',
      '  </header>',
      '  <div class="card__body"><slot></slot></div>',
      '</section>'
    ].join('\n')
  };
})(window);
