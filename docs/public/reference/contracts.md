# @scova/contracts

Scova 的纯 TypeScript/TypeBox 接口契约。Web、API、worker 从本包导入同一份 schema 与 `Static` DTO，不导出 Prisma 实体、密码哈希、会话凭据、租约或 checkpoint。Bun 为主运行时，Node.js 可导入同样的模块。

## 输入、响应与校验

- 成功响应使用普通 JSON；列表为 `{ items, nextCursor }`，不增加固定 `data/code` 包装。
- 错误为 `{ code, message, requestId, fieldErrors? }`，HTTP 状态反映真实错误；字段路径是 JSON Pointer，根路径为 `/`。
- `parseContract(schema, input)` 返回 DTO 或抛出 `ContractValidationError`；`toResponse(requestId)` 生成标准错误体。不会隐式修剪文本、移除未知字段或接受客户端 `userId`。
- API 直接把导出的 schema 交给 Elysia `body/query/headers/response`；相同 schema 中保留中文 `description`，用于 OpenAPI/Swagger 生成。
- IANA 时区、HTTP/HTTPS URL、时间格式及修订头通过 TypeBox FormatRegistry 校验。固定时间先后、事实引用、变化双方证据、报告完整性等通过 TypeRegistry refinement 校验；Value 与 Elysia 的编译器执行同一规则。
- 必须导入可执行 schema，不能从 OpenAPI JSON 反序列化替代服务端 validator；JSON 文档展示结构与中文约束说明，自定义 refinement 的执行代码只保留在本包。

主要导出：`RegisterInputSchema`、`LoginInputSchema`、`PreferencesSchema`、`UpdatePreferencesInputSchema`、`UserSchema`、`SessionResponseSchema`；`TaskConfigSchema`、`CreateTaskInputSchema`、`UpdateTaskInputSchema`、`TaskSchema`、`TaskVersionSchema`；`RunSchema`、`ReportSchema`、`EvidenceSchema`、`ClaimSchema`、`ChangeRecordSchema`；`ApiErrorSchema`、`PageQuerySchema`、`pageSchema`。每个领域 schema 同时导出对应 DTO 类型。

预算 schema 仅限定正安全整数，不把产品默认值当成硬上限。部署者的上限通过 `createBudgetSchema(policy)` 生成同源运行时/文档 schema，默认值由 API 策略注入。URL 合法性不代替真实抓取时的 SSRF、DNS 和重定向检查，来源权限由领域服务校验。

## 修订与幂等

任务编辑发送 `If-Match: "3"`，读取时返回相同格式的 `ETag`；修订从 1 递增，最大为 JavaScript 安全整数。`RevisionHeadersSchema`、`revisionEtag` 和 `parseRevisionEtag` 执行相同边界检查，拒绝弱标签、裸数字和溢出。资源已变化时 API 返回 HTTP 409。

写命令发送 `Idempotency-Key`。`IdempotencyHeadersSchema` 校验格式；服务端仍需按当前用户、路由/资源及 payloadHash 持久化绑定，同一用户动作重发保持同一 key，同 key 不同 payload 返回 409。

## 持久化事件与 SSE

`RunEventSchema` 的结构为 `{ schemaVersion: 1, eventId, runId, seq, type, occurredAt, payload }`。`eventId` 是稳定 UUID，`seq` 是 Run 内从 1 严格递增的持久化序号。已覆盖架构要求的类型：

- `run.queued`、`run.started`、`run.recovering`；
- `step.started`、`step.completed`；
- `tool.started`、`tool.completed`、`tool.failed`；
- `budget.updated`、`coverage.updated`、`report.published`；
- `run.completed`、`run.failed`、`run.canceled`。

每种类型有独立 payload schema，拒绝未知结构版本、类型或混用 payload。事件只包含脱敏摘要、工具元数据和用量，不包括密钥、完整提示词、网页全文或思维链。SSE `id` 使用 `eventId`，客户端按它去重；服务端在当前已授权 Run 内将 `Last-Event-ID` 映射为 seq。`EventCursorQuerySchema.after` 支持显式序号回放，两种游标同时存在时必须指向同一位置，否则 API 拒绝，不静默选取。

游标早于保留范围时，发送 `SseResetControlSchema`：`{ schemaVersion: 1, type: "stream.reset", runId, payload: { reason: "cursor_expired", snapshot, resumeAfter } }`。这是传输控制帧，不入 RunEvent 表，不分配 `eventId/seq`，SSE 帧不得带 `id`，也不推进 `Last-Event-ID`。客户端替换快照、清理此前去重状态，再用 `after=resumeAfter` 重连；收到第一条新的持久化事件后更新 `Last-Event-ID`。`SseMessageSchema` 校验上述两类数据帧；15 秒心跳是 SSE 注释帧，不经过事件 schema。

服务端 `/api/v1/runs/:runId/events` 通过同源 Cookie 验证当前账号，每次最多读取 100 条事件，并从最后已发送 seq 查询下一页。`after` 只接受非负安全整数的十进制文本；超出最新序号或与可定位的 `Last-Event-ID` 不一致时返回 400。无法在当前 Run 定位的事件 ID、已删除历史前缀和序列缺口返回当前 Run 的 reset 快照后关闭，重连时移除旧 `Last-Event-ID`。本接口检测现存事件边界，不新增事件过期天数或删除策略。

流按客户端读取需求逐帧输出，单帧上限 64 KiB；无新事件时每 15 秒发送心跳，客户端 30 秒不继续读取则断开。会话撤销或到期、连接取消和服务停止都会终止查询并清理计时器。终态与事件上界在同一短数据库快照读取，全部终态事件发送完成后关闭连接。前端统一通信模块的接入与重连界面仍待后续交付。

schema 只能验证单帧结构，不能证明跨帧顺序或权限；API/客户端必须保证授权、事务分配 seq、先回放再续传、单调性和重连去重。部分执行只允许 `inconclusive` 或有不完整标记的变化结果；不完整报告必须包含 `limitations` 或 `coverage.gaps`，不推进基线。

## 验证

`vp test packages/contracts/tests/contracts.test.ts` 验证非法输入、边界、错误字段位置、TypeBox Value/Compiler 一致性、状态和证据语义、全部持久化事件及 reset 控制帧。真实 API/数据库/队列行为由对应后续 Issue 验证。

`vp run test:sse` 验证真实 PostgreSQL 回放、续传、reset、会话失效，以及 Bun/Node 的 socket 背压、取消与带活跃连接的优雅停止。
