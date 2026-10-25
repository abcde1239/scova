# @scova/models

Scova 服务端内部数据模型包。`prisma/schema.prisma` 与同目录 `migrations` 是业务数据库模型及迁移的唯一来源；LangGraph checkpoint 迁移独立管理。

## 使用

在仓库根目录运行：

```sh
vp install
vp run @scova/models#generate
vp exec prisma migrate deploy
```

迁移前配置 `DATABASE_URL`；本地连接见[数据库说明](../../prisma/README.md)。

Server 和 worker 通过 `@scova/models` 导入 `PrismaClient`、`Prisma`、生成实体类型及枚举；也可使用 `createDatabaseClient(options)` 创建客户端。调用方负责连接关闭和事务管理。

本包仅供服务端使用，不依赖 Elysia 或 contracts。HTTP DTO、运行时校验与 OpenAPI 使用 `@scova/contracts`；不要向前端返回内部实体或引入数据库客户端。

## 验证

`vp run @scova/models#build` 检查类型，`vp run test:database` 验证真实 PostgreSQL 上的迁移与约束。
