# 主题清单报告组件

`TopicListReport.vue` 与 `ReportBrief.vue` 接受同一份已授权、已校验的共享 `Report`。两者共用 `ReportFrame` 的标题、模式、交付时间、配置版本、覆盖范围、限制、摘要与部分交付警告，也共用 `ReportClaim` 的完整结论、证据说明和有序引用。报告标题焦点入口保持为 `report-title`；同一页面只应挂载一种报告布局。

含 `coverage.artifacts[].content.list` 的 DTO 按显式对象名称显示卡片，每张卡片列出保存的所需字段值、支持依据与缺口；未知字段不隐藏。前端不解析 Claim 句子猜对象或字段。旧问题型报告没有该结构时明确说明并保留问答；更早没有 `coverage.reportValue` 的报告继续按“来源事实 / Agent 推断 / 冲突证据 / 证据不足”分组，保持组内原序。只被变化记录引用的 Evidence 仍保留，正文、参考与历史变化统一链接到集中来源原文。

生产报告详情通过[已保存成果](frontend-report-formats.md)选择器组合本组件。清单正文不重复历史变化，共享变化区位于成果正文之前。来源区按网页与快照集中原文，包含变化所需的引用。只读切换不发出生成请求、不改变 Query、Report 或 Run；不能通过阅读切换新增未生成形式。

带 `coverage.dateScreening` 的资料采集清单使用 `CollectionResults`，展示已收录值、日期、日期来源与直接出处；未收录来源不进入条目表，日期未知列表按保存的 separate/discard 设置展示。它与分析研究的对象字段卡片分别呈现，具体范围见[成果阅读说明](frontend-report-formats.md)。

浏览器受控入口 `apps/web/tests/fixtures/reports/report-topic-list.html` 只在 `mode=test` 构建中存在，顺序卸载、挂载真实简报和清单组件以核对同一 schema 合法样本；普通生产构建不包含该入口。样本及其控制项仅供测试，不代表新的产品页面或实际研究交付。

测试页提供 `window.scovaReportFixture.setReport(value)`，内部通过共享 `ReportSchema` 校验后将同一 DTO 交给真实组件；`setView('brief' | 'topic-list')` 顺序切换布局，`getReport()` 返回当前输入副本。该入口可验证真实 API 返回的已授权报告，不需要另写展示实现；它不会读取接口或持久化报告数据。

```sh
vp test apps/web/tests/report-topic-list.test.ts apps/web/tests/report-view.test.ts
vp run build:frontend
vp run build:e2e
vp run test:e2e tests/e2e/report-topic-list.spec.ts
```
