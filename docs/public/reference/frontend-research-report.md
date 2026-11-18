# 研究报告 Web 阅读视图

`ResearchReport` 是已保存 `Report` 的只读阅读组件，不增加请求、模型调用或缓存。生产页只可选择[实际保存的成果](frontend-report-formats.md)，刷新恢复报告保存的形式。

新报告按保存的大纲展示概述与章节。章节引用本成果已验证的结论，不在浏览时重新生成正文。没有大纲的历史报告保留问题回答或来源事实、Agent 推断、冲突证据、证据不足等原有分组；条件、缺口、置信说明和授权引用继续显示。

目录随当前内容生成：有大纲时链接章节及问题覆盖，没有大纲时链接概述、已保存问题与结论分类；变化、查阅与核验详情、来源入口按组件实际展示范围加入。锚点打开所在折叠区、移动焦点并滚动至标题，保留顶部工具条边距。目录使用界面字体，正文与标题沿用阅读偏好。

生产报告在成果正文前展示共享[变化区](frontend-report-changes.md)；首次执行显示比较起点状态，后续比较保留原分类、原因和双方依据。来源附录按规范网页地址分组、按快照保留版本，与当前成果和变化相关的引文集中展示。切换成果不会混入其他成果的结论。

正文按保存文本安全展示，自然换行并保留段落，不执行来源中的 HTML。稿纸和阅读行宽分别约束，窄屏与文字放大时重排，不截断答案。图片及其他媒体的范围见[来源图片](source-images.md)。

```sh
vp test apps/web/tests/report-research.test.ts
vp run build:frontend
vp run build:e2e
vp run test:e2e tests/e2e/report-research.spec.ts
```

test 构建加入 `apps/web/tests/fixtures/reports/report-research.html`，挂载真实 ResearchReport/ReportBrief；`window.scovaResearchFixture.setReport(report)` 校验并替换样本，`setView('research' | 'brief')` 切换布局。这些测试入口不进入生产构建。

单测通过 Vite+ 转换真实 SFC 并进行 SSR，核对正文、大纲、目录与比较状态；浏览器检查键盘定位、滚动、字体和六宽矩阵。受控样本不代表真实权限、数据库交付或远程研究效果已验收；test 构建后须恢复普通生产构建再预览。
