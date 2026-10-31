# 局部透明层

共享样式与独立样例已提供，实际页面由所属功能接入；本项不修改菜单逻辑、布局或主题状态。组件或布局从 `@/theme/glass.css` 导入，仅在导航、全局工具、报告操作条和手机菜单使用。例如：

```html
<header class="scova-glass scova-glass--navigation">…</header>
<div class="scova-glass scova-glass--tools">…</div>
<div class="scova-glass scova-glass--report">…</div>
<nav class="scova-glass scova-glass--menu">…</nav>
```

浅暗色从 `AppThemeProvider` 的 `--scova-surface`、`--scova-text`、`--scova-border` 等主题变量继承。背景覆盖分别为 92%、92%、94%、96%，模糊为 `0.875rem`。全局工具的 90% 候选在浅色黑底上使松绿链接对比度降至约 4.37:1，故提高到 92%；旧草案 60% 等值不作为产品令牌。

只混合背景 alpha，不设置容器 opacity，文字和图标保持 opacity 1。正文、证据、输入、图片和警告使用 `scova-surface` 等实色内容表面，不能挂玻璃 class；嵌入式表单也须显式保持输入背景不透明。避免叠加多个透明层或以整页 blur 制造装饰。

基础样式先使用实色，只有同时支持 `backdrop-filter` 和 `color-mix` 的浏览器才启用透明混合；仅支持旧前缀的浏览器保留实色。`prefers-reduced-transparency: reduce` 关闭透明、模糊和阴影。需要显式降级时给元素增加 `scova-glass--solid`，或在祖先设置 `data-reduced-transparency="true"`。这两个机制不依赖媒体查询；本模块不增加全局偏好 store，也不承诺自动检测设备性能。

## 可运行样例

在仓库根目录运行 `vp run web#dev`，打开开发服务器的 `/examples/glass/index.html`。样例直接消费同一份主题变量与共享玻璃 CSS，可切浅暗、四主色、黑/白/蓝底与本地图文底图，并提供键盘可操作的“使用实色”。四个区域同时展示以便比较，不实现手机菜单的开关逻辑。底图为样例内 SVG/渐变，无外部图片请求。

生产构建样例可在 `apps/web` 目录运行：

```sh
vp build examples/glass --outDir ../../artifacts/glass-demo --emptyOutDir
vp preview --outDir artifacts/glass-demo
```

样例源码位于 [index.html](../../../apps/web/examples/glass/index.html) 与 [glass.ts](../../../apps/web/src/examples/glass.ts)。字号、间距、圆角和控件尺寸采用相对单位；SVG viewBox 坐标只定义可缩放图形，根字号保持浏览器默认。

## 验证与边界

本机 Chromium 151 的生产样例中，四处玻璃在浅暗、四主色与黑/白/蓝/图文底图的 32 组组合里均保留文字、链接、图标及容器 opacity 1。读取实际截图合成像素并计算 sRGB 对比度，文字/链接最低约 4.60:1，边框最低约 3.28:1；正文、输入、证据、警告和缩略图的内容底色仍不透明。不是仅以主题 token 对主题 token 计算对比度；更换覆盖率、主题或消费者前景色后需重测。

另验原生 `prefers-reduced-transparency` 媒体模拟、祖先实色属性和单元素实色 class；均得到不透明背景、无模糊及无阴影。当前浏览器实际支持 `backdrop-filter`，尝试运行时关闭开关仍返回支持。通过将唯一特性查询改成未知属性，只验证了浏览器执行 `@supports` 假分支后的实色结果；这是分支模拟，**真正不支持该特性的浏览器未验**，不能将实色覆盖或模拟描述为关闭了浏览器能力。

320/390 宽度及测试用 200% 文字（根字号 32px）能重排，无整页横向溢出。上述均为独立样例，不代替实际导航、报告页或移动菜单的功能与视觉验收。无头 Chromium 使用 SwiftShader 软件渲染，合成滚动样本各 180 帧只记录环境观测；**实体桌面/移动设备的滚动、GPU 合成和能耗性能未验**，不据此宣称流畅度或性能收益。
