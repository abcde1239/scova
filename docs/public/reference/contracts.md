# @scova/models

`@scova/models` 是 Scova 的纯 TypeScript/TypeBox 接口契约包。Web、API、worker 从本包导入同一份 schema 与 `Static` DTO，不导出数据库行实体、密码哈希、会话凭据、租约或 checkpoint。Bun 为主运行时，Node.js 可导入同样的模块。接口列表见 [API 文档](api.md)。

## 输入、响应与校验

- **成功响应**：普通 JSON；列表为 `{ items, nextCursor }`，不增加固定 `data/code` 包装。
- **错误**：`{ code, message, requestId, fieldErrors? }`，HTTP 状态反映真实错误；字段路径是 JSON Pointer，根路径为 `/`。
- **解析**：`parseContract(schema, input)` 返回 DTO 或抛出 `ContractValidationError`；`toResponse(requestId)` 生成标准错误体。不会隐式修剪文本、移除未知字段或接受客户端 `userId`。
- **与 Elysia 对接**：API 直接把导出的 schema 交给 Elysia `body/query/headers/response`；相同 schema 中保留中文 `description`，用于 OpenAPI/Swagger 生成。
- **格式与 refinement**：IANA 时区、HTTP/HTTPS URL、时间格式及修订头通过 TypeBox FormatRegistry 校验。固定时间先后、事实引用、变化双方证据、报告完整性等通过 TypeRegistry refinement 校验；Value 与 Elysia 的编译器执行同一规则。
- **使用方式**：必须导入可执行 schema，不能从 OpenAPI JSON 反序列化替代服务端 validator；JSON 文档展示结构与中文约束说明，自定义 refinement 的执行代码只保留在本包。

**主要导出**

| 领域       | 导出                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 账号       | `RegisterInputSchema`、`LoginInputSchema`、`PreferencesSchema`、`UpdatePreferencesInputSchema`、`UserSchema`、`SessionResponseSchema` |
| 任务       | `TaskConfigSchema`、`CreateTaskInputSchema`、`UpdateTaskInputSchema`、`TaskSchema`、`TaskVersionSchema`                               |
| 执行与成果 | `RunSchema`、`ReportSchema`、`EvidenceSchema`、`ClaimSchema`、`ChangeRecordSchema`                                                    |
| 通用       | `ApiErrorSchema`、`PageQuerySchema`、`pageSchema`                                                                                     |

每个领域 schema 同时导出对应 DTO 类型。

**预算与草稿**

- **预算 schema**：仅限定正安全整数，不把产品默认值当成硬上限。部署者的上限通过 `createBudgetSchema(policy)` 生成同源运行时/文档 schema，默认值由 API 策略注入。URL 合法性不代替真实抓取时的 SSRF、DNS 和重定向检查，来源权限由领域服务校验。
- **草稿**：`TaskDraftInputSchema` 与 `TaskDraftResponseSchema` 描述未保存的自然语言草稿。响应保留原文及完整配置，`mode` 区分模型和手工编辑，`manualReason` 提供脱敏回退原因；所有响应均要求再次确认。安全默认和建议计划通过 `warnings` 说明，`parsingUsage` 仅表示本次解析，不能作为任何 Run 的执行用量。

## 修订与幂等

- **修订**：任务编辑发送 `If-Match: "3"`，读取时返回相同格式的 `ETag`；修订从 1 递增，最大为 JavaScript 安全整数。`RevisionHeadersSchema`、`revisionEtag` 和 `parseRevisionEtag` 执行相同边界检查，拒绝弱标签、裸数字和溢出。资源已变化时 API 返回 HTTP 409。
- **幂等**：写命令发送 `Idempotency-Key`。`IdempotencyHeadersSchema` 校验格式；服务端仍需按当前用户、路由/资源及 payloadHash 持久化绑定，同一用户动作重发保持同一 key，同 key 不同 payload 返回 409。

## 持久化事件与 SSE

`RunEventSchema` 的结构为 `{ schemaVersion: 1, eventId, runId, seq, type, occurredAt, payload }`。`eventId` 是稳定 UUID，`seq` 是 Run 内从 1 严格递增的持久化序号。覆盖的事件类型：

- `run.queued`、`run.started`、`run.recovering`；
- `step.started`、`step.completed`；
- `tool.started`、`tool.completed`、`tool.failed`；
- `budget.updated`、`coverage.updated`、`report.published`；
- `run.completed`、`run.failed`、`run.canceled`。

**事件与游标**

- **payload**：每种类型有独立 payload schema，拒绝未知结构版本、类型或混用 payload。事件只包含脱敏摘要、工具元数据和用量，不包括密钥、完整提示词、网页全文或思维链。
- **游标**：SSE `id` 使用 `eventId`，客户端按该 ID 去重；服务端在当前已授权 Run 内将 `Last-Event-ID` 映射为 seq。`EventCursorQuerySchema.after` 支持显式序号回放，两种游标同时存在时必须指向同一位置，否则 API 拒绝，不静默选取。

**reset 控制帧**

游标早于保留范围时，发送 `SseResetControlSchema`：`{ schemaVersion: 1, type: "stream.reset", runId, payload: { reason: "cursor_expired", snapshot, resumeAfter } }`。

- 这是传输控制帧，不入 RunEvent 表，不分配 `eventId/seq`，SSE 帧不得带 `id`，也不推进 `Last-Event-ID`。
- 客户端替换快照、清理此前去重状态，再用 `after=resumeAfter` 重连；收到第一条新的持久化事件后更新 `Last-Event-ID`。
- `SseMessageSchema` 校验上述两类数据帧；15 秒心跳是 SSE 注释帧，不经过事件 schema。

**服务端行为**

- **读取**：`/api/v1/runs/:runId/events` 通过同源 Cookie 验证当前账号，每次最多读取 100 条事件，并从最后已发送 seq 查询下一页。`after` 只接受非负安全整数的十进制文本；超出最新序号或与可定位的 `Last-Event-ID` 不一致时返回 400。
- **reset 条件**：无法在当前 Run 定位的事件 ID、已删除历史前缀和序列缺口返回当前 Run 的 reset 快照后关闭，重连时移除旧 `Last-Event-ID`。本接口检测现存事件边界，不新增事件过期天数或删除策略。
- **流控**：流按客户端读取需求逐帧输出，单帧上限 64 KiB；无新事件时每 15 秒发送心跳，客户端 30 秒不继续读取则断开。会话撤销或到期、连接取消和服务停止都会终止查询并清理计时器。终态与事件上界在同一短数据库快照读取，全部终态事件发送完成后关闭连接。
- **前端**：通过统一 requestlane Fetch transport 的 native 入口接入，处理分片、重连、reset 与会话隔离。

**schema 的边界**：schema 只能验证单帧结构，不能证明跨帧顺序或权限；API/客户端必须保证授权、事务分配 seq、先回放再续传、单调性和重连去重。部分执行只允许 `inconclusive` 或有不完整标记的变化结果；不完整报告必须包含 `limitations` 或 `coverage.gaps`，不推进基线。

## 可撤销反馈

**接口**

- `POST /api/v1/feedback` 接受 `{ taskId, sourceId 或 claimId, kind }`，kind 为 `irrelevant/known/deeper`；恰选一种目标。资料必须曾在当前账号的当前任务被观测，结论必须属于该任务。
- 相同目标同种设置保持幂等，切换或重激活更新同一行；`DELETE /api/v1/feedback/:feedbackId` 逻辑撤销且重复撤销幂等。写操作要求同源会话与 CSRF。
- `GET /api/v1/tasks/:taskId/feedback` 返回 `{ items }`，仅列当前生效项；同一任务最多同时生效 200 条，超限返回 409。

**快照**

新 Run 在创建入队事务内冻结反馈，手动、周期和重试使用同一投影器。切换与撤销不修改已排队、执行中或恢复 Run 的快照；重试作为新执行捕获当前反馈。反馈不产生 TaskVersion、不清空比较基线、不重写历史报告或证据。

**作用**

`Report.feedbackEffects` 展示经本次实际计划、搜索和正文核验的作用：新发现排除、深入子查询、来源优先采集、未变结论降序和基线保护。

- 预算不足或未匹配目标会明确说明，不能把请求当作已执行。
- 基线来源始终参与复读；已了解只降低标记当时内容未变的重复结论顺序，保留引用，新值与重要条件变化继续正常比较。
- 结论级不相关只调整已确认未变结论的展示顺序，不把承载其他事实的整份来源拉黑。
- 当前生效反馈与历史报告保存的作用分别展示。
