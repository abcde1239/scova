# 工作台路由与插槽

`apps/web/src/main.ts` 装配 Pinia 和 Vue Router，等待初始路由就绪后挂载。App 只挂载主题 Provider、工作台布局与命名 RouterView；不处理领域请求或认证守卫。

当前入口为 `/tasks`、`/inbox`、`/library`、`/notifications`、`/account`。这些业务尚未接入，页面明确显示状态。`/account/appearance` 已提供本地主题设置，从账号页进入；不涉及服务端账号偏好。未知地址显示未找到页并保留 URL。

## 登记领域页面

在 `apps/web/src/router/pages/` 新增独立领域文件，默认导出 `RouteRecordRaw[]`，由入口自动收集。页面必须有唯一名称。实现已有入口时使用其名称（如 `tasks`），提供真实 component 和 meta；收集器会替换壳层的 pending 入口并继承导航信息，两个真实实现重名会报错。新增详情使用独立名称和 `meta.section`（如 `tasks`），保持所属导航高亮。页面标题由 `meta.title` 指定。

路由可以使用 `components: { default, context, tools, reading }`：default 为主体，context 为详情分区，tools 为标题旁工具，reading 为阅读控件。布局还提供同名 Vue 插槽，集中维护容器。页面无需修改 App 或主路由表，也不要在壳层发起请求。

每次成功跳转更新文档标题并将焦点移至主内容；提供跳到主内容链接。导航高亮同时使用颜色、下划线与 `aria-current`。尺寸使用弹性单位，根字号保留浏览器默认。手机菜单、图标、用途排版和透明层由后续功能接入。

验证：`vp check`、`vp test`、`vp run -r build`、`vp run harness-lint`。开发使用 `vp run dev`，生产部署的 SPA 回退由部署层配置；本模块不会替代生产代理配置。
