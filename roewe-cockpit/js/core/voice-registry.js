/*!
 * 语音指令注册表 —— 实现「可见即可说」
 * 所有可点控件都会通过 say() 注册一条口语化指令；
 * 无 Web Speech API 的环境下，文字模拟对话走同一套解析逻辑。
 */
(function (global) {
  'use strict';

  var commands = [];

  /* 预置业务指令（无 UI 绑定也能用） */
  var builtin = [
    { id: 'sys.home', phrases: ['回到主页', '回主页', '主页', '首页'], desc: '回到主页', group: '系统' },
    { id: 'sys.nav', phrases: ['打开导航', '去导航', '导航'], desc: '打开导航', group: '系统' },
    { id: 'sys.media', phrases: ['打开音乐', '多媒体', '播放器'], desc: '打开多媒体', group: '系统' },
    { id: 'sys.climate', phrases: ['打开空调', '空调'], desc: '打开空调', group: '系统' },
    { id: 'sys.settings', phrases: ['车辆设置', '打开设置'], desc: '打开车辆设置', group: '系统' },
    { id: 'sys.system', phrases: ['系统设置', '设置页'], desc: '打开设置页', group: '系统' },
    { id: 'sys.surround', phrases: ['打开全景影像', '全景影像', '360'], desc: '打开 360 全景', group: '系统' },
    { id: 'sys.parking', phrases: ['打开泊车辅助', '泊车辅助', '泊车'], desc: '打开泊车辅助', group: '系统' },
    { id: 'sys.theme', phrases: ['切换主题', '换主题', '深色模式', '浅色模式'], desc: '切换主题', group: '系统' },
    { id: 'sys.back', phrases: ['返回', '回去'], desc: '返回上一页', group: '系统' }
  ];

  function normalize(text) {
    return String(text || '')
      .replace(/\s+/g, '')
      .replace(/[，。！？、,.!?]/g, '')
      .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 65248); });
  }

  function register(cmd) {
    if (!cmd || !cmd.desc) return;
    var key = cmd.id || cmd.desc;
    var i = commands.findIndex(function (c) { return c.id === key; });
    if (i >= 0) commands.splice(i, 1);
    commands.push({
      id: key,
      phrases: (cmd.phrases || []).concat([cmd.desc]).map(normalize),
      desc: cmd.desc,
      group: cmd.group || '其他',
      run: cmd.run || function () {},
      visible: cmd.visible !== false
    });
  }

  /* 供界面调用：为任何可点控件绑定语音指令
   * say('打开空调', ['开空调'], () => ...)
   */
  function say(desc, phrases, run, group) {
    register({ desc: desc, phrases: phrases, run: run, group: group });
    return desc;
  }

  /* 匹配一句话：优先整句匹配，其次做「包含 + 关键词打分」 */
  function match(text) {
    var q = normalize(text);
    if (!q) return null;
    var best = null;
    var bestScore = 0;
    commands.forEach(function (cmd) {
      cmd.phrases.forEach(function (p) {
        if (!p) return;
        var score = 0;
        if (q === p) score = 1000 + p.length;
        else if (q.indexOf(p) >= 0) score = 700 + p.length;
        else if (p.indexOf(q) >= 0 && q.length >= 2) score = 400 + q.length;
        if (score > bestScore) { bestScore = score; best = cmd; }
      });
    });
    return bestScore > 0 ? best : null;
  }

  function all() {
    return commands.filter(function (c) { return c.visible; });
  }

  builtin.forEach(register);

  global.RoeweVoiceRegistry = {
    register: register,
    say: say,
    match: match,
    all: all,
    normalize: normalize,
    commands: commands
  };
})(window);
