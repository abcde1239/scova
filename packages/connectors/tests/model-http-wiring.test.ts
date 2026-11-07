import { describe, expect, it, vi } from 'vite-plus/test';
const { request, factory } = vi.hoisted(() => {
    const request = vi.fn();
    return { request, factory: vi.fn(() => ({ request })) };
});
vi.mock('../src/model-http.ts', () => ({ createModelHttpClient: factory }));
import { listProviderModels, createModelProvider } from '../src/index.ts';

describe('模型目录与实际调用共用模型网络通道', () => {
    it('目录和生成均使用同一默认客户端，不改调用协议', async () => {
        request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            body: JSON.stringify({ data: [{ id: 'test-model' }] }),
        });
        await listProviderModels({
            baseUrl: 'https://api.example.com/v1',
            protocol: 'openai_json',
            apiKey: 'fixture-secret',
        });
        request.mockResolvedValueOnce({
            status: 200,
            headers: {},
            body: JSON.stringify({
                choices: [{ finish_reason: 'stop', message: { content: '{"answer":"ok"}' } }],
                usage: { prompt_tokens: 12, completion_tokens: 5 },
            }),
        });
        const model = createModelProvider({
            model: 'test-model',
            apiKey: 'fixture-secret',
            baseUrl: 'https://api.example.com/v1',
            maxAttempts: 1,
        });
        await model.generateStructured({
            prompt: 'Fixture',
            schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
                additionalProperties: false,
            },
            maxInputTokens: 4000,
            maxOutputTokens: 100,
        });
        expect(factory).toHaveBeenCalledTimes(2);
        expect(request.mock.calls.map((call) => call[0])).toEqual([
            'https://api.example.com/v1/models',
            'https://api.example.com/v1/chat/completions',
        ]);
    });
});
