# 文档

按你要做的事找文档。功能与命令以当前代码为准。

## 安装与部署

- [本地开发](guides/local-development.md)：SQLite 本机版、PostgreSQL + Redis 开发环境、端口与数据位置。
- [部署与维护](guides/deployment.md)：Docker Compose 单机部署、备份、升级和对象存储。
- [搜索配置](guides/search.md)：自托管 SearXNG 或账号 Search API。
- [Agent 配置](guides/agent-configuration.md)：部署默认模型与个人模型。

## 使用工作台

- [Web 工作台](guides/web-workbench.md)：项目、任务、报告、工作流、资料库和附件的完整功能。
- [手工创建任务](reference/manual-task.md) · [自然语言草稿](reference/task-draft.md) · [执行计划](reference/task-schedule.md) · [任务生命周期](reference/task-lifecycle.md) · [任务中心](reference/task-center.md) · [执行控制](reference/run-actions.md)
- [账号头像](guides/account-avatars.md)

## 读懂报告

- [报告阅读](reference/frontend-report-detail.md) · [输出形式](reference/frontend-report-formats.md)
- [主题清单](reference/frontend-report-topic-list.md) · [对象对比表](reference/frontend-report-comparison.md) · [研究报告](reference/frontend-research-report.md)
- [变化与基线](reference/frontend-report-changes.md) · [对报告提问](reference/frontend-report-questions.md) · [补充研究](reference/frontend-followup.md)

## 了解系统与接口

- [系统架构](reference/architecture.md) · [数据模型](reference/data-model.md) · [数据库与迁移](reference/database.md)
- [HTTP 接口](reference/api.md) · [共享契约与事件](reference/contracts.md) · [OpenAPI JSON](../../swagger.json)
- [研究循环](reference/agent-research-loop.md) · [生成提示词](reference/research-prompts.md) · [两次执行场景](examples/two-run-scenarios.md)
- 各包说明：[Agent Core](../../packages/agent-core/README.md) · [连接器](../../packages/connectors/README.md) · [共享模型](../../packages/models/README.md) · [数据库](../../packages/db/README.md) · [执行协议](../../packages/execution/README.md) · [通用辅助](../../packages/shared/README.md) · [对象存储](../../packages/object-storage/README.md) · [Worker](../../apps/worker/README.md)

## 参与开发

- [前端约定](reference/frontend-conventions.md)：目录、Vue 与通信规则。
- [验证入口](reference/harness.md) · [浏览器测试](reference/browser-testing.md)：检查、集成测试和 E2E 的前置条件与命令。

需求草案、决策过程和实际验收记录只保存在本地。日志、截图和覆盖率报告是运行产物，不提交。
