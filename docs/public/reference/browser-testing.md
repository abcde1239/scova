# 浏览器测试

先运行 `vp install`，再运行 `vp run test:e2e:install` 安装锁定 Playwright 所需的 Chromium。Linux CI 需额外安装浏览器系统依赖（例如 `vp exec playwright install --with-deps chromium`）。浏览器安装与项目 npm 依赖是两步，不能仅安装 npm 包就认定浏览器可运行。

执行 `vp run test:e2e -- tests/e2e/shell.spec.ts`。配置会先构建真实 Web，再启动仅绑定回环地址的生产预览；测试结束清理该服务，不复用未知的已运行端口。失败截图及 trace 保存在忽略的 `artifacts/e2e/results`。输出打印实际 Chromium 版本。

当前仅覆盖工作台路由、刷新、未知路径、390 视口导航和键盘主内容焦点，不代表账号、研究旅程或完整视觉验收。成功冒烟也在各自结果目录保存桌面和窄视口截图。后续响应式及领域 spec 在各自 Issue 增加；测试配置扫描 `tests/e2e/**/*.spec.ts`，Vite+ 单元扫描与其隔离。

Harness 单独登记 `web-shell-e2e` 范围和默认关闭的 `web-shell-browser` 任务，不将它计入应用单元测试覆盖；该范围的 `requireConfiguredTask` 保持 false，任务为非必需，因此当前 `ready` 不运行浏览器。需要检查时直接使用上述 `test:e2e` 命令。后续 CI 与 ready 接入由 #86 交付，全栈服务 fixture 由 #81 交付；当前壳测试不是全栈门禁。生产代理的 SPA 回退仍需单独验证，本地 preview 的刷新成功不能代替部署检查。
