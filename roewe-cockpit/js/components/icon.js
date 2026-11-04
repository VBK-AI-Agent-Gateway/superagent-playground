/*!
 * 轻量图标组件：内联 SVG（无外部图标库依赖，离线可用）
 */
(function (global) {
  'use strict';

  var PATHS = {
    home: '<path d="M4 11.2 12 4l8 7.2V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    nav: '<path d="M12 2 3 21l9-4 9 4z"/>',
    climate: '<path d="M12 2v20M4.2 7l15.6 10M19.8 7 4.2 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="12" r="2.6"/>',
    media: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.8"/><circle cx="17.5" cy="16" r="2.8"/>',
    car: '<path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11v6.5a1 1 0 0 1-1 1h-1.2a1 1 0 0 1-1-1V16H8.2v1.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><circle cx="8" cy="13" r="1.2" fill="#0b1220"/><circle cx="16" cy="13" r="1.2" fill="#0b1220"/>',
    settings: '<path d="M12 8.6A3.4 3.4 0 1 0 12 15.4 3.4 3.4 0 0 0 12 8.6zm9 3.4-2.1-.6a7.5 7.5 0 0 0-.6-1.5l1.1-1.9-1.9-1.9-1.9 1.1a7.5 7.5 0 0 0-1.5-.6L13.5 3h-3l-.6 2.1a7.5 7.5 0 0 0-1.5.6L6.5 4.6 4.6 6.5l1.1 1.9a7.5 7.5 0 0 0-.6 1.5L3 12v3l2.1.6a7.5 7.5 0 0 0 .6 1.5l-1.1 1.9 1.9 1.9 1.9-1.1a7.5 7.5 0 0 0 1.5.6L10.5 21h3l.6-2.1a7.5 7.5 0 0 0 1.5-.6l1.9 1.1 1.9-1.9-1.1-1.9a7.5 7.5 0 0 0 .6-1.5L21 15z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 18v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    camera: '<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h2l1-2h5l1 2h2A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/><circle cx="12" cy="13" r="3.4" fill="#0b1220"/>',
    park: '<path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.1z"/>',
    back: '<path d="M14.5 5 8 12l6.5 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
    sun: '<circle cx="12" cy="12" r="4.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    cloud: '<path d="M7 18a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 10.6A3.7 3.7 0 0 1 17.4 18z"/>',
    rain: '<path d="M7 15a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 7.6A3.7 3.7 0 0 1 17.4 15z"/><path d="M8.5 18l-1 2.4M12.5 18l-1 2.4M16.5 18l-1 2.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    snow: '<path d="M7 15a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 7.6A3.7 3.7 0 0 1 17.4 15z"/><circle cx="9" cy="19" r="1.1"/><circle cx="13" cy="20" r="1.1"/><circle cx="16.5" cy="18.6" r="1.1"/>',
    fog: '<path d="M7 12a4 4 0 0 1 .4-8A5.5 5.5 0 0 1 18 4.6A3.7 3.7 0 0 1 17.4 12z"/><path d="M4 16h16M6 19h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    pause: '<rect x="7" y="5" width="3.6" height="14" rx="1.2"/><rect x="13.4" y="5" width="3.6" height="14" rx="1.2"/>',
    prev: '<path d="M7 5h2.4v14H7zM19 5v14l-9-7z"/>',
    next: '<path d="M14.6 5H17v14h-2.4zM5 19V5l9 7z"/>',
    volume: '<path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z"/><path d="M15.4 9a4.4 4.4 0 0 1 0 6M17.8 6.4a8 8 0 0 1 0 11.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    volumeMute: '<path d="M4 9.5h3.2L12 5.4v13.2L7.2 14.5H4z"/><path d="M15.5 10l4.5 4M20 10l-4.5 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    bluetooth: '<path d="M11 3l5 4.6-3.4 3.1v2.6L16 16.4 11 21V3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M6.6 8.4 15 15.8M6.6 15.8 15 8.4" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    phone: '<path d="M6.4 3h3l1.5 4-2 1.4a12 12 0 0 0 5.7 5.7L16 12l4 1.5v3a2 2 0 0 1-2.2 2A15.6 15.6 0 0 1 4.4 5.2 2 2 0 0 1 6.4 3z"/>',
    wifi: '<path d="M12 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z"/><path d="M5.2 11.6a9.6 9.6 0 0 1 13.6 0M8 14.4a5.8 5.8 0 0 1 8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    light: '<path d="M4 14h5l5-4 5 2v3h-2a2.4 2.4 0 0 1-4.8 0H9a2.4 2.4 0 0 1-4.8 0z"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    door: '<path d="M4 20V5.5A1.5 1.5 0 0 1 5.5 4h11A1.5 1.5 0 0 1 18 5.5V20z"/><circle cx="15" cy="12.5" r="1.1" fill="#0b1220"/>',
    seat: '<path d="M7 4h6a2 2 0 0 1 2 2v7H7z"/><path d="M6 13h10l1.4 5.2a1.6 1.6 0 0 1-1.5 2H6.1a1.6 1.6 0 0 1-1.5-2z"/>',
    fan: '<circle cx="12" cy="12" r="2.2"/><path d="M12 9.8c0-3.4.8-5.8 3.2-5.8 2.2 0 2.6 3 .4 4.2-1.4.8-2.6 1-3.6 1.6zM14.2 12c3.4 0 5.8.8 5.8 3.2 0 2.2-3 2.6-4.2.4-.8-1.4-1-2.6-1.6-3.6zM12 14.2c0 3.4-.8 5.8-3.2 5.8-2.2 0-2.6-3-.4-4.2 1.4-.8 2.6-1 3.6-1.6zM9.8 12C6.4 12 4 11.2 4 8.8 4 6.6 7 6.2 8.2 8.4c.8 1.4 1 2.6 1.6 3.6z"/>',
    charge: '<path d="M13 2 5 13h5l-1 9 8-11h-5z"/>',
    fuel: '<path d="M6 3h8v18H6zM14 7h2.5l1.5 2v8a1.8 1.8 0 0 1-3.6 0v-5H14z" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    route: '<circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18h5.1a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.6" fill="none" stroke="currentColor" stroke-width="1.9"/>',
    search: '<circle cx="11" cy="11" r="6.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M15.6 15.6 20 20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    warn: '<path d="M12 3 2.5 20h19z"/><path d="M12 9v5" fill="none" stroke="#0b1220" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.1" fill="#0b1220"/>',
    check: '<path d="m4.5 12.5 5 5L20 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    plus: '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    minus: '<path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    ota: '<path d="M12 3v12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
    info: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M12 10.5V17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.1"/>',
    mirror: '<path d="M4 8h10a3 3 0 0 1 3 3v6l-3-2H4z"/><path d="M20 6v10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    sunroof: '<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M6 9h12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>'
  };

  global.RoeweIcon = {
    name: 'RwIcon',
    props: {
      name: { type: String, required: true },
      size: { type: [Number, String], default: 24 }
    },
    computed: {
      svg: function () {
        return PATHS[this.name] || PATHS.info;
      }
    },
    template: '<svg class="rw-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" v-html="svg"></svg>'
  };
})(window);
