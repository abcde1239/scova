# 研究报告 Web 阅读视图

`ResearchReport` 是当前 `Report` DTO 的只读阅读组件，不增加请求、模型调用或缓存。生产报告详情通过[报告形式](frontend-report-formats.md)选择器提供研究报告布局，刷新恢复报告保存的形式。

页面按已有字段顺序展示标题、模式、配置版本、发布时间、摘要、覆盖范围、限制与 partial 状态。partial 会在正文前明确显示，并保留 gaps、已执行查询和耗尽预算；它不会因为变化数组为空而变成“无重要变化”。

报告结论保留四类 claim：来源事实、Agent 推断、冲突证据、证据不足。各分类内部保持 DTO 原数组顺序、原文、confidenceLabel 和已授权引用。相同文字但不同 ID 的结论不会合并。变化与基线始终复用现有 ReportChanges 投影和目录入口；旧值、新值、原因、重要性和双方引用不重写。即使 changes 为空且 baselineRunId 为 null，仍展示报告 outcome 对应的基线、无重要变化或不确定结果及原有限制说明，同时明确没有逐项变化记录、未关联基线执行；不生成变化记录，也不从空数组推导结果。

目录是正文内的原生锚点导航，覆盖摘要、范围与限制、变化、四类结论以及全部来源引用。标题使用稳定 DTO ID，目标有滚动边距以避开顶部工具条，焦点可见。来源附录按 `report.evidence` 原序列出所有证据，因此孤立 evidence 会被明确保留，不会被猜测归入某条结论。

标题、摘要、章节和结论正文沿用阅读字体；目录、工具、状态和引用控件使用界面字体。正文采用纯文本插值和自然换行，不执行 HTML/Markdown，不补图片、章节字段、研究正文或模型重写。尺寸使用 rem 和弹性宽度，窄屏及文字放大时自然重排。

验证：`vp test apps/web/tests/report-research.test.ts`，并结合报告相关回归、`vp check` 与 `vp run web#build`。`vp run web#build:e2e` 仅在 test 模式加入 `/test-fixtures/report-research.html`，真实挂载 ResearchReport 与 ReportBrief，保留既有主题清单和对比样本入口。测试页面可通过 `window.scovaResearchFixture.setReport(report)` 校验 DTO 后换样本，`setView('research' | 'brief')` 比较布局；这些控制和全局接口不进入生产输出。

浏览器专项命令是 `vp run test:e2e tests/e2e/report-research.spec.ts`，需要先生成 test 构建并按项目 E2E 配置启动预览。实际目录键盘定位、焦点/滚动边距、字体切换和六宽矩阵属于独立 QA；受控组件样本不代表真实报告权限、数据库交付或完整研究执行。

专项单元测试还以 Vite+ 中间件模式转换真实 ResearchReport/ReportBrief SFC 并进行 SSR，核对空 changes、null 基线下三种 outcome 的目录、权威结果、限制和无逐项记录说明。该检查不监听端口或写出 dist，不能代替浏览器焦点和视觉验收。
