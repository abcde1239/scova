import { DEFAULT_TASK_BUDGET, DEFAULT_TASK_BUDGET_LIMITS } from '@scova/models';

/** 新建和编辑任务时的部署上限；执行仍服从任务版本内的累计预算。 */
export const TASK_BUDGET_LIMITS = DEFAULT_TASK_BUDGET_LIMITS;

/**
 * 任务执行 Agent（Worker）默认资源配额。
 *
 * 与前端共用新任务默认值；输入和输出 token 均按整次执行累计。
 */
export const TASK_DRAFT_DEFAULT_BUDGET = DEFAULT_TASK_BUDGET;
