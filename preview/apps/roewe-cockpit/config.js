/*!
 * config.js — 荣威RX5 网页版车机系统 · 运行期配置
 * 零构建：所有配置在运行时读取，不参与打包。
 * 修改本文件后直接刷新 index.html 即可生效。
 */
window.COCKPIT_CONFIG = {
  /* ---------- 高德地图 JS API 2.0 ---------- */
  // 在 https://console.amap.com/ 申请「Web端(JS API)」Key 后填入。
  // 留空时系统自动降级为内置示意地图 + 完整路线/车道/路况演示逻辑。
  amapKey: '',
  // 高德安全密钥（2021-12-02 之后申请的 Key 需要在控制台配置安全密钥）
  amapSecurityJsCode: '',
  // 高德 JS API 版本与插件
  amapVersion: '2.0',
  amapPlugins: ['AMap.Driving', 'AMap.Geolocation', 'AMap.PlaceSearch', 'AMap.AutoComplete'],

  /* ---------- 车辆信息 ---------- */
  vehicle: {
    model: '荣威 RX5',
    plate: '沪A·RX520',
    vin: 'LSJA24U60MN000000',
    screen: '10.4" 竖屏 1080×1920'
  },

  /* ---------- 语音助手 ---------- */
  voice: {
    // 唤醒词，命中任意一个即进入聆听态
    wakeWords: ['你好斑马', '你好，斑马', '你好荣威', '你好，荣威', '斑马你好'],
    // 连续对话：回答后保持聆听窗口（毫秒）
    continuousWindowMs: 8000,
    // 普通话优先
    lang: 'zh-CN'
  },

  /* ---------- 主题与座舱偏好（可被 localStorage 覆盖） ---------- */
  defaults: {
    theme: 'dark',        // dark | light
    brightness: 80,       // 20 ~ 100
    volume: 38,
    units: 'metric'
  },

  /* ---------- 驾驶状态模拟器默认值 ---------- */
  simulator: {
    gear: 'P',            // P | R | N | D
    speed: 0,             // km/h
    // 车速超过该阈值时视为行车，娱乐功能受限（即使挡位为 P）
    drivingSpeedThreshold: 5
  }
};
