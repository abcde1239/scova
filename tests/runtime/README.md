# 持久化运行时实验

验证 Bun 与 Node.js 在真实 PostgreSQL、Redis 上运行 Prisma、BullMQ 和 LangGraph checkpoint 的兼容性。

## 运行

安装仓库依赖、Bun 和 Docker 后，在根目录执行：

```sh
docker compose -f compose.test.yaml -p scova-runtime-test up -d --wait
vp run test:runtime
vp run test:runtime:node
docker compose -f compose.test.yaml -p scova-runtime-test down
```

默认使用 `compose.test.yaml` 的专用测试服务：PostgreSQL `127.0.0.1:55432/scova_test`（账号、密码均为 `scova_test`），Redis `127.0.0.1:56379`。可通过 `RUNTIME_DATABASE_URL`、`RUNTIME_REDIS_URL` 覆盖；服务不可用时测试失败。

## 验证范围

- Prisma 事务提交、回滚与连接释放。
- BullMQ 收发、稳定 jobId 去重及队列清理。
- checkpoint 跨进程、跨 epoch 恢复，以及 fencing 拒绝旧 worker 晋升。
- 异常退出资源释放与时区调度的 DST 边界。

每次运行创建独立 schema 和队列，结束后清理；生成客户端位于被忽略的 `.generated/`。仅检查时区逻辑可运行 `vp node scripts/runtime-test.mjs --only=dst`。

本实验验证技术协议，业务执行与交付需另行集成测试。
