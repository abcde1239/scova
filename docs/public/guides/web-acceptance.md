# Web 基础验收索引

基础验收覆盖账号与会话、任务与周期计划、执行和断线恢复、报告与引用、收件箱和通知，以及基础页面的响应式与辅助操作。运行步骤和完整依赖见[浏览器测试](../reference/browser-testing.md)；补充功能见[完整工作台验收](../reference/workbench-verification.md)。

## 可复现门禁

```sh
vp install --frozen-lockfile
vp run test:e2e:install
vp run verify:web
# 启动 compose.test.yaml 的专用测试服务，并提供 Bun、PG 备份工具后：
vp run ready
```

Linux 需安装 Chromium 系统依赖：`vp exec playwright install --with-deps chromium`。`verify:web` 使用随机隔离 Compose 项目，不连接既有部署数据；`ready` 还运行原后端与完整补充门禁，不能用前端通过代替后端服务验证。

| 范围         | 浏览器用例                         | 关键断言                                                                              |
| ------------ | ---------------------------------- | ------------------------------------------------------------------------------------- |
| 英语材料     | `two-rounds-english.spec.ts`       | demo 两轮交付与幂等；受控 live 免费变付费、转载、重复和排除；双方原文引用             |
| 招生         | `two-rounds-admission.spec.ts`     | 截止日期和语言要求变化、时区周期计划、第三轮 partial 不推进完整基线                   |
| 研究         | `two-rounds-research.spec.ts`      | 事实/推断/冲突/不足、修订与二手关系、重复与不完整覆盖                                 |
| 可靠性与隔离 | `browser-resilience.spec.ts`       | 关闭页面、暂停与 Worker 停止分别处理；真实断网、事件 N+1 回放/reset、取消及迟到旧 401 |
| 基础页面     | `base-pages-accessibility.spec.ts` | 六宽与根文字放大、浅暗、键盘注册/登录/任务/执行/报告/引用、忙碌零重复写               |
| 部署         | `environment.spec.ts`              | 真实同源 Cookie 与交付、专属资源、启动和中途失败清理                                  |

源文件均位于 `tests/e2e/`。命令日志、浏览器实际版本、各测试结果和清理附件保存在每次聚合的独立产物目录。浏览器 CI 执行完整聚合；预期失败 job 另验证错误传播与恢复构建。配置存在或部分测试通过，不代表某一提交的整体验收已经通过。

## 性能与证据边界

原 Server 基准继续由 `vp run test:e2e:backend` 验证：十个真实会话、每账号 20 个任务和 400 个 Run/Report/Inbox，四类列表预热后完整 HTTP 响应及 JSON 解析 p95 小于 500ms；持久 SSE 新事件在 2 秒内可读。测试输出运行时、平台、数据规模及实测值，详见[后端验证](backend-verification.md)。这与浏览器渲染、首屏或前端刷新耗时分别记录，不能互相替代。

受控 live 执行真实 API、Worker、Agent、账本、checkpoint、数据库和交付，固定 supplier 仅替代外部研究响应。demo 明确标记演示与覆盖缺口，不能用于证明连续领域比较。远程模型与公网供应商须显式配置后另做烟测，普通 CI 不消费生产密钥。

六宽和 200% 根文字检查不证明整页缩放或实体手机兼容。实际桌面读屏应核名称、顺序、状态、装饰图标零重复报读及纯图标命名，并记录工具、浏览器与构建。移动软键盘、安全区、旋转和移动读屏按[后续计划](../reference/mobile-acceptance-plan.md)分别验收；本地分发按[本地一体化计划](../reference/local-integration-plan.md)另行决策。
