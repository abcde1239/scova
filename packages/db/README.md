# @scova/db

Scova 服务端 PostgreSQL 持久化包，使用 Drizzle ORM 与 node-postgres。公开请求、响应和事件模型由 `@scova/models` 提供；LangGraph checkpoint 的 schema、连接池与迁移独立管理。

## 使用

在仓库根目录运行：

```sh
vp install
vp run db:migrate
```

迁移前配置 `DATABASE_URL`。`?schema=名称` 指定业务 schema，默认 `public`；客户端明确将其转换为 PostgreSQL `search_path`，保留 `application_name`。连接及升级说明见[数据库参考](../../docs/public/reference/database.md)。

```ts
import { createDatabaseClient, closeDatabase, eq, users } from '@scova/db';

const db = createDatabaseClient({ connectionString: process.env.DATABASE_URL, max: 5 });
const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
await closeDatabase(db);
```

`createDatabaseClient` 离线构造原生 Drizzle database，默认连接池上限为 5、连接超时 5 秒。应用负责 `connectDatabase`、事务边界及 `closeDatabase`；事务回调使用同一个原生连接。空闲连接异常默认输出不含连接信息的明确日志，也可通过 `onIdleError(error)` 接入应用日志与告警；连接池自动移除失效连接。实体类型从 `src/schema.ts` 推导，UUID 和更新时间在应用侧生成，保留既有表结构。

`queryRows<T>(executor, sql)` 是参数化 SQL 入口，按 PostgreSQL 类型 OID 将 timestamp 映射为 `Date`；文本游标保留微秒字符串。业务 SQL 留在应用 repo，不能从公开 API 接收任意 SQL。

`@scova/db/feedback` 的 `captureFeedbackSnapshot(tx, userId, taskId)` 在调用方已持有 Task 锁的创建事务中查询并投影反馈，返回可写入 Run 的冻结 JSON；不自行连接数据库或外部服务。

本包仅供服务端使用，不依赖 Elysia；反馈投影使用 `@scova/models` 的快照结构。HTTP DTO、事件与运行时校验由 models 管理；不要向前端返回内部实体或引入数据库客户端。

默认使用 PostgreSQL 客户端。可选本机版从 `@scova/db/sqlite` 显式导入 `createSqliteDatabaseClient(path)`，由该入口自动迁移 SQLite 文件，业务仓储共用 Drizzle 查询接口。Server 用单连接串行事务保护 Run 租约、检查点与业务写入；Worker 通过 Server 的内部执行接口访问这些数据。SQLite 迁移记录在 `sqlite/` 和 `scova_business_migrations`，参见[SQLite 本机版](../../docs/public/guides/local-development.md#sqlite-本机版)。

## 迁移

`@scova/db/migrate` 提供 `migrateDatabase({ connectionString })` 与只读 `verifyDatabase`。迁移使用 Drizzle Kit journal、不可变 SQL 和 `_scova_migrations` 名称/校验和账本，并在同一事务内获取按数据库/schema 隔离的 advisory lock。连接超时 5 秒，迁移锁等待上限 30 秒；锁超时会回滚当前事务并明确失败。

空库执行初始 SQL。已有 Prisma 数据库须具有全部合法历史记录，并通过表、列、默认值、枚举、外键、CHECK、索引及触发器的物理结构校验，才能登记基线；外键内部触发器被禁用也会拒绝接管。不会重放建表或修改业务数据。已知 LF/CRLF 校验和均可识别，旧 `_prisma_migrations` 保留。未知历史、未完成迁移或结构漂移明确失败。

`legacy/migrations` 与 `legacy-manifest.json` 用于不可变历史审计和旧库校验，不需要旧 ORM 的 schema、迁移工具或生成客户端。`drizzle/` 保存当前 SQL、journal 和 Kit schema snapshot；`schema-baseline.json` 绑定已审查 SQL 的物理结构。正常升级前仍须停止写入，并备份业务库和 checkpoint，参见[部署指南](../../docs/public/guides/deployment.md)。

新增迁移的开发流程：

```sh
vp run @scova/db#generate
# 配置专用 SCOVA_TEST_DATABASE_URL；仅在随机参考 schema 内执行并最终回滚。
vp run @scova/db#baseline
```

一起审查并提交 SQL、journal、snapshot 和候选结构基线。SQL 校验和或基线不匹配时拒绝部署。Kit 默认 `public` 标识符会映射到配置的业务 schema，字符串与注释保持原样；自定义函数正文等 SQL 必须单独核查 schema 边界。

## 验证

`vp run @scova/db#build` 检查类型；`vp run test:database` 验证真实 PostgreSQL 上的迁移、约束与存量升级。`vp run @scova/db#test` 可单独运行本包测试，使用专用测试 PostgreSQL，不读取生产 `DATABASE_URL`。
