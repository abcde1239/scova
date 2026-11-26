# 工程治理与验证

运行仓库的静态检查、测试和完整验证门禁，并管理验证产物。

Scova 使用 Vite+ 1.4.0 和 pnpm 工作区，依赖由 `vp install` 管理。Bun 是后端主运行时和治理工具运行时，Node.js 是后端兼容运行时，同时承载 Vite+ 工具链和 Reader 子进程。

## 快速开始

需要 Vite+、项目声明的 Node.js 和独立安装的 Bun >= 1.3.4。

```sh
vp install
vp run harness-lint     # 治理检查：测试布局、任务依赖和文档链接，不运行测试
vp run harness-verify   # 先执行治理检查，再逐项运行下表任务；别名 vp run ready
```

退出码：0 表示通过，1 表示规则或任务失败，2 表示配置或执行条件错误。请查看 JSON 里每个工作区和任务的状态，不要以外层命令成功代替覆盖判断。

## 验证任务

根级 `test:*` 入口由 `tests/tasks.ts` 定义，通过根 `vite.config.ts` 的 `run.tasks` 注册，调用方式为 `vp run test:<名称>`。这些任务关闭缓存，集成聚合会按顺序执行各套件，避免共享测试 Redis 的并发干扰。

| 任务            | 命令              | 覆盖范围                                                            |
| --------------- | ----------------- | ------------------------------------------------------------------- |
| static-check    | `vp check`        | 格式、lint、TypeScript 静态检查                                     |
| unit-tests      | `vp test`         | Web、会话、通信、领域逻辑、contracts、别名隔离、API、Agent 与共享包 |
| workspace-build | `vp run -r build` | 所有已登记工作区的构建和类型检查                                    |

其余必需任务：`runtime-bun`、`runtime-node`、`connectors-runtime`、`api-openapi`、`api-processes`、`backend-integration`、`web-browser-gate`、`web-workbench-gate`。

- **`web-deployment`** 是默认禁用的可选任务，需单独运行 `vp run test:deployment`，`ready` 不会执行它。
- **`web-browser-gate`** 依赖 `static-check`、`unit-tests`、`workspace-build` 和 `backend-integration`，通过 `vp run verify:web:browser` 运行浏览器门禁，详见[浏览器测试](browser-testing.md)。
- **`web-workbench-gate`** 依赖基础浏览器门禁，通过 `vp run verify:mvp:browser` 追加补充页面矩阵和完整用户旅程。独立的 `vp run verify:mvp-full` 先执行完整 `verify:web`，再追加同一阶段，供 Web CI 和单独验收使用。
- 任务图不包含 `ready`、`harness-lint` 和 `harness-verify`，避免递归。
- 暂无测试的工作区保持 `not-configured`，不代表业务验收通过。新建工作区或接入真实测试后，需同时更新 `harness.config.json`、框架扫描配置和真实测试任务。`covers` 只记录覆盖关系，不创建测试。

## 单元与集成测试

根 Vitest 只扫描 `apps/*` 和 `packages/*` 的 `tests` 目录下的 `*.test.ts` 和 `*.spec.ts`，排除产物、E2E 和 `*.integration.test.ts`。Vite 和 Vitest 用原生 `resolve.tsconfigPaths` 按导入文件解析工作区别名。

集成测试需要专用 PostgreSQL 和独立 Bun，完整后端门禁另需 Redis。`vp run test:integration` 串行运行：

- 数据库约束、认证、任务与执行接口。
- 实际 Agent 与报告交付、调度、反馈、通知和资料库。
- Outbox 与 Run 故障恢复、租约 fencing、取消，以及 Bun 和 Node 进程。

单独运行某个套件时，依次执行 `vp test --config tests/<suite>.vite.config.ts`，suite 取 `database`、`auth`、`tasks`、`runs`、`worker-outbox`。使用同一测试 Redis 的套件不要并行，也不能直接传入集成文件路径代替显式配置。

其他专项入口：

- **`vp run test:agent-recovery`**：用真实 PostgreSQL 的 checkpointer 和工具账本，验证 Node 和 Bun 在工具结果提交后、checkpoint 保存前被强杀并接管的恢复，覆盖预算用尽后复用成功结果、unknown 保留费用、旧 epoch 隔离和持久化操作 drain。
- **`vp run test:operations`**：维护集成。它已包含在 `test:worker` 里，根 `test:integration` 不再重复调用，可单独使用。

`packages-db` 的客户端单元测试由根 `vp test` 发现，迁移和数据库集成由 `backend-integration` 覆盖。

## 运行时与服务

`runtime-bun`（`vp run test:runtime`）和 `runtime-node`（`vp run test:runtime:node`）用真实 PostgreSQL 和 Redis 验证事务、队列、跨进程 checkpoint 恢复和 fencing。先启动测试服务：

```sh
docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait
```

没有服务时测试会明确失败，不会回退到内存。每次实验创建并清理独立的 schema 和命名队列，详见源码中的 `tests/runtime/README.md`。

[本地开发环境](../guides/local-development.md)使用独立的 `compose.local.yaml` 和根 `.env.local`，不能替代这些测试依赖。`compose.local.yaml` 和 `.env.local.example` 是公开配置，真实的 `.env.local` 仅保存在本地。`harness-lint` 本身不启动 Docker，也不调用搜索或模型。

## 验证产物

- 新的人工验收证据：用 Harness CLI 的 `artifacts create <名称>` 分配 `artifacts/runs/<id>/`，把报告、日志、截图和 trace 写入返回的目录。写完执行 `artifacts finish <id>`，需要长期引用时执行 `artifacts keep <id>`。`artifacts clean` 默认只预览清理范围。
- Playwright 和项目脚本沿用配置的输出路径，例如 `artifacts/e2e/`、`artifacts/verify-web/`、`artifacts/verify-mvp-full/`。历史快照放 `artifacts/snapshots/`。
- 验证步骤和长期摘要归文档，测试源码和夹具归项目的测试目录。
- `.harness/` 保存 Harness Kit 的托管清单、验证摘要、任务续作状态和托管 Hook，临时 JSON 放 `.harness/tmp/`。`artifacts/` 和 `.harness/` 均被 Git 忽略。
- `doctor` 和产物管理由已安装技能的 `scripts/harness.mjs` 提供：

```sh
node <技能目录>/scripts/harness.mjs <命令> --root <项目绝对路径> --json
```

## Harness CLI 快照

`scripts/vendor/harness-kit.mjs` 是 harness-kit 随附 CLI 的原样快照（schemaVersion 1，SHA-256 `cc523948f6244abe42aa0f7d6be4a5bf14c39c9547bd88e2b2a7322ef594e5e2`），只依赖 Bun 和 Git。`scripts/harness.mjs` 固定项目根、校验摘要，并按 `BUN_BIN`、用户目录下独立的 Bun、PATH 中的 Bun 的顺序选择 Bun。`BUN_BIN` 必须是可执行文件路径，不含命令参数。

更新快照时：

1. 比较上游内容，原样替换文件。
2. 更新包装器和本文的摘要。
3. 重新运行治理检查和验证。

只有该快照排除自动格式化和 lint。不要手工修补生成代码后沿用旧摘要。

Windows 上，包装器会从 PATH 找到原生 `vp.exe` 并放到子进程 PATH 首位，避免 Bun 把 pnpm 的 `.bin/vp` POSIX 脚本当成 Windows 程序启动。请让全局 Vite+ 保持在 PATH 中，配置里不要写开发者机器的绝对工具路径。

## 其他约定

- **提交钩子**：通过 `scripts/check-staged.mjs` 运行 `vp staged`，只允许检查工具更新原先选中的文件，额外改变的暂存范围会还原，工作区内容保留。钩子不执行完整治理或测试。
- **缓存**：治理脚本缓存关闭，确保每次读取 Git index。需要构建缓存时使用显式的 Vite task，不要缓存外层入口。
- **TypeScript**：根配置排除 `artifacts`、`.pnpm-store`、构建和覆盖率产物。

## 公开文档边界

根 README 和 `docs/public` 是公开文档入口，只链接公开文件。源码、项目配置、脚本、测试和工作流按配置中的明确路径进入公开 Git。PRD、memory、开发决策、验收过程、技能上下文和 harness 答案或计划只保留本地，由 `.gitignore` 排除。

- 仓库目前按 private 处理。`repository.visibility=public` 时，lint 还会检查已暂存和已跟踪文件的边界；公开前需要切换该配置并重新验证。
- 公开模式的检查基于 Git index。文件未暂存时 index 为空，通过不代表所有工作文件都已检查。新增文件请核对 `git status --short` 和 `git check-ignore -v <path>`。
- `.gitignore` 不能清除已跟踪的内容或历史。日常治理检查不含完整 Git 历史、托管平台资料或发布产物审计。

## CI

GitHub Actions 包含中文 OpenAPI、契约测试、API 进程启停和后端持久化恢复门禁，另有独立的 Web 浏览器任务和预期失败传播任务。运行完整 `ready` 的环境还需要锁定版本的 Chromium 及系统依赖、Docker Engine 和 Compose，以及后端测试服务。
