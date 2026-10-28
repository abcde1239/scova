# Scova 后端接口测试用例

## Overview

- **Feature**：Scova 基础后端接口与持久化边界
- **Requirements Source**：`docs/scova-prd.md`、GitHub Issues #4、#5、#8、#10、#12、[#30：Elysia 与 Swagger 中文接口文档](https://github.com/abcde1239/scova/issues/30)、`docs/public/reference/data-model.md` 与 `architecture.md`
- **Runtime**：Bun 为主运行时；Node.js 兼容执行；PostgreSQL 为事实数据库；Redis + BullMQ 为队列基础设施
- **Test framework**：Vitest（纯逻辑）；真实 PostgreSQL/Redis 集成测试；后续 API 契约测试可用 Elysia 注入请求
- **Test Coverage**：共享 DTO/错误协议、Swagger/OpenAPI 中文注释、数据库隔离/约束、Cookie 会话、任务版本、幂等 Run 与队列租约
- **Last Updated**：2026-10-24

## 执行约定

1. 测试环境使用独立 PostgreSQL 数据库、Redis 实例和 BullMQ 队列；不得连接开发者个人数据库。
2. 每个请求都通过 Elysia 应用测试入口执行；不得绕过路由直接调用 handler 验证 HTTP 行为。
3. 成功响应使用对应 DTO 的普通 JSON（无响应体的成功状态除外），不强加 `code/message` 包装；错误响应检查 `code`、`message`、`requestId`，字段校验错误另外检查 `fieldErrors` 的路径和中文可读性。保留真实 HTTP 状态。
4. Swagger/OpenAPI 必须由实际 Elysia 路由生成，接口说明、参数、状态码和 schema 描述使用中文；文档中的路径和响应 schema 必须与运行时契约一致。
5. 测试数据使用两个租户（`userA`、`userB`）和至少两个任务；测试结束销毁租户、队列 job 和临时数据库。

## Test Case Categories

### 1. Functional Tests

#### TC-F-001：共享任务配置 DTO 可跨工作区编译

- **Requirement**：Issue #4；PRD US-01
- **Priority**：High
- **Preconditions**：`packages/models` 已定义 Task/TaskVersion/Run 的输入和输出 schema；apps/server、apps/worker、apps/web 引用同一包。
- **Test Steps**：
    1. 使用 `vp test packages/models/tests/contracts.test.ts` 编译并执行契约测试。
    2. 分别从 API、worker、web 的 TypeScript 入口导入同一 DTO。
    3. 对合法任务配置运行运行时解析。
- **Expected Results**：
    - 三个工作区使用同一字段名、枚举和值域，不存在重复接口定义。
    - 合法配置解析成功，输出不包含数据库实体内部字段。
- **Postconditions**：无持久化数据。

#### TC-F-002：错误响应协议和字段定位

- **Requirement**：Issue #4；架构 §7
- **Priority**：High
- **Preconditions**：Elysia API 已注册统一错误处理器。
- **Test Steps**：
    1. POST 一个缺少 `target` 的任务配置。
    2. POST 一个 `budget.searches=0` 的配置。
    3. 读取错误响应 JSON 中的 `requestId`；若实现额外提供追踪响应头，核对其与响应体一致。
- **Expected Results**：返回 contracts/OpenAPI 约定的校验错误 HTTP 状态（本用例按 400 验收）；`code` 稳定可枚举；`fieldErrors` 指向实际 schema 的目标或预算字段；`message` 为中文；每次错误响应有非空 `requestId`。不得用 HTTP 200 包装错误。
- **Postconditions**：请求不创建 Task 或 TaskVersion。

#### TC-F-003：Swagger/OpenAPI 中文文档与路由一致

- **Requirement**：Issue #30；Issue #4 的共享 schema
- **Priority**：High
- **Preconditions**：Elysia Swagger 插件已启用，API 在测试端口启动。
- **Test Steps**：
    1. GET `/swagger/json`（或项目约定的 OpenAPI JSON 地址）。
    2. 检查已交付路由均存在；在 #8、#10、#12 完成后分别核对认证、任务、执行路由。尚未实现的领域不应伪造为可用端点。
    3. 对每个 operation 检查 `summary`/`description`、参数、请求体、2xx/4xx/409 响应 schema。
    4. 将 OpenAPI schema 与 contracts 的 schema 快照比较。
- **Expected Results**：
    - 文档可解析，路由无重复 operationId。
    - 面向用户的说明和字段描述包含中文，且不泄漏密码、token、内部 checkpoint 字段。
    - 文档声明的响应状态码和 schema 与 Elysia 实际响应一致。
- **Postconditions**：只读。

#### TC-F-004：注册、登录、当前用户和注销

- **Requirement**：Issue #8；PRD US-05
- **Priority**：High
- **Preconditions**：PostgreSQL 已迁移；注册功能开启；Elysia auth 路由可用。
- **Test Steps**：
    1. POST `/api/v1/auth/register` 创建 `userA`。
    2. POST `/api/v1/auth/login`，保存 HttpOnly Cookie。
    3. GET `/api/v1/me`。
    4. POST `/api/v1/auth/logout`，再次 GET `/api/v1/me`。
- **Expected Results**：注册和登录返回文档约定的 201/200 及普通 JSON；会话 Cookie 只携带不透明随机 token，不携带密码或用户敏感资料，数据库仅保存 token hash；Cookie 为 HttpOnly、SameSite=Lax，生产为 Secure；`/me` 返回用户 ID、邮箱、默认时区和提醒偏好；注销后返回 401。
- **Postconditions**：测试会话撤销。

#### TC-F-005：用户偏好保存和配置版本快照

- **Requirement**：Issue #8、#10；数据模型 User/TaskVersion
- **Priority**：High
- **Preconditions**：`userA` 已登录。
- **Test Steps**：
    1. PATCH `/api/v1/me/preferences` 设置 `Asia/Shanghai` 和提醒偏好。
    2. POST `/api/v1/tasks` 创建任务。
    3. 读取任务当前版本。
    4. 修改用户默认时区，再读取任务版本。
- **Expected Results**：偏好更新成功；创建的 TaskVersion 固化保存时的配置和时区；修改用户默认值不追溯修改已保存版本。
- **Postconditions**：任务可归档。

#### TC-F-006：创建任务生成不可变版本

- **Requirement**：Issue #10；PRD US-01
- **Priority**：High
- **Preconditions**：`userA` 已登录；配置通过 contracts 校验。
- **Test Steps**：
    1. POST `/api/v1/tasks` 创建主题、来源偏好、预算和 weekly schedule。
    2. GET `/api/v1/tasks/{id}`，记录 `revision=1` 和 `currentVersionId`。
    3. 使用当前 revision 的 `If-Match` PATCH 仅修改标题。
    4. GET 旧版本和当前版本。
- **Expected Results**：创建产生 Task + TaskVersion；旧版本内容不变；新版本递增；Task 指向新版本；仅改标题不改变语义比较范围。已有 Run 的版本冻结由 TC-ST-006 验证。
- **Postconditions**：保留两个版本供后续测试。

#### TC-F-007：If-Match 防止并发编辑覆盖

- **Requirement**：Issue #10；架构 §7
- **Priority**：High
- **Preconditions**：任务 revision 为 2。
- **Test Steps**：
    1. 两个客户端读取 revision=2。
    2. 客户端 A 带 `If-Match: 2` 更新任务。
    3. 客户端 B 仍带 `If-Match: 2` 更新任务。
- **Expected Results**：A 成功并生成 revision=3；B 返回 409 `edit_conflict`，包含当前 revision/资源摘要；B 的字段不覆盖 A。
- **Postconditions**：任务内容等于 A 的更新。

#### TC-F-008：立即执行创建 Run、幂等记录和 Outbox

- **Requirement**：Issue #12；PRD US-02
- **Priority**：High
- **Preconditions**：`userA` 有 active Task，Redis/BullMQ 可用。
- **Test Steps**：
    1. POST `/api/v1/tasks/{id}/runs`，携带稳定 `Idempotency-Key`。
    2. 查询 Run、IdempotencyRecord、Outbox 和 BullMQ job。
    3. 使用相同 key 重发完全相同请求。
- **Expected Results**：第一次原子创建一个 Run 和一个 Outbox 事件，dispatcher 最终至少一次投递 `run-{uuid}` job；第二次返回相同 Run，不新增业务记录。队列重复投递不重复执行业务交付，不要求投递过程 exactly-once。
- **Postconditions**：清理队列 job。

#### TC-F-009：同任务活动执行互斥、不同任务可并行

- **Requirement**：Issue #5、#12；PRD US-02
- **Priority**：High
- **Preconditions**：`userA` 有 Task A、Task B。
- **Test Steps**：
    1. 并发触发 Task A 两次。
    2. 并发触发 Task B 一次。
    3. 查询活动 Run 和数据库索引结果。
- **Expected Results**：Task A 只有一个活动 Run，第二次立即执行返回同一 Run；Task B 可创建独立 Run；数据库唯一索引直接拒绝第二个活动 Run，服务层将竞态转换为既有 Run 的幂等结果。
- **Postconditions**：所有 Run 进入可清理终态。

#### TC-F-010：取消、重试和队列重复投递

- **Requirement**：Issue #12；PRD US-02
- **Priority**：High
- **Preconditions**：Run 处于 queued/running；BullMQ 可模拟重复投递。
- **Test Steps**：
    1. POST `/runs/{id}/cancel`。
    2. 重复投递相同 job。
    3. 对终结失败 Run POST `/runs/{id}/retry`。
    4. 查询父子 Run、报告和提醒。
- **Expected Results**：取消在 Run 行锁下先提交取消请求并产生事件后，该 Run 不再交付报告；若交付先提交则返回已完成的事实，不追溯删除报告；重复 job 不重复执行业务交付；retry 创建带 `parentRunId` 的新 Run，原 Run 历史不变。
- **Postconditions**：父子 Run 均可审计。

### 2. Edge Case Tests

#### TC-E-001：时区和计划边界

- **Requirement**：Issue #4、#10 的输入校验；Issue #3、#18 的 DST/调度行为；PRD US-01/02
- **Priority**：High
- **Preconditions**：任务使用 IANA timezone。
- **Test Steps**：分别提交空时区、`Asia/Shanghai`、DST 缺失时刻、DST 重复时刻和非法 timezone。
- **Expected Results**：合法时区保存；非法时区返回 400 字段错误；缺失时刻按文档顺延；重复时刻只生成一次 occurrence；不使用服务器本地时区替代任务时区。

#### TC-E-002：预算边界和计费累计

- **Requirement**：Issue #4、#12；PRD US-03
- **Priority**：High
- **Preconditions**：contracts 明确最小/最大预算，部署配置声明硬上限；默认值为 10 次搜索、20 次读取、5 分钟，不能把默认值自行等同所有部署的配置最大值。
- **Test Steps**：提交各预算字段的最小值减一、最小值、最大值、最大值加一；保存默认预算配置；在 Agent 预算测试中将调用计数推进到本 Run 固化上限，再尝试重试调用。
- **Expected Results**：越界值被拒绝并定位字段；边界值和默认值被接受；达到本 Run 上限后新调用不发出，Run 记录预算耗尽和已用量；重试计入累计预算。运行时预算行为在 #14 验证，本批接口只验证输入和快照。

#### TC-E-003：幂等 key payload 冲突

- **Requirement**：Issue #4、#12；架构 §7
- **Priority**：High
- **Preconditions**：已有一条成功 IdempotencyRecord。
- **Test Steps**：在相同用户、路由/资源和动作作用域内，用相同 key 提交不同的合法 payload；另用相同 key 对不同任务的作用域发起合法请求。
- **Expected Results**：同作用域 payload 冲突返回 409 `idempotency_conflict`，不创建第二个 Run/Outbox，错误含本次 `requestId`；不同资源作用域互不冲突。原 `resourceId` 是否返回以 contracts 为准，不强加额外泄漏字段。

#### TC-E-004：空集合和分页边界

- **Requirement**：Issue #4、#10
- **Priority**：Medium
- **Preconditions**：账号没有任务或只有一条任务。
- **Test Steps**：请求空任务列表、`limit=0`、超过 contracts 最大 limit、非法/过期 cursor 和最后一页 cursor。
- **Expected Results**：空集合返回普通 JSON 列表 DTO；非法参数按已冻结 contracts 返回字段错误；有效 cursor 不重复或遗漏记录，末页的后续游标为空；不会泄漏其他账号数据。采用游标分页，不引入 offset 协议。

#### TC-E-005：数据库唯一键竞态

- **Requirement**：Issue #5、#12
- **Priority**：High
- **Preconditions**：两个 API 请求同时创建相同报告/提醒或同一 occurrence。
- **Test Steps**：使用 barrier 并发提交两个事务。
- **Expected Results**：一个事务成功，另一个得到可转换的幂等结果或明确 409；无重复 Report、Notification、ScheduleOccurrence；事务不留下半成品。

#### TC-E-006：Swagger schema 安全边界

- **Requirement**：Issue #30；Issue #4、#8
- **Priority**：High
- **Preconditions**：OpenAPI JSON 可访问。
- **Test Steps**：递归扫描所有 request/response schema 和 example。
- **Expected Results**：响应 schema 和任何 example 不包含 `passwordHash`、真实 session token、CSRF secret、checkpoint 原文或数据库连接串；注册/登录请求允许声明密码输入字段并使用虚构示例；中文注释存在；内部错误堆栈不进入 example。

### 3. Error Handling Tests

#### TC-ERR-001：重复邮箱和登录失败限流

- **Requirement**：Issue #8；架构 §8
- **Priority**：High
- **Preconditions**：`userA@example.com` 已注册。
- **Test Steps**：重复注册；连续提交错误密码直到超过限流阈值。
- **Expected Results**：重复注册返回统一 409/字段错误且不暴露密码信息；超过阈值返回 429，带 Retry-After；日志不记录密码或 token。

#### TC-ERR-002：未认证、过期会话和注销后请求

- **Requirement**：Issue #8
- **Priority**：High
- **Preconditions**：准备无 Cookie、过期 Cookie、已撤销 Cookie。
- **Test Steps**：分别访问 `/me`、任务列表和执行控制接口。
- **Expected Results**：统一返回 401；不创建数据库写入；Swagger 声明 401 响应。

#### TC-ERR-003：跨账号资源访问

- **Requirement**：Issue #5、#8、#10、#12；PRD 数据隔离指标
- **Priority**：High
- **Preconditions**：`userA` 拥有任务、版本、Run、报告；`userB` 已登录。
- **Test Steps**：B 读取、修改、执行、取消 A 的资源，并提交 A 的版本/证据 ID。
- **Expected Results**：跨账号资源操作统一返回 404，不暴露资源存在性；数据库复合外键拒绝跨 owner 关联；不产生错误归属 B 的业务资源。拒绝访问可产生脱敏安全审计，不能据此要求没有审计记录。

#### TC-ERR-004：CSRF/Origin 防护

- **Requirement**：Issue #8；架构 §8
- **Priority**：High
- **Preconditions**：写请求需要 Cookie 会话。
- **Test Steps**：缺少 CSRF、错误 Origin、正确 CSRF+Origin 分别提交注册偏好、任务编辑和取消请求。
- **Expected Results**：前两者返回 403，不改变数据；正确组合成功；GET 不被错误拦截。

#### TC-ERR-005：Redis/BullMQ 暂时不可用

- **Requirement**：Issue #12；PRD US-02
- **Priority**：High
- **Preconditions**：API 可连 PostgreSQL；停止 Redis。
- **Test Steps**：提交立即执行、取消和重试请求；恢复 Redis 后再次触发 dispatcher。
- **Expected Results**：数据库事务不回滚已提交的 Run/Outbox；已接受请求返回 202 等契约约定的排队状态，不能暗示尚未提交或已完成交付；恢复后最终投递，允许至少一次重复投递但不产生重复 Run 或业务交付。

#### TC-ERR-006：请求超时或客户端中断

- **Requirement**：Issue #4、#12；架构 §7
- **Priority**：Medium
- **Preconditions**：handler 在事务提交前后分别设置延迟。
- **Test Steps**：客户端在提交前断开，再在提交后断开；使用 AbortSignal。
- **Expected Results**：数据库事务原子完成或回滚，不出现半个 Run/Outbox；客户端断开不被当作服务端必已取消的证明。相同 key 重发取得同一已提交 Run，提交后 Run 可由 worker 继续；不重复业务交付。外部调用不保证 exactly-once。

#### TC-ERR-007：数据库约束拒绝非法关联

- **Requirement**：Issue #5
- **Priority**：High
- **Preconditions**：准备跨 userId 的 TaskVersion、Run、Evidence 和 ClaimEvidence 请求。
- **Test Steps**：直接通过 API 和受控 migration test 尝试写入非法组合。
- **Expected Results**：API 返回可读的 4xx；数据库复合外键拒绝写入；事务整体回滚；错误不暴露 SQL 或连接信息。

#### TC-ERR-008：Swagger 路由或 schema 生成失败

- **Requirement**：Issue #30
- **Priority**：Medium
- **Preconditions**：启动 API 时注入重复 operationId 或未注册 schema。
- **Test Steps**：启动测试应用并请求 OpenAPI JSON。
- **Expected Results**：启动检查失败并指出中文 operation/schema 名称冲突；CI 不允许带无效 OpenAPI 的构建通过；生产 API 不静默提供不完整文档。

### 4. State Transition Tests

#### TC-ST-001：Task 状态 active → paused → active → archived

- **Requirement**：Issue #10、#12；PRD US-02
- **Priority**：High
- **Preconditions**：任务 active，无活动 Run。
- **Test Steps**：暂停任务；尝试周期触发；恢复任务；归档任务；再次尝试编辑和执行。
- **Expected Results**：paused 阻止新 occurrence 但保留历史；恢复后按 scheduleRevision 生成后续 occurrence；archived 拒绝新编辑/执行并保留历史报告。

#### TC-ST-002：Run queued → running → cancel_requested → canceled

- **Requirement**：Issue #12
- **Priority**：High
- **Preconditions**：Run 已入队，worker 可控。
- **Test Steps**：领取 Run；提交取消；模拟工具尚未完成和完成后迟到写入。
- **Expected Results**：状态按顺序变化；取消锁和租约生效；迟到 worker 写入被 fencing 拒绝；无 Report/InboxItem 交付。

#### TC-ST-003：Run failed → retry queued

- **Requirement**：Issue #12；PRD US-02
- **Priority**：High
- **Preconditions**：Run 以可重试临时错误终结。
- **Test Steps**：提交 retry；检查 parentRunId、deadline 和预算快照；重复提交相同 retry key。
- **Expected Results**：生成一个新 Run 并关联父 Run，保留父 Run 的配置版本及预算；新 Run 按自身首次开始时间计算新 deadline。恢复同一个未终结 Run 才要求 deadline 不重置；重复 retry 返回同一子 Run；原失败 Run 不被覆盖。

#### TC-ST-004：租约 epoch 接管与旧 worker fencing

- **Requirement**：Issue #12；架构 §4
- **Priority**：High
- **Preconditions**：worker A 持有 epoch 1，租约过期。
- **Test Steps**：worker B 接管并提升 epoch 2；A 尝试写 RunEvent、Evidence 和 Report；B 完成交付。
- **Expected Results**：A 的所有业务写入被拒绝；B 的 seq 单调递增且只交付一次；恢复计数和 lease epoch 可审计。

#### TC-ST-005：幂等请求提交中断与重放

- **Requirement**：Issue #4、#12
- **Priority**：High
- **Preconditions**：请求在事务提交后、响应返回前发生进程中断。
- **Test Steps**：重启 API；使用相同 idempotency key 重放请求；再使用不同 payload 重放。
- **Expected Results**：记录和业务写入同事务完成；相同 payload 返回原响应/资源引用，不同 payload 在同作用域返回 409；未提交的事务不会留下悬空记录。记录内部状态枚举以 contracts/数据实现为准，不凭测试发明 pending/completed/failed 状态机。

#### TC-ST-006：版本和 Run 的引用冻结

- **Requirement**：Issue #10、#12；PRD US-01
- **Priority**：High
- **Preconditions**：Run R1 使用 TaskVersion V1；任务已编辑产生 V2。
- **Test Steps**：执行 R1；读取 R1 的配置、comparisonScopeHash 和预算；查询当前任务版本。
- **Expected Results**：R1 始终使用 V1 快照；V2 只影响后续 Run；历史 Run 不被更新；Run 的有效比较范围按 V1 语义 hash 加固化 mode 计算，不要求与 TaskVersion 的 hash 字面相等。

## Test Coverage Matrix

| Requirement ID | Source                                            | Test Cases                                                     | Coverage Status                           |
| -------------- | ------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------- |
| REQ-API-001    | Issue #4：DTO、状态、错误和 SSE/HTTP 契约         | TC-F-001、F-002、F-003、E-004、E-006、ERR-002、ERR-006、ST-005 | ⚠ Partial：SSE/reset 与状态枚举非法值待补 |
| REQ-API-002    | Issue #30：Swagger/OpenAPI 中文注释和 schema 对齐 | TC-F-003、E-006、ERR-008                                       | ✓ Complete                                |
| REQ-DB-001     | Issue #5：账号复合隔离与外键                      | TC-F-009、E-005、ERR-003、ERR-007                              | ✓ Complete                                |
| REQ-DB-002     | Issue #5：活动 Run、报告、提醒、occurrence 唯一性 | TC-F-008、F-009、E-005                                         | ✓ Complete                                |
| REQ-AUTH-001   | Issue #8：注册/登录/注销/会话                     | TC-F-004、ERR-001、ERR-002                                     | ✓ Complete                                |
| REQ-AUTH-002   | Issue #8：CSRF、Origin、生产 Cookie 和限流        | TC-F-004、ERR-001、ERR-004                                     | ✓ Complete                                |
| REQ-TASK-001   | Issue #10：不可变版本、revision、If-Match         | TC-F-005、F-006、F-007、ST-006                                 | ✓ Complete                                |
| REQ-TASK-002   | Issue #10：时区、预算、分页和输入校验             | TC-E-001、E-002、E-004、F-002                                  | ✓ Complete                                |
| REQ-RUN-001    | Issue #12：立即执行、Outbox、BullMQ 与幂等        | TC-F-008、E-003、ERR-005、ST-005                               | ✓ Complete                                |
| REQ-RUN-002    | Issue #12：取消、重试、恢复、租约 fencing         | TC-F-010、ERR-006、ST-002、ST-003、ST-004                      | ✓ Complete                                |
| REQ-RUN-003    | PRD US-02：同任务互斥、不同任务并行               | TC-F-009、E-005                                                | ✓ Complete                                |

## Notes and Gaps

- 本文件是早期需求驱动的 QA 设计，“Complete”仅指表内测试设计映射，不等同于测试执行结果。当前后端已实现，业务迁移使用 Drizzle；具体覆盖以 `apps/server/tests/*.integration.test.ts` 和真实执行结果为准。
- 当前基线命令为 `vp check`、`vp test` 和 `vp run ready`；完整门禁已包含真实 PostgreSQL/Redis、HTTP 与后端集成测试，环境及命令见[后端验收](../docs/public/guides/backend-verification.md)。
- Swagger 从真实路由生成；通过 `vp run api:openapi:check` 校验文档与运行时契约一致。
- Redis 队列采用 BullMQ；Redis 只作队列/租约辅助，PostgreSQL 仍是执行事实源。测试必须分别注入数据库成功、队列失败和 worker 迟到三类故障。
- 真实 Tavily/模型服务不进入默认 CI；连接器烟测单独 opt-in。后端接口测试使用固定演示 provider 或可控 fake，避免费用和不确定网络响应。
- 实施依赖为 #2 → #3/#4 → #5 → #8 → #10 → #12；#30 依赖 #2/#4，接口实现需满足其文档门禁。#10 实际依赖 #8，不能与 #8 宣称并行完成；DST/计划 occurrence 属 #18，运行时预算属 #14，不计入本批基础 API 的已完成范围。
- 本文尚未为 SSE 事件版本/reset、全部 Run 终态转换、生产 Cookie 与 Node/Bun 进程启停提供完整可执行测试；后续必须补充，不能仅凭现有映射宣称完整 PRD 覆盖。
