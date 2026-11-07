# 个人作品集网站（三页面静态站点）

按 issue #24 规格实现的纯静态个人作品集：**零依赖、零构建、无框架、无外部 CDN**，
手写 CSS（Flexbox / Grid），表单校验只用原生 JS 与 HTML5 约束属性。

## 文件结构

```
portfolio-site-pages-70693ed094d5/
├── index.html          首页：个人简介、头像主视觉、技能/服务、作品与联系入口
├── works.html          作品列表：四个作品卡片（标题 / 缩略图占位 / 简述 / 可选外链）
├── contact.html        联系表单：姓名、邮箱、留言 + 前端校验 + 静态占位提交
├── css/style.css       全站唯一样式表（设计变量、导航、Hero、卡片网格、表单、响应式断点）
├── js/main.js          导航当前页高亮 + 页脚年份（全站共享）
├── js/contact.js       联系表单校验与静态占位提交提示
└── assets/             图片占位目录（当前为纯 CSS 占位，可放 avatar.png / work-*.png）
```

## 本地运行

直接双击 `index.html`（`file://` 打开同样可用：页面间相对链接与脚本均无网络请求），
或在本目录执行任意静态服务器，例如：

```bash
python3 -m http.server 8000
# 然后访问 http://localhost:8000/
```

## 功能与验收对照

| 验收项 | 实现位置 |
| --- | --- |
| 三个页面可独立打开且无报错 | `index.html` / `works.html` / `contact.html`，无外部资源请求 |
| 三页导航互跳 + 当前页高亮 | 各页 `.site-nav`；`data-page` + `js/main.js` 写入 `aria-current="page"`（CSS 高亮） |
| 作品卡片 ≥ 4 个，桌面/移动端不错位 | `works.html` 四个 `.work` 卡片；`.works-grid` 用 `auto-fill` + 断点收敛为单列 |
| 必填与邮箱格式校验，空提交被拦截 | `js/contact.js` + `required` / `minlength` / `maxlength` / `type="email"` |
| 无外部 CDN，断网可渲染 | 所有样式与脚本均为本地文件，无 `@import`、无远程字体 |
| 语义化标签 | 每页 `header` / `nav` / `main` / `section` / `article` / `footer` |

## 明确不包含（符合 issue 非目标）

后端服务、数据库、真实邮件发送、CMS、用户登录、数据持久化、多语言、
SEO 深度优化、打包压缩、部署流水线。

## 可替换的占位内容

- 头像：把 `assets/avatar.png` 放入后，将 `.avatar` 换成 `<img class="avatar" src="assets/avatar.png" alt="头像">`。
- 作品缩略图：把图片放入 `assets/`，替换 `.work__thumb` 的渐变占位块即可（保留类名以复用样式）。
- 外链：`works.html` 中四个 `https://example.com/...` 为示例地址，请替换为真实链接。
