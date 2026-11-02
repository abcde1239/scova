# 报告对比表

`ComparisonReport` 是同一不可变 `Report` 的只读阅读组件。它复用 `ReportFrame` 的标题、模式、版本、partial/覆盖和摘要，组合已有 `mapReportChanges`、`changeSummary` 与 `reportSections`；不重新比较事实、不推算重要性、不修改报告。生产报告详情通过[报告形式](frontend-report-formats.md)选择器接入本组件，选择只改变本次阅读布局。

对比表使用真实 caption、列标题与事实维度行标题，逐项保留七种服务端分类、重要性文字、原始原因和旧值/本次观测。两侧引用独立按原 ID 顺序展示，保留完整原文、定位、时间及安全来源链接，不借用另一侧引用。`null` 仅显示“未提供旧值/新值”，缺侧直说没有该侧引用，不代表删除、撤回或无变化；旧值非空但无旧引用继续显示待核验警告。

结论摘要沿用已有保守规则。partial、待核验或旧证据不足不能推断无重要变化；基线结论来自报告 outcome，不依据空基线 ID 猜测首次执行或重置。基线执行标识与模式、配置版本均来自真实 DTO，界面不宣称验证隐藏的数据库归属或比较范围。

表格后保留全部四类 Claim 的完整正文、证据说明及原有引用。即使 `changes=[]`，报告头、摘要、覆盖与结论仍存在，只提示没有逐项变化记录，不造空表行或“无变化”结论。共享来源附录按原 DTO 顺序展示全部 Evidence，包括未被 Claim 或变化引用的证据。

表格、事实值、原因与表内引用使用界面无衬线字体，结论正文继续遵循阅读偏好。正文不截断，长文本自然换行。表仅在自身容器横向滚动，不扩大整页；实际溢出时才提供区域焦点与提示，聚焦后可用原生左右方向键滚动，Tab 进入双方引用。控件最小尺寸以 rem 表达，键盘焦点可见。

`apps/web/test-fixtures/report-comparison.html` 仅在 `mode=test` 构建，挂载真实组件、主题和样式。独立 `window.scovaComparisonFixture` 提供 `setReport`、`getReport`、`setView('brief'|'comparison')`、`getView`；ReportSchema 校验后依次卸挂真实简报/对比组件，不同时挂两套报告。该入口是受控组件验证，生产构建不含这些 fixture；生产选择器由报告路由测试另行验证，组件样本不代表真实 Agent 比较交付。

```sh
vp test apps/web/tests/report-comparison-table.test.ts apps/web/tests/report-changes.test.ts apps/web/tests/report-topic-list.test.ts apps/web/tests/report-view.test.ts
vp check
vp run web#build
vp run web#build:e2e
vp run test:e2e tests/e2e/report-comparison-table.spec.ts
vp run harness-lint
```

纯投影单测验证分类、引用集合、缺侧和只读边界；实际表语义、局部原生滚动、字体、六宽与 200% 根文字由浏览器检查。HTTP/DTO 样本不等于真实 API/Worker/数据库交付或真实移动设备验证。
