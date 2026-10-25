# Scova Worker

后台 Outbox 投递进程：从 PostgreSQL 领取记录，写入 BullMQ，并确认或退避重试。当前尚未消费 Agent 研究任务。

## 启动

在仓库根目录配置 `DATABASE_URL`、`REDIS_URL`，安装依赖并完成数据库迁移后运行：

```sh
vp run worker#start       # Bun
vp run worker#start:node  # Node.js
```

按完成一批再等待的方式串行轮询；停止时等待在途投递，然后关闭队列和连接。

## 配置

| 环境变量                  | 默认值       | 用途          |
| ------------------------- | ------------ | ------------- |
| `WORKER_QUEUE_NAME`       | `scova-runs` | BullMQ 队列名 |
| `WORKER_POLL_INTERVAL_MS` | `1000`       | 批次间隔      |
| `WORKER_FAILURE_DELAY_MS` | `5000`       | 批次失败等待  |
| `WORKER_BATCH_SIZE`       | `50`         | 单批领取上限  |
| `WORKER_LEASE_SECONDS`    | `30`         | 单条投递租约  |

## 验证

```sh
vp test apps/worker/tests/lifecycle.test.ts apps/worker/tests/config.test.ts
vp run test:worker
```

集成测试需专用 PostgreSQL、Redis 和独立 Bun，包含真实投递、租约接管及 Bun/Node 进程退出。目录分层见[系统架构](../../docs/public/reference/architecture.md)。
