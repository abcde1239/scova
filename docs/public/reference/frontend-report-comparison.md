# 报告对比表

`ComparisonReport` 是已保存对比成果的只读阅读组件。它复用 `ReportFrame` 的标题、模式、版本、覆盖和摘要，不重新比较事实、不推算重要性、不修改报告。生产页只可选择[实际已保存的成果](frontend-report-formats.md)。含 `coverage.artifacts[].content.comparison` 的报告按明确对象列、共同维度行与关联结论的单元格值展示；未知值及缺口就地显示。没有对象结构的历史问题型报告明确说明并保留问答，没有 `coverage.reportValue` 的更早报告保留 Claim 表格。

对象对比表使用真实 caption、对象列标题与维度行标题，字段依据定位到保存论点，再通过引用链接核对集中原文。历史变化由共享[变化与基线](frontend-report-changes.md)组件展示，保留服务端分类、重要性、原始原因及两侧引用；对象比较与历史变化分别展示。空值不代表删除、撤回或无变化，旧值非空但缺少旧引用时保留待核验提示。

结论摘要沿用已有保守规则。partial、待核验或旧证据不足不能推断无重要变化；基线结论来自报告 outcome，不依据空基线 ID 猜测首次执行或重置。基线执行标识与模式、配置版本均来自真实 DTO，界面不宣称验证隐藏的数据库归属或比较范围。

结构化表格后可展开完整问题依据与结论，待核实内容直接可见。即使 `changes=[]`，对象对比仍可存在；没有历史变化不代表对象无差别。来源附录按来源与快照集中引用。生产页的历史变化区位于成果预览正文之前，与对象比较分开。

表格、事实值、原因与表内引用使用界面无衬线字体，结论正文继续遵循阅读偏好。正文不截断，长文本自然换行。表仅在自身容器横向滚动，不扩大整页；实际溢出时才提供区域焦点与提示，聚焦后可用原生左右方向键滚动，Tab 进入双方引用。控件最小尺寸以 rem 表达，键盘焦点可见。

`apps/web/tests/fixtures/reports/report-comparison.html` 仅在 `mode=test` 构建，挂载真实组件、主题和样式。独立 `window.scovaComparisonFixture` 提供 `setReport`、`getReport`、`setView('brief'|'comparison')`、`getView`；ReportSchema 校验后依次卸挂真实简报/对比组件，不同时挂两套报告。该入口是受控组件验证，生产构建不含这些 fixture；生产选择器由报告路由测试另行验证，组件样本不代表真实 Agent 比较交付。

```sh
vp test apps/web/tests/report-formats.test.ts apps/web/tests/report-changes.test.ts apps/web/tests/report-topic-list.test.ts apps/web/tests/report-view.test.ts
vp check
vp run build:frontend
vp run build:e2e
vp run test:e2e tests/e2e/report-comparison-table.spec.ts
vp run harness-lint
```

成果与变化单测验证对象字段、分类、引用集合、缺侧和只读边界；实际表语义、局部原生滚动、字体、六宽与 200% 根文字由浏览器检查。HTTP/DTO 样本不等于真实 API/Worker/数据库交付或真实移动设备验证。
