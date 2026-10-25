# Scova Worker

后台执行控制进程：投递 PostgreSQL Outbox、消费 BullMQ Run 作业，并管理数据库租约、取消和崩溃恢复。Agent 研究与报告交付尚未接入；默认执行器明确终结为 `EXECUTOR_NOT_CONFIGURED`，不生成报告。

## 启动

在仓库根目录配置 `DATABASE_URL`、`REDIS_URL`，安装依赖并完成数据库迁移后运行：

```sh
vp run worker#start       # Bun
vp run worker#start:node  # Node.js
```

投递和恢复扫描按批串行轮询；Run 消费独立进行。停止时阻止新领取、中断在途执行并保留可恢复状态，等待数据库操作和投递结束后关闭队列和连接。

## 配置

| 环境变量                   | 默认值       | 用途                                       |
| -------------------------- | ------------ | ------------------------------------------ |
| `WORKER_QUEUE_NAME`        | `scova-runs` | BullMQ 队列名                              |
| `WORKER_POLL_INTERVAL_MS`  | `1000`       | 批次间隔                                   |
| `WORKER_FAILURE_DELAY_MS`  | `5000`       | 批次失败等待                               |
| `WORKER_BATCH_SIZE`        | `50`         | 单批领取上限                               |
| `WORKER_LEASE_SECONDS`     | `30`         | 单条投递租约                               |
| `WORKER_RUN_LEASE_SECONDS` | `30`         | Run 租约；续期间隔为其三分之一，最多 10 秒 |
| `WORKER_RUN_CONCURRENCY`   | `2`          | Run 消费并发数，最大 32                    |

Run 从数据库固定 owner、版本、模式和预算，队列只能选择 runId。同一 Run 只有一个有效租约，接管递增 epoch，最多恢复三次；恢复保留首次开始时间和 deadline。数据库恢复扫描独立于原始 job，能处理消息丢失和保留的 completed/failed job。

执行层通过受限上下文发出进度事件并检查执行权限；受信领域 repository 必须通过 `withRunFence` 在同一 Run 行锁事务内写入。普通写入拒绝取消、超期或失效租约；失败/取消终结有单独入口。执行器返回本身不代表已交付成果。

## 验证

```sh
vp test apps/worker/tests/lifecycle.test.ts apps/worker/tests/config.test.ts
vp run test:worker
```

集成测试需专用 PostgreSQL、Redis 和独立 Bun，包含真实投递、租约接管及 Bun/Node 进程退出。目录分层见[系统架构](../../docs/public/reference/architecture.md)。
