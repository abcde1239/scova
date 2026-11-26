# Scova 文档

从[仓库首页](../../README.md#快速开始)启动工作台，或直接用内置样例[运行第一个工作流](guides/workflows.md#运行第一个工作流)。

## 安装与部署

- [本地开发](guides/local-development.md)：SQLite 本机版、PostgreSQL + Redis 开发环境、端口与数据位置。
- [部署与维护](guides/deployment.md)：Docker Compose 单机部署、备份、升级和对象存储。
- [Agent 配置](guides/agent-configuration.md)：部署默认模型与个人模型。
- [搜索配置](guides/search.md)：自托管 SearXNG 或账号 Search API。

## 使用指南

- [工作台概览](guides/web-workbench.md)：功能入口、账号与界面。
- [任务与执行](guides/tasks.md)：创建任务、设置周期、运行、取消和管理。
- [报告](guides/reports.md)：阅读与核对来源、输出形式、变化、提问、补充研究和导出。
- [项目与对话](guides/projects.md)：项目、会话、起草研究计划和自主度。
- [工作流](guides/workflows.md)：画布、模板、试跑和发布。
- [资料库、附件与通知](guides/library.md)：资料搜索、收藏、笔记、附件和站内通知。
- [账号头像](guides/account-avatars.md)：上传头像、恢复默认头像和配置存储。

## 接口

- [HTTP 接口](reference/api.md)：查阅常用接口与请求示例。
- [共享契约与事件](reference/contracts.md)：修订版本、幂等和 SSE。
- [OpenAPI JSON](../../swagger.json)：读取请求、响应和状态码定义。

## 服务与包

- 执行与研究：[Worker](../../apps/worker/README.md)、[Agent Core](../../packages/agent-core/README.md)、[连接器](../../packages/connectors/README.md)。
- 数据与存储：[数据库](../../packages/db/README.md)、[对象存储](../../packages/object-storage/README.md)。
- 共享模块：[接口模型](../../packages/models/README.md)、[执行协议](../../packages/execution/README.md)、[通用辅助](../../packages/shared/README.md)。
