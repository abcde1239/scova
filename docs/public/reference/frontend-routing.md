# 工作台路由与插槽

`apps/web/src/main.ts` 装配 Pinia 和 Vue Router，先安装会话守卫，再挂载 App。首次路由尚未确认或会话恢复中，只显示独立加载布局；守卫完成后才显示工作台或认证布局，并组合 SessionBoundary 与 RouterView。401 在进入业务页前转至登录，服务不可达转至 /service-unavailable 独立错误页；重试成功后回到原站内地址。App 不发起领域请求。

当前入口为 `/tasks`、`/inbox`、`/library`、`/notifications`、`/account`，已有各自业务页面；任务、执行、报告和来源详情按领域路由登记。`/login`、`/register` 提供会话表单；统一守卫处理恢复、退出和安全返回。`/account/appearance` 提供本地主题与阅读偏好，服务端账号偏好使用独立页面。未知地址显示未找到页并保留 URL。

## 登记领域页面

在 `apps/web/src/router/pages/` 新增独立领域文件，默认导出 `RouteRecordRaw[]`，由入口自动收集。页面必须有唯一名称。实现已有入口时使用其名称（如 `tasks`），提供真实 component 和 meta；收集器会替换壳层的 pending 入口并继承导航信息，两个真实实现重名会报错。新增详情使用独立名称和 `meta.section`（如 `tasks`），保持所属导航高亮。页面标题由 `meta.title` 指定。

路由可以使用 `components: { default, context, tools, reading }`：default 为主体，context 为详情分区，tools 为标题旁工具，reading 为阅读控件。布局还提供同名 Vue 插槽，集中维护容器。页面无需修改 App 或主路由表，也不要在壳层发起请求。

登录与注册显式登记 `meta.layout: 'auth'`，共用 `AuthLayout`；其他公开页面不会自动套用认证布局。认证页面不显示工作台导航、面包屑或账号菜单，桌面居中并限制表单宽度，窄屏、矮屏与文字放大时自然滚动。右上角可选择浅色、深色或跟随系统，沿用本地外观偏好。登录、注册的字段校验、Cookie 会话恢复及安全返回继续由原有认证模块管理。

账号、外观、新建和编辑任务通过 `meta.contentWidth: 'form'` 选择最大 44rem 的主体内容区，面包屑、标题和表单共同水平居中；导航保持工作台宽度。列表和报告继续使用宽内容区，报告分栏保持原有规则。

每次成功跳转更新文档标题并将焦点移至主内容；提供跳到主内容链接。导航高亮同时使用颜色、下划线与 `aria-current`。尺寸默认使用 rem，根字号保留浏览器默认。手机菜单、图标、用途排版和局部透明层已由共享布局接入；具体页面的返回焦点和未保存保护由所属领域组合实现。

验证：`vp check`、`vp test`、`vp run build`、`vp run harness-lint`。开发使用 `vp run dev:frontend`，生产部署的 SPA 回退由部署层配置；本模块不会替代生产代理配置。
