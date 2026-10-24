# 前端代码风格与通信约定

状态：待 apps/web 实现时落实的工程契约，2026-10-24。代码风格以用户指定的 community 项目为主要参照，工具链继续使用 Scova 的 Vite+，通信统一采用 requestlane。参考项目的业务、资源和认证方式不作为需要复制的实现。

## 1. 目录与组件

```text
apps/web/src/
  api/           # requestlane 客户端、领域 service、SSE 桥接
  views/         # TaskCenterView 等路由页面，负责组合
  components/    # 按页面/功能拆分；common 放跨页面 UI
  layout/        # 工作台、登录及编辑布局
  composables/   # useXxx：交互、查询、订阅与生命周期
  store/         # Pinia 客户端状态，沿用 community 的单数目录
  models/        # contracts DTO 的类型导出与前端专用视图模型
  router/        # 路由、meta、布局与守卫
  utils/         # 无框架依赖的通用纯逻辑
```

- 使用 Vue 3 `<script setup lang="ts">`，SFC 按 template、script、必要时 style 排列。组件文件 PascalCase，模板组件 kebab-case，composable 命名 useXxx，`@/` 指向 src。
- 页面保持薄层，把独立展示单元移入按功能组织的 components，把复用交互放 composables，远程调用放 api。Props/emits、路由参数使用明确类型，不照搬参考项目中的 any 或弱类型 Props。
- 采用 naive-ui 显式组件导入，UnoCSS 维护 page-container、卡片、表单和空态等语义 shortcut；集中处理主题，不在页面复制大段全局 CSS。
- Vue/TS 前端文件采用 4 空格、单引号、无分号，import type 分离类型。M1 在根 Vite+ fmt.overrides 中仅对 apps/web 的文件设置覆盖，根配置/后端保持既有格式。
- 保持 loading/empty/error/success 状态、可重试错误、键盘焦点和移动端基础适配。异步读取可取消，卸载/换参数时终止旧请求，防止迟到响应覆盖新状态。

## 2. 数据与状态责任

Vue Query 负责服务端数据、缓存、失效与请求状态；Pinia 只存用户摘要、会话 epoch、布局与未保存草稿等客户端状态。DTO 和运行时 schema 来自 packages/contracts，不能在 models 中另建一套字段相近的接口。

community 中存在 Service/store 组合和 JWT 持久化；Scova 借用分层风格，保留自己的 Cookie 会话设计。不要把服务端列表复制进 Pinia，不向 localStorage 写登录 token 或模型密钥。

## 3. requestlane 统一入口

核实的源码基线：[requestlane commit e9f5147](https://github.com/abcde1239/requestlane/tree/e9f5147a73b6b8dee6b672dac6b6b23356f92183)，package.json 版本 0.1.3。实现时通过 Vite+ 安装并锁定已验证发行版，确认浏览器构建和 API 行为；若发行版与所读源码不符，先核实兼容性，不退回另一套请求封装。

- 在模块作用域创建共享 Client 与 Fetch transport，baseURL=/api/v1，credentials=same-origin；端点在模块作用域用 defineEndpoint 定义，输入/输出通过 contracts schema 验证。
- 使用普通 JSON 数据和真实 HTTP 状态。requestlane 默认 identity codec，sendsCodec 是可选且不属于 Scova API 协议。错误经 classifyError 和 Scova 错误体映射，保留 status、code、requestId、fieldErrors。
- 通过请求选项/统一 beforeRequest 注入 CSRF、Idempotency-Key 和 If-Match。请求 key 对同一用户动作重发保持稳定，不能每次网络重试生成新 key；写请求不自动重试。
- Vue Query 的 signal 传入 requestlane；取消不显示失败 toast。每个用户会话持有独立客户端生命周期/epoch，退出或换号时 dispose、清空 Query 缓存并停止 SSE；旧会话迟到的 401 不能清掉新登录会话。
- requestlane 内存响应缓存保持关闭，只有一个服务器缓存拥有者；后续如确需启用另层缓存，需先证明失效和账号隔离规则。

## 4. SSE 桥接

当前 Client 将响应解码成 JSON/text/blob/arraybuffer，不提供 SSE 流解析。在统一 api 模块中使用同一 Fetch transport 的 `native` 入口读取 Response.body，结合 useRunEvents 暴露给页面。不得伪造 responseType=stream 或把 Client.get 的 text 响应当成长连接。

native 会跳过 Client 的 endpoint、session、cache 和错误 hook，必须显式设置同源 credentials、AbortSignal、Last-Event-ID，校验 HTTP 状态与事件结构，并管理 UTF-8 分片、跨 chunk 帧、CRLF、多行 data、心跳、游标去重、reset 和有限重连退避。首版由模块注入 fetcher 便于确定性测试，不让组件直接触碰 transport。

会话变更立刻中断流；以 epoch 校验迟到事件。断线以持久化游标续传，事件使相关 query 失效，最终 Run 状态从 API 读取。库升级若提供正式 SSE API，必须先验证语义，再替换这一集中桥接点。

## 5. 验收

新增的 apps/web 配置、示例页面和通信测试应通过 `vp check`、`vp test` 与 `vp run -r build`。重点测试 Cookie、CSRF/幂等头、校验失败、401/403、取消、Query 失效、换号迟到响应，以及 SSE 分片/重连；Playwright 检查页面状态、键盘操作与两账号隔离。

本轮只确立约定与实现 Issue，尚未安装 requestlane、创建 apps/web 或运行其业务测试。
