# 中文接口文档

API 使用 Bun + Elysia；Node.js 通过官方适配器兼容。启动后访问 `/swagger` 查看交互文档，`/swagger/json` 获取 OpenAPI 3.1 JSON。

```sh
vp run server#start
# Node.js 兼容入口
vp run server#start:node
# 从真实 Elysia 路由生成中文接口文档
vp run api:openapi
# 检查已提交产物是否漂移
vp run api:openapi:check
```

根目录的 [swagger.json](../../../swagger.json) 是生成的 OpenAPI 3.1 文档，不手工编辑。请求和响应引用 `packages/contracts` 的运行时 schema；路由使用中文 summary、description、tags 和唯一 operationId，DTO 字段均有中文说明。新增接口必须同时声明请求、成功/失败响应及必要的 Cookie、CSRF、幂等和修订版本头。

生成器校验中文说明、模型与 contracts 等价、引用可解析和 operationId 唯一。GitHub Actions 运行生成漂移检查、文档测试和 Bun/Node HTTP 启停测试；它不代替真实数据库与队列的业务集成测试。

`POST /api/v1/tasks/:id/pause`、`resume`、`archive` 使用会话、CSRF 和 `If-Match` 修订控制，返回任务详情和新 `ETag`。暂停保留当前 Run，恢复仅安排未来周期时点；归档阻止新手动、重试和周期执行，并对当前 Run 请求取消。已完成幂等命令仍可重放原结果。

报告接口使用当前会话的账号权限：`GET /api/v1/reports` 支持任务筛选与游标分页，`GET /api/v1/reports/:id` 返回结构化结论、来源快照元数据和原文引用。`GET /api/v1/inbox` 分页读取收件箱，`PATCH /api/v1/inbox/:id` 以 `{ "read": true }` 标记已读，传 `false` 恢复未读；写请求仍需 CSRF。报告读取保留演示模式、覆盖缺口和引用定位，完整网页正文及内部工具、checkpoint 不进入响应。

报告的 `changes` 使用同一组可访问证据：`oldEvidenceIds` 来自本次执行首次领取时固定的完整基线，`newEvidenceIds` 来自当前执行；两侧还须分别匹配变化记录的来源与快照。非法关联使整个详情返回 `409 INVALID_REPORT_EVIDENCE`。正文过期清理后仍可读取保存的引用片段和定位。

`GET /api/v1/notifications` 按游标读取当前账号通知，可按 `kind`、`unread` 筛选；失败通知的 `reportId` 可为空，使用 `runId` 查看执行原因。`PATCH /api/v1/notifications/:id` 使用会话和 CSRF，以 `{ "read": true }` 标为已读，`false` 恢复未读；重复已读保留首次时间。通知和收件箱的已读状态相互独立。
