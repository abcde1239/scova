# 浏览器测试

先运行 `vp install`，再运行 `vp run test:e2e:install` 安装锁定 Playwright 所需的 Chromium。Linux CI 需额外安装浏览器系统依赖（例如 `vp exec playwright install --with-deps chromium`）。浏览器安装与项目 npm 依赖是两步，不能仅安装 npm 包就认定浏览器可运行。

`vp run test:e2e --list` 列出默认前端测试，`vp run test:e2e` 执行所有默认前端 spec（排除全栈 environment）；只跑壳冒烟可使用 `vp run test:e2e tests/e2e/shell.spec.ts`。默认配置先以 test 模式构建真实 Web，再由 `tests/e2e/serve.mjs` 在回环地址提供静态应用及受控会话样本，各 spec 按需提供接口样本。测试结束清理服务，不复用未知的已运行端口。失败截图及 trace 保存在忽略的 `artifacts/e2e/results`；每次运行的 JSON 报告（包括成功用例的来源与清理附件）保存到 `artifacts/e2e/report.json`，下一次运行前应复制需要保留的报告。输出打印实际 Chromium 版本。

壳测试覆盖工作台路由、刷新、未知路径、390 视口导航和键盘主内容焦点，不代表账号、研究旅程或完整视觉验收。成功冒烟也在各自结果目录保存桌面和窄视口截图。Vite+ 单元扫描与 Playwright 隔离。

[基础视觉验收](frontend-visual-foundation.md)另提供独立端口的四主色、浅暗、中文字体及透明层矩阵，记录实际渲染测量与源码指纹；它不替代页面专项或真实设备验收。

全栈环境需要 Docker Engine 和 Compose v2，并能拉取构建所需镜像、安装锁定依赖。连续执行两次 `vp run test:e2e tests/e2e/environment.spec.ts`，验证真实 Web 静态代理、API、PostgreSQL、Redis、Worker、迁移与交付。首次构建可能较慢，镜像构建上限 15 分钟；依赖和应用健康等待分别为 90、120 秒，单次 Run 交付等待 90 秒。该命令自动选择全栈配置，不启动 Vite preview。

每个测试使用随机 Compose 项目、独立数据库和 Redis 卷、随机业务 schema、图状态 schema、队列、端口和浏览器账号。浏览器经真实注册接口建立同源 Secure/HttpOnly Cookie 会话，调用 `/me`、创建 Run 并读取经真实交付生成的报告；两个用户验证数据隔离。不降低 Cookie 安全属性，浏览器地址使用 `http://localhost:<随机端口>`，不能改成 HTTP 的 `127.0.0.1`。

`tests/e2e/support/environment.ts` 提供 `owner()`、`request()`、`task()`、`execute()` 和 `prepareDisplay()`，后续领域 spec 可复用。确定性场景复用 Worker 已有供应商 fixture，执行实际 Agent、Reader、账本、检查点和交付路径；报告标记 `executed-supplier-fixture`、`remoteResearch: false`。三类 A/B 两轮结果的准备标记 `prepared-display`，供后续页面展示测试使用。它们不是远程模型或 Tavily 研究成功，也不表示领域页面或三类场景业务断言已完成。普通运行不需要生产凭据，不启用远程搜索服务，生产入口没有测试开关。

测试结束及启动/中途失败均在 `finally` 中关闭浏览器上下文，并对本次项目执行 `down -v --remove-orphans`，断言自身容器、卷和网络已清空；仅移除本次生成的镜像标签。启动失败和中途失败都有持久化 spec。强制杀死进程或关闭 Docker 不能保证执行清理，可从失败附件取得项目名后，仅针对该项目检查和回收资源，不清理其他项目或用户卷。

全栈领域 spec 使用 `SCOVA_E2E_FULL_STACK=1` 选择配置并传具体 spec 路径；运行普通前端样本前移除此变量，避免关闭其静态服务。专用配置按各自 `testMatch` 执行：task-center 和 run-history 使用生产构建，execution 和 visual-foundation 使用 test 构建。各配置会重建同一份 `apps/web/dist`，须串行运行并在切换前停止上一预览。生产代理的 SPA 回退仍需部署检查，本地 preview 的刷新成功不能代替部署验收。

## 统一 Web 门禁

```sh
vp run verify:web
vp run verify:web:browser
vp run verify:web:failure
vp node scripts/verify-web.mjs --plan
```

`verify:web` 串行执行全仓静态检查、单元测试、工作区构建，再执行浏览器门禁。浏览器阶段先执行普通样本 spec，再分别执行四个专用配置，避免同一 spec 在默认和专用配置中重复；最后运行隔离环境、英语/招生/研究两轮、账号及故障恢复、基础页面六宽与键盘 spec。基础主题/字体/透明层矩阵也包含在专用配置中。全部进程退出、服务 teardown 后恢复生产 Web 构建。

`verify:web:browser` 只执行同一浏览器阶段，供 `ready` 的任务图复用，不重复静态检查和单元测试，也不调用 `ready`。Harness 将 `web-shell-e2e` 设为必须配置真实任务，由必需的 `web-browser-gate` 覆盖；原有单项可选任务保留关闭。

`verify:web:failure` 执行真实隔离环境 spec，包含依赖启动和测试中途注入失败的清理断言；确认每项报告记录本项目空资源后，主动以非零退出测试外层失败传播。它预期失败，不能作为成功验收。CI 独立任务要求收到对应失败标记，并核环境阶段和恢复生产构建均成功；其他原因失败也会使 CI 失败。

每次聚合运行使用独立的 `artifacts/verify-web/<时间与进程标识>/`，包含每阶段日志、JSON、失败截图/trace 和 summary。退出码非零、零测试、跳过、flaky、全栈清理附件缺失或资源非空都阻断门禁；控制台及 summary 记录实际 Chromium 版本。GitHub Actions 上传该目录作为短期诊断，不上传私有开发文档或生产凭据。不要同时运行多个聚合入口消费同一 `dist`。

这些门禁运行受控浏览器样本和真实隔离服务，未调用生产远程模型；实际读屏输出、实体设备、整页缩放和远程供应商研究仍分别验收。操作系统终止进程或停止 Docker 可能使 teardown 无法执行，此时按失败附件中的本次项目名检查资源，不清理其他项目。
