# 浏览器测试

运行 Web 的 Playwright 端到端测试和统一 Web 门禁。

## 快速开始

```sh
vp install
vp run test:e2e:install     # 安装锁定版本的 Playwright Chromium
vp run test:e2e --list      # 列出默认前端测试
vp run test:e2e             # 运行所有默认前端 spec（不含全栈环境）
vp run test:e2e tests/e2e/shell.spec.ts   # 只跑壳冒烟
```

- 浏览器安装与 npm 依赖是两步，只装 npm 包不能运行浏览器测试。
- Linux CI 还需安装系统依赖，例如 `vp exec playwright install --with-deps chromium`。

## 默认前端测试

默认配置先以 test 模式构建真实 Web，再由 `tests/e2e/serve.mjs` 在回环地址提供静态应用和受控会话样本，各 spec 按需提供接口样本。结束后清理服务，不复用未知的已运行端口。

- **覆盖范围**：壳测试覆盖工作台路由、刷新、未知路径、390 视口导航和键盘主内容焦点。成功的冒烟还会在结果目录保存桌面和窄视口截图。
- **输出位置**：失败截图和 trace 在 `artifacts/e2e/results`，每次运行的 JSON 报告（含成功用例的来源与清理附件）在 `artifacts/e2e/report.json`，二者都被 Git 忽略。下一次运行前请复制要保留的报告。输出会打印实际的 Chromium 版本。
- **隔离**：Vite+ 单元扫描与 Playwright 互相隔离。
- **API 代理**：普通样本使用 `.env.test` 的同源 `/api/v1`。只有 test 模式的 preview 会把该路径代理到 `127.0.0.1:4190` 的受控 API，浏览器不直接访问该端口，Cookie 和请求来源检查以页面源为准。生产 preview 不启用代理。运行默认样本时保持这一配置，不要注入跨源 API 地址。

## 全栈环境

需要 Docker Engine、Compose v2，并能拉取镜像和安装锁定依赖。

```sh
vp run test:e2e tests/e2e/environment.spec.ts
```

连续执行两次，验证真实的 Web 静态代理、API、PostgreSQL、Redis、Worker、迁移和交付。该命令自动选择全栈配置，不启动 Vite preview。

| 阶段              | 上限    |
| ----------------- | ------- |
| 镜像构建          | 15 分钟 |
| 依赖健康等待      | 90 秒   |
| 应用健康等待      | 120 秒  |
| 单次 Run 交付等待 | 90 秒   |

首次构建可能较慢。

- **隔离**：每个测试使用随机的 Compose 项目、独立的数据库和 Redis 卷、随机的业务 schema、图状态 schema、队列、端口和浏览器账号。
- **会话**：浏览器通过真实的注册接口建立同源 Secure/HttpOnly Cookie 会话，调用 `/me`，创建 Run 并读取交付后的报告。两个用户验证数据隔离。
- **地址**：不降低 Cookie 安全属性，浏览器地址使用 `http://localhost:<随机端口>`，不能改成 HTTP 的 `127.0.0.1`。
- **辅助函数**：`tests/e2e/support/environment.ts` 提供 `owner()`、`request()`、`task()`、`execute()` 和 `prepareDisplay()`，供领域 spec 复用。
- **确定性场景**：复用 Worker 的供应商 fixture，执行实际的 Agent、Reader、账本、检查点和交付路径。报告标记 `executed-supplier-fixture` 和 `remoteResearch: false`，三类 A/B 两轮结果的准备标记为 `prepared-display`。这不是远程模型或 Tavily 的研究成功。
- **凭据**：普通运行不需要生产凭据，不启用远程搜索服务，生产入口也没有测试开关。
- **清理**：测试结束以及启动或中途失败时，都会在 `finally` 中关闭浏览器上下文，对本次项目执行 `down -v --remove-orphans`，断言自身的容器、卷和网络已清空，并只移除本次生成的镜像标签。
- **强杀后的回收**：强制杀死进程或关闭 Docker 时清理不会执行。请从失败附件取得项目名，只检查和回收该项目的资源，不要清理其他项目或用户卷。

### 全栈领域 spec 与专用配置

- 全栈领域 spec 用 `SCOVA_E2E_FULL_STACK=1` 选择配置并传入具体 spec 路径。运行普通前端样本前请移除该变量，否则会关闭其静态服务。
- 专用配置按各自的 `testMatch` 执行：task-center 和 run-history 使用生产构建，execution 和 visual-foundation 使用 test 构建。
- 各配置会重建同一份 `apps/web/dist`，必须串行运行，切换前先停止上一个预览。
- 本地 preview 刷新成功不能代替生产代理的 SPA 回退检查，后者仍需部署检查。

## 统一 Web 门禁

```sh
vp run verify:web                  # 静态检查 + 单元测试 + 工作区构建 + 浏览器门禁
vp run verify:web:browser          # 只运行浏览器阶段
vp run verify:web:failure          # 失败传播检查，预期失败
vp node scripts/verify-web.mjs --plan
```

`verify:web` 依次运行全仓静态检查、单元测试和工作区构建，再运行浏览器阶段：

1. 普通样本 spec。
2. 四个专用配置，同一个 spec 不会在默认和专用配置里重复运行。
3. 隔离环境、英语、招生和研究两轮、账号与故障恢复、基础页面六种宽度及键盘 spec。基础主题、字体和透明层矩阵也在专用配置里。

全部进程退出、服务 teardown 后，会恢复生产 Web 构建。

- **`verify:web:browser`**：只运行同一个浏览器阶段，供 `ready` 的任务图复用，不重复静态检查和单元测试，也不调用 `ready`。
- **`verify:web:failure`**：运行真实隔离环境 spec，包含依赖启动和中途注入失败的清理断言。确认每项报告都记录本项目资源为空后，主动以非零退出验证外层失败传播。它预期失败，不能作为成功验收。CI 独立任务要求收到对应的失败标记，并确认环境阶段和恢复生产构建都成功；其他原因的失败同样会使 CI 失败。
- **补充矩阵**：`verify:mvp-full` 在基础检查之外串行追加补充页面矩阵和联合用户旅程；`ready` 通过 `web-workbench-gate` 追加同一阶段。

### 无障碍检查

`base-pages-accessibility.spec.ts` 在真实隔离服务中检查代表性工作台页面：交互元素的可访问名称、表单标签、`aria-hidden` 焦点隔离和非空状态播报。它用于防止回归，不能替代 NVDA、VoiceOver、TalkBack 的实际朗读，也不能替代实体设备验收。

### 输出与失败条件

每次聚合运行使用独立目录 `artifacts/verify-web/<时间与进程标识>/`，包含每个阶段的日志、JSON、失败截图、trace 和 summary，控制台和 summary 记录实际的 Chromium 版本。GitHub Actions 会上传该目录作为短期诊断，不上传私有开发文档或生产凭据。

以下情况会阻断门禁：退出码非零、零测试、跳过、flaky、全栈清理附件缺失、资源非空。

- 不要同时运行多个聚合入口，它们会共用同一份 `dist`。
- 这些门禁只运行受控浏览器样本和真实隔离服务，不调用生产远程模型。实际读屏输出、实体设备、整页缩放和远程供应商研究需另行验收。
- 进程被系统终止或 Docker 被停止时 teardown 可能不会执行，处理方式同上：按失败附件中的项目名检查资源，不清理其他项目。
