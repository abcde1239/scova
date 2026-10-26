# 单机后端部署与维护

当前提供 API、Worker、同源反向代理、PostgreSQL 17 和 Redis 7 的 Docker Compose 部署。Web 页面尚未交付；以下登录、任务与报告验收使用 API。主运行时为 Bun 1.3.4，镜像内安装 Node 24.22.1、Vite+ 1.4.0 和 PostgreSQL 17 客户端。

## 启动

需要 Docker Engine/Desktop Linux 容器与 Compose v2。为此项目使用独立数据库，不与其他应用共用数据库或 Redis 队列名称。

1. 复制 `.env.example` 为 `.env`，把数据库密码和搜索密钥替换为随机值。数据库密码使用随机十六进制文本，避免连接 URL 的转义歧义；不要提交 `.env`。
2. 执行 `docker compose up --build -d`，再用 `docker compose ps` 查看健康状态。
3. 默认只绑定 `127.0.0.1:8080`。`GET http://localhost:8080/health` 是存活检查；容器健康检查另外核验 PostgreSQL、Redis、全部业务迁移和 saver 版本。Worker 还必须持续更新就绪心跳。

启动先执行一次性 `migrate` 服务。Prisma 业务迁移和 LangGraph saver 迁移均成功后，API/Worker 才启动。迁移服务再次运行时若核验当前全部版本已齐，仅返回只读的 current 结果；需要 DDL 时仍要求 API/Worker 已停止。容器中的 `AGENT_CHECKPOINT_MIGRATION=external` 禁止 Worker 自动建表；本地开发默认保留启动时初始化 saver 的行为。升级镜像后，停止应用并重新执行迁移：

```sh
vp run operations migrate
docker compose up -d --build
```

应用镜像由非 root 用户运行，只读根文件系统和临时 `/tmp`；PostgreSQL 与 Redis 使用独立持久卷，Redis 开启 AOF/everysec。仅代理发布端口，数据库、队列和搜索均在 Compose 网络内部。正常 `docker compose down` 保留数据；不要使用 `down -v` 作为升级或恢复步骤。

默认演示任务不会联网采集或调用模型。通过 `POST /api/v1/auth/register` 或 `/auth/login` 获取会话与 `csrfToken`，后续写请求携带同源 `Origin`、Cookie 和 `x-csrf-token`；先保存完整配置，再显式创建 `mode=demo` 的 Run。轮询 Run/报告 API 验证成果，演示报告明确标识固定资料。草稿缺模型时返回手工模式。完整配置及接口见 [契约](../reference/contracts.md) 与 [API](../reference/api.md)。

## 同源、TLS 与 SSE

`APP_ORIGIN` 必须是客户端实际使用的完整源。默认 HTTP localhost 用于本机访问；面向其他机器部署时，在代理前配置 TLS，并设置相同的 HTTPS `APP_ORIGIN`。生产 Cookie 保持 Secure/HttpOnly；不要通过取消 Secure 解决域名或 TLS 配置错误。

代理关闭 SSE 缓冲、缓存和压缩，透传 Cookie、Origin、Last-Event-ID，75 秒上游读取超时大于 15 秒心跳；客户端断开会关闭上游。应用的持续 SSE 后端由对应功能版本提供，本部署配置不替代前端续传桥接。根路径可能返回 404，因为这里没有登录页面或前端构建。

停止使用 `docker compose stop`：应用接收信号，停止领取与外部调用，等待在途领域写入，再关闭队列、数据库和 HTTP。应用预留 60 秒停止窗口；强杀后的 Run 由数据库租约恢复，不保证外部供应商只调用一次，但报告、Inbox 和通知不得重复。

## 真实服务 opt-in

SearxNG 是固定镜像、非 root 的可选服务。设置随机 `SEARXNG_SECRET` 后运行：

```sh
docker compose --profile live-search up -d
```

设置 `MODEL_API_KEY`、`MODEL_NAME` 和必要的 `MODEL_BASE_URL`。容器使用 `http://searxng:8080`，不使用宿主机的 localhost。默认搜索渠道始终为 SearxNG；仅显式设置 `SEARCH_PROVIDER=tavily` 并提供 `TAVILY_API_KEY` 时使用 Tavily。手动 Run 或调度必须显式选择 live；`WORKER_SCHEDULED_RUN_MODE` 默认 demo。缺凭据或调用失败不会从 live 静默切成演示、付费渠道或其他供应商。真实烟测单独 opt-in，未执行时应记录“未执行”，不能用 fixture 通过冒充真实服务成功。

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

`vp check`、`vp test`、`vp run -r build` 和 `vp run test:operations` 分别验证静态、纯逻辑、工作区构建和真实 PostgreSQL/Redis 维护。真实测试要求 PostgreSQL 17 的 `pg_dump`/`pg_restore` 在 PATH，并允许测试账号创建两个随机临时数据库；测试不清空共享 Redis。`vp run test:deployment` 为显式容器验收：构建镜像，在两个随机独立 Compose 项目中验证迁移、健康检查、代理会话、演示报告/证据、重启幂等和空库恢复，结束时移除自己创建的容器和卷。它不使用现有部署数据，不调用真实供应商；构建需要网络，运行需要 Docker。SSE 持续订阅与断连由对应接口测试另行验证。
