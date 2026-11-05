import { describe, expect, it, vi } from 'vite-plus/test';
import { createModelProvider, type ModelProtocol, type SafeHttpClient } from '../src/index.ts';

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
        'validates %s output and output budget',
        async (protocol) => {
            const data = structuredClone(native[protocol]);
            if (protocol === 'anthropic_messages' && 'content' in data)
                data.content[0]!.input = { answer: 42 as unknown as string };
            else if ('candidates' in data)
                data.candidates[0]!.content.parts[0]!.text = '{"answer":42}';
            await expect(
                setup(protocol, data).model.generateStructured(input),
            ).rejects.toMatchObject({ code: 'invalid_response' });
            const valid = setup(protocol, native[protocol]);
            await expect(
                valid.model.generateStructured({ ...input, maxOutputTokens: 7 }),
            ).rejects.toMatchObject({ code: 'budget_exceeded' });
        },
    );
});
