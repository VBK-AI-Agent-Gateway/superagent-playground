/*!
 * 全局状态仓库（极简响应式，基于 Vue.reactive）
 * 所有模块共享同一份车辆 / 主题 / 媒体 / 空调状态。
 */
(function (global) {
  'use strict';

  var CFG = global.ROEWE_CONFIG || {};
  var Vue = global.Vue;

  function createStore() {
    var state = Vue.reactive({
      /* ---------- 主题 ---------- */
      theme: CFG.theme === 'light' ? 'light' : 'dark',

      /* ---------- 挡位状态机：P 驻车 / D 行车 ---------- */
      gear: 'P',
      speed: 0,
      /* 娱乐限制阈值，车速 > 该值且 D 挡时限速娱乐 */
      restrictedSpeed: (CFG.drive && CFG.drive.restrictedSpeed) || 5,

      /* ---------- 车辆指标（模拟数据） ---------- */
      vehicle: {
        model: (CFG.vehicle && CFG.vehicle.model) || '荣威 RX5',
        plate: (CFG.vehicle && CFG.vehicle.plate) || '沪A·RX520',
        vin: (CFG.vehicle && CFG.vehicle.vin) || 'LSJA24U6XXXXXXXXXX',
        battery: 72,          // 电量 %
        range: 386,           // 续航 km
        fuel: 46,             // 油耗 %
        odo: 12864,           // 总里程 km
        tirePressure: [2.4, 2.4, 2.3, 2.3],
        doorOpen: false,
        locked: true,
        charging: false
      },

      /* ---------- 驾驶模式 ---------- */
      driveMode: 'comfort',

      /* ---------- 空调 ---------- */
      climate: {
        power: true,
        tempL: 24,
        tempR: 24,
        dual: false,
        fan: 3,
        recirculation: false,   // false = 外循环, true = 内循环
        ac: true,
        defrostFront: false,
        defrostRear: false,
        seatHeatL: 0,
        seatHeatR: 0
      },

      /* ---------- 多媒体 ---------- */
      media: {
        playing: false,
        source: 'netease',      // netease | bluetooth | local | radio
        trackIndex: 0,
        volume: 40,
        muted: false,
        progress: 0,
        duration: 245,
        bluetooth: { connected: false, device: 'iPhone 15 Pro', dialing: false },
        call: { active: false, name: '', number: '', seconds: 0 }
      },

      /* ---------- 车辆设置 ---------- */
      settings: {
        headlight: 'auto',      // off | auto | low | high
        headlightDelay: 30,
        mirrorFold: true,
        mirrorAdjust: 'center',
        doorAutoLock: true,
        doorChildLock: false,
        sunroof: 0,
        sunroofShade: 0,
        trunk: false,
        drivingMode: 'comfort',
        reversingCamera: true
      },

      /* ---------- 系统设置页 ---------- */
      system: {
        brightness: 80,
        theme: null,            // 由 theme 同步
        wifi: true,
        wifiName: 'ROEWE-RX5-5G',
        bluetooth: true,
        btName: 'ROEWE-RX5',
        otaVersion: 'OS 3.2.1',
        otaNew: true,
        about: {
          device: 'Roewe Smart Cockpit 10.4"',
          sn: 'RWX5-2026-0001',
          chip: 'MT8666 8核',
          ram: '4GB',
          storage: '32GB',
          build: '2026.11.04'
        }
      },

      /* ---------- 天气（模拟数据） ---------- */
      weather: {
        city: '上海',
        desc: '多云',
        icon: 'cloudy',
        temp: 19,
        high: 23,
        low: 14,
        humidity: 62,
        wind: '东南风 2级',
        aqi: 48,
        updated: '--:--'
      },

      /* ---------- 导航 ---------- */
      nav: {
        engine: 'fallback',       // fallback（内置示意图） | amap（高德 JS API 2.0）
        configured: false,        // config.js 中是否填了 key
        destination: '上海虹桥火车站',
        eta: 26,
        distance: 18.4,
        remainDistance: 18.4,
        traffic: '畅通',
        lane: '直行',
        nextManeuver: '沿中环路高架直行 1.2km 后靠右驶出',
        progress: 0,
        restricted: false
      },

      /* ---------- 全景 / 泊车 ---------- */
      surround: {
        camera: 'front',          // front | rear | left | right
        view: '3d',               // 3d | 2d
        radar: [46, 82, 35, 120, 68, 150], // 前左 前右 后左 后右 侧左 侧右 (cm)
        obstacles: [],
        trajectory: true,
        autoParking: false,
        alarmLevel: 0             // 0 安全 1 注意 2 警告 3 危险
      },

      /* ---------- 语音助手 ---------- */
      voice: {
        supported: false,
        listening: false,
        awake: false,
        wakeWord: '你好荣威',
        transcript: '',
        messages: [],
        speaking: false
      },

      /* ---------- 轻量提示（Toast / 受限提示） ---------- */
      toast: { show: false, text: '', level: 'info', id: 0 },

      /* ---------- 调试 ---------- */
      fps: 60
    });

    /* ---------- 计划：驾驶模式（含切换时写入 settings） ---------- */
    state.modes = ['comfort', 'eco', 'sport', 'snow'];
    state.setDriveMode = function (mode) {
      if (state.modes.indexOf(mode) < 0) return;
      state.driveMode = mode;
      state.settings.drivingMode = mode;
    };

    /* ---------- 派生属性 ---------- */
    state.isDriving = function () {
      return state.gear === 'D' && state.speed > state.restrictedSpeed;
    };

    return state;
  }

  global.createRoeweStore = createStore;
})(window);
