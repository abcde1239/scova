# Scova · 知巡

任务驱动的 AI 信息查阅与研究工作台。围绕主题搜索、阅读和查证资料，生成带引用的报告，并持续追踪新增与变化。

项目开发中：已实现账号会话、用户隔离、任务配置、执行命令和 Outbox 投递基础；Agent 研究、报告交付及完整前端仍在建设。

## 技术与目录

Vite+ / TypeScript monorepo，Vue 3 前端，Bun + Elysia 后端（兼容 Node.js），PostgreSQL + Prisma，Redis + BullMQ。

| 目录                  | 用途                     |
| --------------------- | ------------------------ |
| `apps/web`            | 前端工作台               |
| `apps/server`         | 后端接口与中文 Swagger   |
| `apps/worker`         | 后台执行与队列           |
| `packages/contracts`  | 共享接口与事件定义       |
| `packages/models`     | 服务端业务数据模型与迁移 |
| `packages/agent-core` | Agent 状态与执行逻辑     |
| `packages/connectors` | 搜索及来源适配           |

## 本地开发

安装 [Vite+](https://viteplus.dev/guide/)、Node.js >= 22.18、Bun >= 1.3.4 和 Docker。依赖统一通过 Vite+ 安装。

```sh
vp install
docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait
vp exec prisma generate
```

配置 `DATABASE_URL`、`REDIS_URL` 和 `APP_ORIGIN`，运行 `vp exec prisma migrate deploy` 初始化业务数据库。连接配置见[数据库说明](prisma/README.md)；本地环境文件不提交。

```sh
vp run dev                # 前端
vp run server#start       # Bun 后端
vp run server#start:node  # Node.js 后端
vp run worker#start       # Worker 启动入口
```

后端提供 `/health`、`/swagger` 和 `/swagger/json`。Worker 执行闭环尚未完成。

## 验证

```sh
vp check
vp test
vp run -r build
vp run api:openapi:check
```

`vp test` 运行单元与契约测试；数据库、队列和运行时集成需启动专用服务，参见[验证说明](docs/public/reference/harness.md)。完整门禁：`vp run ready`。

## 文档

- [系统架构](docs/public/reference/architecture.md) · [数据模型](docs/public/reference/data-model.md)
- [接口文档](docs/public/reference/api.md) · [共享契约](packages/contracts/README.md)
- [交付计划](docs/public/guides/delivery-plan.md) · [两次执行验收](docs/public/examples/two-run-scenarios.md)
- [前端与通信约定](docs/public/reference/frontend-conventions.md)
