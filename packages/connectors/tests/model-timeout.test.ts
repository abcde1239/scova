import { describe, expect, it, vi } from 'vite-plus/test';
import { createModelProvider, createSafeHttpClient, type HttpTransport } from '../src/index.ts';
import { ConnectorError } from '../src/types.ts';
import { prepareProvider } from '../src/providers.ts';

const input = {
    prompt: 'bounded fixture',
    schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
    },
    maxInputTokens: 4000,
    maxOutputTokens: 100,
};
describe('模型独立超时预算', () => {
    it('调用方无法把模型单次总等待延长到120秒以上', async () => {
        vi.useFakeTimers();
        try {
            let signal: AbortSignal | undefined;
            const http = createSafeHttpClient({
                resolve: async () => [{ address: '93.184.215.14', family: 4 }],
                maxTimeoutMs: 120_000,
                transport: async (_url, options) => {
                    signal = options.signal;
                    return new Promise(() => {});
                },
            });
            const model = createModelProvider({
                apiKey: 'fixture',
                model: 'fixture',
                http,
                maxAttempts: 1,
            });
            const assertion = expect(
                model.generateStructured(input, { timeoutMs: 240_000 }),
            ).rejects.toMatchObject({ code: 'timeout' });
            await vi.advanceTimersByTimeAsync(120_001);
            await assertion;
            expect(signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
    it('自动重试向账本传递前次固定异常分类，避免覆盖成未知错误', async () => {
        const failure = new ConnectorError('http', 'DO_NOT_RENDER secret', true, 503);
        const beforeAttempt = vi.fn();
        let attempts = 0;
        const provider = prepareProvider({ maxAttempts: 2, retryDelayMs: 0 });
        await provider.call('model', { beforeAttempt }, async () => {
            if (++attempts === 1) throw failure;
            return { url: 'https://api.example.com', status: 200, headers: {}, body: '{}' };
        });
        expect(beforeAttempt.mock.calls[0]).toEqual(['model']);
        expect(beforeAttempt.mock.calls[1]).toEqual(['model', failure]);
    });
    it('模型可超过60秒但不超过120秒，HTTP与供应商层使用同一预算', async () => {
        vi.useFakeTimers();
        try {
            const transport: HttpTransport = async () => {
                await new Promise((resolve) => setTimeout(resolve, 65_000));
                return {
                    status: 200,
                    headers: {},
                    body: JSON.stringify({
                        choices: [
                            { finish_reason: 'stop', message: { content: '{"answer":"ok"}' } },
                        ],
                        usage: { prompt_tokens: 10, completion_tokens: 5 },
                    }),
                };
            };
            const http = createSafeHttpClient({
                resolve: async () => [{ address: '93.184.215.14', family: 4 }],
                transport,
                maxTimeoutMs: 120_000,
            });
            const model = createModelProvider({
                apiKey: 'fixture',
                model: 'fixture',
                http,
                maxAttempts: 1,
            });
            const result = model.generateStructured(input);
            const assertion = expect(result).resolves.toMatchObject({ data: { answer: 'ok' } });
            await vi.advanceTimersByTimeAsync(65_001);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
    it('调用方的更短截止时间始终生效并中止传输', async () => {
        vi.useFakeTimers();
        try {
            let signal: AbortSignal | undefined;
            const http = createSafeHttpClient({
                resolve: async () => [{ address: '93.184.215.14', family: 4 }],
                maxTimeoutMs: 60_000,
                transport: async (_url, options) => {
                    signal = options.signal;
                    return new Promise(() => {});
                },
            });
            const model = createModelProvider({
                apiKey: 'fixture',
                model: 'fixture',
                http,
                maxAttempts: 1,
            });
            const result = model.generateStructured(input, { timeoutMs: 5000 });
            const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
            await vi.advanceTimersByTimeAsync(5001);
            await assertion;
            expect(signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
