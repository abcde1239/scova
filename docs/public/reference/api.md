# 中文接口文档

本文说明 Scova 后端 API 的启动与文档生成方式，并按资源列出各接口的请求约定、权限要求和限制。API 使用 Bun + Elysia，Node.js 通过官方适配器兼容；交互文档和契约来源见[接口契约](contracts.md)。

## 启动与文档生成

启动后访问 `/swagger` 查看交互文档，`/swagger/json` 获取 OpenAPI 3.1 JSON。

```sh
vp run server#start
# Node.js 兼容入口
vp run server#start:node
# 从真实 Elysia 路由生成中文接口文档
vp run api:openapi
# 检查已提交产物是否漂移
vp run api:openapi:check
```

- **生成产物**：根目录的 [swagger.json](../../../swagger.json) 是生成的 OpenAPI 3.1 文档，不手工编辑。
- **声明规则**：请求和响应引用 `packages/models` 的运行时 schema；路由使用中文 summary、description、tags 和唯一 operationId，DTO 字段均有中文说明。新增接口必须同时声明请求、成功/失败响应及必要的 Cookie、CSRF、幂等和修订版本头。
- **生成器校验**：中文说明、模型与 contracts 等价、引用可解析和 operationId 唯一。

容器运行、迁移及恢复见[部署维护](../guides/deployment.md)。

## 任务与草稿

**自然语言草稿**

- `POST /api/v1/task-drafts` 接收 `{ "inputText": "需求描述", "timezone": "Asia/Tokyo" }`，其中时区可省略。接口使用会话与 CSRF，返回原始描述、完整可编辑配置、`mode`、`requiresConfirmation: true`、警告和独立解析用量；不会保存任务或启用计划。
- 无模型、解析失败或超时会明确返回手工草稿，限流和基础设施错误仍使用真实 HTTP 状态。确认并编辑后通过 `POST /api/v1/tasks` 保存配置。

**需求澄清**

- `POST /api/v1/task-drafts/questions` 接收 `inputText`、可选 `timezone`、`clarifications: [{ question, answer }]` 和从 0 开始的 `round`（0–2）。
- 需求整理 Agent 根据原文与回答返回摘要、最多三个问题和待确认范围；末轮仅整理范围，需求明确时可提前结束。模型不可用或输出无效时明确返回 `mode: manual`。
- 问答与草稿生成共用原解析限流和预算，每请求最多两次模型尝试；不保存任务，不搜索网页。最终草稿请求可附带 `clarifications` 和经用户核对的 `searchScope`，服务端强制保留已确认范围。

**任务状态**

- `POST /api/v1/tasks/:id/pause`、`resume`、`archive` 使用会话、CSRF 和 `If-Match` 修订控制，返回任务详情和新 `ETag`。
- 暂停保留当前 Run，恢复仅安排未来周期时点；归档阻止新手动、重试和周期执行，并对当前 Run 请求取消。已完成幂等命令仍可重放原结果。

**执行历史**

`GET /api/v1/tasks/:taskId/runs` 返回当前账号指定任务的执行历史，按排队时间倒序游标分页，`limit` 最大 100。公开字段包含固定任务版本、模式、预算、状态和覆盖情况，不返回租约、checkpoint、工具正文或反馈内部快照。历史游标绑定账号、任务与数据库原始时间；Task、Report、Inbox 列表同样使用数据库微秒精度边界。

## 报告与收件箱

**读取**

- `GET /api/v1/reports` 支持任务筛选与游标分页，`GET /api/v1/reports/:id` 返回结构化结论、来源快照元数据和原文引用。
- `GET /api/v1/inbox` 分页读取收件箱，`PATCH /api/v1/inbox/:id` 以 `{ "read": true }` 标记已读，传 `false` 恢复未读；写请求仍需 CSRF。
- 报告读取保留演示模式、覆盖缺口和引用定位，完整网页正文及内部工具、checkpoint 不进入响应。

**覆盖与日期**

- `coverage.delivery` 可选，包含 `answered`（核心问题均有引用答案）、`partial`（部分问题有答案）、`sources_only`（仅来源资料）及问题计数；详情校验分类与保存的结论映射一致。该字段独立于 `coverage.completeness`、Run 状态和比较基线，旧记录可以缺省。
- 证据快照的可选 `sourceDates` 分别返回 `published`、`modified`，各含 `status`、`instant`、`value` 和 `precision`；`day`、`local` 精度的 `instant` 为 null，不伪造 UTC 时刻。日期来自本轮已保存的来源时间观测并重新校验，不采用模型猜测或更新时间替代发布时间。

**变化**

报告的 `changes` 使用同一组可访问证据：`oldEvidenceIds` 来自本次执行首次领取时固定的完整基线，`newEvidenceIds` 来自当前执行；两侧还须分别匹配变化记录的来源与快照。非法关联使整个详情返回 `409 INVALID_REPORT_EVIDENCE`。正文过期清理后仍可读取保存的引用片段和定位。

**通知**

`GET /api/v1/notifications` 按游标读取当前账号通知，可按 `kind`、`unread` 筛选；失败通知的 `reportId` 可为空，使用 `runId` 查看执行原因。`PATCH /api/v1/notifications/:id` 使用会话和 CSRF，以 `{ "read": true }` 标为已读，`false` 恢复未读；重复已读保留首次时间。通知和收件箱的已读状态相互独立。

## 报告证据问答

- **提问**：`POST /reports/:reportId/questions` 提交问题，`GET /reports/:reportId/questions/:questionId` 读取已保存回答。创建要求会话、CSRF 与稳定 `Idempotency-Key`，同键异问题返回 409；处理中重放返回 409 且不重复付费调用。
- **回答范围**：问答仅使用此报告内已授权引用，事实回答采用逐字原文摘录，每条带 `evidenceId/quote`；缺模型、缺资料或无效输出明确标记不足。问答使用独立 Redis 用户/全局请求与 token 额度，最多一次模型尝试，不调用搜索或网页阅读。额外资料应先进入受授权报告。
- **后续研究**：只有另行 `POST /reports/:reportId/questions/:questionId/followup` 并提交 `{ "confirm": true }` 才启动新研究。该接口要求 CSRF 与幂等键，仅接受真实报告，固定原报告的配置与预算；历史演示报告返回 409 LEGACY_DEMO_RUN，以问题为目标生成独立 Run；Task 锁内原子写入执行、事件、Outbox 和问题关联。
- **约束**：已有活动执行时返回 409，重复确认返回原关联执行。后续研究及其重试有独立比较范围，不覆盖原报告、任务配置或普通监控基线。取消及已撤销会话的晚返回不保存事实回答。

## 反馈

- **接口**：`POST /api/v1/feedback` 为指定任务的来源或结论设置 `irrelevant`、`known`、`deeper`；`DELETE /api/v1/feedback/:feedbackId` 撤销，`GET /api/v1/tasks/:taskId/feedback` 读取当前生效项。目标必须属于当前账号和任务，写请求需 CSRF。
- **快照**：新执行在 Task 锁内冻结反馈快照；恢复沿用快照，重试及明确确认的后续研究作为新执行捕获当时反馈。
- **作用**：反馈不改写历史报告、版本或普通比较范围，`Report.feedbackEffects` 解释实际生效情况；已了解不会遮蔽新值和重要变化。

## 资料库

- **接口**：`/bookmarks` 收藏列表/创建/取消、`/notes` 纯文本笔记创建/查询/编辑/删除、`/library/sources/:sourceId/snapshots` 历史及详情，以及 `/library/search` 隔离检索。
- **写入要求**：所有写接口使用会话与 CSRF；创建笔记要求稳定 `Idempotency-Key`，编辑和删除要求 `If-Match`。同键异参或旧修订返回 409，缺少命令头返回 428。取消收藏不删除来源、报告或引用。
- **历史正文**：只在保留期内返回，过期立即不读不搜；保存的原文片段、hash、定位和比较清单继续保留。历史快照按成功观测时间选择；列表游标保留 PostgreSQL 微秒精度并绑定账号与筛选范围。
- **搜索**：使用 PostgreSQL `simple` 全文索引，中文及字面词辅以受超时限制的子串召回，返回 `matchedBy` 和有界摘录，不抓取新 URL。

## 项目、工作流和私有报告资源

- **任务与项目归属**：`POST /api/v1/tasks/start` 使用任务配置和必需的 `Idempotency-Key` 创建未归类任务并排队一次执行，返回 `{ detail, runId }`。`GET /api/v1/tasks/:taskId/project` 返回当前归属，未归类时为 `{ project: null }`。对同一路径 `POST` 可为未归类任务原子创建项目并归类，若已有归属则返回 409。
- **项目**：`/api/v1/projects` 分页读取及创建项目。项目详情包含关联任务分页和最近执行、报告。使用 `PUT` 或 `DELETE /api/v1/projects/:projectId/tasks/:taskId` 关联、移动或解除关联。删除项目时保留任务、计划和历史成果。
- **工作流草稿**：`/api/v1/workflows` 管理工作流草稿。保存和发布使用 `If-Match`。新版画布用有向无环图保存节点及依赖，并单独保存坐标和分组。发布冻结图及研究任务版本，`/workflows/:workflowId/versions` 返回已发布版本。
- **工作流运行**：启动使用 `Idempotency-Key`。正式运行传入 `versionId`，试跑已保存的画布需指定 `draftRevision` 和 `preview: true`。`/workflow-runs/:runId` 返回归属当前账号的节点状态、成果、通知以及研究子执行标识。研究子执行继续提供原有 SSE。
- **模板**：`/api/v1/workflow-templates` 返回内置和个人模板。模板的启动与复制接口使用固定模板版本，复制会建立独立草稿。内置模板间的文件、模型和通知配置通过本次运行参数传入。
- **工作流通知**：`/api/v1/notifications` 同时返回研究通知和 `kind: workflow` 的站内通知。后者引用实际工作流运行，可附带交付节点标识。
- **报告图表**：报告的 `charts/source-hosts` 生成可读的来源分组数据和私有 SVG 下载，下载有效期 24 小时。

## 附件

**报告附件**

- `attachments` 接收 CSV、TXT、Markdown、JSON、TSV、PDF、PNG、JPEG 或 WebP 原始字节，文本使用 UTF-8，单件上限 10 MiB。
- 256 KiB 以内的附件保存在 PostgreSQL，其中文本支持按逻辑记录读取行号。超过 256 KiB 的附件存入私有 R2/S3，仅提供原件下载。未配置桶或存储暂不可用时返回 503。
- 解析失败仍保留原件。所有资源按报告和账号授权，删除后由 Server 回收无引用对象。

**项目会话附件**

`POST /api/v1/threads/:threadId/attachments?filename=…` 用于上传私有项目会话附件，要求会话及 CSRF，并接收不超过 256 KiB 的原始请求体。支持 CSV、TXT、Markdown、JSON、TSV、PDF、PNG、JPEG、WebP，`Content-Type` 必须与文件扩展名匹配。附件元数据及原件下载按账号与会话授权。
