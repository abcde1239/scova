# Scova Worker

后台研究执行进程：投递 PostgreSQL Outbox、消费 BullMQ Run 作业，管理租约、预算账本和 LangGraph 检查点，将研究候选及其原文引用原子交付为报告和收件箱记录。

## 启动

在仓库根目录配置 `DATABASE_URL`、`REDIS_URL`，安装依赖并完成数据库迁移后运行：

```sh
vp run worker#start       # Bun
vp run worker#start:node  # Node.js
```

投递、恢复扫描和周期调度各自按批串行轮询；Run 消费独立进行。停止时阻止新领取、中断在途执行并保留可恢复状态，等待调度事务、数据库操作和投递结束后关闭队列和连接。

## 配置

| 环境变量                       | 默认值       | 用途                                        |
| ------------------------------ | ------------ | ------------------------------------------- |
| `WORKER_QUEUE_NAME`            | `scova-runs` | BullMQ 队列名                               |
| `WORKER_POLL_INTERVAL_MS`      | `1000`       | 批次间隔                                    |
| `WORKER_FAILURE_DELAY_MS`      | `5000`       | 批次失败等待                                |
| `WORKER_BATCH_SIZE`            | `50`         | 单批领取上限                                |
| `WORKER_LEASE_SECONDS`         | `30`         | 单条投递租约                                |
| `WORKER_RUN_LEASE_SECONDS`     | `30`         | Run 租约；续期间隔为其三分之一，最多 10 秒  |
| `WORKER_RUN_CONCURRENCY`       | `2`          | Run 消费并发数，最大 32                     |
| `WORKER_SCHEDULER_INTERVAL_MS` | `30000`      | 周期任务扫描间隔                            |
| `WORKER_SCHEDULER_CONCURRENCY` | `2`          | 同批调度事务并发数，最大 8                  |
| `WORKER_SCHEDULED_RUN_MODE`    | `demo`       | 周期执行固定模式；真实研究需显式配置 `live` |

Run 从数据库固定 owner、版本、模式和预算，队列只能选择 runId。同一 Run 只有一个有效租约，接管递增 epoch，最多恢复三次；恢复保留首次开始时间和 deadline。数据库恢复扫描独立于原始 job，能处理消息丢失和保留的 completed/failed job。

调度以 IANA 时区的每日/每周当地时间计算 UTC 时点。DST 缺失时刻取首个有效时刻，重复时刻取较早一次。停机只补最近一次到期，较早时点计入 `missedCount`；已有活动执行则记 `skipped_overlap`。Occurrence、Run、首事件、Outbox 与下一时点在一个 PostgreSQL 事务内提交，多 Worker 通过任务行锁和唯一约束去重。暂停保留当前执行且允许显式手动运行，恢复只安排未来时点；归档阻止新执行并请求取消当前执行。

`AGENT_CHECKPOINT_SCHEMA` 默认为 `scova_agent`，启动时在独立表空间串行运行 saver 迁移。真实执行使用 `SEARXNG_BASE_URL`（默认 `http://127.0.0.1:8080`）、`MODEL_API_KEY`、`MODEL_NAME` 和可选 `MODEL_BASE_URL`。`SEARCH_PROVIDER` 默认为 `searxng`，只有显式选择 `tavily` 时才读取 `TAVILY_API_KEY`。详情见[搜索部署](../../docs/public/guides/search.md)。密钥仅来自部署者环境，不写入任务或事件。真实 Run 缺配置以 `AGENT_CONFIGURATION_INVALID` 失败，禁止静默转为演示；demo Run 始终使用固定演示资料。

执行层通过受限上下文发出进度事件并检查执行权限；受信领域 repository 必须通过 `withRunFence` 在同一 Run 行锁事务内写入。普通写入拒绝取消、超期或失效租约；失败/取消终结有单独入口。执行器返回本身不代表已交付成果。

每个供应商 attempt 先提交 ToolCall 和累计预留，再调用外部服务。成功结果与可信用量原子结算；unknown/失败尝试保留预留。恢复按逻辑操作和输入指纹复用成功结果，即使用量恰已耗尽也无需再次付费调用。checkpoint 只从数据库已提升的明确引用恢复，新 epoch 不继承旧线程的未提升 pending writes。截止后不调用搜索、阅读或模型，只允许读取截止前已合法保存的正文构造 partial 候选；取消仍禁止交付。停止等待已开始的领域写和 checkpoint 操作后关闭连接。

交付重新读取明确提升的 checkpoint，并将正文与当前 Run 成功工具记录比对，逐条校验原文引用、owner、版本和模式。在同一 Run 行锁事务内保存快照、证据、结论、报告、收件箱和终态事件；重投返回已交付报告，取消先获锁则不交付。没有可引用正文时失败。

首次领取固定同 owner/task/有效范围/mode 的完整基线，恢复不重新选择。比较清单随报告保存，交付事务重新验证成功模型账本、事实原文和双方证据后保存变化；完整执行推进基线，partial 保留原指针。范围包含比较策略版本，演示与真实基线隔离。图与当前引用校验边界见 [Agent Core](../../packages/agent-core/README.md)；未核验新来源发布日期、官方身份、来源失败或正文截断均显示覆盖缺口。

## 验证

```sh
vp test apps/worker/tests/lifecycle.test.ts apps/worker/tests/config.test.ts
vp run test:worker
vp run test:agent-recovery
vp run test:delivery
```

集成测试需专用 PostgreSQL、Redis 和独立 Bun，包含真实投递、租约接管及 Bun/Node 进程退出。目录分层见[系统架构](../../docs/public/reference/architecture.md)。
