/**
 * Worker资源配置。
 */
export const TASK_BUDGET_LIMITS = {
    /** 单任务执行期间允许调用搜索引擎的最大次数*/
    maxSearches: 10,

    /** 单任务执行期间允许爬取与解析的目标网页最大数量*/
    maxPages: 20,

    /** 单任务在 Worker 端的全局最大物理执行时长，超时后强行终止并回收线程 */
    maxDurationSeconds: 300,
} as const;

/**
 * 任务执行 Agent（Worker）默认资源配额。
 *
 * 继承物理资源硬上限，并补充长任务推理执行所需的上下文基准配额；
 * 用于草稿任务未显式声明预算时的执行标准。
 */
export const TASK_DRAFT_DEFAULT_BUDGET = {
    ...TASK_BUDGET_LIMITS,

    /** 执行阶段单次向大模型灌入的提示词与爬取内容最大 Token 上限 */
    maxInputTokens: 40_000,

    /** 执行阶段报告产物与思考链等的最大 Token 总量 */
    maxOutputTokens: 8_000,
} as const;
