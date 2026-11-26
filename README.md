# Scova · 知巡

任务驱动的 AI 信息查阅与研究工作台。围绕主题搜索、阅读和查证资料，生成带引用的报告，并持续追踪新增与变化。

> 项目仍在开发中，功能和界面可能调整。

## 功能

- **研究与资料采集**：生成带来源引用的简报、主题清单、对比表或研究报告。
- **定期追踪**：按天或按周运行任务，标出新增和变化。
- **项目与对话**：让助手起草研究计划，确认后运行。可以引用报告、来源段落或上传的文件继续讨论。
- **工作流**：在画布上串联整理、研究和文档生成，也可直接运行库存预警或项目周报模板。
- **执行管理**：为任务设置用量上限，查看进度，并在需要时取消执行。

## 快速开始

源码运行需要 [Vite+](https://viteplus.dev/guide/)、Node.js 22.18 或更新版本，以及 Bun 1.3.4 或更新版本。先获取源码并安装依赖：

```sh
git clone https://github.com/abcde1239/scova.git
cd scova
vp install
```

### SQLite 本机版

在个人电脑上运行。业务数据、任务队列和限流状态保存在本地 SQLite 文件里，无需 Docker。

```sh
vp run local:sqlite
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173) 注册。首次启动会创建并迁移数据库。数据目录、端口、备份和运行参数见 [SQLite 本机版说明](docs/public/guides/local-development.md#sqlite-本机版)。

### PostgreSQL + Redis

使用 Docker 启动开发所需的数据库与队列。

```sh
vp run local:up
vp run db:migrate
vp run dev
```

打开 [http://localhost:5173](http://localhost:5173) 注册。需要自托管搜索时，第一条命令改为 `vp run local:up --search`。配置文件、服务端口和单独启动命令见[本地开发指南](docs/public/guides/local-development.md#postgresql--redis)。

## 使用

### 先体验一次工作流（无需模型）

打开工作台后，用内置样例运行[库存预警清单](docs/public/guides/workflows.md#运行第一个工作流)。预警表应只保留低库存商品 `sample-A`。

### 完成第一次研究

先准备研究所需的服务：

- **模型**：使用部署默认模型，或在「账号 → Agent 配置」[添加个人模型](docs/public/guides/agent-configuration.md#配置模型)。
- **搜索**：配置[账号 Search API 或自托管 SearXNG](docs/public/guides/search.md#选择搜索方式)。源码运行且使用默认网页 Reader 时，按[网页读取说明](docs/public/guides/local-development.md#网页读取reader)安装 Chromium。

1. 在首页点击「创建独立任务」，填写标题、查阅主题和查阅目标。
2. 点击「保存并立即运行」，在执行详情查看进度。
3. 完成后打开[报告](docs/public/guides/reports.md)，通过正文引用查看保存的来源片段。

需要围绕主题持续研究时，可以把需求归入[项目与对话](docs/public/guides/projects.md)。

## 构建与部署

在服务器上运行时，按[容器部署指南](docs/public/guides/deployment.md#快速开始)配置环境、启动 Docker Compose 并检查服务状态。默认访问 [http://localhost:8080](http://localhost:8080)。

单独构建 Web 静态资源时，运行 `vp run build:frontend`。产物位于 `apps/web/dist`，可用 `vp run preview:frontend` 预览。

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

| 命令                       | 用途                                  |
| -------------------------- | ------------------------------------- |
| `vp run local:sqlite`      | 启动 SQLite 本机版                    |
| `vp run dev`               | 启动前端、Server 和 Worker 的开发进程 |
| `vp run build`             | 构建工作区。后端工作区执行类型检查    |
| `vp check`                 | 检查格式、lint 和类型                 |
| `vp test`                  | 运行根目录单元与契约测试              |
| `vp run api:openapi:check` | 检查 OpenAPI 是否与路由一致           |

其他启动命令见[本地开发指南](docs/public/guides/local-development.md#常用命令)。专项验证任务见 `tests/tasks.ts`，用 `vp run test:<名称>` 执行。

## 文档

- [公开文档索引](docs/public/README.md)包含工作台、任务、报告和各组件说明。
- [部署与维护](docs/public/guides/deployment.md)覆盖配置、备份、升级与恢复。
- [HTTP 接口](docs/public/reference/api.md)提供调用示例和 [OpenAPI](swagger.json) 入口。
