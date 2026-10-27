import { createModelProvider, type ModelProvider } from '@scova/connectors';

/**
 * 任务规划 Agent（Task Draft Agent）资源配置。
 *
 * 用于在任务拆解、结构化规划阶段对大模型调用施加多维度配额约束，
 * 防范长上下文溢出、高额费用透支、接口并发爆破与长时间悬挂。
 */
export interface TaskDraftPolicy {
    /** 规划任务全局最大超时时间，超出后强制中断 */
    timeoutMs: number;

    /** 单次模型交互或子指令执行的最大超时时间 */
    commandTimeoutMs: number;

    /** 单次请求允许输入给大模型的最大 Token 上限 */
    maxInputTokens: number;

    /** 规划阶段单次任务累计允许模型输出的最大 Token 上限 */
    maxOutputTokens: number;

    /** 单次模型生成尝试允许的最大输出 Token 上限 */
    outputTokensPerAttempt: number;

    /** 滑动限流与配额统计的时间窗口周期 */
    windowSeconds: number;

    /** 单个用户在时间窗口内允许发起的规划请求次数上限 */
    userRequests: number;

    /** 全局所有用户在时间窗口内允许发起的规划请求总次数上限 */
    globalRequests: number;

    /** 单个用户在时间窗口内允许触发的模型调用尝试总次数上限*/
    userAttempts: number;

    /** 全局所有用户在时间窗口内允许触发的模型调用尝试总次数上限 */
    globalAttempts: number;

    /** 单个用户在时间窗口内允许累计消耗的模型输入 Token 配额 */
    userInputTokens: number;

    /** 全局所有用户在时间窗口内允许累计消耗的模型输入 Token 总配额 */
    globalInputTokens: number;

    /** 单个用户在时间窗口内允许累计消耗的模型输出 Token 配额 */
    userOutputTokens: number;

    /** 全局所有用户在时间窗口内允许累计消耗的模型输出 Token 总配额 */
    globalOutputTokens: number;

    /** 限流与配额计数存储（如 Redis）中使用的 Key 命名空间前缀 */
    keyPrefix: string;
}
export function createTaskDraftPolicy(overrides: Partial<TaskDraftPolicy> = {}): TaskDraftPolicy {
    const policy = {
        timeoutMs: 15_000,
        commandTimeoutMs: 5_000,
        maxInputTokens: 40_000,
        maxOutputTokens: 4_000,
        outputTokensPerAttempt: 2_000,
        windowSeconds: 60,
        userRequests: 10,
        globalRequests: 100,
        userAttempts: 20,
        globalAttempts: 200,
        userInputTokens: 400_000,
        globalInputTokens: 4_000_000,
        userOutputTokens: 40_000,
        globalOutputTokens: 400_000,
        keyPrefix: 'scova:task-drafts:',
        ...overrides,
    };
    for (const [key, value] of Object.entries(policy))
        if (
            key === 'keyPrefix'
                ? typeof value !== 'string' || !value.trim()
                : !Number.isSafeInteger(value) || Number(value) < 1
        )
            throw new Error('草稿解析策略必须使用有效前缀和正安全整数');
    if (
        policy.timeoutMs > 15_000 ||
        policy.commandTimeoutMs > 5_000 ||
        policy.maxInputTokens > 40_000 ||
        policy.maxOutputTokens > 4_000 ||
        policy.outputTokensPerAttempt > 2_000
    )
        throw new Error('草稿解析策略超过单次安全上限');
    return policy;
}

/** 惰性装配单独的models适配器，不触发搜索、演示管线或网络调用。 */
export function createTaskDraftModel(): ModelProvider | null {
    const apiKey = process.env.MODEL_API_KEY?.trim();
    const model = process.env.MODEL_NAME?.trim();
    if (!apiKey || !model) return null;
    return createModelProvider({
        apiKey,
        model,
        baseUrl: process.env.MODEL_BASE_URL,
        maxAttempts: 1,
    });
}
