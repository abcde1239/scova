# Scova · 知巡

任务驱动的 AI 信息查阅与研究工作台。围绕主题搜索、阅读和查证资料，生成带引用的报告，并持续追踪新增与变化。

Vue 工作台支持独立任务和项目内任务、定时执行、串行工作流、执行进度与取消。研究成果提供四种报告形式、来源引用、连续问答、图表下载和私有 CSV 附件。后端 Agent 按预算搜索、阅读并核验证据，通过持久化执行状态支持恢复与跨次比较。项目仍在开发，使用入口见[工作台说明](docs/public/guides/web-workbench.md)。

## 技术与目录

Vite+ / TypeScript monorepo，Vue 3 前端，Elysia 后端，PostgreSQL + Drizzle，Redis + BullMQ。后端以 **Bun 为主运行时，Node.js 为兼容运行时**；Server、Worker 和数据库迁移默认使用 Bun。

| 目录                                                           | 用途                                                |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `apps/web`                                                     | 前端工作台                                          |
| `apps/server`                                                  | 后端接口与中文 Swagger                              |
| `apps/worker`                                                  | 后台执行与队列                                      |
| `packages/models`                                              | 共享接口与事件定义                                  |
| `packages/db`                                                  | 服务端业务数据模型与迁移                            |
| `packages/agent-core`                                          | Agent 状态与执行逻辑                                |
| `packages/connectors`                                          | 搜索及来源适配                                      |
| [`packages/object-storage`](packages/object-storage/README.md) | Cloudflare R2 / S3 通用文件存储、用途目录与图片校验 |

## 本地开发

账号支持[上传和移除头像](docs/public/guides/account-avatars.md)，需配置 Cloudflare R2 或 S3 存储。

安装 [Vite+](https://viteplus.dev/guide/)、Node.js >= 22.18、Bun >= 1.3.4 和 Docker。依赖统一通过 Vite+ 安装。

```sh
vp install
vp run local:up           # 启动 PostgreSQL、Redis；内置搜索用 local:up --search
vp run db:migrate         # 初始化或核验业务数据库
vp run dev                # 本机并行启动前端、Bun Server 和 Worker，监听源码变化
```

`local:up` 自动从 `.env.local.example` 生成根目录 `.env.local` 和随机数据库密码、搜索密钥，保留已有文件，并为缺失的账号模型加密配置初始化主密钥。开发入口和迁移自动读取这份配置，前端通过 `VITE_API_BASE_URL` 直连 API。默认前端 `http://localhost:5173`、API `http://localhost:3000`；三个基础服务只绑定本机，使用独立持久卷。端口、模型和 Docker 数据位置说明见[本地开发环境](docs/public/guides/local-development.md)，个人模型在[Agent 配置](docs/public/guides/agent-configuration.md)管理。已有数据库先备份、停止应用；迁移工具校验完整历史与实际结构后无损接管，见[数据库说明](packages/db/README.md)。

```sh
vp run dev:frontend       # 仅前端
vp run dev:server         # 仅 Bun Server
vp run dev:worker         # 仅 Bun Worker
vp run local:status       # 查看三个基础服务的状态
vp run local:down         # 停止这套基础服务，保留数据卷与 .env.local
```

后端提供 `/health`、`/swagger` 和 `/swagger/json`。Worker 消费队列并执行 Agent，Server 管理租约、检查点和工具账本，并从已保存的正文交付带引用的报告与收件箱记录；未核验时间范围、来源失败或正文截断会保留为 partial，不冒充完整研究。配置见 [Worker 说明](apps/worker/README.md)。

## 构建与预览

```sh
vp run build              # 按依赖顺序执行所有工作区的 build
vp run build:frontend     # 仅前端：vue-tsc 类型检查 + 生产构建
vp run build:server       # 仅 Server 类型检查
vp run build:worker       # 仅 Worker 类型检查
vp run preview:frontend   # 预览 apps/web/dist，也可用 vp run preview
```

根目录用 `vp run <命令>` 执行 monorepo 脚本；直接调用 Vite 内置命令时显式指定工作区，例如 `vp -C apps/web dev`、`vp -C apps/web preview`。`vp -C apps/web build` 只执行 Vite 构建；包含 Vue 模板类型检查时使用 `vp run build:frontend`。Node.js 开发可用 `vp run server#dev:node`、`vp run worker#dev:node`。后端和共享包的 build 当前仅做类型检查，运行时直接使用源码；前端 preview 只提供静态产物，不启动 API 或 Worker。

## 验证

```sh
vp check
vp test
vp run api:openapi:check
vp run test:integration  # 需专用 PostgreSQL / Redis
vp run verify:web       # 需 Chromium 和 Docker，基础 Web 门禁
vp run verify:mvp-full  # 追加补充页面与完整工作台联合旅程
```

`vp test` 运行单元与契约测试；根级专项测试登记在 `tests/tasks.ts`，仍用 `vp run test:<名称>` 执行。数据库、队列和运行时集成需启动专用服务。先运行 `vp run test:e2e:install` 安装锁定 Chromium（Linux 另需浏览器系统依赖），参见[验证说明](docs/public/reference/harness.md)。完整门禁 `vp run ready` 同时包含后端、基础浏览器与补充工作台验证。

## 文档

[文档索引](docs/public/README.md)按使用指南、实现参考和示例组织。

- [系统架构](docs/public/reference/architecture.md) · [数据模型](docs/public/reference/data-model.md)
- [接口文档](docs/public/reference/api.md) · [共享契约](packages/models/README.md)
- [研究循环与完成判定](docs/public/reference/agent-research-loop.md) · [生成提示词](docs/public/reference/research-prompts.md)
- [本机 SearxNG 部署](docs/public/guides/search.md) · [搜索、模型与安全阅读](packages/connectors/README.md)
- [Swagger / OpenAPI JSON](swagger.json)（`vp run api:openapi` 重新生成）
- [两次执行验收](docs/public/examples/two-run-scenarios.md)
- [Web 工作台](docs/public/guides/web-workbench.md) · [前端与通信约定](docs/public/reference/frontend-conventions.md) · [浏览器测试](docs/public/reference/browser-testing.md)

单机 Web/API 启动、迁移、备份恢复与数据保留见 [部署指南](docs/public/guides/deployment.md)。
