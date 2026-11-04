/*!
 * 内置模拟数据（题目要求：车辆状态/外设数据一律内置模拟数据）
 */
(function (global) {
  'use strict';

  global.ROEWE_MOCK = {
    /* 音乐播放列表 */
    tracks: [
      { title: '夜航', artist: '荣威车载精选', album: '城市夜行', duration: 245, cover: '#2b6cff' },
      { title: '起风了', artist: '林家谦', album: '风起', duration: 302, cover: '#8b5cf6' },
      { title: '平凡之路', artist: '朴树', album: '猎户星座', duration: 302, cover: '#0ea5e9' },
      { title: '夜的钢琴曲五', artist: '石进', album: '夜的钢琴曲', duration: 214, cover: '#f97316' },
      { title: '海阔天空', artist: 'Beyond', album: '乐与怒', duration: 326, cover: '#10b981' },
      { title: 'Cruel Summer', artist: 'Taylor Swift', album: 'Lover', duration: 178, cover: '#ec4899' }
    ],

    /* 蓝牙配对设备 */
    btDevices: [
      { name: 'iPhone 15 Pro', connected: true, battery: 82 },
      { name: '华为 Mate 60', connected: false, battery: 64 },
      { name: '小米 14', connected: false, battery: 51 }
    ],

    /* 常见地点（用于导航卡片与语音助手） */
    places: [
      { name: '上海虹桥火车站', distance: 18.4, eta: 26, tag: '火车站' },
      { name: '南京路步行街', distance: 6.2, eta: 15, tag: '商圈' },
      { name: '外滩停车场', distance: 5.4, eta: 13, tag: '停车场' },
      { name: '国家电网充电站（浦东）', distance: 2.1, eta: 7, tag: '充电站' },
      { name: '中国石化加油站（沪闵路）', distance: 3.6, eta: 9, tag: '加油站' },
      { name: '上海迪士尼度假区', distance: 32.8, eta: 41, tag: '景区' },
      { name: '家', distance: 12.6, eta: 21, tag: '常用' },
      { name: '公司', distance: 9.8, eta: 19, tag: '常用' }
    ],

    /* 导航备选路线 */
    routes: [
      { name: '推荐路线', distance: 18.4, eta: 26, traffic: '畅通', via: '中环路高架' },
      { name: '躲避拥堵', distance: 20.1, eta: 29, traffic: '缓行', via: '内环高架' },
      { name: '少收费', distance: 17.6, eta: 32, traffic: '畅通', via: '沪闵路地面' }
    ],

    /* 车道引导 */
    lanes: ['left', 'straight', 'straight', 'right'],

    /* 天气图标序列 */
    weatherIcons: ['sunny', 'cloudy', 'overcast', 'rain', 'snow', 'fog'],

    /* 语音助手快捷指令（可见即可说） */
    voiceCommands: [
      '导航到上海虹桥火车站',
      '打开空调',
      '温度调到 22 度',
      '风量调大',
      '播放音乐',
      '下一首',
      '音量调到 60',
      '打开座椅加热',
      '关闭车窗',
      '我要去充电站',
      '打开全景影像',
      '回到主页'
    ],

    /* 泊车障碍物（相对车位坐标，单位 m） */
    obstacles: [
      { id: 'o1', x: -1.4, y: 2.2, type: 'car', level: 2 },
      { id: 'o2', x: 1.2, y: 5.0, type: 'pillar', level: 1 },
      { id: 'o3', x: 0.2, y: 8.4, type: 'pedestrian', level: 3 }
    ]
  };
})(window);
