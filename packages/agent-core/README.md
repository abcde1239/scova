# Scova Agent Core

单一 LangGraph 研究图：加载固定任务、规划、搜索、选择来源、读取正文、校验、比较入口、综合和候选校验。输出带原文引用的 `AgentCandidate`，由 Worker 的领域服务负责报告交付。

`runResearchAgent(context, dependencies)` 接收固定 owner/Run/版本/模式、预算和取消信号，以及受限工具、checkpointer 和引用提升接口。Agent 不持有数据库、队列、文件系统或脚本工具。默认预算为 10 次搜索、20 次读取、300 秒、40,000 输入 token 和 8,000 输出 token；实际值使用 Run 快照。

Worker 为每次供应商尝试原子预留预算，保存成功结果，并按稳定 operationKey 复用；不确定调用保留费用，恢复不重置用量或期限。不承诺供应商调用 exactly-once。每个节点保存 checkpoint 后先通过租约 fencing 提升明确引用，再继续执行；接管使用独立 epoch/thread，只复制已提升状态，丢弃旧线程可能迟到的 pending writes。

搜索摘要不充当正文证据。候选引用须匹配已读取正文，事实使用逐字原文，推断和冲突单独标注。模型引用修复最多两次；循环另有搜索、页面和总步数上限。来源发布日期及官方身份尚无独立核验能力，对应限制始终进入 partial coverage。比较节点当前标记 `not_performed`，基线差异由后续功能接入。

取消不产生交付；期限耗尽后只能从已合法保存的正文生成确定性 partial 候选。演示模式使用固定资料，真实模式缺配置明确失败。报告、收件箱和原子交付尚未接入，候选生成成功不等于 Run 已交付。

```sh
vp test packages/agent-core/tests/agent.test.ts
vp run test:agent-recovery
vp run agent-core#build
```

恢复集成测试需要专用 PostgreSQL 和独立 Bun。部署与运行配置见 [Worker](../../apps/worker/README.md)。
