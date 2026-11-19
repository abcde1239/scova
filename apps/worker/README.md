# Scova Worker

后台研究执行进程：消费 BullMQ Run 作业，管理租约、预算账本和 LangGraph 检查点，将研究候选及其原文引用原子交付为报告和收件箱记录。

运行前先执行 Server 的 `vp run db:migrate`。Worker 只核验 checkpoint 版本，不建表，也不提供备份、恢复等离线维护命令。运行态仍须连接 PostgreSQL 和 Redis，以维护本次执行的租约、checkpoint、工具账本和交付。调度、Outbox 投递及恢复回补由 Server 后台负责，单独启动 Worker 不会产生队列作业。

## 启动

在仓库根目录配置 `DATABASE_URL`、`REDIS_URL`，安装依赖并完成数据库迁移后运行：

```sh
vp run worker#start       # Bun
vp run worker#start:node  # Node.js
```

停止时阻止新领取、中断在途执行并等待写入收敛，再关闭消费者与执行连接。取消、租约到期和进程停机分别处理，后者保留可恢复状态。

## 配置

默认通过 SearxNG 搜索；可显式配置 Tavily、DeepSeek/Perplexity 独立搜索 API，或在账号供应商配置中授权 OpenAI/Anthropic 内置搜索。内置搜索同时计入搜索与 Token 预算，详见[搜索配置](../../docs/public/guides/search.md)。

| 环境变量                             | 默认值        | 用途                                                                        |
| ------------------------------------ | ------------- | --------------------------------------------------------------------------- |
| `WORKER_QUEUE_NAME`                  | `scova-runs`  | BullMQ 队列名                                                               |
| `WORKER_RUN_LEASE_SECONDS`           | `30`          | Run 租约；续期间隔为其三分之一，最多 10 秒                                  |
| `WORKER_RUN_CONCURRENCY`             | `2`           | Run 消费并发数，最大 32                                                     |
| `SEARCH_ENGINE_INTERVAL_MS`          | `10000`       | 每引擎共享启动间隔（毫秒）                                                  |
| `SEARCH_CONFIG_VERSION`              | `1`           | 搜索实例出口、地区或 CX 配置指纹版本                                        |
| `SEARCH_CACHE_ENABLED`               | `true`        | 同账号候选缓存与在途复用                                                    |
| `SEARCH_ADAPTIVE_ENABLED`            | `true`        | Agent 最多两次预算内补搜                                                    |
| `RESEARCH_ANSWER_SUPPLEMENT_ENABLED` | `false`       | 旧策略的可选补证；新执行按覆盖缺口自动补证，仍受SEARCH_ADAPTIVE_ENABLED约束 |
| `READER_RENDER_WAIT_MS`              | `1000`        | 浏览器 DOM 渲染等待，范围 1–5000 毫秒                                       |
| `READER_CHROMIUM_SANDBOX`            | `false`(容器) | Chromium sandbox；宿主机可设为 `true`                                       |

Run 从数据库固定 owner、版本、模式和预算，队列只能选择 runId。同一 Run 只有一个有效租约，接管递增 epoch，最多恢复三次；恢复保留首次开始时间和 deadline。Server 的恢复扫描独立于原始 job，能处理消息丢失和保留的 completed/failed job。

网页阅读默认使用 Crawlee + Playwright。Reader 先用受限 HTTP 客户端安全跟随重定向，再在一次性 Chromium 上下文中执行 JavaScript；页面只能发起经过同一安全客户端的公网 GET，禁止写请求、凭据转发、下载、WebSocket、service worker 和二次导航。单次读取最多 15 秒、主文档/单资源 2 MiB、总资源 8 MiB、32 个资源请求。Worker 镜像已安装匹配 Chromium；Bun 在 Windows 上通过 Node/vpx 子进程承载 Reader，取消和关闭会等待浏览器清理。该能力面向非交互公网页面，登录墙、挑战页和 PDF 不保证得到正文。

Bun 入口通过 `scripts/run-bun.mjs` 将当前 Node 路径传给 Reader；直接运行 Bun 时可用 `READER_NODE_EXECUTABLE` 指定 Node 可执行文件，默认查找 `node`。Node 通过仓库内 Vite+ loader 加载 Reader TypeScript，不需要额外安装脚本运行器。

`AGENT_CHECKPOINT_SCHEMA` 默认为 `scova_agent`，由 Server 迁移创建并登记版本，Worker 启动时只核验该版本。模型优先使用账号配置，可用 `MODEL_API_KEY`、`MODEL_NAME` 和可选 `MODEL_BASE_URL` 设置部署默认模型。搜索与正文提取默认使用内置 SearXNG，账号可配置独立 Search API，任务或单次执行可覆盖；不读取服务器搜索 API 默认或模型内嵌搜索。`SEARXNG_BASE_URL`（默认 `http://127.0.0.1:8080`）仅指定内置工具地址，不选择搜索方式；搜索密钥单独加密保存，不写入任务或事件。升级须先执行数据库迁移，旧搜索 API 可在账号页显式迁入，见[搜索配置](../../docs/public/guides/search.md)。任务模型配置不可用时以 `AGENT_CONFIGURATION_INVALID` 失败，显式 API 缺配置或密钥无法读取分别使用 `SEARCH_API_NOT_CONFIGURED`、`SEARCH_CREDENTIAL_INVALID`，生产 Worker 不接受 demo 队列；历史演示报告仍可读取，测试可显式注入固定供应商。

执行层通过受限上下文发出进度事件并检查执行权限；受信领域 repository 必须通过 `withRunFence` 在同一 Run 行锁事务内写入。普通写入拒绝取消、超期或失效租约；失败/取消终结有单独入口。执行器返回本身不代表已交付成果。

SearxNG 搜索在出站前通过 Redis 原子申请引擎资格，跨 Worker 保持并发 1，验证码和限流独立冷却；Redis 故障不退回无限制调用。同账号相同条件查询合并在途请求，候选缓存保持原始查询时间，命中仍记逻辑预算，真正重试另记。出站前重新检查 Run 租约与取消，等待不延长 deadline；共享状态与缓存细节见搜索部署说明。

每个供应商 attempt 先提交 ToolCall 和累计预留，再调用外部服务。成功结果与可信用量原子结算；unknown/失败尝试保留预留。恢复按逻辑操作和输入指纹复用成功结果，即使用量恰已耗尽也无需再次付费调用。checkpoint 只从数据库已提升的明确引用恢复，新 epoch 不继承旧线程的未提升 pending writes。截止后不调用搜索、阅读或模型，只允许读取截止前已合法保存的正文构造 partial 候选；取消仍禁止交付。停止等待已开始的领域写和 checkpoint 操作后关闭连接。

模型明确额度不足记录为 `TOOL_MODEL_QUOTA_EXCEEDED`；同一 Run 后续模型预留会被拒绝，跨进程恢复仍有效，已成功操作可重放。该状态只限制当前 Run，补充额度后可新建执行，不会永久停用账号模型。失败预留仍保留，供应商错误原文不会公开。

交付重新读取明确提升的 checkpoint，并将正文与当前 Run 成功工具记录比对，逐条校验原文引用、owner、版本和模式。在同一 Run 行锁事务内保存快照、证据、结论、报告、收件箱和终态事件；重投返回已交付报告，取消先获锁则不交付。没有可引用正文时失败。

证据质量采用软约束：结论可保留为有引用的模型归纳或待核实内容，报告逐条说明不确定性；不匹配原文的文字不会作为引用保存。全部结论均待核实时，真实正文摘录单独放入来源附录，不与无直接依据的结论关联。比较按最多 3 页分批并局部修复，交付逐批核对成功账本；部分比较值未核实也可交付，只有完整结果才能推进基线。筛选说明与真正覆盖缺口分别记录，原有预算和权限约束继续生效。

新执行按形式和问题范围分组，每组最多6项冻结需求、最多24条结论（简报8条），修复只请求未完整的字段。当前字段绑定决定活动结论，完整字段不因局部失败退化，冲突仍保留；所有原始尝试保存在不可变回执中，活动集最多192条。稳定组最多60个，实际调用受原累计预算和deadline约束；直接答复先于历史变化抽取。一组证据综合和局部修复各一次；覆盖不足时在原预算内定向补搜、读取最多4页，仅新增正文可开启第二组，最多4轮。输出配额基于不可变回执的实际usage回收，输入先容纳固定契约再适配本批正文，累计账本始终是硬限。新wire强制assessment、形式和单问题关联，旧检查点保持原协议。0/N标记覆盖验收失败。结构失败事件保存阶段、schema指纹和可信预期约束，不保存无效响应值；失败usage与修复分别结算。

报告先冻结目标和焦点问题，再为结论记录问题关联、支持关系、时间适用性、来源关系和内容作用。`coverage.reportValue` 将问题展示为已回答、主要结论、不同来源或暂无直接回答，并将结论分为主回答、参考线索或省略。模型评估只是自评，引用定位不代表语义已独立核实；同一问题内同源观点与引用集中展示，条件与缺口保留在对应说明；旧报告没有该字段时兼容读取。对于不带新覆盖策略的旧检查点，启用 `RESEARCH_ANSWER_SUPPLEMENT_ENABLED` 后，核心问题仍有具体缺口时最多补搜一次、读取两页并复用原第二轮综合额度；预算、期限、账本和恢复不放宽，无新增信息即停止。默认关闭。

首次领取固定同 owner/task/有效范围/mode 的完整基线，恢复不重新选择。比较清单随报告保存，交付事务重新验证成功模型账本、事实原文和双方证据后保存变化；完整执行推进基线，partial 保留原指针。范围包含比较策略版本，演示与真实基线隔离。图与当前引用校验边界见 [Agent Core](../../packages/agent-core/README.md)；未核验新来源发布日期、官方身份、来源失败或正文截断均显示覆盖缺口。

站内通知读取固定任务版本的偏好，在报告交付或失败终结事务内创建。完整交付按每次汇总/仅重要变化/关闭处理，partial 和 failed 仅按运行问题开关生成提醒；用户取消不提醒。唯一键防止重放重复，已读状态保持不变。关闭通知不会影响报告、收件箱或基线。

## 验证

```sh
vp test apps/worker/tests/lifecycle.test.ts apps/worker/tests/config.test.ts
vp run test:worker
vp run test:agent-recovery
vp run test:delivery
```

集成测试需专用 PostgreSQL、Redis 和独立 Bun，包含真实投递、租约接管及 Bun/Node 进程退出。目录分层见[系统架构](../../docs/public/reference/architecture.md)。
