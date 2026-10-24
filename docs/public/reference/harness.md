# 工程治理与验证

Scova 使用 Vite+ 1.4.0 与 pnpm 工作区。`pnpm-workspace.yaml` 是当前版本支持的工作区配置；Bun 是治理工具及后续服务的运行时，依赖继续由 `vp install` 管理。

## 命令

安装 Vite+、兼容项目声明的 Node.js 和独立 Bun >= 1.3.4 后运行：

```sh
vp install
vp run harness-lint
vp run harness-verify
```

`harness-lint` 检查工作区测试布局、任务依赖和验收文档链接，不运行测试；repository.visibility=public 时还检查 Git index 文件边界。仓库当前先采用 private，内部文档仍按约定仅保留本地；未来公开前需切换治理配置并重新验证边界。`harness-verify` 先执行同一治理检查，再逐项运行以下任务；`vp run ready` 是它的别名。

| 任务            | 命令              | 当前覆盖范围                            |
| --------------- | ----------------- | --------------------------------------- |
| static-check    | `vp check`        | 格式、lint、TypeScript 静态检查         |
| unit-tests      | `vp test`         | API 健康检查、OpenAPI 与 utils 模板测试 |
| workspace-build | `vp run -r build` | 所有已登记工作区构建/类型检查           |

根聚合测试只声明实际覆盖的工作区，没有额外配置相同的子任务，避免重复执行。暂无测试的工作区保持 `not-configured`；这不代表业务验收通过。新建工作区或接入真实业务测试后须同时更新 `harness.config.json`、框架扫描配置和真实测试任务；`covers` 只记录覆盖关系，不创建测试。

任务图中不包含 `ready`、`harness-lint` 或 `harness-verify`，避免递归。检查退出码：0 表示所请求门禁通过，1 表示规则或任务失败，2 表示配置或执行条件错误。查看 JSON 中每个工作区和任务的状态，不以外层命令成功替代测试覆盖判断。

根 Vitest 只扫描 `apps/*`、`packages/*` 的 `src`/`tests` 下 `*.test.ts` 和 `*.spec.ts`，排除产物及 E2E，避免临时验证快照中的测试被重复发现。脚本缓存关闭，确保治理命令每次读取当前 Git index；后续需要构建缓存时使用显式 Vite task，不能缓存外层治理入口。

## 工具可移植性

完整门禁还包含 `runtime-bun`（`vp run test:runtime`）与 `runtime-node`（`vp run test:runtime:node`），验证真实 PostgreSQL/Redis 的事务、队列、跨进程 checkpoint 恢复和 fencing。先运行 `docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait`；没有服务时明确失败，不回退内存。实验每次创建并清理独立 schema 和命名队列，详见源码中的 `tests/runtime/README.md`。

`scripts/vendor/harness-kit.mjs` 是 harness-kit 随附 CLI 的原样快照（schemaVersion 1，SHA-256 `cc523948f6244abe42aa0f7d6be4a5bf14c39c9547bd88e2b2a7322ef594e5e2`），仅依赖 Bun 和 Git，不依赖全局安装的技能。`scripts/harness.mjs` 固定项目根、校验摘要，并使用 `BUN_BIN`、用户目录下独立 Bun 或 PATH 中的 Bun。指定 `BUN_BIN` 时必须是可执行文件路径，不含命令参数。

更新快照时比较上游内容，原样替换文件，更新包装器和本文摘要，重新运行治理检查及验证。仅该快照排除自动格式化和 lint，项目自有包装器正常接受检查。不要手工修补生成代码再沿用旧摘要。

Windows 上包装器会从 PATH 定位原生 `vp.exe` 并放到子进程 PATH 首位，避免 Bun 将 pnpm `.bin/vp` 的 POSIX 脚本当作 Windows 程序启动。保持全局 Vite+ 在 PATH 中；不在配置里写开发者机器的绝对工具路径。

## 公开文档边界

根 README 和 `docs/public` 是公开文档入口，只链接公开文件。源码、项目配置、脚本、测试及工作流按配置中的明确路径允许进入公开 Git；本地环境、依赖和构建产物受内部规则保护。PRD、memory、开发决策、验收过程、技能上下文和 harness 答案/计划仅保留本地，并由 `.gitignore` 排除。

公开模式的 lint 会检查已暂存/跟踪内容。仓库尚无提交、文件未暂存时，index 为空，因此通过不意味着全部工作文件已接受发布检查；新增文件应核对 `git status --short` 和 `git check-ignore -v <path>`。私有源仓库的普通 lint 不执行公开 index 审计；可在独立测试快照中显式模拟公开模式验证文档保护。`.gitignore` 无法清除已经跟踪的内容或历史。日常治理检查不包含完整 Git 历史、托管平台资料或发布产物审计。

CI 在分期计划的交付阶段接入相同验证入口；当前尚未创建 GitHub Actions 工作流。
