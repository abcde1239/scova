# Scova 数据库

PostgreSQL 业务表定义、Drizzle 客户端与迁移统一维护在 [@scova/db](../packages/db/README.md)，供 Server 和 Worker 共用，兼容 Bun 与 Node.js。此目录只保留旧文档入口，不再提供 Prisma 工具链。

## 初始化

在仓库根目录配置 `DATABASE_URL`，再运行：

```sh
vp run db:migrate
```

本地测试容器的连接地址为 `postgresql://scova_test:scova_test@127.0.0.1:55432/scova_test`；Redis 为 `redis://127.0.0.1:56379`，通过 `REDIS_URL` 配置。仅用于本地测试，部署时使用独立账号和凭据。

## 测试

```sh
docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait
vp run test:database
```

测试在专用数据库中创建并清理随机 schema。可通过 `SCOVA_TEST_DATABASE_URL` 覆盖连接，不读取业务 `DATABASE_URL`。

## 维护

当前模型定义在 `packages/db/src/schema.ts`，原生迁移位于 `packages/db/drizzle/`。`packages/db/prisma/migrations/` 是不可变历史 SQL 审计资料，存量库接管需要核对原迁移 checksum 与实际表结构；不会对已有表重放建表。迁移包含的手写索引与 CHECK 必须保留。

详细约束见[数据库参考](../docs/public/reference/database.md)和[数据模型](../docs/public/reference/data-model.md)。
