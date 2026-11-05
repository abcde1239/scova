# 单机 Web 部署与维护

当前提供 Vue 工作台、API、Worker、同源静态资源/反向代理、PostgreSQL 17 和 Redis 7 的 Docker Compose 部署。登录、任务、执行、简报及资料库等页面已接入，路由可刷新访问；功能与剩余范围见[工作台说明](web-workbench.md)。Web 镜像只包含构建后的静态资源与 Nginx 配置，浏览器不需要 Node/Bun。后端主运行时为 Bun 1.3.4，后端镜像内安装 Node 24.22.1、Vite+ 1.4.0 和 PostgreSQL 17 客户端。这是单机 Web 部署，不是桌面端或本地一体化应用。

## 启动

需要 Docker Engine/Desktop Linux 容器与 Compose v2。为此项目使用独立数据库，不与其他应用共用数据库或 Redis 队列名称。

1. 复制 `.env.example` 为 `.env`，把数据库密码和搜索密钥替换为随机值。数据库密码使用随机十六进制文本，避免连接 URL 的转义歧义；不要提交 `.env`。
2. 执行 `docker compose up --build -d`，再用 `docker compose ps` 查看健康状态。
3. 默认只绑定 `127.0.0.1:8080`。打开 `http://localhost:8080/tasks` 访问工作台。`GET /health` 是 API 存活检查；API/Worker 容器健康检查另外核验 PostgreSQL、Redis、全部业务迁移和 saver 版本，代理健康检查验证 Web 入口可读。Worker 还必须持续更新就绪心跳。

`Dockerfile` 的 `build` 阶段在 Linux 内安装锁定依赖并运行全部工作区构建；`web` 目标从 `apps/web/dist` 复制静态产物，Compose 的 `proxy` 服务使用该目标，`runtime` 目标保留 API/Worker/维护工具。构建不从宿主机复制 dist 或 node_modules，也不将后端模型凭据作为前端构建参数。更新源码后执行 `docker compose up --build -d` 才会重新构建 Web 资源。

启动先执行一次性 `migrate` 服务。Drizzle 业务迁移和 LangGraph saver 迁移均成功后，API/Worker 才启动。迁移服务再次运行时若核验当前全部版本已齐，仅返回只读的 current 结果；需要 DDL 时仍要求 API/Worker 已停止。容器中的 `AGENT_CHECKPOINT_MIGRATION=external` 禁止 Worker 自动建表；本地开发默认保留启动时初始化 saver 的行为。升级前先使用旧版本镜像完成备份并验证恢复；保持应用停止，再构建新镜像、执行迁移并启动：

```sh
vp run operations backup
docker compose build
vp run operations migrate
docker compose up -d
```

从 Prisma 版本首次升级时，新镜像的备份命令要求原生迁移账本已经存在，因此升级前备份须由旧镜像执行。迁移会核验旧账本与完整物理结构后接管，保留业务数据和历史账本。失败时保持应用停止并检查原因。仅在新版本尚未写入且旧版本结构兼容时才考虑回退镜像；恢复备份会丢弃恢复点后的数据，必须先评估并保存新增数据。

API/Worker 与 Web 代理均由非 root 用户运行，只读根文件系统和临时 `/tmp`；PostgreSQL 与 Redis 使用独立持久卷，Redis 开启 AOF/everysec。仅代理发布端口，数据库、队列和搜索均在 Compose 网络内部。正常 `docker compose down` 保留数据；不要使用 `down -v` 作为升级或恢复步骤。

新执行统一进行真实研究。通过 `POST /api/v1/auth/register` 或 `/auth/login` 获取会话与 `csrfToken`，后续写请求携带同源 `Origin`、Cookie 和 `x-csrf-token`；先保存完整任务配置，再以 `{}` 或 `{ "mode": "live" }` 创建 Run。缺少必要搜索或模型配置时执行明确失败，草稿仍可手工编辑。完整配置及接口见 [契约](../reference/contracts.md) 与 [API](../reference/api.md)。

## 同源、TLS 与 SSE

`APP_ORIGIN` 必须是客户端实际使用的完整源。默认 HTTP localhost 用于支持本机 Secure Cookie 例外的浏览器；不要改用 HTTP IP 地址来访问，浏览器可能拒绝保存 Secure Cookie。面向其他机器部署或浏览器不支持该例外时，在代理前配置 TLS，并设置相同的 HTTPS `APP_ORIGIN`。生产 Cookie 保持 Secure/HttpOnly；不要通过取消 Secure 解决域名或 TLS 配置错误。

`/api`、`/health`、`/swagger` 及其子路径转发真实后端响应，不进入 SPA 回退或静态缓存。代理关闭 SSE 缓冲、缓存和压缩，透传 Cookie、Origin、Last-Event-ID，75 秒上游读取超时大于 15 秒心跳；客户端断开会关闭上游。`GET /api/v1/runs/:runId/events` 在同一认证会话下持续推送持久化事件；断连后传入上一事件的 `Last-Event-ID` 按顺序续传，终态事件读尽后关闭连接。不同账号访问返回 404。应用统一通信模块负责 Fetch transport 桥接与重连游标。

`/tasks`、`/reports/:id` 等无文件路由回退到 `index.html`，由 Vue Router 处理；页面可用范围见[Web 工作台](web-workbench.md)；未知页面由应用显示未找到页面状态。`index.html` 和普通公共文件使用 `Cache-Control: no-cache`；Vite 的 `/assets/` 哈希产物使用一年 immutable 缓存。缺失 `/assets/*` 和含扩展名的静态文件保持 404，不返回工作台 HTML；未知 API 仍由后端返回 JSON/404。只将带内容哈希的构建资源放入 `/assets/`，不要把可变文件复制到该缓存目录。部署在源的根路径，不配置子目录 base。

停止使用 `docker compose stop`：应用接收信号，停止领取与外部调用，等待在途领域写入，再关闭队列、数据库和 HTTP。应用预留 60 秒停止窗口；强杀后的 Run 由数据库租约恢复，不保证外部供应商只调用一次，但报告、Inbox 和通知不得重复。

## 真实服务 opt-in

SearxNG 是固定镜像、非 root 的可选服务。设置随机 `SEARXNG_SECRET` 后运行：

```sh
docker compose --profile live-search up -d
```

设置 `MODEL_API_KEY`、`MODEL_NAME` 和必要的 `MODEL_BASE_URL` 作为部署默认模型，或配置 `AGENT_CREDENTIAL_KEY` 后让各账号在界面添加个人供应商，详见[Agent 配置](agent-configuration.md)。加密主密钥在 Server/Worker 中必须一致，并独立备份。容器使用 `http://searxng:8080`，不使用宿主机的 localhost。默认搜索渠道始终为 SearxNG；仅显式设置 `SEARCH_PROVIDER=tavily` 并提供 `TAVILY_API_KEY` 时使用 Tavily。手动、重试和调度统一创建 live 执行，旧 `WORKER_SCHEDULED_RUN_MODE` 已移除，设置该变量不再改变调度行为。缺凭据或调用失败不会从 live 静默切成演示、付费渠道或其他供应商。真实烟测单独 opt-in，未执行时应记录“未执行”，不能用 fixture 通过冒充真实服务成功。

## 维护窗口

仓库根目录的 `vp run operations ...` 先停止代理/API/Worker，再运行一次性维护容器。它不会自动恢复应用，以便操作者检查结果。所有维护使用同一 Compose 项目与 `.env`，完成后执行 `docker compose up -d`。不要手动同时启动应用和维护；维护 CLI 需要 `SCOVA_MAINTENANCE=1` 并拒绝仍带生产应用名称的数据库连接。可通过 `docker compose --profile maintenance run --rm operations ...` 在已经确认停止应用后直接调用。

### 备份与恢复

```sh
vp run operations backup --name=2026-10-26.dump
docker compose up -d
```

备份使用 `pg_dump` 的 custom 格式，包含整个专用数据库及业务/saver 两套迁移记录。文件以 0600 权限保存到 `backups` 命名卷，完成后原子发布，不覆盖同名文件；`.partial` 表示未成功发布，不用于恢复。备份包含账号资料、报告与抓取内容，应按数据库同等权限保存。可使用 `docker compose cp` 或只读挂载该卷将备份复制到受控离机存储。

首版建议每天一次备份、至少保留最近 7 个成功备份及升级前备份，操作者明确配置离机副本与删除周期。正文/账号删除不会追溯擦除既有离线备份。

恢复要求使用与备份匹配的应用镜像和空 PostgreSQL 数据库。先保持 API/Worker 停止，将备份卷接到目标部署；目标 PostgreSQL 卷应为新卷。不要先执行迁移，否则目标已非空：

```sh
docker compose up -d postgres redis
docker compose --profile maintenance run --rm operations restore --name=2026-10-26.dump
# 上一步只预览；确认目标配置后执行：
docker compose --profile maintenance run --rm operations restore --name=2026-10-26.dump --apply
docker compose up -d
```

`pg_restore` 在单事务内恢复，并拒绝非空目标。PostgreSQL 是执行事实源；新 Redis 卷可由 Outbox 和恢复扫描重建作业。Redis AOF 用于同机重启持久化；若另备份 Redis 卷，必须先停 Redis，完整复制 `/data`，不要只复制 AOF 的一个分片。恢复后先验证任务、报告/引用、基线和已提升 checkpoint 可读，再恢复对外流量。重放不能增加同一 Run 的报告/Inbox/通知数量。

### 30 天原始数据保留

```sh
vp run operations retention
vp run operations retention --apply
docker compose up -d
```

默认仅预览。每批最多清理 100 个旧终态 Run 和 100 个到期正文快照，重复执行至计数为 0。Run 按 `finishedAt` 超过 30 天筛选，快照使用持久化 `textExpiresAt`。清理包括 Snapshot 正文、ToolCall 完整输出，以及 saver 的 checkpoints、blobs、pending writes 中所有 epoch/未提升线程；同步清空已清理终态 Run 的 checkpoint 引用。

活跃/待恢复 Run 的工具结果和 checkpoint 不清理；被活跃 Run 观测引用的 Snapshot 正文也保留。报告、短引用、定位、指纹、元数据、用量账本及基线事实清单继续保留。清理后历史引用仍可解释，后续比较不依赖旧完整正文。这里不删除 RunEvent；维护事件保留策略时必须保留每个 Run 最新事件，避免当前序号分配器重用历史 seq。

### 账号删除

```sh
vp run operations delete-account --user-id=账号UUID
vp run operations delete-account --user-id=账号UUID --apply
docker compose up -d
```

默认预览。先停止全部应用并 drain，然后按 Run ID 移除该账号的已知 BullMQ 作业，再在同一 PostgreSQL 事务内撤销会话、归档任务、清除所有 saver epoch 并删除账号。现有 owner 级联覆盖任务版本、执行/Outbox/事件、报告/Inbox/通知、来源/引用、收藏、笔记、反馈和报告问答。数据库失败会回滚业务及图状态；已移除队列作业可由保留的 Outbox 重建。Redis 失败时不删除数据库，重试命令即可；不要清空共享 Redis。其他账号的队列、数据和基线保持不变。

## 验证

容器验收使用显式命令 `vp run test:deployment`。Harness 中的 `web-deployment` 仅登记根工程的独立部署检查，默认关闭且非必需，不扩大应用单测覆盖或让当前 `ready` 自动启动 Docker；浏览器 CI 与 ready 门禁接入由 #86 单独交付。

`vp check`、`vp test`、`vp run -r build` 和 `vp run test:operations` 分别验证静态、纯逻辑、工作区构建和真实 PostgreSQL/Redis 维护。真实测试要求 PostgreSQL 17 的 `pg_dump`/`pg_restore` 在 PATH，并允许测试账号创建两个随机临时数据库；测试不清空共享 Redis。`vp run test:deployment` 为显式容器验收：构建后端/Web 镜像，在两个随机独立 Compose 项目中验证 Web SPA/静态缓存/缺失文件、真实 API 与 Swagger 路由、迁移、健康、代理会话、缺配置失败、重启幂等和空库恢复，结束时移除自己创建的容器和卷。它不使用现有部署数据，不调用真实供应商；构建需要网络，运行需要 Docker。脚本还暂停专用 Worker 创建排队 Run，要求代理首事件在 2 秒内可读，再启动真实消费者，验证同一连接收到新增事件、主动断开后的 Last-Event-ID 有序续传、终态后 3 秒内 EOF 及跨账号 404。脚本使用 live Run 验证缺凭据时明确失败、无伪造报告并关闭流，不调用供应商。报告交付另由显式注入供应商的集成测试验证，两者均不计为远程供应商烟测成功。此脚本的会话检查是 HTTP 级验收；业务页面与真实浏览器 Cookie、渲染和操作另验，不能以 API 成功代替页面交付。
