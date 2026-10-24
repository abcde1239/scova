# 业务数据库

Prisma 6.19 管理 `schema.prisma` 中的 PostgreSQL 业务模型；Bun 为主运行时，Node.js 使用同一生成客户端。`DATABASE_URL` 必须由部署者环境配置，不提交密码。

首次部署先执行 `vp exec prisma generate` 与 `vp exec prisma migrate deploy`，确认成功后再启动 API/worker。再次执行 deploy 不重复建表。不使用 `db push` 替代已审查的 SQL migration，也不重置共享或用户数据库。

所有用户私有实体带 `userId` 和 `(userId,id)` 唯一键。跨实体引用使用带 owner 的复合外键；Task 当前版本、Run 配置版本、Report 对应 Run、SourceSnapshot/RunSource 与 Evidence 的来源/观测关系另绑定任务或来源，防止拼接其他账号或其他任务的合法 UUID。账号删除通过 owner 外键级联清理；非 owner 关系为 NO ACTION，单独硬删除需由服务先处理合法依赖。

`ChangeEvidence` 与 `QuestionEvidence` 将逻辑模型中的证据列表归一化为关系，保证每条证据具备 owner 外键。`ChangeRecord.oldSourceId` 显式标识旧快照来源，支持保留转载关系；其与 oldSnapshotId 必须同时为空或同时存在。Feedback 的 claim 还绑定 task，不能把同用户其他任务的结论拼接进来。

Outbox 首版只保存 Run 命令，其 aggregateId 由 owner 复合外键绑定 Run；未来新增聚合类型必须显式调整 schema。幂等 resourceId 是服务内部的响应引用而不是可自由访问的资源授权，读取时仍须依据 scope 与会话验证 owner。

部分唯一索引和 CHECK 位于 migration 尾部，包括活动 Run 互斥、反馈条件唯一键、目标恰一、事件类型/版本/序号、修订和计数边界。后续 migration diff 不得丢弃这些手写约束。Prisma 无法通过 CHECK 跨表判断基线完整、引用来源于当前/基线执行等条件，这些由领域交付事务校验；数据库仍独立保证 owner 与关联身份。

LangGraph checkpoint 使用独立 schema 与迁移，不由 Prisma 管理。`Run.checkpointRef` 仅保存经过 fencing 提升的显式引用，不能将客户端输入作为 checkpoint 地址。

`apps/api/tests/database.integration.test.ts` 使用专属随机 `scova_db_*` schema，在空 schema 执行 migrate deploy 两次，再用真实 PostgreSQL 验证外键、唯一键、CHECK 与并发互斥；结束后仅清理该次生成的 schema。测试优先读取 `SCOVA_TEST_DATABASE_URL`、其次 `RUNTIME_DATABASE_URL`，否则使用 compose.test.yaml 的本地测试端口。不会读取生产 DATABASE_URL，不执行 reset、TRUNCATE 全库或 Redis FLUSHALL。
