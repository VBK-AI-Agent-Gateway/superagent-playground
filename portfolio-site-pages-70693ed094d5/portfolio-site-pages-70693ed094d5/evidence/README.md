# 视觉证据（Before / After）

本目录保存本次 PR 的界面证据，全部为真实应用截取（Playwright headless 截屏），非设计稿或示意图。

## Before —— 基线：合并前的线上仓库站点

- 基线版本：`main` 分支当前线上构建，提交 `ca8b345`
- 地址：`https://vbk-ai-agent-gateway.github.io/superagent-playground/`
- 采集方式：真实访问线上地址后截屏
- 结论：线上根路径只有仓库 README 渲染页，**不存在任何作品集页面**
  （`/portfolio/index.html`、`/portfolio/works.html`、`/portfolio/contact.html`、`/portfolio/css/style.css` 实测均返回 404）

| 文件 | 内容 |
| --- | --- |
| `before-live-root-desktop.png` | 线上根路径 1280×900（仓库 README 页，非作品集） |
| `before-live-root-mobile.png` | 线上根路径 375×780 |
| `before-live-portfolio-desktop.png` | 请求 `/portfolio/index.html` 得到 GitHub Pages 404 |
| `before-live-portfolio-mobile.png` | 请求 `/portfolio/index.html` 得到 GitHub Pages 404（移动端） |

因此 Before 无法展示作品集界面本身：改动前该界面在线上并不存在，这正是本次要新增的功能。
上表用「线上现状 + 目标路径 404」如实记录基线，而非伪造一张旧作品集截图。

## After —— 变更后：本次提交的本地渲染

- 变更版本：分支 `agent/portfolio-site-pages-70693ed094d5`，提交 `8e82514`
- 采集方式：对本次交付目录启动本地静态服务器后截屏
- 视口与主题：桌面 1280×900、移动 375×780；浅色主题；三页均为默认初始状态
- 表单校验图：桌面视口，邮箱填入 `not-an-email` 后提交，展示可见的错误反馈

| 文件 | 内容 |
| --- | --- |
| `desktop-home.png` | 首页：简介、头像主视觉、技能卡片、作品/联系入口，导航高亮「首页」 |
| `desktop-works.png` | 作品页：四张作品卡片网格，导航高亮「作品」 |
| `desktop-contact.png` | 联系页：姓名/邮箱/留言表单，导航高亮「联系」 |
| `desktop-contact-validation.png` | 联系页校验失败态：邮箱格式错误时的字段标红与提示 |
| `mobile-home.png` / `mobile-works.png` / `mobile-contact.png` | 同上三页的移动端 375px 渲染 |

> 合并后线上路径为 `/portfolio/index.html`。After 图为本地渲染：新目录尚未部署到 Pages，
> 因此无法从线上地址截取变更后的页面。
