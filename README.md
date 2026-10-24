# Scova · 知巡

Scova 是一个任务驱动的 AI 信息查阅与研究工作台：设置主题与查阅目标，由 Agent 搜索、阅读和查证，生成带引用的报告，并在后续执行中识别重复、新增与实质变化。适用主题包括学习、教育、行业动态和个人兴趣。

当前已建立 web/api/worker 与 contracts/agent-core/connectors 六个工作区，保留 utils 模板测试。Vue 页面、Bun/Elysia API（含 Node.js 兼容入口）和 worker 可独立启动；业务接口按 Issue 分期实现。

## 设计文档

- [系统架构与执行流程](docs/public/reference/architecture.md)
- [数据模型与一致性约束](docs/public/reference/data-model.md)
- [分期交付计划](docs/public/guides/delivery-plan.md)
- [三个任务的两次执行验收](docs/public/examples/two-run-scenarios.md)
- [harness 治理与验证](docs/public/reference/harness.md)
- [前端风格与 requestlane 通信约定](docs/public/reference/frontend-conventions.md)

## 环境与安装

使用 Vite+ 1.4.0；Node.js 与 pnpm 版本由根 `package.json` 声明，依赖通过 `vp install` 安装。治理工具需要独立 Bun >= 1.3.4 和 Git；Bun 作为运行时使用，项目依赖继续由 Vite+ / pnpm 管理。

```bash
vp install
docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait
vp run harness-lint
vp run harness-verify
```

`harness-lint` 只检查项目约定；`harness-verify` 检查约定并运行静态检查、测试和构建。当前 API 健康检查/中文 OpenAPI 与 utils 模板有测试，其余未实现模块不声明业务覆盖。

开发入口：`vp run dev` 启动 Vue；`vp run api#start` 使用 Bun，`vp run api#start:node` 使用 Node.js；`vp run worker#start` 启动 worker。API 提供 `/health`、`/swagger` 和 `/swagger/json`。

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

- Run the development server:

```bash
vp run dev
```
