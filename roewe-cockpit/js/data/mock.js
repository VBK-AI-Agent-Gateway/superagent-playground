/*!
 * js/data/mock.js — 内置模拟数据（车辆状态、外设、媒体、天气、POI…）
 * 全部数据本地生成，不依赖任何后端接口。
 */
(function (global) {
  'use strict';

  var MOCK = {
    /* ---------- 车辆实时指标 ---------- */
    vehicle: {
      speed: 0,            // km/h
      battery: 78,         // %
      range: 326,          // km 剩余续航
      fuel: 62,            // % 油量
      fuelPer100: 6.8,     // L/100km
      power: 0,            // kW 实时功率
      odometer: 12486,     // km
      tirePressure: [2.4, 2.4, 2.3, 2.5],
      coolant: 88,         // ℃
      outsideTemp: 21,     // ℃
      charging: false,
      doors: { fl: false, fr: false, rl: false, rr: false, trunk: false },
      windows: { fl: false, fr: false, rl: false, rr: false },
      lights: { low: false, high: false, position: true, fog: false, hazard: false },
      lock: true,
      sunroof: 0,          // 0~100 开度
      mirrorFolded: false,
      driveMode: 'comfort' // eco | comfort | sport | snow
    },

    /* ---------- 空调 ---------- */
    climate: {
      power: true,
      tempL: 22.5,
      tempR: 22.5,
      dual: false,
      fan: 3,              // 0~7
      auto: true,
      ac: true,
      recirculate: true,   // true=内循环 false=外循环
      defrostFront: false,
      defrostRear: false,
      seatHeatL: 0,        // 0~3
      seatHeatR: 0,
      sync: false
    },

    /* ---------- 媒体 ---------- */
    media: {
      source: 'local',     // local | bluetooth | radio | online
      playing: false,
      trackIndex: 0,
      volume: 38,
      progress: 0,         // 秒
      mute: false,
      tracks: [
        { title: '夜航星',        artist: '斑马音乐 · 精选', duration: 254, cover: '#1e8fff' },
        { title: 'City Lights',   artist: 'Neon Drive',      duration: 212, cover: '#7c5cff' },
        { title: '雨落外滩',      artist: '沪上爵士',        duration: 287, cover: '#22d39a' },
        { title: 'Highway 318',   artist: 'Road Trip Radio', duration: 233, cover: '#ffb020' },
        { title: '晚风告白',      artist: '斑马音乐 · 热歌', duration: 198, cover: '#ff5a5f' }
      ],
      bt: {
        connected: true,
        device: 'iPhone 15 Pro',
        battery: 76,
        signal: 4,
        recent: [
          { name: '陈工',    number: '138****6621', time: '今天 09:12' },
          { name: '张师傅',  number: '139****0088', time: '昨天 18:40' },
          { name: '400-820-0068', number: '荣威客服', time: '10-28' }
        ],
        contacts: [
          { name: '陈工',   number: '138****6621' },
          { name: '张师傅', number: '139****0088' },
          { name: '李工',   number: '137****1190' },
          { name: '王工',   number: '136****2244' }
        ],
        // 通话状态机：idle | dialing | talking
        call: { state: 'idle', name: '', number: '', seconds: 0 }
      },
      radio: { freq: 101.7, band: 'FM', name: '上海交通广播' }
    },

    /* ---------- 天气 ---------- */
    weather: {
      city: '上海市 · 浦东新区',
      now: 21,
      text: '多云',
      icon: 'cloudy',
      high: 24,
      low: 17,
      aqi: 42,
      aqiText: '优',
      humidity: 58,
      wind: '东南风 2 级',
      hourly: [
        { t: '现在', v: 21, i: 'cloudy' },
        { t: '14时', v: 23, i: 'cloudy' },
        { t: '15时', v: 24, i: 'sunny'  },
        { t: '16时', v: 23, i: 'sunny'  },
        { t: '17时', v: 21, i: 'cloudy' },
        { t: '18时', v: 19, i: 'rain'   }
      ],
      daily: [
        { d: '今天', hi: 24, lo: 17, i: 'cloudy' },
        { d: '明天', hi: 26, lo: 18, i: 'sunny'  },
        { d: '周四', hi: 22, lo: 16, i: 'rain'   },
        { d: '周五', hi: 20, lo: 15, i: 'rain'   },
        { d: '周六', hi: 25, lo: 17, i: 'sunny'  }
      ]
    },

    /* ---------- 导航 ---------- */
    nav: {
      destination: { name: '上海虹桥火车站·P5 停车场', address: '上海市闵行区申贵路 1500 号', distance: 18.6, eta: 32 },
      origin: '当前位置 · 世纪大道 100 号',
      // 途经点 / 路线方案
      routes: [
        { id: 'r1', name: '推荐路线', via: '南北高架路 → 延安高架路', distance: 18.6, duration: 32, toll: 0,  traffic: 'light' },
        { id: 'r2', name: '躲避拥堵', via: '内环高架路 → 沪闵高架路', distance: 21.2, duration: 35, toll: 0,  traffic: 'clear' },
        { id: 'r3', name: '高速优先', via: 'S20 外环高速',            distance: 24.8, duration: 29, toll: 15, traffic: 'clear' }
      ],
      // 车道引导
      lane: {
        total: 4,
        // 1 = 推荐车道
        recommend: [0, 1, 1, 0],
        maneuver: '前方 500 米 靠右行驶，进入延安高架路匝道',
        nextManeuver: '随后 1.2 公里 右转进入申贵路',
        icon: 'ramp-right'
      },
      // 行驶进度
      progress: 0,
      // 电子眼与路况
      cameras: [
        { at: 0.18, type: '限速 80', note: '区间测速起点' },
        { at: 0.52, type: '闯红灯', note: '路口电子警察' },
        { at: 0.77, type: '限速 60', note: '隧道出口' }
      ],
      trafficEvents: [
        { at: 0.30, level: 'jam',    text: '前方 2.1km 缓行 约 4 分钟' },
        { at: 0.64, level: 'slow',   text: '前方 6.4km 车多缓行' },
        { at: 0.88, level: 'clear',  text: '终点附近畅通' }
      ],
      // 沿途服务：充电站 / 加油站（无 key 时用内置示意数据演示搜索交互）
      pois: [
        { id: 'p1', type: 'charge', name: '国家电网充电站（世纪大道）', address: '浦东新区世纪大道 100 号', distance: 1.2, eta: 4,  detail: '快充 8 枪 · 空闲 5', rating: 4.8 },
        { id: 'p2', type: 'charge', name: '特来电（陆家嘴环路）',       address: '浦东新区陆家嘴环路 1000 号', distance: 2.6, eta: 7,  detail: '快充 6 枪 · 空闲 2', rating: 4.5 },
        { id: 'p3', type: 'charge', name: '星星充电（浦东南路）',       address: '浦东新区浦东南路 1288 号',  distance: 4.1, eta: 10, detail: '慢充 4 枪 · 空闲 4', rating: 4.2 },
        { id: 'p4', type: 'fuel',   name: '中国石化（浦东南路站）',     address: '浦东新区浦东南路 899 号',   distance: 1.8, eta: 6,  detail: '92# 7.86 元/L',     rating: 4.4 },
        { id: 'p5', type: 'fuel',   name: '中国石油（世纪大道站）',     address: '浦东新区世纪大道 1500 号',  distance: 3.2, eta: 8,  detail: '95# 8.35 元/L',     rating: 4.3 },
        { id: 'p6', type: 'fuel',   name: '壳牌（杨高中路站）',         address: '浦东新区杨高中路 2000 号',  distance: 5.5, eta: 12, detail: '92# 7.92 元/L',     rating: 4.6 }
      ],
      // 常用地址
      favorites: [
        { name: '家',   address: '浦东新区世纪大道 100 号',       distance: 6.2,  eta: 12, icon: 'home' },
        { name: '公司', address: '浦东新区张江高科技园区',         distance: 12.4, eta: 22, icon: 'work' },
        { name: '充电站', address: '国家电网充电站（世纪大道）',   distance: 1.2,  eta: 4,  icon: 'charge' },
        { name: '加油站', address: '中国石化（浦东南路站）',       distance: 1.8,  eta: 6,  icon: 'fuel' }
      ]
    },

    /* ---------- 泊车辅助 ---------- */
    parking: {
      // 雷达距离（cm），index 0 为最左
      radar: { front: [86, 142, 210, 175, 94], rear: [58, 96, 132, 104, 62] },
      side: { left: 42, right: 128 },
      obstacle: { active: true, bearing: 'left-rear', distance: 58, level: 'warn' },
      trajectory: true,
      autoParkReady: true
    },

    /* ---------- 车辆设置 ---------- */
    settings: {
      lights: { auto: true, welcome: true, followMe: 30, ambient: 'blue' },
      mirror: { autoFold: true, reverseTilt: true, heat: false },
      lock: { autoLock: true, speedLock: true, hornOnLock: false, childLock: false },
      sunroof: { open: 0, vent: false },
      driving: {
        mode: 'comfort',
        regen: 'standard',   // low | standard | high
        esp: true,
        hillAssist: true,
        laneAssist: true
      },
      reverse: { guideLines: true, dynamic: true, brightness: 70 }
    },

    /* ---------- 系统设置 ---------- */
    system: {
      brightness: 80,
      theme: 'dark',
      wifi: { on: true, ssid: 'RX5-5G-车机热点', signal: 4, ip: '192.168.10.24' },
      wifiList: [
        { ssid: 'RX5-5G-车机热点', signal: 4, secure: true,  saved: true  },
        { ssid: 'SAIC-WiFi',        signal: 3, secure: false, saved: false },
        { ssid: 'CMCC-5G',          signal: 2, secure: true,  saved: false }
      ],
      bluetooth: { on: true, device: 'iPhone 15 Pro' },
      hotspot: false,
      ota: {
        version: 'ZebraOS 2.0.0 (V4.1.2)',
        build: '20260925-1456',
        hardware: 'MT8666 / 4G+64G',
        channel: 'stable',
        lastCheck: '2026-11-04 08:20',
        available: { version: 'ZebraOS 2.1.0', size: '1.8 GB', note: '优化语音唤醒率 / 新增 360 循迹倒车' }
      },
      storage: { used: 21.4, total: 64 },
      language: 'zh-CN'
    },

    /* ---------- 账号 / 关于 ---------- */
    about: {
      model: '荣威 RX5 2024 款 超感旗舰版',
      vin: 'LSJA24U60MN000000',
      imei: '861234567890123',
      sn: 'RX5-MT8666-0024',
      screen: '10.4 英寸 竖屏 1080×1920',
      software: 'ZebraOS 2.0.0',
      mcu: '1.4.7'
    }
  };

  /* 深拷贝导出，避免多个模块互相污染 */
  global.CockpitMock = MOCK;
  global.cloneMock = function (obj) { return JSON.parse(JSON.stringify(obj)); };
})(window);
