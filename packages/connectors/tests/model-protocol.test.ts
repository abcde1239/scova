import { describe, expect, it, vi } from 'vite-plus/test';
import { createModelProvider, type ModelProtocol, type SafeHttpClient } from '../src/index.ts';
import { modelRequest } from '../src/model/protocol.ts';

const schema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
};
const input = {
    prompt: 'Summarize',
    schema,
    untrustedSources: [{ text: 'untrusted' }],
    maxInputTokens: 4000,
    maxOutputTokens: 100,
};
const native = {
    openai_json: {
        choices: [{ finish_reason: 'stop', message: { content: '{"answer":"ok"}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
    },
    openai_chat_completions: {
        choices: [{ finish_reason: 'stop', message: { content: '{"answer":"ok"}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
    },
    anthropic_messages: {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'scova_output', input: { answer: 'ok' } }],
        usage: {
            input_tokens: 12,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 3,
            output_tokens: 8,
        },
    },
    gemini: {
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"answer":"ok"}' }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3 },
    },
};
function setup(protocol: ModelProtocol, data: unknown) {
    const request = vi.fn(
        async (url: string, _options?: Parameters<SafeHttpClient['request']>[1]) => ({
            url,
            status: 200,
            headers: {},
            body: JSON.stringify(data),
        }),
    );
    const model = createModelProvider({
        protocol,
        model: 'test-model',
        apiKey: 'test-secret',
        http: { request },
        maxAttempts: 1,
    });
    return { request, model };
}
describe('native model protocols', () => {
    it.each([
        ['not JSON DO_NOT_RENDER', 'json', undefined],
        ['{"answer":42}', 'schema', [{ schemaPath: '#/properties/answer/type', keyword: 'type' }]],
        [
            '{"answer":"ok","DO_NOT_RENDER":"sk-secret"}',
            'schema',
            [
                {
                    schemaPath: '#/additionalProperties',
                    keyword: 'additionalProperties',
                    allowedProperties: ['answer'],
                },
            ],
        ],
    ] as const)(
        'keeps safe content diagnostics and confirmed usage for %s',
        async (content, failure, issues) => {
            const data = structuredClone(native.openai_json);
            data.choices[0]!.message.content = content;
            const { model, request } = setup('openai_json', data);
            const error = await model.generateStructured(input).catch((error: unknown) => error);
            expect(error).toMatchObject({
                code: 'invalid_response',
                modelFailure: failure,
                modelUsage: { inputTokens: 20, outputTokens: 8, estimated: false },
            });
            expect((error as { modelSchemaIssues?: unknown }).modelSchemaIssues).toEqual(issues);
            expect(JSON.stringify(error)).not.toMatch(/DO_NOT_RENDER|sk-secret/);
            expect(request).toHaveBeenCalledTimes(1);
        },
    );

    it.each(Object.keys(native) as ModelProtocol[])(
        'retains usage when rejecting %s schema content',
        async (protocol) => {
            const data = structuredClone(native[protocol]);
            if ('choices' in data) data.choices[0]!.message.content = '{"answer":42}';
            else if ('content' in data)
                data.content[0]!.input = { answer: 42 as unknown as string };
            else data.candidates[0]!.content.parts[0]!.text = '{"answer":42}';
            await expect(
                setup(protocol, data).model.generateStructured(input),
            ).rejects.toMatchObject({
                modelFailure: 'schema',
                modelUsage: { inputTokens: 20, outputTokens: 8, estimated: false },
            });
        },
    );

    it('does not trust malformed or over-budget usage on a failed response', async () => {
        for (const prompt_tokens of [-1, 5000, '20', Number.MAX_SAFE_INTEGER + 1]) {
            const data = {
                ...native.openai_json,
                choices: [{ finish_reason: 'stop', message: { content: 'bad JSON' } }],
                usage: { prompt_tokens, completion_tokens: 8 },
            };
            const error = await setup('openai_json', data)
                .model.generateStructured(input)
                .catch((error: unknown) => error);
            expect(error).not.toHaveProperty('modelUsage');
        }
    });

    it.each(['deepseek-flash', 'deepseek-v4-pro'])(
        'uses the bounded JSON output allowance for content on official %s',
        (model) => {
            for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/']) {
                const request = modelRequest(
                    'openai_json',
                    baseUrl,
                    model,
                    'test-secret',
                    input,
                    [],
                );
                expect(request.body.thinking).toEqual({ type: 'disabled' });
                expect(request.body.max_tokens).toBe(input.maxOutputTokens);
                expect(request.body.response_format).toEqual({ type: 'json_object' });
            }
        },
    );
    it.each([
        ['openai_json', 'https://proxy.example/v1', 'deepseek-flash'],
        ['openai_json', 'https://api.deepseek.com.evil.example/v1', 'deepseek-flash'],
        ['openai_json', 'https://api.deepseek.com/custom/v1', 'deepseek-flash'],
        ['openai_json', 'https://api.deepseek.com/v1', 'deepseek-reasoner'],
        ['openai_json', 'https://api.deepseek.com/v1', 'another-model'],
        ['openai_chat_completions', 'https://api.deepseek.com/v1', 'deepseek-flash'],
    ] as const)(
        'keeps unrelated provider contracts for %s / %s / %s',
        (protocol, baseUrl, model) => {
            expect(
                modelRequest(protocol, baseUrl, model, 'test-secret', input, []).body,
            ).not.toHaveProperty('thinking');
        },
    );
    it.each(Object.keys(native) as ModelProtocol[])(
        'passes larger input/output budgets through %s and retains actual usage',
        async (protocol) => {
            const data = structuredClone(native[protocol]);
            if ('usage' in data && 'prompt_tokens' in data.usage) {
                data.usage.prompt_tokens = 128000;
                data.usage.completion_tokens = 48000;
            } else if ('usage' in data && 'input_tokens' in data.usage) {
                data.usage.input_tokens = 127992;
                data.usage.output_tokens = 48000;
            } else if ('usageMetadata' in data) {
                data.usageMetadata.promptTokenCount = 128000;
                data.usageMetadata.candidatesTokenCount = 47997;
            }
            const { model, request } = setup(protocol, data);
            const large = {
                ...input,
                untrustedSources: [{ text: 'context '.repeat(16000) }],
                maxInputTokens: 256000,
                maxOutputTokens: 64000,
            };
            const result = await model.generateStructured(large);
            expect(result.usage).toEqual({
                inputTokens: 128000,
                outputTokens: 48000,
                estimated: false,
            });
            const payload = JSON.parse(request.mock.calls[0][1]!.body!);
            expect(
                protocol === 'gemini'
                    ? payload.generationConfig.maxOutputTokens
                    : payload.max_tokens,
            ).toBe(64000);
        },
    );
    it.each([{ maxInputTokens: 256001 }, { maxOutputTokens: 64001 }])(
        'rejects above-cap input %j before HTTP',
        async (limit) => {
            const { model, request } = setup('openai_json', native.openai_json);
            await expect(model.generateStructured({ ...input, ...limit })).rejects.toMatchObject({
                code: 'configuration',
            });
            expect(request).not.toHaveBeenCalled();
        },
    );
    it.each(Object.keys(native) as ModelProtocol[])(
        'adapts %s with JSON schema, credentials and exact usage',
        async (protocol) => {
            const { request, model } = setup(protocol, native[protocol]);
            expect(await model.generateStructured(input)).toEqual({
                data: { answer: 'ok' },
                mode: 'live',
                usage: { inputTokens: 20, outputTokens: 8, estimated: false },
            });
            const [url, options] = request.mock.calls[0]!;
            const body = JSON.parse(options!.body!);
            expect(options?.maxRedirects).toBe(0);
            expect(url).not.toContain('test-secret');
            if (protocol === 'anthropic_messages') {
                expect(url).toBe('https://api.anthropic.com/v1/messages');
                expect(options?.headers?.['x-api-key']).toBe('test-secret');
                expect(options?.headers?.authorization).toBeUndefined();
                expect(body.tools[0].input_schema).toEqual(schema);
                expect(body.tool_choice).toEqual({ type: 'tool', name: 'scova_output' });
            } else if (protocol === 'gemini') {
                expect(url).toBe(
                    'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent',
                );
                expect(options?.headers?.['x-goog-api-key']).toBe('test-secret');
                expect(body.generationConfig.responseJsonSchema).toEqual(schema);
            } else {
                expect(options?.headers?.authorization).toBe('Bearer test-secret');
                if (protocol === 'openai_json') {
                    expect(body.response_format).toEqual({ type: 'json_object' });
                    expect(body.messages[0].content).toContain(JSON.stringify(schema));
                } else expect(body.response_format.json_schema.schema).toEqual(schema);
            }
            expect(JSON.stringify(body)).toContain('untrusted');
        },
    );
    it.each(['openai_chat_completions', 'openai_json', 'anthropic_messages', 'gemini'] as const)(
        'preserves ordered conversation roles for %s and budgets the transcript',
        async (protocol) => {
            const { request, model } = setup(protocol, native[protocol]);
            await model.generateStructured({
                ...input,
                messages: [
                    { role: 'user', content: '上一轮问题' },
                    { role: 'assistant', content: '上一轮回答' },
                ],
            });
            const body = JSON.parse(request.mock.calls[0]![1]!.body!);
            const messages =
                protocol === 'gemini'
                    ? body.contents
                    : protocol === 'anthropic_messages'
                      ? body.messages
                      : body.messages.slice(1);
            expect(messages.slice(0, 3).map((message: { role: string }) => message.role)).toEqual([
                'user',
                protocol === 'gemini' ? 'model' : 'assistant',
                'user',
            ]);
            expect(JSON.stringify(messages[0])).toContain('上一轮问题');
            expect(JSON.stringify(messages[1])).toContain('上一轮回答');
            const limited = setup(protocol, native[protocol]);
            await expect(
                limited.model.generateStructured({
                    ...input,
                    maxInputTokens: 1000,
                    messages: [{ role: 'user', content: '长历史'.repeat(1000) }],
                }),
            ).rejects.toThrow();
            expect(limited.request).not.toHaveBeenCalled();
        },
    );
    it.each([
        [
            'anthropic_messages',
            { ...native.anthropic_messages, content: [{ type: 'text', text: 'refused' }] },
        ],
        ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }],
        [
            'gemini',
            { ...native.gemini, usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 1 } },
        ],
    ] as const)('rejects refusal, truncation or invalid usage for %s', async (protocol, data) => {
        await expect(setup(protocol, data).model.generateStructured(input)).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });
    it.each([
        [
            'openai_json',
            {
                choices: [
                    { finish_reason: 'length', message: { content: '{"answer":"partial"}' } },
                ],
            },
        ],
        [
            'openai_chat_completions',
            {
                choices: [
                    { finish_reason: 'length', message: { content: '{"answer":"partial"}' } },
                ],
            },
        ],
        ['anthropic_messages', { ...native.anthropic_messages, stop_reason: 'max_tokens' }],
        [
            'gemini',
            { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
        ],
    ] as const)(
        'classifies truncated %s output without publishing even valid JSON',
        async (protocol, data) => {
            await expect(
                setup(protocol, data).model.generateStructured(input),
            ).rejects.toMatchObject({ code: 'output_truncated' });
        },
    );
    it.each(['anthropic_messages', 'gemini'] as const)(
        'rejects %s output usage above its reservation',
        async (protocol) => {
            const valid = setup(protocol, native[protocol]);
            await expect(
                valid.model.generateStructured({ ...input, maxOutputTokens: 7 }),
            ).rejects.toMatchObject({ code: 'budget_exceeded' });
        },
    );
});
