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

Server 按 `main → app → router → handler → service → repo` 调用：`app` 装配 Elysia、Node 兼容层和生命周期；`router` 声明接口契约与中文文档；`handler` 处理 HTTP、会话与响应；`service` 组织业务规则与事务；`repo` 执行数据库和 Redis 访问；`utils` 仅放小工具。业务数据模型、Prisma schema 和迁移统一放在 `packages/db`，Server/Worker 通过 `@scova/db` 引用；公开 DTO 与事件 schema 仍由 `@scova/models` 管理。

Worker 按 `main/node → app → handler → service → repo + queue` 调用：app 管配置、依赖及串行循环，handler 是后台批次入口，service 编排租约与投递规则，repo 执行数据库 CAS，queue 适配 BullMQ。停止时先阻止新领取、等待在途批次，再关闭队列、Redis 和数据库；不在 service 或导入模块时连接外部服务。Worker 调用 agent-core，不能把队列投递或技术实验当作 Agent 已完成执行。
