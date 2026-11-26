# Scova · 知巡

任务驱动的 AI 信息查阅与研究工作台。围绕主题搜索、阅读和查证资料，生成带引用的报告，并持续追踪新增与变化。

> 项目仍在开发中，功能和界面可能调整。

## 功能

- **研究报告**：可通过研究和资料采集任务生成简报、主题清单、对比表与研究报告。
- **定期追踪**：给任务设定每天或每周的执行时间，提供新增部分与变化部分标明。
- **项目与对话**：通过项目和对话管理任务。在对话里让助手起草研究计划，任务配置，确认后运行，之后能引用报告、来源段落或上传的文件进行后续工作。
- **工作流**：可视化的工作流编排，将整理、研究、生成文档等串成固定流程；提供库存预警、项目周报等预设模板。
- **预算与进度可控**：提供可限制成本预算的任务配置；任务运行中可查看进度，并随时中断和继续。

## 快速开始

需要 [Vite+](https://viteplus.dev/guide/)、Node.js >= 22.18 和 Bun >= 1.3.4。标准部署使用 PostgreSQL + Redis。个人电脑可选 SQLite 轻量模式。

| 方式               | 数据与队列               | 需要 Docker | 适合                         |
| ------------------ | ------------------------ | ----------- | ---------------------------- |
| SQLite 本机版      | 全部存在本地 SQLite 文件 | 否          | 个人电脑，单人使用，开箱即用 |
| PostgreSQL + Redis | PostgreSQL、Redis 容器   | 是          | 多人共享、长期运行的环境     |

### SQLite 本机版

不需要 PostgreSQL、Redis 和 Docker。业务数据、任务队列和限流状态都保存在 `.scova-local/` 下的 SQLite 文件里。

```sh
git clone https://github.com/abcde1239/scova.git
cd scova
vp install
vp run local:sqlite
```

首次启动会自动创建并迁移数据库，按 Ctrl+C 停止。可选参数：

- `--node`：后端改用 Node.js 24 或更新版本，默认使用 Bun。
- `--backend-only`：只启动 Server 与 Worker。

模型、搜索和 R2 / S3 在 `.scova-local/.env` 中配置，首次启动会自动生成执行令牌和凭据加密密钥。数据目录和端口可用 `SCOVA_LOCAL_DATA_DIR`、`SCOVA_LOCAL_WEB_PORT`、`SCOVA_LOCAL_API_PORT`、`SCOVA_LOCAL_EXECUTION_PORT` 修改。

限制：仅支持单台电脑上的一个 Server 实例，只监听本机回环地址；资料库使用字面子串搜索；上传超过 256 KiB 的报告附件需要配置 R2 / S3。备份时先停止应用，再复制整个数据目录（包括 `.env`）。详见[本地开发环境](docs/public/guides/local-development.md#sqlite-本机版)。

### PostgreSQL + Redis

需要 Docker。

```sh
git clone https://github.com/abcde1239/scova.git
cd scova
vp install
vp run local:up            # PostgreSQL、Redis；需要 SearXNG 时改为 local:up --search
vp run db:migrate          # 初始化数据库
vp run dev                 # 前端、Server、Worker
```

`local:up` 会生成 `.env.local`（随机数据库密码、搜索密钥和账号模型加密主密钥），已有文件会保留。端口与数据位置见[本地开发环境](docs/public/guides/local-development.md)。

### 打开工作台

SQLite 本机版打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)，PostgreSQL + Redis 开发环境打开 [http://localhost:5173](http://localhost:5173)，注册即可。容器部署见[部署指南](docs/public/guides/deployment.md)。

### 搜索服务（可选）

研究需要搜索来源，二选一即可：

- **自托管 SearXNG**：需要 Docker，随基础服务启动（`vp run local:up --search`），无需额外账号和费用。SQLite 本机版不启动 SearXNG。
- **Search API**：不部署 SearXNG，登录后在「账号 → Agent 配置」填入 DeepSeek 或 Tavily 的接口和密钥。

两者都没有时可以正常使用工作流模板，但研究任务会因缺少搜索而失败。详见[搜索配置](docs/public/guides/search.md)。

## 使用

### 先体验一次工作流（无需模型）

1. 将下面内容保存为 `inventory.csv`。
2. 打开「工作流」，在模板库选择「库存预警清单」，点「使用模板」。
3. 上传文件，库存列名填 `stock`，预警阈值填 `10`，点「运行模板」。
4. 在运行详情查看预警表，下载只含 `sample-A` 的 CSV；勾选「发送站内通知」后也可从通知进入成果。

```csv
sku,stock
sample-A,4
sample-B,12
```

### 完成第一次研究

1. **配置模型和搜索**：在「Agent 配置」确认已有部署默认模型，或添加个人研究模型（需部署启用密钥加密，界面提示未启用时请联系管理员）。搜索使用自托管 SearXNG 或账号 Search API，二选一，见上文[搜索服务](#搜索服务可选)。源码运行并使用默认网页 Reader 时，先执行 `vp exec playwright install chromium`。详见[模型配置](docs/public/guides/agent-configuration.md)和[搜索配置](docs/public/guides/search.md)。
2. **创建任务**：首页点「创建独立任务」，填写标题、查阅主题和查阅目标，其余使用默认值。
3. **运行**：「保存并立即运行」创建后马上开始；「确认保存任务」只创建，稍后在任务页执行。
4. **查看报告**：在执行详情看进度，完成后打开报告，查看来源并导出。

需要围绕主题持续讨论时，在首页输入需求并归入项目，用「起草研究计划：……」让助手准备草案，确认后运行。

## 构建与部署

用 Docker Compose 在单机上构建并运行，浏览器只需访问同源地址，不需要在宿主机安装 Node 或 Bun。

```sh
cp .env.example .env      # 把数据库密码换成随机值，并设置 WORKER_EXECUTION_TOKEN
docker compose up --build -d
docker compose ps         # 查看各服务健康状态
```

打开 [http://localhost:8080](http://localhost:8080) 访问工作台，默认只监听本机。更新源码后再次执行 `docker compose up --build -d` 才会重新构建前端。

8080 被占用时，在 `.env` 中修改端口，并让 `APP_ORIGIN` 与浏览器访问的地址保持一致，否则登录和写请求会被同源校验拒绝：

```dotenv
SCOVA_PORT=9090
APP_ORIGIN=http://localhost:9090
```

修改后执行 `docker compose up -d` 生效，访问 `http://localhost:9090`。

不想部署 Redis 时，可叠加 SQLite 队列配置（需要 Docker Compose 2.24.4 或更新版本）。业务数据仍在 PostgreSQL，只是任务队列和协调状态改存挂载到 Server 的 SQLite 文件：

```sh
docker compose -f compose.yaml -f compose.sqlite.yaml up -d --build --wait
```

PostgreSQL 和 Redis 都不想用，且只在个人电脑上使用时，选 [SQLite 本机版](#sqlite-本机版)，该模式直接在本机运行，不使用 Docker 容器。

模型、搜索、对象存储、备份和升级见[部署指南](docs/public/guides/deployment.md)，搜索选项见[搜索配置](docs/public/guides/search.md)。

只构建前端静态资源时使用 `vp run build:frontend`，产物在 `apps/web/dist`，可用 `vp run preview:frontend` 预览；后端运行时直接使用源码，`build:server`、`build:worker` 只做类型检查。

## 项目结构

Vite+ / TypeScript monorepo。前端 Vue 3，后端 Elysia，数据库 PostgreSQL + Drizzle，队列 Redis + BullMQ。Server、Worker 和迁移默认运行在 Bun，Node.js 为兼容运行时。

| 目录                                                           | 用途                               |
| -------------------------------------------------------------- | ---------------------------------- |
| `apps/web`                                                     | Vue 工作台                         |
| `apps/server`                                                  | 接口、租约、报告交付与中文 Swagger |
| `apps/worker`                                                  | 队列消费与 Agent 执行              |
| `packages/models`                                              | 共享的接口与事件契约               |
| `packages/db`                                                  | 数据库 schema、迁移                |
| `packages/agent-core`                                          | Agent 状态与研究逻辑               |
| `packages/connectors`                                          | 搜索、网页读取与模型适配           |
| [`packages/object-storage`](packages/object-storage/README.md) | R2 / S3 文件存储（头像、大附件）   |

## 命令速查

在仓库根目录用 `vp run <命令>` 执行。命令分四类：一键启动、开发运行、构建、验证。

### 一键启动

准备并启动运行环境，用法见[快速开始](#快速开始)。

| 命令                          | 作用                                                            |
| ----------------------------- | --------------------------------------------------------------- |
| `local:sqlite`                | 一条命令启动 SQLite 本机版：前端、Server、Worker，不需要 Docker |
| `local:up [--search]`         | 启动 PostgreSQL 和 Redis 容器，加 `--search` 同时启动 SearXNG   |
| `local:status` / `local:down` | 查看或停止这些容器，数据卷和 `.env.local` 保留                  |
| `local:init`                  | 只生成 `.env.local`，不启动容器                                 |

### 开发运行

开发时的热更新进程，修改源码后自动重启。

| 命令                                         | 作用                                   |
| -------------------------------------------- | -------------------------------------- |
| `dev`                                        | 同时启动前端、Server、Worker           |
| `dev:frontend` / `dev:server` / `dev:worker` | 只启动其中一个                         |
| `db:migrate`                                 | 初始化或升级业务数据库，`dev` 之前执行 |
| `server#dev:node` / `worker#dev:node`        | 用 Node.js 兼容运行时启动后端          |

后端提供 `/health`、`/swagger` 和 `/swagger/json`。

### 构建

| 命令                            | 作用                                                 |
| ------------------------------- | ---------------------------------------------------- |
| `build`                         | 构建所有工作区。后端只做类型检查，运行时直接使用源码 |
| `build:frontend`                | 前端类型检查并生产构建，产物在 `apps/web/dist`       |
| `build:server` / `build:worker` | 只做对应后端的类型检查                               |
| `preview:frontend`              | 预览前端产物，只提供静态页面，不启动 API 和 Worker   |

容器镜像用 `docker compose up --build -d` 构建，见[构建与部署](#构建与部署)。

### 验证

```sh
vp check                  # 格式、lint、类型检查
vp test                   # 单元与契约测试
vp run api:openapi:check  # OpenAPI 与代码一致
vp run test:integration   # 需专用 PostgreSQL / Redis
vp run test:e2e:install   # 安装浏览器测试用 Chromium
vp run verify:web         # 基础 Web 门禁，需 Chromium 和 Docker
vp run ready              # 完整门禁
```

专项测试登记在 `tests/tasks.ts`，用 `vp run test:<名称>` 执行。

## 文档

| 主题     | 链接                                                                                                                                                                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 使用指南 | [工作台概览](docs/public/guides/web-workbench.md) · [任务与执行](docs/public/guides/tasks.md) · [报告](docs/public/guides/reports.md) · [项目与对话](docs/public/guides/projects.md) · [工作流](docs/public/guides/workflows.md) · [资料库与通知](docs/public/guides/library.md) |
| 配置     | [Agent 配置](docs/public/guides/agent-configuration.md) · [搜索](docs/public/guides/search.md) · [账号头像](docs/public/guides/account-avatars.md)                                                                                                                               |
| 部署     | [部署指南](docs/public/guides/deployment.md) · [本地开发](docs/public/guides/local-development.md)                                                                                                                                                                               |
| 接口     | [接口文档](docs/public/reference/api.md) · [共享契约](packages/models/README.md) · [OpenAPI](swagger.json)（`vp run api:openapi` 重新生成）                                                                                                                                      |
| 包与服务 | [Worker](apps/worker/README.md) · [数据库](packages/db/README.md) · [共享模型](packages/models/README.md) · [对象存储](packages/object-storage/README.md)                                                                                                                        |

完整索引见 [docs/public/README.md](docs/public/README.md)。
