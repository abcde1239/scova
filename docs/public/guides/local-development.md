# 本地开发环境

在本机运行 Scova 的 Web、Server 和 Worker，用于开发或试用。两种方式：SQLite 本机版（无需 Docker）和 PostgreSQL + Redis（Docker 启动依赖）。

需要 [Vite+](https://viteplus.dev/guide/)、Node.js >= 22.18 和 Bun >= 1.3.4。

## SQLite 本机版

适合个人电脑单人使用：一台电脑上运行一个 Server 实例，Web 与后端只监听回环地址。标准部署和共享环境请使用 PostgreSQL + Redis。

```sh
vp install
vp run local:sqlite
```

打开 http://127.0.0.1:5173 注册账号。首次启动会自动创建并迁移数据库，按 Ctrl+C 停止。

- **`--node`**：后端改用 Node.js 24 或更新版本，默认使用 Bun。
- **`--backend-only`**：只启动 Server 与 Worker。

### 数据与配置

- **`.scova-local/business.sqlite`**：业务记录、Run 租约和 Agent 检查点。
- **`.scova-local/state.sqlite`**：队列、限流和搜索协调状态。Worker 通过 Server 接口领取作业。
- **`.scova-local/.env`**：首次启动生成执行令牌和凭据加密密钥。模型、搜索和 R2 / S3 在这里配置。

| 变量                         | 作用         | 默认值 |
| ---------------------------- | ------------ | ------ |
| `SCOVA_LOCAL_DATA_DIR`       | 数据目录     | -      |
| `SCOVA_LOCAL_WEB_PORT`       | Web 端口     | `5173` |
| `SCOVA_LOCAL_API_PORT`       | API 端口     | `3000` |
| `SCOVA_LOCAL_EXECUTION_PORT` | 内部执行端口 | `3001` |

### 限制与备份

- 资料库使用字面子串搜索。
- 联网研究需要配置模型和搜索供应商。
- 上传超过 256 KiB 的报告附件需要配置 R2 / S3。
- 首次创建本机库得到的是空工作区。
- **备份**：先停止应用，再复制整个数据目录，包括 `.env`。

## PostgreSQL + Redis

需要 Docker Desktop（Linux 容器）。在仓库根目录运行：

```sh
vp install
vp run local:up      # 启动 PostgreSQL 和 Redis
vp run db:migrate    # 迁移业务库和 checkpoint schema
vp run dev           # 启动前端、Server、Worker，监听源码变化
```

- **配置文件**：`local:up` 首次会生成 `.env.local`，数据库密码和搜索密钥随机生成，已有配置不会被覆盖。只想生成配置时运行 `vp run local:init`。
- **读取方式**：`db:migrate`、Server 和 Worker 的开发命令自动读取根 `.env.local`，已注入进程的环境变量优先。
- **升级已有环境**：运行 `vp run local:init` 补齐缺失的 `WORKER_EXECUTION_TOKEN`，Server 与 Worker 共用该令牌。内部执行接口默认监听 `127.0.0.1:3001`。
- **迁移检查**：`vp run dev` 启动前会检查执行令牌和业务迁移。提示有待迁移时，先退出运行中的 Server 和 Worker，再执行 `vp run db:migrate` 和 `vp run dev`。

需要内置搜索时运行 `vp run local:up --search`。

请用 `local:up` 启动依赖，不要在 Docker Desktop 的 Images 页分别点击 Run，否则 Compose 的密码、端口和数据卷不会生效。手动调用 Compose 时必须指定环境文件：

```sh
docker compose --env-file .env.local -f compose.local.yaml -p scova-local up -d --wait
```

启用搜索时，在 `up` 前加 `--profile live-search`。

### 本机连接

所有端口只绑定回环地址。修改发布端口时，同时修改对应连接 URL，再运行 `local:up`。

| 服务            | 地址                                   | 配置                                                       |
| --------------- | -------------------------------------- | ---------------------------------------------------------- |
| PostgreSQL      | `127.0.0.1:15432`，用户/数据库 `scova` | `DATABASE_URL`、`POSTGRES_PASSWORD`、`SCOVA_LOCAL_PG_PORT` |
| Redis           | `127.0.0.1:16379`                      | `REDIS_URL`、`SCOVA_LOCAL_REDIS_PORT`                      |
| SearXNG（可选） | `http://127.0.0.1:18080`               | `SEARXNG_BASE_URL`、`SCOVA_SEARXNG_PORT`                   |

本项目与测试服务（`compose.test.yaml`）、正式部署（`compose.yaml`）和独立搜索项目（`search:up`）互相隔离。使用 `local:up --search` 时无需再运行 `search:up`。

### 常用命令

```sh
vp run dev:frontend       # 仅前端
vp run dev:server         # 仅 Server
vp run dev:worker         # 仅执行进程；投递与调度需要 Server
vp run local:status       # 查看基础服务状态
vp run local:down         # 停止并移除本项目容器和网络
```

- 退出 `vp run dev` 后基础服务继续运行。
- `local:down` 保留数据卷和 `.env.local`。再次 `local:up` 恢复服务；要恢复 SearXNG 须加 `--search`。
- 不带 `--search` 的 `local:up` 不会停止已在运行的 SearXNG。
- 修改数据库迁移前先停止 Server 和 Worker，迁移后再启动。已有数据卷的数据库密码不会随环境文件重置。

### Bun 与 Node.js

后端默认使用 Bun，Node.js 是显式兼容运行时，不会自动切换。

| 用途        | Bun（默认）           | Node.js（兼容）            |
| ----------- | --------------------- | -------------------------- |
| Server 开发 | `vp run dev:server`   | `vp run server#dev:node`   |
| Worker 开发 | `vp run dev:worker`   | `vp run worker#dev:node`   |
| Server 启动 | `vp run server#start` | `vp run server#start:node` |
| Worker 启动 | `vp run worker#start` | `vp run worker#start:node` |
| 数据库迁移  | `vp run db:migrate`   | `vp run db:migrate:node`   |

- **运行时检查**：API 的 `/health` 返回实际运行时。

### 网页读取（Reader）

Worker 默认的网页 Reader 使用 Crawlee + Playwright。首次运行前安装 Chromium：

```sh
vp exec playwright install chromium
```

Reader 会执行公开页面的 JavaScript，但只允许经过安全 HTTP 客户端的公网 GET，不支持登录态、写操作、下载、WebSocket 和 service worker。容器配置见[部署说明](deployment.md)。

### 单机 SQLite 协调模式

在 PostgreSQL 开发环境下，可只用 SQLite 替代 Redis 处理队列和协调。业务记录、执行租约、报告和 Agent 检查点仍在 PostgreSQL。

1. 运行 `vp run local:init` 准备配置。
2. 在 `.env.local` 中把 `SCOVA_SQLITE_STATE_PATH` 设为 SQLite 文件的绝对路径，例如 Windows 的 `C:/scova-data/state.sqlite`。
3. 启动：

```sh
docker compose --env-file .env.local -f compose.local.yaml -p scova-local up -d --wait postgres
vp run db:migrate
vp run dev
```

需要内置搜索时，在 `up` 前加 `--profile live-search`，并在末尾追加 `searxng`。

- 只有 Server 打开该文件，Worker 通过 Server 的内部执行接口领取作业。
- 配置后，执行队列、登录与草案限流、内置搜索协调状态都存入 SQLite。
- 切换前先停止同一数据库的 API 与 Worker。使用本机磁盘，并限制文件目录的访问权限。
- **改回 Redis**：去掉该配置，启动 Redis 和两个应用。两个队列的现存记录彼此独立，未结束的 Run 由 Server 根据 PostgreSQL 状态重新投递。

## 访问与跨域配置

通过 http://localhost:5173 注册和登录。浏览器按根环境文件中的 `VITE_API_BASE_URL` 直连 API，不使用 Vite proxy，普通请求和 SSE 都携带 Cookie。API 文档见 http://localhost:3000/swagger。

```dotenv
APP_ORIGIN=http://localhost:5173
VITE_API_BASE_URL=http://localhost:3000/api/v1
PORT=3000
```

| 变量                | 说明                                                      |
| ------------------- | --------------------------------------------------------- |
| `APP_ORIGIN`        | 前端的准确访问来源，同时是 API 的 CORS 白名单             |
| `PORT`              | API 监听端口，修改时同步修改 `VITE_API_BASE_URL`          |
| `VITE_API_BASE_URL` | 浏览器访问 API 的地址；未配置时使用 `/api/v1`（同源部署） |

- 前后端使用相同主机名，不要混用 `localhost` 和 `127.0.0.1`，否则 SameSite=Lax 的 Cookie 在不同端口下不能正常工作。
- CORS 只允许配置的来源，写请求仍检查 Origin 与 CSRF。
- Vite 从仓库根目录加载环境文件：`.env.local`（见 `.env.local.example`）由开发和本机构建预览共用，也可用 `.env.development.local`、`.env.production.local` 分别配置。模式专属文件优先于通用文件，进程环境变量优先级最高。
- 部署独立 API 时，设置同站点的完整 HTTPS 地址。

## 搜索与模型

研究任务的调用链为 Worker → agent-core → connectors → SearXNG。资料库搜索只查询已保存的内容。

- **模型**：在「账号 → Agent 配置」添加并启用个人供应商，支持 OpenAI 兼容、Anthropic 和 Gemini。也可在 `.env.local` 填写 `MODEL_API_KEY`、`MODEL_NAME` 和必要的 `MODEL_BASE_URL` 作为部署默认值，再重启 Server。个人配置优先。`local:init` 会初始化服务端加密主密钥。详见 [Agent 配置](agent-configuration.md)。
- **搜索**：默认使用免费 SearXNG（`local:up --search`）。不启用时，在账号搜索设置里配置 Search API，并把需要联网检索的任务设为 Search API 或跟随账号默认。显式选择内置搜索的任务不会自动改用付费供应商。详见[搜索说明](search.md)。
- **缺配置**：手动、重试和定时执行都是真实研究，缺少模型配置时会明确失败。

单独验证真实搜索，不调用模型：

```sh
vpx --env-file=.env.local scripts/smoke-search.ts --live
```

搜索上游可能限流、超时或要求验证码，SearXNG 健康只说明实例可用，不保证有可用来源。

### Fake-IP 代理

代理返回 Fake-IP 时，模型通道默认自动改用可信 HTTPS DNS 重新解析，仍会校验真实公网 IP 和 TLS 证书。

| 变量                  | 作用               | 可选值                                                     |
| --------------------- | ------------------ | ---------------------------------------------------------- |
| `MODEL_DNS_RESOLVER`  | 模型通道的解析方式 | `system`、`alidns`、`cloudflare`、`google`                 |
| `READER_DNS_RESOLVER` | 网页读取的解析方式 | `auto`（默认）、`system`、`alidns`、`cloudflare`、`google` |

在 `.env.local` 中设置后，重启 Server 和 Worker（Reader 只需重启 Worker）。策略详见 [Agent 配置](agent-configuration.md)。

## Windows 与 Docker Desktop

- **自动启动**：Windows 上的 `local:up` 会先检查 Docker 引擎。没有就绪时自动启动 Docker Desktop 并等待，不需要提前手动打开。
- **启动卡住时**：先正常退出 Docker Desktop，再重新执行 `local:up`。启动器不会结束正在运行的 Docker 进程，Docker 仍在启动时只会继续等待。
- **遗留文件导致启动失败**：Docker Desktop 偶尔会留下无法访问的 `dockerInference` 或 `engine.sock`。只有 Desktop 和 backend 都已退出时，启动器才会把 `%LOCALAPPDATA%` 下的 `Docker/run` 和 `docker-secrets-engine` 两个临时目录改名备份并重建。镜像、数据卷和 Docker 设置不会被改动。
- **单独运行启动器**，用于排查：

```sh
powershell -NoProfile -File scripts/start-docker.ps1
```

- **Docker 数据位置**：镜像、容器和命名卷保存在 Docker Desktop 的磁盘映像里，位置在 Docker Desktop 的设置中调整，本项目不会修改该位置。不要为开发删除已有的 Docker 磁盘或数据卷。
