/** 与已有手工创建策略保持一致；草稿不能扩大这些部署预算。 */
export const TASK_BUDGET_LIMITS = {
  maxSearches: 10,
  maxPages: 20,
  maxDurationSeconds: 300,
} as const;
export const TASK_DRAFT_DEFAULT_BUDGET = {
  ...TASK_BUDGET_LIMITS,
  maxInputTokens: 40_000,
  maxOutputTokens: 8_000,
} as const;
