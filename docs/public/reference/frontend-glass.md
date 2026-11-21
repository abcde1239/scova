# 局部透明层

共享样式集中在由 `main.ts` 引入的 `@/main.css`，供需要局部透明层的导航、工具条和菜单使用；具体页面按当前视觉设计选择，不增加重复背景。例如：

```html
<header class="scova-glass scova-glass--navigation">…</header>
<div class="scova-glass scova-glass--tools">…</div>
<div class="scova-glass scova-glass--report">…</div>
<nav class="scova-glass scova-glass--menu">…</nav>
```

浅暗色从 `AppThemeProvider` 的 `--scova-surface`、`--scova-text`、`--scova-border` 等主题变量继承。背景覆盖分别为 92%、92%、94%、96%，模糊为 `0.875rem`。全局工具的 90% 候选在浅色黑底上使松绿链接对比度降至约 4.37:1，故提高到 92%；旧草案 60% 等值不作为产品令牌。

只混合背景 alpha，不设置容器 opacity，文字和图标保持 opacity 1。正文、证据、输入、图片和警告使用 `scova-surface` 等实色内容表面，不能挂玻璃 class；嵌入式表单也须显式保持输入背景不透明。避免叠加多个透明层或以整页 blur 制造装饰。

独立认证页不使用玻璃或动画：`AuthLayout.vue` 为静态分栏，表单栏使用实色表面，左侧展示栏只用强调色淡底和静态网格线装饰；减少透明度时隐藏网格线。详见[登录页](frontend-login.md)。

基础样式先使用实色，只有同时支持 `backdrop-filter` 和 `color-mix` 的浏览器才启用透明混合；仅支持旧前缀的浏览器保留实色。`prefers-reduced-transparency: reduce` 关闭透明、模糊和阴影。需要显式降级时给元素增加 `scova-glass--solid`，或在祖先设置 `data-reduced-transparency="true"`。这两个机制不依赖媒体查询；本模块不增加全局偏好 store，也不承诺自动检测设备性能。

## 验证

使用现有的[基础视觉测试](frontend-visual-foundation.md)，复用真实主题、组件与玻璃样式：

```sh
vp exec playwright test --config tests/e2e/visual-foundation.config.ts
```

该入口自动启动 test 模式构建，检查四主色、浅暗色、黑/白/蓝底色下的实际渲染对比度，以及减少透明度、显式实色和字体回退。`/__examples/visual-foundation` 仅用于测试，不进入正常开发或生产路由。

均匀底色上的自动检查不覆盖照片或渐变背景；测试样例不代替真实导航、报告页、手机菜单和响应式交互验收。真正不支持相关 CSS 特性的浏览器、实体设备 GPU 与能耗性能仍需单独验证。
