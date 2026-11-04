/*!
 * 荣威RX5 网页版车机系统 — 运行时配置
 * ------------------------------------------------------------------
 * 本文件是唯一需要按实际情况修改的配置入口，全部字段都有内置兜底，
 * 不填任何内容也能双击 index.html 直接运行。
 */
window.ROEWE_CONFIG = {
  /* 高德地图 JS API 2.0 key（可选）
   * 1) 前往 https://console.amap.com/ 申请「Web端(JS API)」key
   * 2) 建议同时申请「安全密钥 securityJsCode」（2021-12-02 之后申请的 key 必须配置）
   * 3) 填入下方后刷新页面，导航模块自动从「内置示意图」切换为真实高德地图
   */
  amap: {
    key: '',
    securityJsCode: '',
    version: '2.0',
    /* 地图加载超时（毫秒），超时自动降级为内置示意图 */
    timeout: 6000
  },

  /* 设计稿基准：1080 × 1920 竖屏（9:16），rem 适配 */
  design: {
    width: 1080,
    height: 1920,
    rootFontSize: 100
  },

  /* 默认车辆与用户信息 */
  vehicle: {
    model: '荣威 RX5',
    plate: '沪A·RX520',
    vin: 'LSJA24U6XXXXXXXXXX'
  },

  /* 默认主题：cockpit-dark（原厂深色座舱） / cockpit-light（浅色座舱） */
  theme: 'dark',

  /* 驾驶状态模拟器初始状态：gear = P | D，speed 单位 km/h */
  drive: {
    gear: 'P',
    speed: 0,
    /* D 挡行车限制阈值：车速大于该值时娱乐功能受限 */
    restrictedSpeed: 5
  },

  /* 内置模拟数据开关（关闭后仍可离线运行，仅用于展示）」 */
  mock: {
    /* 天气刷新间隔（毫秒） */
    weatherInterval: 60000
  }
};
