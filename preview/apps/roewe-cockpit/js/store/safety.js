/*!
 * 车机安全交互核心模块
 * 1. 挡位状态机（D 挡行车限制娱乐）
 * 2. 轻量化非阻塞弹窗（不遮挡导航与关键驾驶信息）
 * 3. 车载级页面过渡动画
 * 4. 驾驶状态模拟器（D/P 挡 + 车速滑块）
 */
(function (global) {
  'use strict';

  /* ---------------- 娱乐类页面白名单判定 ---------------- */
  var ENTERTAINMENT_VIEWS = ['media', 'surround'];

  var RESTRICT_TEXT = '行车中，娱乐功能已限制';

  /* ---------------- 轻量提示：非阻塞、不遮关键信息 ---------------- */
  function createToast(state) {
    var seq = 0;
    var timer = null;

    function show(text, level, duration) {
      seq += 1;
      state.toast.text = text;
      state.toast.level = level || 'info';
      state.toast.id = seq;
      state.toast.show = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        state.toast.show = false;
      }, duration || 2200);
    }

    return {
      show: show,
      info: function (t) { show(t, 'info'); },
      warn: function (t) { show(t, 'warn', 2600); },
      restricted: function () { show(RESTRICT_TEXT, 'warn', 2600); }
    };
  }

  /* ---------------- 挡位状态机 ---------------- */
  function createGearMachine(state, toast) {
    function isRestricted(view) {
      if (ENTERTAINMENT_VIEWS.indexOf(view) < 0) return false;
      return state.isDriving();
    }

    /* 挡位切换：D 挡自动带动车速爬升，P 挡立即归零 */
    function setGear(gear) {
      if (gear !== 'D' && gear !== 'P') return;
      if (state.gear === gear) {
        if (gear === 'P' && state.speed !== 0) state.speed = 0;
        return;
      }
      state.gear = gear;
      if (gear === 'P') {
        state.speed = 0;
        toast.info('已挂入 P 挡（驻车），娱乐功能已解锁');
      } else {
        state.speed = Math.max(state.speed, 8);
        state.nav.destination = state.nav.destination || '上海虹桥火车站';
        toast.info('已挂入 D 挡（行车），导航优先展示');
      }
      state.fps = 60;
    }

    function setSpeed(v) {
      var speed = Math.max(0, Math.min(180, Math.round(v)));
      state.speed = speed;
      /* 车速为 0 且处于 D 挡时视为静止，不限制娱乐 */
    }

    return {
      setGear: setGear,
      setSpeed: setSpeed,
      isRestricted: isRestricted,
      restrictedViews: ENTERTAINMENT_VIEWS,
      RESTRICT_TEXT: RESTRICT_TEXT
    };
  }

  /* ---------------- 视图路由 + 车载级过渡动画 ---------------- */
  function createRouter(state, toast, gearMachine) {
    var stack = [];
    var current = null;
    var direction = 'forward';
    var animating = false;
    var animTimer = null;
    var changeHandler = null;

    function notify() {
      if (changeHandler) { try { changeHandler(); } catch (e) { /* 渲染层异常不影响路由 */ } }
    }

    function canEnter(view) {
      return !gearMachine.isRestricted(view);
    }

    function push(view, payload) {
      if (view === current) return false;
      if (!canEnter(view)) {
        toast.restricted();
        return false;
      }
      /* 离开全景/娱乐页时关闭对应沉浸态 */
      if (current === 'nav') state.nav.restricted = false;
      stack.push({ view: current, payload: null });
      direction = 'forward';
      current = view;
      animating = true;
      if (animTimer) clearTimeout(animTimer);
      animTimer = setTimeout(function () { animating = false; }, 520);
      if (changeHandler) changeHandler();
      if (payload && view === 'nav') state.nav.destination = payload.destination || state.nav.destination;
      if (view === 'voice') state.voice.awake = true;
      return true;
    }

    function replace(view) {
      if (view === current) return false;
      if (!canEnter(view)) {
        toast.restricted();
        return false;
      }
      stack.length = 0;
      stack.push({ view: current, payload: null });
      direction = 'fade';
      current = view;
      notify();
      return true;
    }

    function back() {
      var prev = null;
      while (stack.length) {
        var item = stack.pop();
        if (item && item.view && item.view !== current) { prev = item.view; break; }
      }
      if (!prev) prev = 'home';
      if (!canEnter(prev)) {
        toast.restricted();
        prev = 'home';
      }
      direction = 'back';
      current = prev;
      notify();
    }

    function home() {
      if (current === 'home') return;
      stack.length = 0;
      direction = 'back';
      current = 'home';
      notify();
    }

    return {
      get current() { return current; },
      get direction() { return direction; },
      get stack() { return stack; },
      get animating() { return animating; },
      push: push,
      replace: replace,
      back: back,
      home: home,
      canEnter: canEnter,
      /* 渲染层订阅视图变化（外壳组件设置） */
      set onChange(fn) { changeHandler = typeof fn === 'function' ? fn : null; },
      get onChange() { return changeHandler; },
      set current(v) { current = v; }
    };
  }

  /* ---------------- 驾驶状态模拟器 ---------------- */
  function createDriveSimulator(state, gearMachine, toast) {
    return {
      get gear() { return state.gear; },
      get speed() { return state.speed; },
      setGear: gearMachine.setGear,
      setSpeed: gearMachine.setSpeed,
      isDriving: function () { return state.isDriving(); }
    };
  }

  global.RoeweSafety = {
    ENTERTAINMENT_VIEWS: ENTERTAINMENT_VIEWS,
    RESTRICT_TEXT: RESTRICT_TEXT,
    createToast: createToast,
    createGearMachine: createGearMachine,
    createRouter: createRouter,
    createDriveSimulator: createDriveSimulator
  };
})(window);
