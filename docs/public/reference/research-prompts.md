# 研究生成提示词

研究规划、综合和证据评估的固定提示以英文编写，报告正文、条件、理由和缺口要求简体中文。搜索词按资料选择语言，国际技术资料优先英文，地区法规和服务使用当地语言；原文引文和逐字提取值保留原语言。英文指令并不保证所有模型的质量更高。

## 资产与组装

| 阶段         | 源码                                                   | 作用                                                               |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------ |
| 搜索规划     | `packages/agent-core/src/model/prompts/planning.md`    | 冻结任务、时间和问题 ID；用互补查询覆盖对象、条件和不同观点        |
| 内容综合     | `packages/agent-core/src/model/prompts/synthesis.md`   | 先回答问题，再组织依据；合并同源互补信息，保留条件、争议和不确定性 |
| 证据评估     | `packages/agent-core/src/model/prompts/assessment.md`  | 解释 schema 枚举；区分逐字匹配、语义支持与模型自评                 |
| 交付形式     | `packages/agent-core/src/model/output-instructions.ts` | 简报、清单、对比和研究报告各自的采集及写作目标；只生成选中形式     |
| 比较与修复   | `packages/agent-core/src/research/nodes/compare.ts`    | 稳定事实键、原文值、有界修复与冻结上下文                           |
| 输入与篇幅   | `packages/agent-core/src/model/input.ts`               | 先计算提示开销，再提供全文或分隔片段；输出留出完整 JSON 的空间     |
| 规划输入预算 | `packages/agent-core/src/model/planning-input.ts`      | 完整任务与 schema 预检；仅压缩固定指令，保留原阶段和累计预算       |
| 协议系统规则 | `packages/connectors/src/model/provider.ts`            | 结构化 JSON、来源隔离、禁止伪造和语言约束                          |

Markdown 在模块启动时读取，修改后重启对应 Server/Worker；Docker 使用源码包，资产随包复制。任务和修复数据通过单次 JSON 替换进入固定模板，用户内容中的 `{{input}}` 保持字面，不再作为模板展开。预算、权限、工具授权和保存校验仍由代码执行。

## 关键约束

四种形式分别组织内容：简报给核心回答，清单围绕具体对象，对比使用共同维度，研究报告用完整论证段落。多选共享采集预算，每条结论属于一个成果，不能把同一批文字复制成多个形式。

规划同时冻结各成果的对象、字段和必答范围，综合只能将这些要求关联到已验证的结论，不能因来源失败删掉对象。来源权威性与引用是证据约束，不另造必答字段；不适用的机制与资料未知分别说明。规划结构异常按成果隔离，无可核验规划范围时只作部分交付。

清单字段和比较单元格保留关联结论的条件与缺口；从结论截取的短值若会丢失必要条件，则保守使用完整结论。这些结构检查与连续原文匹配仍不构成独立语义核查。修复后的同字段结论只有在同源证据重叠等条件满足时替代旧主答案，旧结论及账本继续保留。

字段展示文字改写失配时，可以退回同次成功综合明确关联的完整已验证论断，仍核对问题、形式和完整对象身份。多条关联须由一条完整论断包含组内全部正文，否则不回退；超长不截断。支持等级仍取原评估，不能把真实部分支持改成已支持。报告讨论的输入额度从固定提示和 schema 之外的剩余空间分配，避免固定指令增长后误删很短的原报告上下文。

该证据 schema 的 `fact` 只接受引用内的逐字原句，自己的话、翻译和归纳使用 `inference`；冲突引用双方，材料确实缺失时使用 `insufficient`。引文必须是单个原文片段内连续、逐字的短文本，不翻译或跨片段拼接。年付折合月费不能写成月付价格；转载不能计作多份独立验证；收集截止日期不强加因果、预测等未请求要求。

模型自评不等于独立事实核查。发布时间、更新时间和采集时间分开判断；搜索 API 提取正文保留其来源和整页覆盖未知的限制。受控测试验证输入、引用、预算和恢复契约，真实模型的内容质量仍需用固定任务、来源快照和人工评分持续比较。

缺口只对应会影响所需回答的具体缺失，不因主动补充其他 API、版本历史或替代方法而扩张必答范围。没有足够依据的可选补充应省略；有依据且不影响结论适用性的背景单列参考。会改变结论的条件、例外、风险和冲突仍直接关联问题，不能仅因未绑定某个字段就降为背景或清空缺口。

## 官方参考

2026-11-10 参照以下官方资料中的明确任务步骤、示例、结构分隔与输出约束改写：

- [OpenAI Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
- [Anthropic Be clear and direct](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/be-clear-and-direct)
- [DeepSeek Search](https://api-docs.deepseek.com/api/search)：`need_content` 与 `content`。
- [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)：`include_raw_content` 与 `raw_content`。
- [Perplexity Search](https://docs.perplexity.ai/api-reference/search-post)：当前返回摘要，不能据此认定取得完整正文。
