# 本地开发环境

前端、Server、Worker 在宿主机运行并监听源码变化。`compose.local.yaml` 默认只启动 PostgreSQL 17 和 Redis 7；SearXNG 是同一个 `scova-local` Compose 项目中的可选服务。

## 启动与停止

先启动 Docker Desktop（Linux 容器），在仓库根目录运行：

```sh
vp install
vp run local:up
vp run db:migrate
vp run dev
```

`local:up` 首次自动生成被 Git 和 Docker 构建上下文忽略的 `.env.local`，数据库密码与搜索密钥随机生成，不覆盖已有配置。也可先运行 `vp run local:init` 仅生成配置。`db:migrate` 由 Server 同时迁移业务库和 checkpoint schema；Worker 不再在启动时自动建表。`db:migrate`、Server 和 Worker 的开发命令自动读取根 `.env.local`，已注入进程的环境变量优先。Worker 启动脚本仅从环境文件加载执行、队列、搜索策略和 Reader 所需配置。已有开发环境升级时再运行 `vp run local:init` 生成缺失的 `WORKER_EXECUTION_TOKEN`，由同版本 Server 和 Worker 共用。内部执行接口默认监听 `127.0.0.1:3001`。正式 start 命令仍由部署环境提供配置。

`vpr dev`（`vp run dev` 的简写）在并行启动应用前检查执行令牌和 PostgreSQL 业务迁移，通过后才启动开发进程。已有开发环境在提示待迁移时，先退出仍运行的 Server 和 Worker，再执行 `vp run db:migrate` 和 `vpr dev`。

需要内置搜索时运行 `vp run local:up --search`。不启用 SearXNG 时，在应用的账号搜索设置里配置 Search API，并将需要联网检索的任务设为 Search API 或跟随账号默认；显式选择内置搜索的任务不会自动改用付费供应商。

使用 `local:up` 启动基础依赖，不要在 Docker Desktop 的 Images 页分别点击 Run；单独运行镜像不会自动应用 Compose 的密码、端口和数据卷。手动调用 Compose 时须指定根环境文件：`docker compose --env-file .env.local -f compose.local.yaml -p scova-local up -d --wait`。启用搜索时在 `up` 前加 `--profile live-search`。Compose 默认不会自动读取 `.env.local`。

后端以 Bun 为主运行时，Node.js 为显式兼容运行时。默认命令使用 Bun，不自动切换到 Node.js：

| 用途        | Bun（默认）           | Node.js（兼容）            |
| ----------- | --------------------- | -------------------------- |
| Server 开发 | `vp run dev:server`   | `vp run server#dev:node`   |
| Worker 开发 | `vp run dev:worker`   | `vp run worker#dev:node`   |
| Server 启动 | `vp run server#start` | `vp run server#start:node` |
| Worker 启动 | `vp run worker#start` | `vp run worker#start:node` |
| 数据库迁移  | `vp run db:migrate`   | `vp run db:migrate:node`   |

Server/Worker 的默认开发、start 和数据库迁移入口通过 `scripts/run-bun.mjs` 启动，优先使用 `BUN_BIN`，其次使用用户目录 `~/.bun/bin/bun`（Windows 为 `bun.exe`），最后查找 PATH。使用独立安装的 Bun，可避免 Vite+ 的同名 shim 尝试联网安装包管理器。Bun 安装在其他位置时，在启动命令前将 `BUN_BIN` 环境变量设为其可执行文件绝对路径，以便各入口一致选择运行时。Windows 上如果 Bun 1.3.4 报找不到 `pg` 或 `srvx/node`，可升级 Bun 或将 `BUN_BIN` 指向已验证的 Bun 1.4.4。迁移命令由 `vpx` 从根目录加载 `.env.local`，再让 Bun 在 Server 工作区运行维护入口并解析 `@/` 别名。

Bun 开发命令监听应用及 `packages/*/src` 的源码变化，重启时先通过 IPC 请求旧后端进程停止。应用进程从各自的工作区启动并解析 `@/` 别名。

Vite+ 的 Node 工具进程与后端运行时分别管理。API 的 `/health` 返回实际运行时；验证双入口可运行 `vp run test:processes`，检查 HTTP、Swagger 和优雅退出。

### 单机 SQLite 协调模式

将 `SCOVA_SQLITE_STATE_PATH` 设为本机 SQLite 文件的绝对路径，仅 Server 打开文件。Worker 通过 Server 的内部执行接口领取作业，两进程使用相同的队列名。Windows 可使用 `D:/scova-data/state.sqlite`。配置后会使用 SQLite 持久化执行队列、登录与草案限流，以及内置搜索的协调状态。业务记录、执行租约、报告和 Agent 检查点仍在 PostgreSQL。

先用 `vp run local:init` 准备本机配置，再把路径写入 `.env.local` 并执行以下命令。需要内置搜索时，在 Compose 命令的 `up` 前加入 `--profile live-search`，在末尾一并指定 `searxng`。

```sh
docker compose --env-file .env.local -f compose.local.yaml -p scova-local up -d --wait postgres
vp run db:migrate
vp run dev
```

切换前停止同一数据库的 API 与 Worker。使用本机磁盘并限制文件目录的访问权限。重新选用 Redis 时去掉配置，再启动 Redis 和两个应用。两个队列的现存记录彼此独立，未结束的 Run 由 Server 根据 PostgreSQL 状态重新投递。

Worker 的默认网页 Reader 使用 Crawlee + Playwright，开发机首次运行需安装 Chromium：

```sh
vp exec playwright install chromium
```

Reader 会执行公开页面 JavaScript，但仍只允许经过安全 HTTP 客户端的公网 GET；不支持登录态、写操作、下载、WebSocket 或 service worker。Bun Worker 的 Playwright 控制由 Node/vpx 子进程承载，包括 Windows 和容器；Worker 主进程仍使用 Bun。容器配置见[部署说明](deployment.md)。

打开 [工作台](http://localhost:5173)，通过该地址注册和登录。浏览器通过根环境文件中的 `VITE_API_BASE_URL` 直连 API，不使用 Vite proxy；普通请求和 SSE 均携带 Cookie。

```dotenv
APP_ORIGIN=http://localhost:5173
VITE_API_BASE_URL=http://localhost:3000/api/v1
PORT=3000
```

`APP_ORIGIN` 是前端的准确访问来源，也是 API 的 CORS 白名单；`PORT` 是 API 监听端口，调整时同步修改 `VITE_API_BASE_URL`。前后端使用相同主机名（不要混用 localhost 和 127.0.0.1），以便 SameSite=Lax 的 Cookie 在不同端口下正常工作。CORS 只允许配置来源，写请求仍检查 Origin 与 CSRF。API 文档直接访问 [Swagger](http://localhost:3000/swagger)。

Vite 从仓库根目录加载环境文件：本机连接写入 `.env.local`（见 `.env.local.example`），开发和本机构建预览共用该地址；也可用 `.env.development.local`、`.env.production.local` 分别配置。未配置时使用 `/api/v1`，适用于同源部署；部署独立 API 时设置同站点的完整 HTTPS 地址。模式专属文件优先于通用文件，进程环境变量优先级最高。只有 `VITE_` 变量会进入浏览器，禁止用于秘密。修改后重启开发服务；preview 使用构建时地址，修改后需重新构建。开发端口冲突会直接报错。

```sh
vp run dev:frontend       # 仅前端
vp run dev:server         # 仅 Server
vp run dev:worker         # 仅执行进程；投递与调度需要 Server
vp run local:status
vp run local:down
```

退出 `vp run dev` 后基础服务继续运行；`local:down` 只停止并移除本项目容器和网络，保留数据卷和 `.env.local`。再次 `local:up` 会恢复基础服务；要恢复 SearXNG 则加 `--search`。不带 `--search` 的 `local:up` 不会停止已经在运行的 SearXNG。修改数据库迁移前先停止 Server/Worker，运行迁移后再启动；已有卷的数据库密码不会随环境文件自动重置。

## 本机连接

| 服务            | 地址                                   | 配置                                                       |
| --------------- | -------------------------------------- | ---------------------------------------------------------- |
| PostgreSQL      | `127.0.0.1:15432`，用户/数据库 `scova` | `DATABASE_URL`、`POSTGRES_PASSWORD`、`SCOVA_LOCAL_PG_PORT` |
| Redis           | `127.0.0.1:16379`                      | `REDIS_URL`、`SCOVA_LOCAL_REDIS_PORT`                      |
| SearXNG（可选） | `http://127.0.0.1:18080`               | `SEARXNG_BASE_URL`、`SCOVA_SEARXNG_PORT`                   |

所有端口仅绑定回环地址。修改基础服务发布端口时，同时修改对应连接 URL，再运行 `local:up`。本项目与 `compose.test.yaml` 的临时测试服务、`compose.yaml` 的正式部署、`search:up` 的独立搜索项目各自隔离；使用 `local:up --search` 时无需另外运行 `search:up`。

Windows 在 D 盘仓库目录执行这些命令。镜像、容器与命名卷的实际存储位置由 Docker Desktop 的磁盘映像位置决定，需将其设置在 D 盘；命令工作目录不会自动迁移 Docker 存储。不要为开发删除既有 Docker 磁盘或卷。

Windows 的 `local:up` 会先检查 Docker 引擎，必要时启动 Desktop 并等待就绪。针对遗留 `dockerInference` 或 `engine.sock` 导致的启动错误，启动器只在 Docker Desktop 和 backend 都已退出时，备份并重建两处临时运行目录。Docker 仍在运行或启动中时仅等待，不强停、不修改运行目录。也可单独运行 `powershell -NoProfile -File scripts/start-docker.ps1`；这处理启动残留，不修改 Windows socket 实现。

## 搜索和模型

研究任务的调用链为 Worker → agent-core → connectors → SearXNG。Server 接收执行命令并持久化 Run/Outbox，后台负责调度、发布及恢复扫描；Worker 消费 BullMQ 或经 Server 消费 SQLite 队列并执行 Agent；资料库搜索仅查询已保存的数据库内容。新 Run 统一真实研究，历史演示报告仍标示其固定资料来源。

单独验证真实搜索，不调用模型：

```sh
vpx --env-file=.env.local scripts/smoke-search.ts --live
```

真实研究可在「账号 → Agent 配置」添加并启用个人供应商，支持 OpenAI 兼容、Anthropic 和 Gemini；`local:init` 初始化服务端加密主密钥。也可在 `.env.local` 填写 `MODEL_API_KEY`、`MODEL_NAME` 和必要的 `MODEL_BASE_URL` 作为部署默认值，再重启 Server。个人配置优先，详见[Agent 配置](agent-configuration.md)。手动、重试和定时执行统一使用真实研究，不再提供 demo 选项或调度模式环境变量；缺模型配置时明确失败。默认免费 SearXNG；可显式配置独立搜索 API 或在供应商配置中授权模型内置搜索。搜索上游可能限流、超时或要求验证码，健康检查不代表结果覆盖完整，详见[搜索说明](search.md)。

代理返回Fake-IP导致模型目录被拒绝时，模型通道默认自动使用可信HTTPS DNS重新解析，列表和实际调用都生效；仍校验真实公网IP并验证TLS证书。需要调整时在`.env.local`设置`MODEL_DNS_RESOLVER=system|alidns|cloudflare|google`后重启Server/Worker，具体策略见[Agent配置](agent-configuration.md)。

网页读取的Fake-IP兼容使用独立 `READER_DNS_RESOLVER=auto`，可设置 `system|alidns|cloudflare|google` 后重启Worker。SearXNG健康只证明实例可用；上游验证码、限流和访问拒绝仍可能导致真实搜索没有可用来源。
