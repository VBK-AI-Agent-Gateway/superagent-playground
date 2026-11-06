/*!
 * js/core/voice-registry.js — “可见即可说”指令注册表
 * 每个可点击控件在 mounted 时注册自己的语音说法，卸载时注销；
 * 语音层据此实现“页面上看得见的，就能说得出来”。
 */
(function (global) {
  'use strict';

  var entries = [];
  var seq = 0;

  /* 常见前缀与语气词，匹配前先剥离 */
  var PREFIX = /^(请|帮我|麻烦|给我|我要|我想|我要把|把|需要|给我把)/;
  var TAIL = /(吧|呢|啊|呀|好吗|可以吗|谢谢)$/;

  function normalize(text) {
    if (text === null || text === undefined) return '';
    var t = String(text).trim();
    /* 去掉标点（中英文） */
    t = t.replace(/[\s，。、！？：；“”‘’（）《》,.!?:;"'()<>[\]{}~`@#$%^&*_+=|\\/-]+/g, '');
    /* 反复剥离前缀 */
    var guard = 0;
    while (PREFIX.test(t) && guard++ < 4) t = t.replace(PREFIX, '');
    var g2 = 0;
    while (TAIL.test(t) && g2++ < 4) t = t.replace(TAIL, '');
    return t.toLowerCase();
  }

  function phrasesOf(entry) {
    if (!entry) return [];
    var raw = entry.phrases || entry.phrase || [];
    if (typeof raw === 'string') raw = [raw];
    if (!Array.isArray(raw)) return [];
    return raw.map(function (p) { return String(p); }).filter(function (p) { return p.length; });
  }

  function register(entry) {
    if (!entry || !entry.id) return function () {};
    var record = {
      id: entry.id,
      label: entry.label || entry.id,
      scope: entry.scope || 'global',
      description: entry.description || '',
      handler: typeof entry.handler === 'function' ? entry.handler : function () {},
      phrases: phrasesOf(entry),
      _k: ++seq
    };
    /* 同 id 重复注册时以最新为准 */
    var old = entries.map(function (e) { return e.id; }).indexOf(record.id);
    if (old >= 0) entries.splice(old, 1);
    entries.push(record);
    record.norm = record.phrases.map(normalize).filter(function (p) { return p.length; });

    var alive = true;
    return function unregister() {
      if (!alive) return;
      alive = false;
      var i = entries.indexOf(record);
      if (i >= 0) entries.splice(i, 1);
    };
  }

  function match(text) {
    var q = normalize(text);
    if (!q) return null;
    var best = null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      for (var j = 0; j < e.norm.length; j++) {
        var p = e.norm[j];
        if (!p) continue;
        var score = 0;
        if (q === p) score = 100;
        else if (q.indexOf(p) >= 0 || p.indexOf(q) >= 0) score = 60 + Math.min(p.length, q.length);
        if (score > 0 && (!best || score > best.score)) best = { entry: e, score: score, phrase: e.phrases[j] };
      }
    }
    if (!best) return null;
    return {
      entry: best.entry,
      score: best.score,
      phrase: best.phrase,
      id: best.entry.id,
      label: best.entry.label
    };
  }

  function count() { return entries.length; }
  function list() {
    return entries.slice().sort(function (a, b) {
      if (a.scope === b.scope) return a._k - b._k;
      return a.scope < b.scope ? -1 : 1;
    });
  }
  function clear() { entries.length = 0; }

  global.CockpitVoiceRegistry = {
    normalize: normalize,
    register: register,
    unregisterAll: clear,
    match: match,
    count: count,
    list: list,
    clear: clear
  };
})(window);
