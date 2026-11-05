/* main.js —— 全站少量原生脚本（零依赖、无框架、无网络请求）
   1) 导航当前页高亮（依据 <body data-page>，保证本地 file:// 打开时同样生效）
   2) 页脚年份自动更新                                            */
(function () {
  "use strict";

  function highlightCurrentNav() {
    var page = document.body.getAttribute("data-page");
    if (!page) {
      return;
    }
    var links = document.querySelectorAll(".site-nav a[data-nav]");
    for (var i = 0; i < links.length; i++) {
      if (links[i].getAttribute("data-nav") === page) {
        links[i].setAttribute("aria-current", "page");
      } else {
        links[i].removeAttribute("aria-current");
      }
    }
  }

  function fillFooterYear() {
    var nodes = document.querySelectorAll("[data-year]");
    var year = String(new Date().getFullYear());
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = year;
    }
  }

  function init() {
    highlightCurrentNav();
    fillFooterYear();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
