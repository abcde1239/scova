# Scova · 知巡

任务驱动的 AI 信息查阅与研究工作台。围绕主题搜索、阅读和查证资料，生成带引用的报告，并持续追踪新增与变化。

项目开发中：已实现账号会话、用户隔离、任务配置、执行控制、搜索/模型/安全阅读适配器、有预算的持久化 Agent、证据报告交付和报告/收件箱 API，以及连续运行的基线与变化比较。当前优先完善后端，前端暂缓。

## 技术与目录

Vite+ / TypeScript monorepo，Vue 3 前端，Bun + Elysia 后端（兼容 Node.js），PostgreSQL + Prisma，Redis + BullMQ。

| 目录                  | 用途                     |
| --------------------- | ------------------------ |
| `apps/web`            | 前端工作台               |
| `apps/server`         | 后端接口与中文 Swagger   |
| `apps/worker`         | 后台执行与队列           |
| `packages/models`     | 共享接口与事件定义       |
| `packages/db`         | 服务端业务数据模型与迁移 |
| `packages/agent-core` | Agent 状态与执行逻辑     |
| `packages/connectors` | 搜索及来源适配           |

## 本地开发

安装 [Vite+](https://viteplus.dev/guide/)、Node.js >= 22.18、Bun >= 1.3.4 和 Docker。依赖统一通过 Vite+ 安装。

```sh
vp install
docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait
vp exec prisma generate
```

配置 `DATABASE_URL`、`REDIS_URL` 和 `APP_ORIGIN`，运行 `vp exec prisma migrate deploy` 初始化业务数据库。连接配置见[数据库说明](packages/db/README.md)；本地环境文件不提交。

```sh
vp run dev                # 前端
vp run server#start       # Bun 后端
vp run server#start:node  # Node.js 后端
vp run worker#start       # Outbox 投递与 Run 消费控制
vp run search:up          # 本机 SearxNG，无需搜索 API 密钥
```

后端提供 `/health`、`/swagger` 和 `/swagger/json`。Worker 可从成功保存的正文交付带引用的报告与收件箱记录；未核验时间范围、来源失败或正文截断会保留为 partial，不冒充完整研究。配置见 [Worker 说明](apps/worker/README.md)。

## 验证

```sh
vp check
vp test
vp run -r build
vp run api:openapi:check
vp run test:integration  # 需专用 PostgreSQL / Redis
```

`vp test` 运行单元与契约测试；数据库、队列和运行时集成需启动专用服务，参见[验证说明](docs/public/reference/harness.md)。完整门禁：`vp run ready`。

## 文档

- [系统架构](docs/public/reference/architecture.md) · [数据模型](docs/public/reference/data-model.md)
- [接口文档](docs/public/reference/api.md) · [共享契约](packages/models/README.md)
- [本机 SearxNG 部署](docs/public/guides/search.md) · [搜索、模型与安全阅读](packages/connectors/README.md)
- [Swagger / OpenAPI JSON](swagger.json)（`vp run api:openapi` 重新生成）
- [交付计划](docs/public/guides/delivery-plan.md) · [两次执行验收](docs/public/examples/two-run-scenarios.md)
- [前端与通信约定](docs/public/reference/frontend-conventions.md)

单机后端启动、迁移、备份恢复与数据保留见 [部署指南](docs/public/guides/deployment.md)。
