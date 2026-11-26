# 部署与维护

在单台服务器上用 Docker Compose 部署 Scova，并完成备份、升级和日常维护。个人电脑本地运行可选择 [SQLite 本机版](local-development.md#sqlite-本机版)。

部署包含 Web 工作台、API、Worker、同源静态资源与反向代理、PostgreSQL 17 和 Redis 7。Web 镜像只含构建后的静态资源和 Nginx 配置。后端主运行时为 Bun 1.3.4，后端镜像内装有 Node 24.22.1、Vite+ 1.4.0 和 PostgreSQL 17 客户端。功能范围见[工作台说明](web-workbench.md)。

## 快速开始

需要 Docker Engine（或 Docker Desktop 的 Linux 容器）和 Compose v2。请为 Scova 使用独立的数据库，不要与其他应用共用数据库或 Redis 队列名称。

1. 复制 `.env.example` 为 `.env`，修改以下配置，不要提交 `.env`：
    - 把数据库密码替换为随机值，建议使用随机十六进制文本，避免连接 URL 转义问题。
    - 为 `WORKER_EXECUTION_TOKEN` 设置独立的 32 字节随机令牌（可用 64 位十六进制）。
    - 只有启用内置 SearXNG 时才需要设置随机搜索密钥。
2. 构建并启动，再查看健康状态：

```sh
docker compose up --build -d
docker compose ps
```

3. 打开 `http://localhost:8080/tasks`。默认只绑定 `127.0.0.1:8080`。

启动时先运行一次性的 `migrate` 服务，业务迁移和 LangGraph saver 迁移都成功后，API 和 Worker 才会启动。更新源码后再次执行 `docker compose up --build -d` 才会重新构建 Web 资源。

健康检查：

- **`GET /health`**：API 存活检查。
- **API 容器**：额外核验 PostgreSQL、所选协调存储、业务迁移和 saver 版本。
- **Worker 容器**：启动时验证内部执行接口的鉴权、检查点版本和队列名称，健康检查读取 Worker 的心跳。
- **代理容器**：验证 Web 入口可读。

## 配置

### 搜索与模型

- **模型**：设置 `MODEL_API_KEY`、`MODEL_NAME` 和必要的 `MODEL_BASE_URL` 作为部署默认模型；或设置 `AGENT_CREDENTIAL_KEY`，让各账号在界面添加个人供应商。详见 [Agent 配置](agent-configuration.md)。
- **加密主密钥**：模型默认值和加密主密钥由 Server 持有，**主密钥必须独立备份**。
- **搜索**：搜索服务、密钥和正文策略只在账号的独立搜索区域配置，服务器没有默认搜索 Agent。旧的 `SEARCH_PROVIDER`、`SEARCH_API_*`、`TAVILY_API_KEY` 不再生效。详见[搜索说明](search.md)。
- **执行方式**：手动、重试和定时执行都是真实研究，旧的 `WORKER_SCHEDULED_RUN_MODE` 已移除。缺少凭据或调用失败时明确报错，不会静默切换到演示、付费渠道或其他供应商。

可选的 SearXNG 使用固定镜像，以非 root 运行。设置随机 `SEARXNG_SECRET` 后启动：

```sh
docker compose --profile live-search up -d
```

`SEARXNG_BASE_URL` 是内置工具的基础设施地址，容器内使用 `http://searxng:8080`，不要用宿主机的 localhost。

### 报告附件对象存储

单个附件超过 256 KiB 时，API 把原件存入私有桶，最大 10 MiB，元数据保存在 PostgreSQL。

| 变量                                                                   | 说明           |
| ---------------------------------------------------------------------- | -------------- |
| `STORAGE_PROVIDER`                                                     | `r2` 或 `s3`   |
| `STORAGE_BUCKET`、`STORAGE_ACCESS_KEY_ID`、`STORAGE_SECRET_ACCESS_KEY` | 两种服务都需要 |
| `STORAGE_R2_ACCOUNT_ID`                                                | 仅 R2          |
| `STORAGE_REGION`                                                       | 仅 S3          |

- 凭据需要能读、写、删除 `report-attachments/` 下的对象。
- 下载经同源 API 鉴权，无需开放公共读权限，也无需配置浏览器 CORS。
- Server 会周期性清理没有报告附件引用的对象，包括上传中断留下的对象。
- **备份要同时保留 PostgreSQL 和对应的桶对象。** 调整桶或前缀前，先复制仍被业务库引用的对象，并保留原有对象路径。

### 同源、TLS 与 SSE

- **`APP_ORIGIN`** 必须是客户端实际使用的完整源。
- 默认的 HTTP localhost 依赖浏览器对本机 Secure Cookie 的例外。不要改用 HTTP 的 IP 地址访问，浏览器可能拒绝保存 Secure Cookie。
- 面向其他机器部署，或浏览器不支持该例外时，在代理前配置 TLS，并把 `APP_ORIGIN` 设为相同的 HTTPS 地址。
- 生产 Cookie 保持 Secure 和 HttpOnly，不要为了绕过域名或 TLS 配置错误而取消 Secure。
- `/api`、`/health`、`/swagger` 及其子路径转发真实后端响应，不走 SPA 回退或静态缓存。
- 代理对 SSE 关闭缓冲、缓存和压缩，透传 Cookie、Origin 和 Last-Event-ID。上游读取超时为 75 秒，大于 15 秒的心跳间隔；客户端断开会关闭上游。
- `GET /api/v1/runs/:runId/events` 在同一认证会话下持续推送事件。断线后带上上一事件的 `Last-Event-ID` 可按顺序续传，终态事件读尽后连接关闭。其他账号访问返回 404。
- `/tasks`、`/reports/:id` 等无文件路由回退到 `index.html`，由 Vue Router 处理。缺失的 `/assets/*` 和带扩展名的静态文件保持 404。
- `index.html` 和普通公共文件使用 `Cache-Control: no-cache`；`/assets/` 下带哈希的产物缓存一年（immutable）。只把带内容哈希的构建资源放进 `/assets/`。
- 部署在源的根路径，不支持子目录 base。

### 容器与 Worker 安全

- API、Worker 和 Web 代理以非 root 运行，使用只读根文件系统和临时 `/tmp`。只有代理发布端口，PostgreSQL 位于独立的数据库网络。
- PostgreSQL 与 Redis 使用独立持久卷，Redis 开启 AOF/everysec。
- Worker 通过默认网络上的 `http://api:3001` 访问内部执行接口。跨主机部署时，用受控内网和 HTTPS 承载该接口。
- Worker 使用 `worker-runtime` 镜像（含锁定版本的 Chromium），配有 256 MiB `/dev/shm` 和 1536 MiB 内存上限。
- 容器默认 `READER_CHROMIUM_SANDBOX=false`，安全边界由非 root、只读根文件系统、cap drop 和 no-new-privileges 提供。需要额外的 Chromium sandbox 时可设为 `true`，请先在目标内核上验证。
- Reader 只处理非交互的公网页面，会执行 JavaScript 生成 DOM，但阻止写请求、凭据、下载、WebSocket、service worker 和二次导航。单次读取最多 15 秒，总资源 8 MiB。

### 使用 SQLite 做队列与协调

单机 Compose 可叠加 `compose.sqlite.yaml`：只替换 Redis，用挂载到 Server 的 SQLite 文件处理队列与协调，业务数据库仍是 PostgreSQL。需要 Docker Compose 2.24.4 或更新版本（支持 `!override`）。

```sh
docker compose -f compose.yaml -f compose.sqlite.yaml up -d --build --wait
```

- 可先用独立的 Compose 项目名试运行。切换已有实例前，先停止 API 和 Worker，并在维护命令中使用相同的 Compose 文件组合。
- 让 `vp run operations` 使用相同组合：

```sh
# Bash
export COMPOSE_FILE=compose.yaml:compose.sqlite.yaml
# PowerShell
$env:COMPOSE_FILE='compose.yaml;compose.sqlite.yaml'
```

- 协调状态保存在 `sqlite-state` 卷，仅 Server 和维护容器挂载该卷。API 和 Server 维护命令须使用同一主机上的可写磁盘。
- 业务备份仍通过 PostgreSQL 维护命令完成。需要保留协调状态时，先停止 API、Worker 和维护进程，再对整个 SQLite 卷做一致快照。
- 分布式部署继续使用默认的 Redis 协调。

### Worker 并发

Server 的 `api` 服务同时运行定时调度、Outbox 投递和可恢复 Run 回补，Worker 可横向扩容。`WORKER_QUEUE_NAME` 由 Server、Worker 和维护命令共用。

以下变量现在配置在 `api` 而不是 Worker：

| 变量                           | 默认值  | 单位 |
| ------------------------------ | ------- | ---- |
| `WORKER_POLL_INTERVAL_MS`      | `1000`  | 毫秒 |
| `WORKER_FAILURE_DELAY_MS`      | `5000`  | 毫秒 |
| `WORKER_BATCH_SIZE`            | `50`    | 条   |
| `WORKER_LEASE_SECONDS`         | `30`    | 秒   |
| `WORKER_SCHEDULER_INTERVAL_MS` | `30000` | 毫秒 |
| `WORKER_SCHEDULER_CONCURRENCY` | `2`     | 个   |

`WORKER_RUN_CONCURRENCY` 控制每个 Worker 同时消费的 Run 数，默认 `2`，范围 `1–32`。有任务排队且资源未饱和时：

1. 把 `.env` 中的值提高到 `4`。
2. 等在途任务结束。
3. 重建 Worker：

```sh
docker compose up -d --no-deps worker
```

宿主机开发时，改 `.env.local` 并重启 Worker。每次调整后观察队列等待时间、Run 错误和超时率、数据库连接等待、Worker 内存和供应商 429，再决定是否继续提高。

- 同一个任务最多有一个活跃 Run。不同账号共享队列和执行槽位，目前没有按账号预留槽位或公平轮转。
- 多个 Worker 实例会叠加消费槽位，也会增加数据库连接、Chromium 和供应商资源消耗。设定上限不等于实测容量。
- 面向多租户前，应先设计整队列并发上限、按账号排队和运行配额，再扩大实例数。

## 备份与升级

### 日常维护方式

`vp run operations ...` 会先停止代理、API 和 Worker，再运行一次性维护容器。不会自动恢复应用，便于检查结果。

- 所有维护使用同一个 Compose 项目和 `.env`，完成后执行 `docker compose up -d`。
- 不要同时启动应用和维护。维护 CLI 需要 `SCOVA_MAINTENANCE=1`，并拒绝仍带生产应用名称的数据库连接。
- 确认应用已停止后，也可直接调用：`docker compose --profile maintenance run --rm operations ...`。

### 备份

```sh
vp run operations backup --name=2026-10-26.dump
docker compose up -d
```

- 备份使用 `pg_dump` 的 custom 格式，包含整个专用数据库及业务和 saver 两套迁移记录。
- 文件以 0600 权限保存在 `backups` 命名卷，完成后原子发布，不覆盖同名文件。`.partial` 文件表示未成功发布，不能用于恢复。
- 备份包含账号资料、报告和抓取内容，请按数据库同等权限保管。可用 `docker compose cp` 或只读挂载该卷，把备份复制到受控的离机存储。
- 建议每天备份一次，至少保留最近 7 个成功备份和每次升级前的备份，并自行配置离机副本和删除周期。
- 正文和账号删除不会追溯擦除已有的离线备份。
- 别忘了单独备份模型凭据的加密主密钥。

### 升级

升级前先用旧版本镜像完成备份并验证可恢复。保持应用停止，设置好内部令牌，再构建新镜像、迁移并启动同版本的 Server 和 Worker：

```sh
vp run operations backup
docker compose build
vp run operations migrate
docker compose up -d
```

- 从 Prisma 版本首次升级时，新镜像的备份命令要求原生迁移账本已存在，所以升级前的备份必须由旧镜像执行。迁移会核验旧账本和完整物理结构后接管，保留业务数据和历史账本。
- 迁移服务再次运行时，若当前全部版本已齐，只返回只读的 current 结果。需要 DDL 时，API 和 Worker 必须已停止。
- 升级 Worker 时先停旧 Worker，再以同一版本更新 `api` 和 Worker，保持内部执行协议版本一致。已保存的 Run 和 Outbox 不会丢失。
- 迁移失败时保持应用停止并检查原因。只有新版本尚未写入数据、旧版本结构也兼容时，才考虑回退镜像。
- 恢复备份会丢弃恢复点之后的数据，必须先评估并保存新增数据。
- **不要使用 `down -v` 作为升级或恢复步骤。** 正常的 `docker compose down` 会保留数据。

### 恢复

恢复需要与备份匹配的应用镜像和一个空的 PostgreSQL 数据库。保持 API 和 Worker 停止，把备份卷接到目标部署，目标 PostgreSQL 卷应是新卷。不要先执行迁移，否则目标库已非空。

```sh
docker compose up -d postgres redis
# 预览，不执行恢复
docker compose --profile maintenance run --rm operations restore --name=2026-10-26.dump
# 确认目标配置后执行恢复
docker compose --profile maintenance run --rm operations restore --name=2026-10-26.dump --apply
docker compose up -d
```

- `pg_restore` 在单个事务内恢复，并拒绝非空目标。
- PostgreSQL 是执行事实源。新的 Redis 卷可由 Outbox 和恢复扫描重建作业。
- 若另外备份了 Redis 卷，须先停止 Redis，完整复制 `/data`，不要只复制 AOF 的某个分片。
- 恢复后先确认任务、报告、引用、基线和已提升的 checkpoint 可读，再恢复对外流量。

### 30 天原始数据保留

```sh
vp run operations retention            # 默认只预览
vp run operations retention --apply    # 执行清理
docker compose up -d
```

- 每批最多清理 100 个旧终态 Run、100 个到期正文快照和 100 份到期的报告 Markdown 暂存。重复执行直到计数为 0。
- Run 按 `finishedAt` 超过 30 天筛选，快照按 `textExpiresAt` 筛选。
- 清理内容包括快照正文、ToolCall 完整输出，以及 saver 的 checkpoints、blobs、pending writes（所有 epoch 和未提升线程），同时清空已清理终态 Run 的 checkpoint 引用。
- 导出暂存的清理不会删除原报告。账号再次导出时，也会清理该账号的到期暂存。
- 活跃或待恢复 Run 的工具结果和 checkpoint 不会清理，被活跃 Run 引用的快照正文也保留。
- 报告、短引用、定位、指纹、元数据、用量账本和基线事实清单继续保留，历史引用仍可解释。
- 保留策略不删除 RunEvent。自行维护事件保留时，必须保留每个 Run 的最新事件，避免序号分配器重用历史 seq。

### 账号删除

```sh
vp run operations delete-account --user-id=账号UUID            # 默认只预览
vp run operations delete-account --user-id=账号UUID --apply    # 执行删除
docker compose up -d
```

- 先停止全部应用并等待在途工作结束。
- 命令按 Run ID 移除该账号的已知 BullMQ 作业，再在同一个 PostgreSQL 事务内撤销会话、归档任务、清除所有 saver epoch 并删除账号。
- 任务版本、执行、Outbox、事件、报告、Inbox、通知、来源、引用、收藏、笔记、反馈和报告问答随账号一起级联删除。
- 数据库失败会回滚业务数据和图状态。已移除的队列作业可由保留的 Outbox 重建。
- Redis 失败时不会删除数据库，重试命令即可。**不要清空共享 Redis。** 其他账号的队列、数据和基线不受影响。

## 停止应用

```sh
docker compose stop
```

应用收到信号后停止领取任务和外部调用，等待在途写入完成，再关闭队列、数据库和 HTTP，预留 60 秒停止窗口。被强杀的 Run 由数据库租约恢复。外部供应商可能被重复调用，但报告、Inbox 和通知不会重复。

## 常见问题

- **登录后立刻掉线或 Cookie 不保存**：检查 `APP_ORIGIN` 是否与浏览器地址完全一致。通过 HTTP 的 IP 地址访问时，浏览器可能拒绝 Secure Cookie，请改用 `http://localhost:8080` 或配置 HTTPS。
- **SSE 事件延迟或断开**：确认自建代理关闭了缓冲、缓存和压缩，上游读取超时大于 15 秒的心跳间隔。
- **缺凭据导致执行失败**：这是预期行为，补充模型和搜索配置即可，草稿仍可手工编辑。
- **维护命令拒绝运行**：确认应用已停止，且设置了 `SCOVA_MAINTENANCE=1`。
- **接口鉴权**：通过 `POST /api/v1/auth/register` 或 `/auth/login` 获取会话和 `csrfToken`，写请求须携带同源 `Origin`、Cookie 和 `x-csrf-token`。完整接口见[契约](../reference/contracts.md)与 [API](../reference/api.md)。
