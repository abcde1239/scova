import { createModelProvider, type ModelProvider } from '@scova/connectors';

export interface TaskDraftPolicy {
    timeoutMs: number;
    commandTimeoutMs: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    outputTokensPerAttempt: number;
    windowSeconds: number;
    userRequests: number;
    globalRequests: number;
    userAttempts: number;
    globalAttempts: number;
    userInputTokens: number;
    globalInputTokens: number;
    userOutputTokens: number;
    globalOutputTokens: number;
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

/** 惰性装配单独的模型适配器，不触发搜索、演示管线或网络调用。 */
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
