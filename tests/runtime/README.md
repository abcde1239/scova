# 持久化运行时兼容性实验

本实验对应 Issue #3，仅验证真实 PostgreSQL/Redis 下的技术协议，不代表生产业务编排已实现。

依赖安装后使用独立测试容器：

```sh
docker compose -f compose.test.yaml up -d --wait
vp run test:runtime
vp node scripts/runtime-test.mjs
docker compose -f compose.test.yaml down
```

`test:runtime` 应使用 Bun 主运行时启动 `scripts/runtime-test.mjs`；第二条 Node 命令验证兼容运行时。默认 PostgreSQL 为 `127.0.0.1:55432/scova_test`，测试账号与密码都是 `scova_test`；Redis 为 `127.0.0.1:56379`。可通过 `RUNTIME_DATABASE_URL`、`RUNTIME_REDIS_URL` 覆盖，仅指向专用测试服务。没有服务时命令失败，不降级内存或跳过。

实验每次生成独立 schema 和 BullMQ 队列，结束后清理；不使用 FLUSHALL。Prisma fixture 的客户端生成至 `tests/runtime/.generated`，不提交生成产物。LangGraph checkpoint 表在同一独立 schema 内由 saver.setup 管理，不与业务 migration 混用。

验证内容：

- Prisma commit/rollback、模型读取和连接释放。
- BullMQ 真正收发、稳定 jobId 去重、资源关闭与命名队列清理。
- 两节点图在第一个节点后中断并保存明确 checkpointRef；进程完全退出后，新 epoch/thread 从此引用恢复。
- 旧 worker 接管后仍能写旧 thread 的 checkpoint，但 fencing 条件拒绝晋升；恢复不用旧 thread 的“最新”指针。
- 已完成 first 节点只调用一次，second 节点与交付只写一次，独立主键使重复执行直接失败。
- 额外启动一个在连接建立后故意异常的进程，要求 finally 关闭连接池后以失败码退出，不调用 process.exit 或强制杀进程。
- DST 缺失当地时刻向前顺延，重复时刻取较早一次，后一天仍按当地时刻计算。

仅验证无外部服务的 DST 断言：`vp node scripts/runtime-test.mjs --only=dst`。这个结果不能代替完整运行时实验。每个 checkpoint 阶段都会输出独立 PID，父进程要求全部不同，避免将同进程重建图误称为进程恢复。
