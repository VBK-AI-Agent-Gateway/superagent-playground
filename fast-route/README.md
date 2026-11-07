# fast-route —— 分诊路由「快速通道」交付包（issue #22）

把「完整系统 / app / 多模块开发」类需求从租户侧**本地自建**改判为**派单执行**：
EU 侧插件 `dispatch_dev` 调规划官出规格 → 经 GitHub App 在本仓库开 issue（首行
`[route:full]`）并贴触发评论 → VM 侧 superagent 按 issue 正文执行完整开发流程。

本目录**只产出脚本，不执行任何一步**。所有脚本由操作员在对应主机上手工运行。
本包不含任何 EU/VM 生产凭据，私钥只按路径读取。

## 交付物清单

| # | 文件 | 运行位置 | 作用 |
|---|------|----------|------|
| A1 | `patch-admission.sh` | VM | 把 `prompts/admission.md` 第 14 行锚点从只认 `(github-actions[bot])` 泛化为同时认 `sandbox-dispatch[bot]`，并追加 3 条快速通道路由规则 |
| A2 | `patch-scope.sh` | VM | 给 `prompts/team/scope.md` 追加快速通道执行策略段（`[route:light]` 单 agent 直做、不默认开 subagent、一轮自检后出 PR） |
| B1 | `aa-dev-dispatch.ts` | EU | pi 插件，注册工具 `dispatch_dev`；规划官出规格 → 硬校验 → 开 issue + 触发评论；含熔断、审计、失败不降级 |
| B2 | `patch-skillguide.py` | EU | 给宿主 `personal-assistant.ts` 的 skillGuide 注入分诊路由规则 |
| B3 | `deploy-plugin.sh` | EU | 部署 B1 到容器：拷贝 → drop-in 挂载 → 构建验证 → 运行时 smoke → env 注入 → 门禁重启 → 复核 |
| B4 | `README.md` | — | 本文件：执行顺序、回滚命令、灰度验收 |

## 执行顺序（严格按序）

### ① VM：提示词补丁

```bash
# 先自检（在临时目录跑，不碰真实文件）
./patch-admission.sh --selftest     # 期望输出 SELFTEST_OK
./patch-scope.sh     --selftest     # 期望输出 SELFTEST_OK

# 真实执行
./patch-admission.sh                # 默认 dry-run，只打印
./patch-admission.sh --apply
./patch-scope.sh --apply
```

**重启 dsh-superagent 前必须确认无在途任务**（`running=0`），否则 abort。
提示词在进程启动时通过 `readFileSync` 载入，**不重启不生效**。

### ② VM：把派单账号加入 policy bots

管理 API 仅限 loopback:3082，且需要 `x-orchestrator-request: 1` 头。

```bash
# 先 GET 拿完整字段集
curl -s http://127.0.0.1:3082/admin/sources -H 'x-orchestrator-request: 1'
# PUT 回写时必须带上 GET 到的完整字段集，只增不改
#   sources.github.bots += {"id":"sandbox-dispatch[bot]"}
```

> PUT 若只提交被改字段，会清掉其余配置。务必整份回写。

### ③ EU：部署插件 + 注入规则

```bash
./deploy-plugin.sh                  # dry-run：打印将执行的每一步
./deploy-plugin.sh --apply          # 真正部署（含 running=0 门禁）
python3 patch-skillguide.py         # dry-run
python3 patch-skillguide.py --apply
# 重启 wagate 使 skillGuide 生效（同样先在途任务门禁）
```

`deploy-plugin.sh --apply` 内部会：探测规划官地址（容器内先试
`http://127.0.0.1:3001/v1`，再试 `http://172.17.0.1:3001/v1`，取第一个
`/v1/models` 通的）；两个都不通即 abort，要求操作员手工填写。
`WAGATE_DISPATCH_PLANNER_KEY` 由操作员**交互输入**，脚本不硬编码也不写日志。

### ④ 灰度验收

## 回滚

| 改动 | 回滚命令 |
|------|----------|
| A1 `admission.md` | `cp -p /home/qt/src/dsh-sa-git/prompts/admission.md.bak.route.<ts> /home/qt/src/dsh-sa-git/prompts/admission.md` |
| A2 `scope.md` | `cp -p /home/qt/src/dsh-sa-git/prompts/team/scope.md.bak.route.<ts> /home/qt/src/dsh-sa-git/prompts/team/scope.md` |
| B1 插件 | `cp -p /srv/wagate/patches/aa-dev-dispatch.ts.bak.route.<ts> /srv/wagate/patches/aa-dev-dispatch.ts` |
| B1 挂载 | `cp -p /etc/systemd/system/wagate.service.d/route-mount.conf.bak.route.<ts> /etc/systemd/system/wagate.service.d/route-mount.conf`（首次创建则 `rm -f` 该文件）后 `systemctl daemon-reload && systemctl restart wagate` |
| B1 env | `cp -p /etc/wagate.env.bak.route.<ts> /etc/wagate.env` 后重启 |
| B1 紧急停用（不卸载） | `/etc/wagate.env` 里把 `WAGATE_DISPATCH_OFF` 改成 `1` 后重启；插件会返回中性文案「dispatch 已停用」 |
| B2 skillGuide | `cp -p /srv/wagate/personal-assistant.ts.bak.route.<ts> /srv/wagate/personal-assistant.ts` 后重启 |

所有 `.bak.route.<ts>` 由脚本自动生成；`<ts>` 是执行时的 unix 秒。

## 灰度验收用例

### VM 侧（快速通道 `[route:light]`）

| # | 用例 | 期望 |
|---|------|------|
| 1 | 3 个小任务，issue 正文带 `[route:light]` | worker 日志零 subagent 调用；一轮自检后直接出 PR |
| 2 | 1 个未标记任务 | 行为与改动前一致（无回归） |

### EU 侧

| # | 用例 | 期望 |
|---|------|------|
| 3 | 「做个OA系统」 | 走 `dispatch_dev` → 出规格 → 开 issue + 触发评论；回复含工单链接；**不做本地自建** |
| 4 | 文档 / 单页任务 | 与改动前一致，零变化（不触发派单） |
| 5 | 模拟规划官超时 | 返回 isError + 中文人话，**不降级为本地执行** |
| 6 | 同一请求连发两次 | 第二次走熔断分支，转为追问而非再次本地糊一个 |

### 观察期指标

- 派单成功率（issue 创建成功且触发评论成功 / 总调用）
- 熔断触发次数（同一 session 反复判轻）
- 审计文件增长：`/srv/tenants/.dispatch-audit/dispatch-YYYYMMDD.jsonl` 每行一事件
  （`ts` / `sid` / `action` / `issue` / `result`），按天轮转
- 规划官超时率（`WAGATE_DISPATCH_*` 相关 isError 占比）
- 误判为「本地可做」的申诉数（用户反馈要做成完整系统却被 bounce）

## 已知限制

- **本包不执行任何部署**：worker 无 EU/VM 生产凭据，全部脚本由操作员手工运行。
- `deploy-plugin.sh` 的首次部署会先 restart 一次让 BindMount 生效，再在容器内做
  构建验证与 smoke；因此首次执行会有一次短暂重启。
- 规划官地址探测依赖容器内 `curl` 或 `wget` 可访问 3001 端口；网络策略不同时
  需操作员手工填写 `WAGATE_DISPATCH_PLANNER_URL`。
- `patch-skillguide.py` 通过正则定位 `skillGuide` 后的第一个字符串常量；若上游把
  该注入文本改成拼接或外部文件，脚本会明确报错并让操作员人工确认，不会瞎猜。
- B1 插件的 `.ts` 由 `deploy-plugin.sh` 在容器内用 `bun build` 验证真实可构建，
  并额外做一次 `import` 运行时 smoke；本地无 bun/tsc，未在开发机做类型检查。
