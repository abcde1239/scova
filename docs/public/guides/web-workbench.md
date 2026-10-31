# Web 工作台

Scova 通过同源 Cookie 会话提供任务、收件箱和资料库。首版面向浏览器；桌面壳、本地一体化与完整实体移动端适配仍属后续范围。

## 当前功能

- 注册、登录、会话恢复、退出和账号偏好；四色主题、浅暗/系统与本地阅读设置。
- 任务列表、手工创建和编辑、自然语言可编辑草稿、周期与预算、暂停/恢复/归档。保存配置不会立即执行。
- 显式选择 demo/live 执行，查看 Run 历史、实时进度、覆盖缺口、预算、取消与重试。关闭页面不等于取消服务端 Run。
- 简报、证据引用、变化与报告历史，结果收件箱和站内通知，独立管理已读状态。
- 可撤销反馈及已交付效果、来源收藏、纯文本笔记、来源快照与历史、当前账号已存资料搜索。搜索资料库不会联网研究。
- 报告内证据问答；后续研究须再次明确确认，建立独立关联执行并沿用原版本、模式和预算。

生产报告当前呈现简报。主题清单、对比表和研究报告已有独立组件及测试入口，统一切换由 [#27](https://github.com/abcde1239/scova/issues/27) 跟踪。图片组件目前用于受控样例，生产 DTO 没有媒体字段，缺图保持纯文字。完整业务旅程、视觉/键盘与浏览器 CI/ready 门禁继续独立验收；专项测试通过不代表整个 MVP 已完成。

## 开发与验证

在仓库根运行：

```sh
vp install
vp run dev
```

API/Worker、数据库、Redis 与搜索配置见[部署指南](deployment.md)。开发代理将 `/api/v1` 转发至本地 API；浏览器始终通过同源会话通信。缺少远程模型时草稿可手工编辑、报告问答明确提示不足；live 不自动切换为演示。

```sh
vp check
vp test
vp run web#build
vp run test:e2e tests/e2e/shell.spec.ts
```

生产构建只有正常应用入口，样例与三种报告测试 HTML 仅在 test 构建生成。浏览器安装、领域配置、隔离全栈环境及证据边界见[浏览器测试](../reference/browser-testing.md)。实体设备、读屏和真实远程模型需分别验证。

## 开发和视觉参考

- [目录、Vue 与通信约定](../reference/frontend-conventions.md) · [路由](../reference/frontend-routing.md) · [会话](../reference/frontend-session.md) · [事件流](../reference/frontend-run-events.md)
- [视觉决策](../reference/frontend-visual-review.md) · [字体与阅读](../reference/frontend-fonts.md) · [图标](../reference/frontend-icons.md) · [响应导航](../reference/frontend-responsive.md)
- [局部玻璃与降级](../reference/frontend-glass.md) · [基础视觉检查](../reference/frontend-visual-foundation.md) · [来源图片样例](../reference/source-images.md) · [媒体契约边界](../reference/frontend-media-contract.md)

界面按用途选择字体，留出阅读空间，避免重复说明填充空隙。尺寸默认 rem，容器弹性重排，px 仅用于必要例外；普通内容、操作、输入与禁用状态各有明确光标。视觉参数变化须检查浅暗主题、窄屏、200%文字、键盘焦点和加载/空/错误状态。
