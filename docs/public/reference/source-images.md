# 来源图片展示

`SourceItem` 展示标题、摘要、动作插槽和最多一张可选缩略图；`SourceImage` 也可独立用于报告图示。输入 `SourceImageInput` 位于 Web models，仅含同源根路径 `src`、有意义的 `alt`、必要出处 `attribution` 及可选概念图标记 `concept`。这不是共享 API DTO，也不表示素材已获生产授权。

缺图、无效输入或加载失败时组件不渲染图片列，标题、摘要和动作占用可用宽度，无破图、空白槽或“暂无图片”提示。正在加载的图片也不预留列；成功后展示。变更图片地址重新加载，失败不会阻止文字操作。外部地址、data/blob 地址和缺失说明的图片不装载；调用方仍须负责验证素材来源、授权及同源交付，组件不能代替媒体安全服务。

缩略图采用约 9.375rem、3:2；容器变窄后约 5.5rem 方形、极窄约 4.5rem，并允许图文上下重排。报告使用 `variant="report"`，按原比例 contain 显示完整图例与比例尺。尺寸为弹性单位，保留浏览器默认根字号，文字放大可重排。

受控样例只在 `vp run web#build:e2e` 的 test 模式提供 `/__examples/source-images`；普通生产构建不登记该路由，也不包含其素材。素材为仓库自制 SVG 几何概念图，图中与图注均明确标记，不是真实地图、来源图片或研究结果。SVG viewBox 数值是绘图坐标，不是布局像素尺寸。

执行 `vp run test:e2e tests/e2e/source-images.spec.ts` 检查六个视口、200% 文字、失败/无图列回收、文字动作及报告原比例。截图保存在 `artifacts/e2e/results`。单元输入检查运行 `vp test apps/web/tests/source-image.test.ts`。

当前 LibrarySource、LibrarySnapshot 与 Evidence 的共享 schema 没有图片字段；生产页面保持纯文字。本项未修改 DTO、API、数据库、抓取器或生产页面，不增加图片抓取请求。真实媒体契约与交付按独立设计实施。
