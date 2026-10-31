# 浏览器测试

先运行 `vp install`，再运行 `vp run test:e2e:install` 安装锁定 Playwright 所需的 Chromium。Linux CI 需额外安装浏览器系统依赖（例如 `vp exec playwright install --with-deps chromium`）。浏览器安装与项目 npm 依赖是两步，不能仅安装 npm 包就认定浏览器可运行。

执行 `vp run test:e2e tests/e2e/shell.spec.ts`。配置会先构建真实 Web，再启动仅绑定回环地址的生产预览；测试结束清理该服务，不复用未知的已运行端口。失败截图及 trace 保存在忽略的 `artifacts/e2e/results`；每次运行的 JSON 报告（包括成功用例的来源与清理附件）保存到 `artifacts/e2e/report.json`，下一次运行前应复制需要保留的报告。输出打印实际 Chromium 版本。

壳测试覆盖工作台路由、刷新、未知路径、390 视口导航和键盘主内容焦点，不代表账号、研究旅程或完整视觉验收。成功冒烟也在各自结果目录保存桌面和窄视口截图。Vite+ 单元扫描与 Playwright 隔离。

[基础视觉验收](frontend-visual-foundation.md)另提供独立端口的四主色、浅暗、中文字体及透明层矩阵，记录实际渲染测量与源码指纹；它不替代页面专项或真实设备验收。

全栈环境需要 Docker Engine 和 Compose v2，并能拉取构建所需镜像、安装锁定依赖。连续执行两次 `vp run test:e2e tests/e2e/environment.spec.ts`，验证真实 Web 静态代理、API、PostgreSQL、Redis、Worker、迁移与交付。首次构建可能较慢，镜像构建上限 15 分钟；依赖和应用健康等待分别为 90、120 秒，单次 Run 交付等待 90 秒。该命令自动选择全栈配置，不启动 Vite preview。

每个测试使用随机 Compose 项目、独立数据库和 Redis 卷、随机业务 schema、图状态 schema、队列、端口和浏览器账号。浏览器经真实注册接口建立同源 Secure/HttpOnly Cookie 会话，调用 `/me`、创建 Run 并读取经真实交付生成的报告；两个用户验证数据隔离。不降低 Cookie 安全属性，浏览器地址使用 `http://localhost:<随机端口>`，不能改成 HTTP 的 `127.0.0.1`。

`tests/e2e/support/environment.ts` 提供 `owner()`、`request()`、`task()`、`execute()` 和 `prepareDisplay()`，后续领域 spec 可复用。确定性场景复用 Worker 已有供应商 fixture，执行实际 Agent、Reader、账本、检查点和交付路径；报告标记 `executed-supplier-fixture`、`remoteResearch: false`。三类 A/B 两轮结果的准备标记 `prepared-display`，供后续页面展示测试使用。它们不是远程模型或 Tavily 研究成功，也不表示领域页面或三类场景业务断言已完成。普通运行不需要生产凭据，不启用远程搜索服务，生产入口没有测试开关。

测试结束及启动/中途失败均在 `finally` 中关闭浏览器上下文，并对本次项目执行 `down -v --remove-orphans`，断言自身容器、卷和网络已清空；仅移除本次生成的镜像标签。启动失败和中途失败都有持久化 spec。强制杀死进程或关闭 Docker 不能保证执行清理，可从失败附件取得项目名后，仅针对该项目检查和回收资源，不清理其他项目或用户卷。

后续全栈领域 spec 使用 `SCOVA_E2E_FULL_STACK=1` 选择配置，再传具体 spec 路径；默认入口继续只运行壳测试。Harness 在非必需的 `web-shell-e2e` 范围登记默认关闭的 `web-shell-browser`、`web-environment-browser`。全栈浏览器实际连接后端与数据库，但这些可选任务不计入后端必需门禁，后端已有集成任务继续执行。当前 `ready` 不运行浏览器；CI 与门禁接入由后续专项交付。生产代理的 SPA 回退仍需部署检查，本地 preview 的刷新成功不能代替部署验收。
