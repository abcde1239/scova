# Scova Agent Core

`@scova/agent-core` 提供可恢复的 LangGraph 研究图：冻结任务与字段、提出知识草稿、检索和读取、按缺口补证、综合、比较及生成 `AgentCandidate`。Worker 负责工具账本、租约和原子交付。

`runResearchAgent(context, dependencies)` 接收固定的 Run/用户/任务版本、预算、期限与取消信号，以及受限模型/搜索/读取工具、checkpointer 和检查点提升接口。通过包入口导入 `AgentContext`、`AgentDependencies`、`runResearchAgent` 和 `candidateFromCheckpoint`；Agent 不连接数据库或队列。

源码按职责组织，`src/index.ts` 是统一包入口，`src/types.ts` 定义对外契约：

| 目录        | 职责                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| `research/` | 执行图、运行状态、检查点身份、节点、缺口调度，以及从执行状态生成候选的适配 |
| `report/`   | 报告价值与覆盖投影、字段绑定、成果文档、比较清单和变化                     |
| `search/`   | 查询恢复、检索词、读取候选、定向导航和搜索回执                             |
| `evidence/` | 原文关联、片段选择和支持等级规则                                           |
| `model/`    | 模型输入与预算适配、提示词及 Markdown 资产、输出指令和错误分类             |
| `utils/`    | 无业务状态的小型结构守卫                                                   |

新增实现放入对应领域；图节点负责衔接领域能力，报告与搜索规则各自在所属目录维护。共享包内部使用相对导入，跨包消费统一通过 `@scova/agent-core`。

新执行冻结 `loopQualityPolicy: 1`，并由规划请求元数据和 Worker 成功账本认证：

- `coverage.completion` 分别报告回答可交付、核验结束、外部证据完整支持及停止原因。知识草稿答全后继续有界核验；预算、期限、额度或无增益时停止。
- 字段综合保留已完成绑定，优先重绑现有正文，再读已发现且允许的 URL，资料缺失才补搜。必需内容缺失保留 partial，不把多条 partial 自动视为完整支持。
- 一条结论可以回答相关的多个冻结问题；每条引用仍须逐问题获得发现范围或合法 `evidenceLinks` 授权。原始正文、问题标签、hash 和引文区间保持不变。
- 稳定知识可交付为无引用的 `model_answer`，界面显示【模型自回答】；实时、精确数据和指定出处继续要求外部核验。回答 complete 不代表外部证据完整。

模型负责语义评估，程序验证结构、原文、范围、回执和预算。旧检查点保留冻结策略；仅基于已有证据的修订不自动联网。默认预算为 10 次搜索、20 次读取、600 秒、累计 1,000,000 输入和 128,000 输出 token，实际执行使用 Run 快照。

新执行的 `baselinePolicy: 1` 将回答完成与比较起点资格分开，只有必答字段全部有外部支持才能推进起点。资料采集另冻结 `collectionPolicy: 1`：只收录日期窗口内、值有直接原文出处的条目，关闭知识草稿与模型补答；日期未确认的来源单列或按用户设置剔除。分析研究可不限定日期，模型回答仍保留标签。

Worker 提供 `dependencies.loadPages` 时，新检查点冻结 `pagePolicy: 1`，只保存页面引用；节点运行前从成功读取回执恢复正文并验证元数据和指纹。`candidateFromCheckpoint(context, hydratedState, 'deadline')` 保留已提升的结论并生成部分交付，调用者须先验证租约、取消状态和明确检查点 ID；截止后不重新读取来源。

在仓库根目录验证：

```sh
vp test packages/agent-core/tests
vp run test:delivery
vp run test:agent-recovery
vp run agent-core#build
```

交付和恢复集成需要独立 PostgreSQL，双运行时恢复还需 Bun。详见 [Worker](../../apps/worker/README.md)。
