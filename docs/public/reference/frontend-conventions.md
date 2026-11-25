# 前端代码风格与通信约定

状态：当前工程约定，2026-10-31。代码风格以用户指定的 community 项目为主要参照，工具链继续使用 Scova 的 Vite+，通信统一采用 requestlane。参考项目的业务、资源和认证方式不作为需要复制的实现。

## 1. 目录与组件

```text
apps/web/src/
  component/     # 仅 .vue：可复用 UI 和主题 provider
  layout/        # 认证、工作台和状态外壳及其专用导航、菜单和面包屑
  composable/    # useXxx：交互、查询、订阅与生命周期
  utils/         # 跨功能辅助、领域辅助（如 report/）、主题、国际化和启动辅助
  store/         # Pinia 客户端状态
  api/           # requestlane 客户端、领域接口、SSE 桥接
  view/          # 页面组件
  router/        # Vue Router 装配、路由元数据；pages/ 按领域登记路由
```

顶层只使用上述八个源码目录。框架装配和全局基础文件 `main.ts`、`bootstrap.ts`、`App.vue`、`main.css` 与 `env.d.ts` 留在 `src/` 根；测试、构建配置和静态资源不在此限制内。若要新增一级目录，需解释为何无法归入现有层。

- 使用 Vue 3 `<script setup lang="ts">`，SFC 按 template、script、必要时 style 排列。组件文件 PascalCase，模板组件 kebab-case，composable 命名 useXxx，`@/` 指向 src。
- `component/` 及其子目录只存放 `.vue`。单个组件的简短私有逻辑可内联在 SFC；需要独立文件的纯投影、展示类型或预设放在 `utils/`，按领域分组（如 `utils/report/sources.ts`），文件名不重复领域前缀。
- 页面保持薄层，把独立展示单元移入按功能组织的 `component`，把复用交互放 `composable`，远程调用放 `api`。Props/emits、路由参数使用明确类型，不照搬参考项目中的 any 或弱类型 Props。
- 采用 naive-ui 显式组件导入，UnoCSS 维护 page-container、卡片、表单和空态等语义 shortcut；集中处理主题，不在页面复制大段全局 CSS。
- 样式默认使用 UnoCSS 模板原子类，hover、focus、显隐、简单动画、过渡和响应式效果也沿用 UnoCSS。配置统一放在 `apps/web/unocss.config.ts`；高频组合提取用途明确的 shortcuts，状态或断点组合可使用 variant group。shortcut 命名避免与预设已有规则或变体冲突。
- 站内普通跳转用 `internal-link`，辅助前进入口用 `navigation-link` 配尾部 chevron，宽度随内容、左对齐；站外来源用 `external-link` 配常显外部打开图标，保留新窗口说明。普通链接无常驻下划线、底色或胶囊边框，悬停变色，前进入口的尾部 chevron 在允许动效时右移 0.125rem；按下显示下划线，键盘有清晰焦点；标题用 `title-link` 保持正文色，文末页内引用用轻量 `reference-link`。目录、面包屑不统一加箭头；菜单选中态、整卡片和按钮保留各自用途样式。
- `main.ts` 在 `utils/startup.ts` 的恢复流程中加载 `bootstrap.ts`。`bootstrap.ts` 装配 Vue、路由、会话与插件，并导入基础样式 `main.css`。`index.html` 保留独立的启动界面，装配失败时由 `utils/startup.ts` 恢复重试入口。阅读字体样式与加载逻辑同在 `composable/`，仍按需加载，不承载页面样式。复杂动画可保留 scoped CSS；类名组合过长、拆分后难以阅读的局部控件也允许 scoped，优先使用简短的 UnoCSS `@apply` 规则或语义 shortcuts，不强行堆叠长类名。
- 全仓格式统一由根 Vite+ fmt 管理：4 空格缩进、单引号、100 字符行宽，分号沿用工具默认规则；前端不另设格式覆盖。文本由根 `.gitattributes` 统一检出为 LF，避免 Windows 的 `core.autocrlf` 与格式检查冲突；自动识别的二进制文件保持原始字节。Vue/TS 使用 import type 分离类型。
- 字号、间距、圆角、控件尺寸与响应式断点默认使用 `rem`，保留浏览器默认根字号，行高使用无单位值。容器结合百分比、弹性布局和 `min/max/clamp` 自适应；局部图标等需要随当前文字缩放时可使用 `em`。`px` 仅用于确有需要的特殊情况，并在代码或变更说明中解释用途；测试视口和图片原始分辨率的像素不属于页面布局尺寸。避免固定高度裁切放大后的文字，并验证窄屏及 200% 文字放大。
- 保持 loading/empty/error/success 状态、可重试错误、键盘焦点和移动端基础适配。异步读取可取消，卸载/换参数时终止旧请求，防止迟到响应覆盖新状态。
- 用户操作的成功、失败、取消和结果核对反馈统一通过 `useActionNotification` 报告，不在页面保留“已恢复为未读”“已保存”等即时提示，也不同时显示通知与页面文案。字段校验、加载/空态、实际业务状态、冲突恢复与重试入口仍随对应内容展示；批量失败明细保留可逐项处理的列表。通知不抢焦点，原控件移除时将焦点交还有效控件；观察消息不立即回放缓存值，卸载后停止报告，切换会话清空旧通知。

## 2. 数据与状态责任

Vue Query 负责服务端数据、缓存、失效与请求状态；Pinia 只存用户摘要、会话 epoch、布局与未保存草稿等客户端状态。共享 DTO 和运行时 schema 来自 `@scova/models`。前端专用的展示类型放在 `utils/` 的对应领域目录。

community 中存在 Service/store 组合和 JWT 持久化；Scova 借用分层风格，保留自己的 Cookie 会话设计。不要把服务端列表复制进 Pinia，不向 localStorage 写登录 token 或模型密钥。

## 3. requestlane 统一入口

核实的源码基线：[requestlane commit e9f5147](https://github.com/abcde1239/requestlane/tree/e9f5147a73b6b8dee6b672dac6b6b23356f92183)，package.json 版本 0.1.3。实现时通过 Vite+ 安装并锁定已验证发行版，确认浏览器构建和 API 行为；若发行版与所读源码不符，先核实兼容性，不退回另一套请求封装。

- 在模块作用域创建共享 Client 与 Fetch transport，baseURL 由根环境文件的 VITE_API_BASE_URL 决定，credentials=include；开发直连 API，不使用 Vite proxy，生产默认 /api/v1；Server 仅允许 APP_ORIGIN 来源的 credentialed CORS，保留 SameSite Cookie、Origin 与 CSRF 校验；端点在模块作用域用 `defineApiEndpoint` 定义，通过 `modelValidator` 适配共享 schema。
- 使用普通 JSON 数据和真实 HTTP 状态。requestlane 默认 identity codec，sendsCodec 是可选且不属于 Scova API 协议。错误经 classifyError 和 Scova 错误体映射，保留 status、code、requestId、fieldErrors。
- 通过请求选项/统一 beforeRequest 注入 CSRF、Idempotency-Key 和 If-Match。请求 key 对同一用户动作重发保持稳定，不能每次网络重试生成新 key；写请求不自动重试。
- Vue Query 的 signal 传入 requestlane；取消不显示失败 toast。每个用户会话持有独立客户端生命周期/epoch，退出或换号时 dispose、清空 Query 缓存并停止 SSE；旧会话迟到的 401 不能清掉新登录会话。
- requestlane 内存响应缓存保持关闭，只有一个服务器缓存拥有者；后续如确需启用另层缓存，需先证明失效和账号隔离规则。

## 4. SSE 桥接

当前 Client 将响应解码成 JSON/text/blob/arraybuffer，不提供 SSE 流解析。在统一 api 模块中使用同一 Fetch transport 的 `native` 入口读取 Response.body，结合 useRunEvents 暴露给页面。不得伪造 responseType=stream 或把 Client.get 的 text 响应当成长连接。

native 会跳过 Client 的 endpoint、session、cache 和错误 hook，必须显式设置同源 credentials、AbortSignal、Last-Event-ID，校验 HTTP 状态与事件结构，并管理 UTF-8 分片、跨 chunk 帧、CRLF、多行 data、心跳、游标去重、reset 和有限重连退避。首版由模块注入 fetcher 便于确定性测试，不让组件直接触碰 transport。

会话变更立刻中断流；以 epoch 校验迟到事件。断线以持久化游标续传，事件使相关 query 失效，最终 Run 状态从 API 读取。库升级若提供正式 SSE API，必须先验证语义，再替换这一集中桥接点。

### 增量解析器

`apps/web/src/api/sse-parser.ts` 提供无 Vue 依赖的 `createSseParser({ runId, maxFrameBytes? })`。
将原始 `Uint8Array` 逐块传入 `push`，读取该次完成的 `SseMessage[]`；流结束后调用 `finish`。
默认单帧上限 65,536 字节，包含字段、注释和换行。UTF-8、CRLF、中文和 emoji 可跨 chunk；多行 data 按换行连接，注释和未知字段不输出业务消息。

解析器复用 `SseMessageSchema` 并验证目标 Run、wire event/type 与 id/eventId；reset 不允许 id、eventId 或 seq，且快照必须属于同一 Run。
`SseParseError.code` 区分超限、UTF-8、JSON、schema、信封及不完整尾帧错误；失败调用在错误前已完成的消息位于 `completedMessages`，调用方仍须按顺序处理这些消息，再处理错误。
EOF 不代替空行，不输出部分消息；错误或 finish 后不能复用实例。连接、重连、去重、游标推进和 Query 失效由订阅层实现，reset 不推进 Last-Event-ID。

## 5. 验收

应用与共享包的测试实现放各工作区 `tests/`，固定输入和辅助代码放 `tests/fixtures/` 或 `tests/support/`。Web 组件展示页、素材、报告 HTML 与测试路由定义统一位于 `apps/web/tests/fixtures/`，仅在 test 构建启用；`src/` 保存生产应用代码。根 `tests/` 负责跨工作区与浏览器验证，运行产物写入忽略的 `artifacts/`。竞态测试可复用 `tests/support/deferred.ts` 控制响应顺序，不用固定延时替代明确的异步条件。

新增的 apps/web 配置、示例页面和通信测试应通过 `vp check`、`vp test` 与 `vp run -r build`。重点测试 Cookie、CSRF/幂等头、校验失败、401/403、取消、Query 失效、换号迟到响应，以及 SSE 分片/重连；Playwright 检查页面状态、键盘操作与两账号隔离。

当前 `apps/web/src/api` 已提供最小 HTTP 通信入口，端点由 `defineApiEndpoint` 在模块作用域声明，输入/输出使用 `modelValidator` 适配共享 schema。`api.request(endpoint, input, options)` 返回 `{ data, status, headers, url }`，编辑时读取 `headers.etag`，在下一次调用的 `ifMatch` 中原样传回；内部使用 requestlane 的 `requestRaw` 保留真实状态和响应头，并统一执行端点校验。`options` 接收 `signal`、`timeout`、`csrfToken`、`idempotencyKey` 与 `ifMatch`，认证写请求必须提供当前 CSRF，同一动作重发复用调用方持有的幂等键，不自动重试。

`ApiRequestError` 保留错误分类及可用的状态、错误码、追踪 ID 和字段定位；取消可由 `kind === 'cancelled'` 识别。`createApi({ fetcher })` 用于注入测试 transport；`dispose()` 取消整个 HTTP 调用（含异步校验）。默认实例与 `transport` 共用同一 Fetch transport。原生 `transport.native` 是 SSE 桥接入口，跳过 HTTP 客户端校验、凭据配置和 dispose，调用方必须自行传入 credentials/signal 并管理清理。

运行 `vp test apps/web/tests/requestlane.test.ts` 验证通信契约。登录页面、SSE 解析与续传已分别接入；这些 HTTP 单元测试本身不覆盖完整浏览器旅程，具体能力与限制见[Web 工作台使用说明](../guides/web-workbench.md)。

## 6. Query 与会话作用域

应用入口安装一个 `createSessionLifecycle()`，共享它的 Pinia、QueryClient 与注入键。业务读取使用 `useSessionQuery(endpoint, input, key)`，写命令使用 `useSessionMutation(endpoint)`；Query 是唯一服务端缓存，Mutation 默认不重试。查询 key 自动包含账号、epoch、端点和输入，查询卸载时的 signal 传到同一 HTTP 入口。`queryOptions` 可供非组件调用 `queryClient.fetchQuery`；当前未安装账号时组件查询保持禁用，由应用会话流程显式请求恢复。

登录、恢复和退出流程在动作开始时保存 `const scope = lifecycle.capture()`，经 `scope.request(...)` 请求，再以 `scope.replaceSession(result.data)` 或 `scope.replaceSession(null)` 完成交接。作用域过期时交接被拒绝，不能在迟到回调中直接安装旧会话。生命周期内的当前认证请求 401 会清空当前会话；匿名登录失败不会清掉已安装账号。`replaceSession` 是统一安装入口，不执行登录、注销 HTTP 或路由跳转。

切换动作先推进 epoch、中止旧 scope signal、取消 Query 和 HTTP、释放注册清理回调并清缓存，再创建新 HTTP client、安装新用户摘要；CSRF 只在内存闭包中保留，不进入 Pinia 或持久化存储。全局 Query/Mutation 错误观察过滤取消错误，UI 采用相同的 `shouldReportQueryError`，不为取消/卸载提示失败。普通错误仍由页面展示，失效按实际资源 key 定向执行，不默认轮询或窗口焦点刷新。

流模块从捕获的 scope 取得同一 `transport` 与 `signal`，通过 `scope.registerCleanup(close)` 注册关闭回调，主动关闭时调用返回的注销函数。接收数据前检查 `scope.isCurrent()`；native 请求仍须显式设置同源凭据并连接该 signal。此接口只管理流生命周期，不解析或重连 SSE。

运行 `vp test apps/web/tests/query-lifecycle.test.ts` 验证会话切换、迟到结果隔离、取消和定向刷新。该测试使用受控响应，不代表真实后端登录或 SSE 联调。
