import {
    createModelProvider,
    estimateModelInputTokens,
    MODEL_INPUT_TOKEN_LIMIT,
    type StructuredInput,
} from '@scova/connectors';
import type { DatabaseClient } from '@scova/db';
import { openProviderCredentials } from '@scova/shared/credentials';
import { activeAgentProvider } from '@/repo/execution/agent-providers';
import { ApiError } from '@/utils/errors';
import type { WorkflowGenerator } from './canvas-node-execution.ts';

export function createWorkflowGenerator(
    database: DatabaseClient,
    userId: string,
    signal?: AbortSignal,
): WorkflowGenerator {
    return async ({ instructions, context, providerId }) => {
        signal?.throwIfAborted();
        const row = await activeAgentProvider(database, userId, providerId);
        signal?.throwIfAborted();
        if (!row)
            throw new ApiError(
                503,
                'AGENT_CONFIGURATION_INVALID',
                '当前账号没有可用的工作流模型配置',
            );

        const input: StructuredInput = {
            prompt: `按以下要求撰写 Markdown 正文，并将正文放在 markdown 字段中。\n${instructions}`,
            schema: {
                type: 'object',
                properties: { markdown: { type: 'string' } },
                required: ['markdown'],
                additionalProperties: false,
            },
            untrustedSources: [JSON.parse(context)],
            maxInputTokens: MODEL_INPUT_TOKEN_LIMIT,
            maxOutputTokens: 4096,
        };
        input.maxInputTokens = estimateModelInputTokens(input);
        if (input.maxInputTokens > MODEL_INPUT_TOKEN_LIMIT)
            throw new ApiError(
                422,
                'WORKFLOW_GENERATION_INPUT_LIMIT',
                '工作流生成材料超过模型输入限制',
            );

        let model: ReturnType<typeof createModelProvider>;
        try {
            model = createModelProvider({
                apiKey: openProviderCredentials(row.encryptedApiKey, userId, row.id).modelApiKey,
                model: row.model,
                baseUrl: row.baseUrl,
                protocol: row.protocol,
                maxAttempts: 1,
            });
        } catch {
            throw new ApiError(
                503,
                'AGENT_CONFIGURATION_INVALID',
                '当前账号模型配置不可用，请检查供应商设置',
            );
        }
        const result = await model.generateStructured<{ markdown: string }>(input, { signal });
        signal?.throwIfAborted();
        return result.data.markdown;
    };
}
