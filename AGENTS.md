<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Running Scripts

Run TypeScript and JavaScript files with `vpx <file>`, for example `vpx ./scripts/seed.ts --dry-run`. It handles enums, decorators, JSX, and tsconfig `paths`, so do not add `tsx` or `ts-node` to run scripts. `vpx --watch <file>` reruns the file when a file it uses changes, in place of `tsx watch`. `vp node <file>` runs plain Node.js.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

## Monorepo 协作

编码或系统设计前，若本地存在 `docs/overall/README.md`、`docs/overall/MEMORY.md`，先读取整体协作约定与项目记忆。跨应用、共享包或根工程的统一修改，应在 `docs/overall/cross-app-changes.md` 记录影响面、执行顺序和验证结果。

`docs/overall` 为私有开发资料目录，仅保留本地，不提交到公开 Git，也不从公开文档链接。所有工作完成后将通用经验合并至 `docs/overall/MEMORY.md`，重点总结开发过程与优化点。

## 前端与通信

前端代码风格以 community 为主要参照，遵循 `docs/public/reference/frontend-conventions.md` 的 Vue SFC、目录分层、命名与前端格式约定；格式仍由 Vite+ 管理。前后端 HTTP 统一使用 requestlane，SSE 通过同一 Fetch transport 的 native 入口在统一通信模块中桥接。页面不得另建 fetch/axios 请求层；Vue Query 管服务端缓存，Pinia 管客户端状态，保留 Scova 的同源 Cookie 会话。

## README 写作

所有 README 面向阅读和使用仓库或包的人，保持简洁、准确。按需要提供名称与简介、当前功能或状态、安装与快速开始、常用命令和文档入口；包级 README 聚焦用途、用法和验证。避免重复章节、模板占位、冗长约束和开发流水账，详细设计放在参考文档并链接。README 中的命令、路径与实现状态必须与代码一致，公开 README 不链接私有资料。

## 目录与后端分层

每个 `apps/*`、`packages/*` 工作区均以 `src` 保存源码，配置本工作区的 `@/* → ./src/*` 别名。应用内部使用 `@/`，跨包通过包名和 exports 引用；直接导出源码的共享包内部保留相对引用，避免消费方 TypeScript 将 `@/` 解析到错误工作区。Vite/Vitest 开启按导入文件解析 tsconfig paths；Node.js 入口通过 `vpx` 执行。

Web 的 `src/` 顶层目录仅用 `component`（仅 `.vue`：复用 UI、应用级 UI provider）、`layout`（应用页面外壳及其专用导航、菜单和面包屑）、`composable`（复用交互和响应式流程）、`utils`（通用辅助，以及按领域分组的纯函数、展示类型和静态配置）、`store`（Pinia 客户端状态）、`api`（requestlane、SSE 与接口契约适配）、`view`（页面）、`router`（Vue Router 装配、路由登记和元数据）。使用这些单数目录名；报告等专用辅助模块放在 `utils` 的对应领域子目录，不在 `component` 存放独立 `.ts` 文件，也不另设顶层目录。

Server 的 `src/` 顶层目录仅用 `repo`、`handler`、`service`、`model`、`utils`、`app`、`router`。调用链为 `main → app → router → handler → service → repo`：`app` 装配 Elysia、Node 适配和生命周期；`router` 声明接口与中文文档；`handler` 适配 HTTP/会话/响应；`service` 组织规则和事务；`repo` 执行 PostgreSQL/Redis 访问及队列投递；`model` 保存 Server 专用 schema 与框架契约注册；`utils` 仅放辅助代码。PostgreSQL 的 Drizzle schema、行类型、客户端和迁移统一放在 `packages/db`；共享 DTO 和事件 schema 由 `@scova/models` 管理，不在应用内复制。业务查询使用原生 Drizzle；历史 SQL 保持不可变，存量库接管先验证实际结构与迁移状态，不重置用户数据库。

Server 的 `handler/http` 放 Cookie、Origin/CSRF、会话桥接、请求体限制与 SSE 背压/心跳/连接清理，`repo` 包含 Redis 客户端适配及数据访问，`repo/queue` 放 BullMQ 发布、回补和维护操作；长期连接由 `app` 装配并关闭。Server 后台控制由 `app` 装配独立批次和资源，负责调度、Outbox 投递及可恢复 Run 回补，不暴露 HTTP 路由；停止先阻止新批次并等待在途工作，再关闭资源。

Worker 复用后端分层的实际子集，不建空 `router` 或 `model`：只消费 BullMQ 作业、管理执行并运行 agent-core，禁止周期调度、发布 Run 或扫描回补。`app/queue` 承载运行时消费适配，`handler` 接收作业，`service` 编排，`repo` 目前仍负责执行绑定的租约、工具账本、checkpoint 和交付。停止先中断并等待在途执行收敛，再释放消费者及执行依赖；导入模块不连接外部服务。队列确认不能视为 Agent 已完成执行。

以上限制只针对应用 `src/` 的一级目录，不限制层内按职责分组、工作区根级的测试/静态资源/工具配置，或 `src/` 顶层真实入口文件（如 Web 的 `main.ts`、`App.vue`、`main.css`、`env.d.ts`，后端的 `main.ts`、`node.ts` 及部署实际调用的健康检查/维护 CLI）。不给入口增加纯转发文件或空目录；如确需额外一级目录，在变更说明中写明现有层为何不适合、边界和使用方，并同步公开架构文档。
