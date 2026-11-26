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

## Documentation and evidence

- Use `docs/public/` for published guides, reference material, and examples. Keep PRDs, decisions, and verification procedures or durable summaries in `docs/prd/`, `docs/decision/`, and `docs/verification/`, respectively. Keep these internal directories and `docs/overall/` local, and link to them only from internal material. See `docs/structure.md` for the local directory map and `.agent/guide.md` for shared collaboration and verification guidance when available.
- Store generated reports, logs, screenshots, and traces from ad hoc verification in one registered `artifacts/runs/<id>/` directory per work item. Use `harness artifacts create`, then `finish` after writing and `keep` before linking retained evidence. Keep Playwright and repository verification scripts on their configured output paths. Put temporary design drafts, HTML prototypes, and design review screenshots in the run’s `design/` directory. Keep maintained specifications in project documentation. Use `artifacts/snapshots/` for reviewed exports and `artifacts/archive/` for historical evidence.
- Keep `.harness/` for CLI state and managed hooks. Place temporary Harness JSON under `.harness/tmp/`. Keep executable tests and reusable fixtures in the framework's test directories.

## Web conventions and API access

Use the local frontend conventions (`docs/overall/dev-reference/frontend-conventions.md`) for Vue SFCs, naming, and directory responsibilities. Web API requests use the shared requestlane client in `apps/web/src/api/client.ts`. The Run SSE adapter uses the same Fetch transport through `native`, with explicit session, cancellation, and event validation. Keep page code on the shared API and composable entry points. Vue Query owns server data and caching, Pinia owns client state, and the app uses same-origin cookie sessions.

## README 写作

所有 README 面向阅读和使用仓库或包的人，保持简洁、准确。按需要提供名称与简介、当前功能或状态、安装与快速开始、常用命令和文档入口；包级 README 聚焦用途、用法和验证。避免重复章节、模板占位、冗长约束和开发流水账，详细设计放在参考文档并链接。README 中的命令、路径与实现状态必须与代码一致，公开 README 不链接私有资料。

## Scova verification

- Run `vp check` for static checks and `vp test` for the root unit suite. The root suite excludes browser E2E and `*.integration.test.ts`. Run integration suites through `vp run test:integration` with dedicated services or select the applicable `tests/*.vite.config.ts` with `vp test --config`. Use `vp run test:e2e` for the configured Playwright suite.
- Run `vp run harness-lint` for repository governance and `vp run ready` for the full configured gate. See the local verification reference (`docs/verification/testing.md`) for prerequisites and task coverage. The installed Harness Kit CLI supplies `doctor`, `check`, and artifact lifecycle commands.

## Runtimes and source layout

Bun is the default for Server and Worker development, startup, containers, and database migration. Use `vp run server#dev:node`, `vp run worker#dev:node`, or `vp run db:migrate:node` when validating the Node.js compatibility path. Vite+ and the Reader's Node subprocess have their own runtime boundaries. Verify backend runtime changes with both `vp run test:runtime` and `vp run test:runtime:node` when they cover the change.

Use the workspace `src/` directory for source and its local `@/*` alias for application imports. Import across workspaces through package exports. Source-exporting packages use relative imports internally so aliases do not resolve against a consumer workspace. Keep `resolve.tsconfigPaths` enabled for Vite and Vitest. Verify alias resolution against each package's declared source entry.

Web 的 `src/` 顶层目录仅用 `component`（仅 `.vue`：复用 UI、应用级 UI provider）、`layout`（应用页面外壳及其专用导航、菜单和面包屑）、`composable`（复用交互和响应式流程）、`utils`（通用辅助，以及按领域分组的纯函数、展示类型和静态配置）、`store`（Pinia 客户端状态）、`api`（requestlane、SSE 与接口契约适配）、`view`（页面）、`router`（Vue Router 装配、路由登记和元数据）。使用这些单数目录名；报告等专用辅助模块放在 `utils` 的对应领域子目录，不在 `component` 存放独立 `.ts` 文件，也不另设顶层目录。

Server 的 `src/` 顶层目录仅用 `repo`、`handler`、`service`、`model`、`utils`、`app`、`router`。调用链为 `main → app → router → handler → service → repo`：`app` 装配 Elysia、Node 适配和生命周期；`router` 声明接口与中文文档；`handler` 适配 HTTP/会话/响应；`service` 组织规则和事务；`repo` 执行 PostgreSQL/Redis 访问及队列投递；`model` 保存 Server 专用 schema 与框架契约注册；`utils` 仅放辅助代码。

`@scova/db` owns the PostgreSQL Drizzle schema, row types, client, and migrations. Use Drizzle for business queries and preserve historical SQL. Before adopting an existing database, verify its schema and migration history, then preserve user data throughout the adoption. Public DTOs and event schemas come from `@scova/models`. Server and Worker share their internal execution protocol, queue and lease types, and wire encoding through the subpath exports of `@scova/execution`.

Server 的 `handler/http` 放 Cookie、Origin/CSRF、会话桥接、请求体限制与 SSE 背压/心跳/连接清理，`repo` 包含 Redis 客户端适配及数据访问，`repo/queue` 放 BullMQ 发布、回补和维护操作；长期连接由 `app` 装配并关闭。Server 后台控制由 `app` 装配独立批次和资源，负责调度、Outbox 投递及可恢复 Run 回补，不暴露 HTTP 路由；停止先阻止新批次并等待在途工作，再关闭资源。

Worker 复用后端分层的实际子集，不建空 `router` 或 `model`：只消费 Run 作业、管理执行并运行 agent-core，禁止周期调度、发布 Run 或扫描回补。`app/queue` 承载运行时消费适配，`handler` 接收作业，`service` 编排，`repo` 通过 Server 的内部执行接口申请租约、持久化工具账本和 checkpoint、提交候选成果。Server 校验账号、租约和 epoch，执行交付事务。SQLite 队列经同一接口消费；Worker 生产代码不访问 PostgreSQL 或 SQLite 文件。停止先中断并等待在途执行收敛，再释放消费者及执行依赖；导入模块不连接外部服务。队列确认不能视为 Agent 已完成执行。

These layout rules govern the immediate subdirectories of application `src/` folders. Group related code within its layer and keep tests, static assets, and tooling configuration at the workspace level as appropriate. Web `main.ts` starts the recovery boundary and loads `bootstrap.ts`, which mounts Vue and loads the base CSS. Backend root entries include `main.ts`, `node.ts`, and the health and operations entry points used by deployment. Give each entry file a direct startup or tooling responsibility. If a new top-level directory is necessary, record its responsibility and callers, explain why the existing layers do not fit, and update the local architecture reference (`docs/overall/dev-reference/architecture.md`).

<!-- prettier-ignore-start -->

<!-- harness-kit:begin -->
## Project development and verification

- Use the project instructions already loaded by the host. Read additional instructions only when entering a new scope with undiscovered rules or when applicable instructions are missing from the current context. Avoid rereading files whose relevant contents are already available unless they changed. For missing collaboration or verification context, read .agent/guide.md if present, otherwise docs/agent_guide.md if present. Consult MEMORY.md only for missing, task-relevant context. Continue from public files when private material is absent.
- Keep this host entry concise. Put durable, actionable repository-wide agent rules here and narrower rules in the host's scoped instruction files. Record product requirements and feature acceptance criteria in project specs, architecture rationale in decision records, and task progress in task records. Point to relevant sources for on-demand reading without copying or automatically importing them. Add project-owned rules outside the Harness Kit markers.
- If docs/decision/coding-style/RULES.md exists, apply adopted rules within this task's scope; candidate rules are references only. Personal preferences do not override current user requirements, applicable instructions or existing tool configuration. Explain material conflicts.
- Use applicable installed Skills. If a task needs Harness Kit guidance that is missing from the current context, use the host's Skill mechanism to load it. Implement small changes directly; clarify scope and acceptance for complex work. Preserve frameworks and user edits.
- Use harness doctor for diagnosis, harness check for conventions and harness run for configured verification. If unavailable, verify the installation and selected Node.js/Bun runtime. Never report unrun, unconfigured, timed-out or skipped work as passed.
- Before generating logs, reports, screenshots, review mockups, or disposable prototypes, allocate an output directory with harness artifacts create. Keep accepted design specifications and maintained documentation assets in the project documentation. Reuse it across agents, finish it after writers stop, and keep it before linking durable evidence. Preview cleanup; apply it only when requested. Keep .harness for CLI state and managed Hook files. Put tests, fixtures, and snapshots in the framework test directories; keep test output in the framework output directory or a managed artifact run. Never add experimental Hook executables to .harness/hooks.
- For complex or cross-session work, use harness task start/resume/status to preserve goals, harness run --work ID to associate verification, harness task accept for checked criteria, and harness task finish only after completion gates hold.
- Delegate independent work only when authorized and real host tools are available. Give each subagent a name that identifies its responsibility, such as tester or checkout-frontend. Use the host’s name field when available; otherwise, include the label in the assignment. Provide goals, writable files, interface dependencies, applicable rules and verification commands. Assign one writer per shared file and independently check changes and evidence.
- Reproduce failures and distinguish implementation, configuration and environment causes before retrying. Report changes, actual outcomes and remaining blockers; refresh relevant evidence after project inputs change.
- Write maintained agent prompts and instructions in English. Use the requested language for each response or deliverable. Preserve source requirements, exact wording, code, and identifiers when carrying context forward. For observed agent behavior problems, assess context, tools, workflow, prompts and validation before adding a scoped rule.
- For public documentation, identify the intended reader. Cover supported product use, behavior, interfaces, and architecture relevant to that reader. Keep development history, internal decisions, work records, and repository-specific publication procedures internal. When both audiences need the same facts, write a standalone public explanation. Use descriptive headings and neutral prose with minimal personal pronouns. Before adding or editing a public page, identify its public path, reader, and applicable writing rules. Before finishing, reread the entire page and affected navigation as that reader. Verify changed claims, commands, and public links. For a public documentation audit, inventory and read every public page and report coverage and unresolved findings in internal records.
- After coding or system design, consolidate reusable project memory and applicability. Keep development lessons, decisions and verification records internal. Check actual artifacts and provenance separately before publication.
<!-- harness-kit:end -->

<!-- prettier-ignore-end -->
