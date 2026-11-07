# 主题清单报告组件

`TopicListReport.vue` 与 `ReportBrief.vue` 接受同一份已授权、已校验的共享 `Report`。两者共用 `ReportFrame` 的标题、模式、交付时间、配置版本、覆盖范围、限制、摘要与部分交付警告，也共用 `ReportClaim` 的完整结论、证据说明和有序引用。报告标题焦点入口保持为 `report-title`；同一页面只应挂载一种报告布局。

当前 DTO 没有语义主题字段。清单仅按现有“来源事实 / Agent 推断 / 冲突证据 / 证据不足”分组，保持组内原序，每条完整 Claim 是一个清单项；空组不显示。不生成主题、不合并或重写事实、不删除引用。只被变化记录引用的 Evidence 仍保留在同一 Report 中，不能将它误称为简报原本逐条展示的引用。

生产报告详情通过[报告形式](frontend-report-formats.md)选择器组合本组件。清单保留变化与基线说明，并由共享来源附录按原序展示全部 Evidence，包括仅变化引用与孤立证据。只读切换不发出新请求、不改变 Query、Report 或 Run；当前阅读形式与 Report 保存的 `format` 分开。

浏览器受控入口 `tests/fixtures/reports/report-topic-list.html` 只在 `mode=test` 构建中存在，顺序卸载、挂载真实简报和清单组件以核对同一 schema 合法样本；普通生产构建不包含该入口。样本及其控制项仅供测试，不代表新的产品页面或实际研究交付。

测试页提供 `window.scovaReportFixture.setReport(value)`，内部通过共享 `ReportSchema` 校验后将同一 DTO 交给真实组件；`setView('brief' | 'topic-list')` 顺序切换布局，`getReport()` 返回当前输入副本。该入口可验证真实 API 返回的已授权报告，不需要另写展示实现；它不会读取接口或持久化报告数据。

```sh
vp test apps/web/tests/report-topic-list.test.ts apps/web/tests/report-view.test.ts
vp run build:frontend
vp run build:e2e
vp run test:e2e tests/e2e/report-topic-list.spec.ts
```
