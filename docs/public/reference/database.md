# 业务数据库

PostgreSQL 表与关系定义在 `packages/db/src/schema.ts`，Server/Worker 通过 `@scova/db` 使用原生 Drizzle 客户端与推导行类型。公开 DTO、事件和运行时校验独立放在 `@scova/models`。Bun 为主运行时，Node.js 使用相同实现。连接由部署者配置，不提交密码。

## 初始化与升级

配置 `DATABASE_URL` 后运行 `vp run db:migrate`，成功后启动 API/Worker，无需生成客户端。迁移使用 `packages/db/drizzle/` 的 SQL/journal 和 `_scova_migrations` 账本，在事务及按数据库/schema 隔离的 advisory lock 内执行，重复执行安全。

已有 Prisma 数据库先验证备份、停止 API/Worker，再运行同一命令。接管前校验八组原迁移的名称、完成状态、已知 checksum，以及实际表、列、类型、默认值、枚举、外键、CHECK、索引与触发器；一致后才登记初始基线，不在存量表重放建表 SQL。原 `_prisma_migrations` 与 `packages/db/prisma/migrations/` 保留审计。只有已知 LF/CRLF 两种行尾校验和等价，其他内容变化仍拒绝。未知、失败、不完整历史或结构漂移会回滚报错，不清库、不自动放行。

新变更先修改 schema，再执行 `vp run @scova/db#generate` 生成 SQL/snapshot/journal。配置专用 `SCOVA_TEST_DATABASE_URL` 后运行 `vp run @scova/db#baseline`，通过随机 schema 回滚事务生成候选物理结构基线。审查 SQL、snapshot、journal 和基线后一起提交；不能重写已应用迁移，也不能用 schema push 代替审查。

维护窗口、备份恢复及回退边界见[部署指南](../guides/deployment.md)。恢复写入后不能直接还原旧备份丢弃新增数据，须先评估版本兼容性与恢复点。

## 隔离与一致性

私有实体带 `userId` 和 `(userId,id)` 唯一键；跨实体引用使用 owner 复合外键，任务版本、报告、来源、快照及观测另绑定关联身份，防止拼接其他账号或其他任务的合法 UUID。账号删除通过 owner 外键级联清理；其他关联按约束先处理合法依赖。

活动 Run、反馈目标、事件类型/版本/序号及计数边界由部分唯一索引与 CHECK 保证。`ChangeEvidence`、`QuestionEvidence` 将证据列表归一化；旧来源/快照成对存在，反馈 claim 绑定任务。跨表的基线完整性、引用合法性与一次性报告交付仍由领域事务核验，不能只依赖 ORM 类型。

Outbox 的 aggregateId 绑定 Run；幂等响应引用不替代读取授权。调度部分索引 `tasks_due_active(next_run_at,id)` 与 `(taskId,scheduleRevision,scheduledAt)` 唯一约束保留。Run/Outbox CAS、epoch fencing、PG 时钟及 Task→Run 锁顺序保持原语义，不跨网络等待持有业务事务。

UUID 与 Task/Baseline/Feedback/Note 的更新时间有显式应用默认值；显式传入历史时间仍保留。时间列使用 `timestamptz(6)`，内部分页游标通过 SQL 保留微秒，不能降为 JS Date 的毫秒边界。

## 连接与 checkpoint

客户端工厂只构造连接池，应用负责显式连接及停止。URL 中 `schema` 是应用约定，工厂校验后设置 PostgreSQL search_path，并保留 application_name。连接池与超时见 [db 包说明](../../../packages/db/README.md)。

LangGraph checkpoint 保持独立 schema、版本账本、连接池和迁移，由原 saver 管理，不进入业务 Drizzle 迁移。Worker 按配置启动或外部维护模式核验 saver；Run.checkpointRef 仅保存经租约 fencing 提升的引用。备份、保留期与账号删除共同处理业务和 checkpoint 数据，不能仅删除业务表就认为研究内容已清除。

## 验证

`vp run test:database` 使用专用随机 schema，验证空库和存量升级、重复与并发迁移、物理约束和损坏拒绝；Server 真实数据库测试继续覆盖外键、唯一、CHECK 与业务互斥。配置优先读取 `SCOVA_TEST_DATABASE_URL`，其次 `RUNTIME_DATABASE_URL`，默认使用 compose.test.yaml 的测试端口，不读取生产 DATABASE_URL。

`vp run test:integration` 串行验证完整后端；Node/Bun runtime 验证原生 Drizzle 提交/回滚与队列、checkpoint 恢复。所有清理只针对各次测试生成的 schema/队列，不 reset 用户或共享数据库。
