# 本地开发环境

前端、Server、Worker 在宿主机运行并监听源码变化。`compose.local.yaml` 将 PostgreSQL 17、Redis 7、SearXNG 放在同一个 `scova-local` Compose 项目中，使用官方镜像、独立持久卷和健康检查。

## 启动与停止

先启动 Docker Desktop（Linux 容器），在仓库根目录运行：

```sh
vp install
vp run local:up
vp run db:migrate
vp run dev
```

`local:up` 首次自动生成被 Git 和 Docker 构建上下文忽略的 `.env.local`，数据库密码与搜索密钥随机生成，不覆盖已有配置。也可先运行 `vp run local:init` 仅生成配置。`db:migrate`、Server 和 Worker 的开发命令自动读取根 `.env.local`；已注入进程的环境变量优先。正式 start 命令仍由部署环境提供配置。

使用 `local:up` 启动整套依赖，不要在 Docker Desktop 的 Images 页分别点击 Run；单独运行镜像不会自动应用 Compose 的密码、端口和数据卷。手动调用 Compose 时须指定根环境文件：`docker compose --env-file .env.local -f compose.local.yaml -p scova-local up -d --wait`。Compose 默认不会自动读取 `.env.local`。

Server/Worker 的 Bun 开发与 start 入口通过 `scripts/run-bun.mjs` 启动，优先使用 `BUN_BIN`，其次使用用户目录 `~/.bun/bin/bun`（Windows 为 `bun.exe`），最后查找 PATH。使用独立安装的 Bun，可避免 Vite+ 的同名 shim 尝试联网安装包管理器。Bun 安装在其他位置时，将 `BUN_BIN` 环境变量设为其可执行文件绝对路径后再运行；该变量须在启动命令前设置，不能仅写入由 Bun 随后加载的 `.env.local`。

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
vp run dev:worker         # 仅 Worker
vp run local:status
vp run local:down
```

退出 `vp run dev` 后基础服务继续运行；`local:down` 只停止并移除本项目容器和网络，保留三个数据卷和 `.env.local`。再次 `local:up` 会恢复原数据。修改数据库迁移前先停止 Server/Worker，运行迁移后再启动；已有卷的数据库密码不会随环境文件自动重置。

## 本机连接

| 服务       | 地址                                   | 配置                                                       |
| ---------- | -------------------------------------- | ---------------------------------------------------------- |
| PostgreSQL | `127.0.0.1:15432`，用户/数据库 `scova` | `DATABASE_URL`、`POSTGRES_PASSWORD`、`SCOVA_LOCAL_PG_PORT` |
| Redis      | `127.0.0.1:16379`                      | `REDIS_URL`、`SCOVA_LOCAL_REDIS_PORT`                      |
| SearXNG    | `http://127.0.0.1:18080`               | `SEARXNG_BASE_URL`、`SCOVA_SEARXNG_PORT`                   |

所有端口仅绑定回环地址。修改基础服务发布端口时，同时修改对应连接 URL，再运行 `local:up`。本项目与 `compose.test.yaml` 的临时测试服务、`compose.yaml` 的正式部署、`search:up` 的独立搜索项目各自隔离；使用本地整套环境时无需另外运行 `search:up`。

Windows 在 D 盘仓库目录执行这些命令。镜像、容器与命名卷的实际存储位置由 Docker Desktop 的磁盘映像位置决定，需将其设置在 D 盘；命令工作目录不会自动迁移 Docker 存储。不要为开发删除既有 Docker 磁盘或卷。

Windows 的 `local:up` 会先检查 Docker 引擎，必要时启动 Desktop 并等待就绪。针对遗留 `dockerInference` 或 `engine.sock` 导致的启动错误，启动器只在 Docker Desktop 和 backend 都已退出时，备份并重建两处临时运行目录。Docker 仍在运行或启动中时仅等待，不强停、不修改运行目录。也可单独运行 `powershell -NoProfile -File scripts/start-docker.ps1`；这处理启动残留，不修改 Windows socket 实现。

## 搜索和模型

研究任务的调用链为 Worker → agent-core → connectors → SearXNG。Server 接收执行命令并持久化 Run/Outbox，Worker 从 BullMQ 消费；资料库搜索仅查询已保存的数据库内容。新 Run 统一真实研究，历史演示报告仍标示其固定资料来源。

单独验证真实搜索，不调用模型：

```sh
vpx --env-file=.env.local scripts/smoke-search.ts --live
```

真实研究可在「账号 → Agent 配置」添加并启用个人供应商，支持 OpenAI 兼容、Anthropic 和 Gemini；`local:init` 初始化服务端加密主密钥。也可在 `.env.local` 填写 `MODEL_API_KEY`、`MODEL_NAME` 和必要的 `MODEL_BASE_URL` 作为部署默认值，重启 Server/Worker。个人配置优先，详见[Agent 配置](agent-configuration.md)。手动、重试和定时执行统一使用真实研究，不再提供 demo 选项或调度模式环境变量；缺模型配置时明确失败。默认免费 SearXNG；Tavily 仅在显式设置 `SEARCH_PROVIDER=tavily` 时使用。搜索上游可能限流、超时或要求验证码，健康检查不代表结果覆盖完整，详见[搜索说明](search.md)。

代理返回Fake-IP导致模型目录被拒绝时，模型通道默认自动使用可信HTTPS DNS重新解析，列表和实际调用都生效；仍校验真实公网IP并验证TLS证书。需要调整时在`.env.local`设置`MODEL_DNS_RESOLVER=system|alidns|cloudflare|google`后重启Server/Worker，具体策略见[Agent配置](agent-configuration.md)。

网页读取的Fake-IP兼容使用独立 `READER_DNS_RESOLVER=auto`，可设置 `system|alidns|cloudflare|google` 后重启Worker。SearXNG健康只证明实例可用；上游验证码、限流和访问拒绝仍可能导致真实搜索没有可用来源。
