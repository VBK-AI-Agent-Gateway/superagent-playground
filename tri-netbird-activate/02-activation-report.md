# EU NetBird 复机与激活报告

- **主机**: `5.189.129.216`（EU，`vmi3595830`）
- **部署目录**: `/opt/netbird-server`（compose v1，命令 `docker-compose` 1.29.2）
- **报告时间**: 2026-11-06
- **数据源**: 只读核查（`docker ps -a` / `docker inspect` / `docker logs` / 卷内文件列举 / 宿主监听与 HTTP 探测）。本次交付**未在 EU 上执行任何写操作**。

> ⚠️ **执行边界（必读）**：本目录内的脚本与补丁**只产出、不执行**（派单评论明确要求「无生产凭据，操作员审后执行」）。下方「复机步骤」是给操作员逐条执行的命令清单；所有结果性描述均标注了来源，凡未实测的结论一律标为*待实测*。

---

## 1. 复机时间线

| 时间（UTC） | 事件 | 证据来源 |
|---|---|---|
| 2026-09-18 19:18 | `netbirdio/netbird-server:latest` 镜像构建（`d1da0c0179c9`）；`netbirdio/dashboard:latest` 构建于 2026-09-03（`fa2d8b02a817`） | `docker images` |
| 2026-09-22 07:56 / 08:01 | 历史上正常启动，日志出现 `geolocation service has been initialized from /var/lib/netbird` | `docker logs netbird-server` |
| 2026-09-24 / 09-28 / 10-03 | 正常运行期；偶发 `no valid authentication provided`（未认证探测，非故障） | 同上 |
| **2026-10-18 13:47** | **`FATL combined/main.go:11: failed to execute command: 1 error occurred`** —— 首次启动失败 | 同上 |
| 2026-10-18 14:01 – 14:08+ | 连续 `FATL management/internals/server/modules.go:50: could not initialize geolocation service: failed to get database filename: Head "https://pkgs.netbird.io/geolocation-dbs/GeoLite2-City/download?suffix=tar.gz": dial tcp 5.22.212.152:443: i/o timeout` | 同上 |
| 2026-10-31 04:38:16 | 最后一次启动尝试：migration 全部跑完（peers/setup_keys/policies/groups/… 全部 `no migration needed`） | 同上 |
| 2026-10-31 04:38:47 | `resolve domains: using persisted account domain "netbird.selfhosted"` —— 已越过 migration，进入服务装配阶段 | 同上 |
| **2026-10-31 04:39:04** | **进程以 exit code 2 退出**（`{{.State.FinishedAt}}`），此后未再自行起来 | `docker inspect` |
| 2026-11-06（核查时） | `netbird-server` `status=exited`，`RestartCount=34528`，`ExitCode=2`；`netbird-nginx` Exit 0、`netbird-dashboard` Exit 0 | `docker inspect` |

**说明**：`docker ps -a` 显示的「6 天前退出」对应 10-31 那次退出；而故障的**起点是 10-18**，日志中累计 34,529 条 `FATL`（同一根因在 `restart: unless-stopped` 下反复重启）。

---

## 2. 原退出原因（根因）

**直接原因**：`netbird-server` 在启动装配阶段初始化 geolocation（GeoIP）服务时，需要向 `pkgs.netbird.io` 发起 `HEAD` 请求解析数据库文件名；该请求 `dial tcp 5.22.212.152:443: i/o timeout`，初始化失败即 `FATL` 退出，进程退出码 **2**。

**关键观察（影响修复方案）**：

1. `/opt/netbird-server/config.yaml` 末尾**已经存在** `geoip: enabled: false`（第 35–36 行，缩进为 1 空格）。
2. 但 10-18 起的日志仍然走到 `could not initialize geolocation service` —— 说明该配置块**未被正确解析**（见下方分析），GeoIP 初始化依旧被执行。
3. 数据卷内**geodata 文件齐全**：`GeoLite2-City_20260911.mmdb`（65,921,355 B）、`geonames_20260911.db`（7,208,960 B），另有 `store.db`（749,568 B，**既有用户数据**）、`idp.db`、`events.db`。历史上（09-22）正是从 `/var/lib/netbird` 成功初始化过 geolocation。
4. 卷内**没有** `geodata/` 子目录 —— 文件直接位于卷根。
5. 部署内 `config.yaml` 挂载为 `:ro`，且文件被当作**带顶层 `server:` 段的合并配置**书写；末尾 `geoip:` 段顶格书写、子键仅缩进 1 空格。

**推断**：`geoip.enabled: false` 之所以没生效，最可能是该段的**缩进/YAML 结构未被配置加载器接受**（子键 1 空格缩进）；同时即使 geoip 被关闭，该版本仍会尝试初始化 geolocation 数据库命名，从而必须在启动时访问外网。10-31 那次已经跑完 migration 才退出，证明**失败点在 migration 之后的服务装配**，与数据卷内容无关 —— 因此**不需要、也绝不允许**重置或删除数据卷。

> **红线遵守声明**：本次核查未删除、未重置、未迁移任何数据卷；`store.db` 保持原样。按 issue 第 2.1 条，仅在「判断必须重置才能激活」时才需停机汇报——经上述证据判断**不需要重置**，故本报告继续给出最小改动方案。

---

## 3. 修复方案（最小改动 diff，供操作员审核后执行）

原则：**只动 `/opt/netbird-server` 内的配置文件，不动镜像、不动卷、不动 compose 版本**。

### 3.1 修复 `config.yaml` 的 geoip 段（YAML 结构修正，不改语义）

```diff
--- a//opt/netbird-server/config.yaml
+++ b//opt/netbird-server/config.yaml
@@
-geoip:
- enabled: false
+geoip:
+  enabled: false
```

要点：
- 把 `enabled` 的子键缩进从 **1 空格**改为**2 空格**，与文件内其它段（如 `server:` 下为 2 空格、其子键 4 空格）保持一致的 YAML 层级。
- **不改动** `geoip.enabled` 的取值（保持 `false`）、**不改动**其余任何键。
- 若该版本要求顶层段顶格，则此改法即为让 `enabled` 真正成为 `geoip` 的成员键。

### 3.2 备份原文件（执行任何写入前）

```bash
cd /opt/netbird-server
cp -a config.yaml "config.yaml.bak.$(date +%Y%m%d-%H%M%S)"
```

### 3.3 复机与验证（操作员执行）

```bash
cd /opt/netbird-server
docker-compose up -d
sleep 20
docker ps -a --format '{{.Names}}\t{{.Status}}'      # 期望三容器 Up
docker logs --tail 50 netbird-server                 # 期望无 FATL
```

验证脚本（本次交付物，只读）：`bash 01-verify.sh`（默认目标 `root@5.189.129.216`）。

### 3.4 若 3.1 仍报同一 `FATL`（备用最小改动）

说明该版本**无论如何都要**在启动时访问 `pkgs.netbird.io`。按「最小改动、不加新组件」原则，备选顺序如下，**逐条尝试、勿并行**：

1. **确认出网**：`curl -sI --max-time 10 https://pkgs.netbird.io/` 在 EU 上返回 200（核查时从本 VM 探测为 200，EU 侧*待实测*）。若 EU 侧超时，则是**出网/防火墙问题**，修复网络放行即可，不改配置。
2. **预置 geodata**：把已有 `GeoLite2-City_20260911.mmdb` 与 `geonames_20260911.db` 放到该版本期望的路径（若要求子目录，则创建 `/var/lib/netbird/geodata/` 并置入），使其无需联网下载。
3. 仍失败则**停手汇报**，附 `docker logs` 与所用 config.yaml，请操作员定夺。

> 上述 3.4 属于**备用路径**，未在 EU 实测；请以 3.1 + 3.3 为首选。

---

## 4. 激活记录

**前置判定规则（依 issue 第 2.3 条）**：先读取 `GET /api/instance`，看 `setup_required`：

- `setup_required: true` → 走首次激活，创建首个管理员；
- `setup_required: false` → 历史上已建过管理员，**只验证登录入口 200 并如实记录，不重置密码**。

### 4.1 只读核查结论（已实测，直接决定走哪条分支）

对数据卷 `store.db` 的只读查询（`sqlite3 -readonly`，未改任何数据）显示：

| 表 | 内容 | 结论 |
|---|---|---|
| `accounts` | 1 条：`dap1r8udv81s73ap6350`，domain `netbird.selfhosted`，建于 **2026-09-22 06:18:11 UTC** | 账号已存在 |
| `users` | 1 条：`role=owner`、`is_service_user=0`、`blocked=0`，建于 2026-09-22 06:18:11 UTC | **管理员已存在** |
| `setup_keys` | 1 条：`General key for employee devices`，`type=reusable`，`expires_at=2026-09-29 06:28:26 UTC`，`revoked=0`，**`used_times=0`** | **key 已存在但已过期** |
| `peers` | **0 条** | 从未有设备接入成功 |

**由此得出（重要）**：

1. **激活（首个管理员创建）在 2026-09-22 就已完成**，因此复机后 `setup_required` 预期为 **`false`** → 按规则走**情形 B**，**不重置密码、不新建管理员**。
2. **无需**执行 `POST /api/instance/setup`（第 4.3 节情形 A 仅在核查结论被推翻时备用）。
3. 现存 setup key **已于 2026-09-29 过期**（距今约 38 天），且从未被使用。**最终用户拿它注册会失败**，必须新建一条（第 5 节），旧 key 可顺手 Revoke。这正是 issue 第 2.5 条要求「配置一个可复用、配额 ≥10 的 key」的实际原因。
4. 管理员**邮箱**在库中以密文存储（AES-GCM，密钥为 `config.yaml` 的 `store.encryptionKey`），**只读查询无法解出明文**。因此下表邮箱记为*待复机后从 Dashboard 读取*，**不臆造**。历史默认值为 `admin@netbird.selfhosted`，供参考但不作为事实断言。

### 4.2 激活步骤（操作员执行，复机并确认 8443 返回 200 之后）

```bash
# 1) 读取账号状态（预期 setup_required=false）
curl -sk https://127.0.0.1:8443/api/instance
```

**情形 B（预期命中）：`setup_required: false`** —— 只验证登录入口，不动账号：

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/
# 期望 200；不重置、不新建管理员
```

随后用**既有管理员**登录 Dashboard（邮箱见下表；密码仅在 `secrets/NETBIRD-ACCESS.md`），在 **Setup Keys** 页确认现存 key 状态并按第 5 节新建一条。

**情形 A（备用，仅当实测 `setup_required: true`）**：

```bash
curl -sk -X POST https://127.0.0.1:8443/api/instance/setup \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@netbird.selfhosted","password":"<强密码>","name":"Administrator"}'
```

> 实际请求体以该版本 API 为准；若字段名不同，以返回的错误信息微调。若实测为 `true`，说明现有账号库未被识别，**先停下来在本 issue 汇报**再动。

### 4.3 激活记录表

| 项 | 值 |
|---|---|
| 账号 ID | `dap1r8udv81s73ap6350`（domain `netbird.selfhosted`） |
| 管理员用户 ID | `CiQ2M2U4ZmI3NS0zNzk2LTQxZWEtOTQ0Ni1iMzg1M2QyODJmM2YSBWxvY2Fs`（role=owner, blocked=0） |
| 管理员邮箱 | *待复机后从 Dashboard 读取*（库内为密文，无法只读解出；历史默认 `admin@netbird.selfhosted`） |
| 管理员密码 | **仅存 `secrets/NETBIRD-ACCESS.md`**，见第 6 节 |
| 首个管理员创建时间 | 2026-09-22 06:18:11 UTC（已实测） |
| `setup_required` 实测取值 | *待复机后填写*（依上表预期为 `false`） |
| 登录入口 HTTP 状态 | *待复机后填写* |
| 现存 setup key | `dap202mdv81s73ap666g` / `General key for employee devices` / reusable / **expires 2026-09-29（已过期）** / used_times=0 / revoked=0 |
| 现存 peer 数 | 0（从未接入） |

---

## 5. 最终用户接入用的 Setup Key（issue 第 2.5 条）

现存 key 已过期（见 4.1），**必须新建**。以下为操作员在 Dashboard 中的步骤（推荐，可视化、可随时撤销）：

1. 以管理员登录 **https://5.189.129.216:8443**。
2. 左侧 **Setup Keys** → **Create Setup Key**。
3. 填写：
   - **Name**: `employee-devices-2026-11`（示例，便于日后定位撤销）
   - **Type**: **Reusable**（多台设备可复用 —— issue 要求）
   - **Expires in**: 选 **30 days**（issue 允许「永不过期或 30 天内」；此处取 30 天更安全）
   - **Usage limit / Quota**: **≥ 10**
   - **Auto-assigned groups**: 按需（如 `All`），不确定则留空
4. 创建后页面会**一次性显示明文 key** —— 立即复制到 `secrets/NETBIRD-ACCESS.md`，并记下 key 名称/ID。
5. 顺手把已过期的旧 key（`General key for employee devices`，2026-09-29 过期）**Revoke**，避免混淆。

**登记要求（issue 第 2.5 条）**：`secrets/NETBIRD-ACCESS.md` 中同时登记 **key 明文 + 名称/ID + 过期 + 配额**，并写明**可由操作员随时撤销/轮换**（该说明已写在该文件顶部）。**明文 key 不得出现在本报告、issue 正文/评论或任何其它位置。**

**已实测的旧 key 元数据（供对照，非机密）**：`id=dap202mdv81s73ap666g`、name=`General key for employee devices`、type=`reusable`、`created_at=2026-09-22 06:28:26 UTC`、`expires_at=2026-09-29 06:28:26 UTC`、`revoked=0`、`used_times=0`、`usage_limit=0`、`ephemeral=0`。

---

## 6. 接入配置核对

### 6.1 对外地址一致性（已核查，全部指向 `https://5.189.129.216:8443`）

| 文件 / 项 | 值 | 结论 |
|---|---|---|
| `config.yaml` → `server.exposedAddress` | `https://5.189.129.216:8443` | ✅ 一致 |
| `config.yaml` → `server.auth.issuer` | `https://5.189.129.216:8443/oauth2` | ✅ 一致 |
| `config.yaml` → `server.auth.dashboardRedirectURIs` | `.../nb-auth`、`.../nb-silent-auth` | ✅ 一致 |
| `dashboard.env` → `NETBIRD_MGMT_API_ENDPOINT` | `https://5.189.129.216:8443` | ✅ 一致 |
| `dashboard.env` → `NETBIRD_MGMT_GRPC_API_ENDPOINT` | `https://5.189.129.216:8443` | ✅ 一致 |
| `dashboard.env` → `AUTH_AUTHORITY` | `https://5.189.129.216:8443/oauth2` | ✅ 一致 |

### 6.2 端口发布（compose 声明，已核查）

| 端口 | 协议 | 用途 | compose 声明 |
|---|---|---|---|
| 8443 | TCP | 主入口（nginx TLS 终结 → dashboard/server） | `0.0.0.0:8443:443` ✅ |
| 8085 | TCP | HTTP → 8443 的 301 跳转 | `0.0.0.0:8085:80` ✅ |
| 3478 | **UDP** | STUN | `0.0.0.0:3478:3478/udp` ✅ |

**宿主监听实测**：*待复机后由 `01-verify.sh` 采集*（`ss -tlnup | grep -E '8443|8085|3478'`）。核查时三容器均未运行，故当前无监听。

**防火墙 / 云安全组**：需在操作员侧确认对该三端口放行。核查范围内**未**读取、**未**修改任何防火墙规则；证据请由操作员在复机后用 `iptables -S` / 云控制台截图补入本节。

---

## 7. 凭据管理（`secrets/NETBIRD-ACCESS.md`）

- 管理员**密码**与 **setup key** 只写入 `secrets/NETBIRD-ACCESS.md`（git 跟踪的交付物内），**不进 issue 正文/评论、不进 chat、不落在仓库其它任何文件**。
- 该文件顶部含**轮换说明**：两者均**可由操作员随时撤销/轮换**：
  - setup key → dashboard → Setup Keys → 选中 → **Revoke/Delete**，随后新建；
  - 管理员密码 → 以管理员身份在 dashboard 重置，或新建第二管理员后停用旧账号。
- 本次交付**未**在 EU 上创建任何 setup key，也**未**写入任何真实凭据；`secrets/NETBIRD-ACCESS.md` 中的敏感值为**占位符**，待操作员复机并激活后填入。

---

## 8. 本次核查做了 / 没做什么

**做了（全部只读）**：`docker ps -a`、`docker inspect`、`docker logs`、数据卷内文件列举、`docker images`、读取 `/opt/netbird-server/{docker-compose.yml,config.yaml,dashboard.env,nginx.conf?}`、从本 VM 探测 EU 端口与外网。

**没做**：未 `docker-compose up/down`、未重启任何容器、未改任何配置或镜像、未创建/删除卷、未创建 setup key、未改防火墙、未触碰 `wagate`、`ai-gateway`、系统级 nginx、任何 systemd 服务或 ASG 数据。
