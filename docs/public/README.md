# 文档

使用指南、当前实现参考和可复现示例保存在本目录，随仓库发布。功能状态与命令以当前代码为准。

## 安装与使用

- [本地开发](guides/local-development.md) · [部署与维护](guides/deployment.md)
- [Web 工作台](guides/web-workbench.md) · [Agent 配置](guides/agent-configuration.md) · [搜索配置](guides/search.md) · [账号头像](guides/account-avatars.md)
- [手工配置任务](reference/manual-task.md) · [自然语言草稿](reference/task-draft.md) · [执行计划](reference/task-schedule.md) · [任务生命周期](reference/task-lifecycle.md) · [任务中心](reference/task-center.md)
- [执行详情](reference/frontend-run-detail.md) · [研究运行图](reference/frontend-run-graph.md) · [执行控制](reference/run-actions.md) · [执行历史](reference/frontend-run-history.md)

## 报告与资料

- [报告工作区](reference/frontend-report-detail.md) · [输出形式与成果](reference/frontend-report-formats.md)
- [主题清单](reference/frontend-report-topic-list.md) · [对象对比表](reference/frontend-report-comparison.md) · [研究报告](reference/frontend-research-report.md)
- [变化与基线](reference/frontend-report-changes.md) · [报告历史](reference/frontend-report-history.md)
- [连续问答](reference/frontend-report-questions.md) · [修订与补充研究](reference/frontend-followup.md)
- [反馈](reference/frontend-feedback.md) · [反馈的交付效果](reference/frontend-feedback-effects.md)
- [收件箱](reference/frontend-inbox.md) · [通知](reference/frontend-notifications.md) · [收藏](reference/frontend-bookmarks.md) · [笔记](reference/frontend-notes.md)
- [资料库搜索](reference/frontend-library-search.md) · [来源历史](reference/frontend-source-history.md) · [图片与媒体边界](reference/source-images.md)

## 系统与接口

- [系统架构](reference/architecture.md) · [数据模型](reference/data-model.md) · [数据库与迁移](reference/database.md)
- [HTTP 接口](reference/api.md) · [共享契约与事件](reference/contracts.md) · [OpenAPI JSON](../../swagger.json)
- [研究循环与完成判定](reference/agent-research-loop.md) · [生成提示词](reference/research-prompts.md)
- [Agent Core](../../packages/agent-core/README.md) · [搜索与阅读连接器](../../packages/connectors/README.md) · [共享模型](../../packages/models/README.md) · [数据库包](../../packages/db/README.md) · [共享逻辑](../../packages/shared/README.md)
- [Worker](../../apps/worker/README.md) · [对象存储](../../packages/object-storage/README.md) · [图片存储](../../packages/image-storage/README.md)

## 前端实现

- [目录、Vue 与通信约定](reference/frontend-conventions.md) · [路由](reference/frontend-routing.md) · [会话](reference/frontend-session.md) · [执行事件流](reference/frontend-run-events.md)
- [注册](reference/frontend-registration.md) · [登录](reference/frontend-login.md) · [账号偏好](reference/frontend-preferences.md) · [加载、空与错误状态](reference/frontend-states.md)
- [视觉设计](reference/frontend-design.md) · [字体与阅读](reference/frontend-fonts.md) · [图标](reference/frontend-icons.md) · [响应式布局](reference/frontend-responsive.md) · [局部玻璃效果](reference/frontend-glass.md)

## 验证与示例

- [工程验证入口](reference/harness.md) · [后端验证](guides/backend-verification.md) · [浏览器测试](reference/browser-testing.md)
- [Web 验收清单](guides/web-acceptance.md) · [基础视觉检查](reference/frontend-visual-foundation.md) · [完整工作台验收](reference/workbench-verification.md) · [移动设备检查](reference/mobile-verification.md)
- [两次执行场景](examples/two-run-scenarios.md)

开发记忆、需求草案、决策过程、历史评审和实际验收记录仅保留本地。测试源码与固定夹具随所属工作区提交；日志、截图、trace、覆盖率和生成报告属于运行产物，不提交。
