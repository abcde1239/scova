import { describe, expect, it, vi } from 'vite-plus/test';
import {
    listProviderModels,
    createSafeHttpClient,
    ConnectorError,
    type ModelProtocol,
    type SafeHttpClient,
} from '../src/index.ts';

function fixture(pages: unknown[], protocol: ModelProtocol = 'openai_json') {
    const request = vi.fn<SafeHttpClient['request']>(async (url) => ({
        url,
        status: 200,
        headers: {},
        body: JSON.stringify(pages.shift()),
    }));
    const input = {
        baseUrl: 'https://models.example.com/custom/v1',
        protocol,
        apiKey: 'fixture-secret',
    };
    return { request, input, run: () => listProviderModels(input, { request }) };
}
describe('供应商模型目录', () => {
    it.each(['openai_json', 'openai_chat_completions'] as const)(
        '读取%s目录，使用凭据头、保自定义根路径且不生成/重试/重定向',
        async (protocol) => {
            const { run, request } = fixture(
                [{ data: [{ id: 'b' }, { id: 'a', name: '模型 A' }, { id: 'a', name: '模型 A' }] }],
                protocol,
            );
            expect(await run()).toEqual({
                items: [
                    { id: 'a', name: '模型 A' },
                    { id: 'b', name: 'b' },
                ],
                truncated: false,
            });
            expect(request).toHaveBeenCalledTimes(1);
            expect(request.mock.calls[0]?.[0]).toBe('https://models.example.com/custom/v1/models');
            expect(request.mock.calls[0]?.[1]).toMatchObject({
                method: 'GET',
                maxRedirects: 0,
                maxBytes: 1048576,
                headers: { authorization: 'Bearer fixture-secret' },
            });
        },
    );
    it('Anthropic读取后页、使用专属密钥和版本头', async () => {
        const { run, request } = fixture(
            [
                {
                    data: [{ id: 'claude-a', display_name: 'Claude A' }],
                    has_more: true,
                    last_id: 'claude-a',
                },
                { data: [{ id: 'claude-b', display_name: 'Claude B' }], has_more: false },
            ],
            'anthropic_messages',
        );
        expect((await run()).items.map((item) => item.id)).toEqual(['claude-a', 'claude-b']);
        expect(new URL(request.mock.calls[1]![0]).searchParams.get('after_id')).toBe('claude-a');
        expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
            'x-api-key': 'fixture-secret',
            'anthropic-version': '2023-06-01',
        });
        expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization');
    });
    it('Gemini过滤仅嵌入模型、分页并规范模型ID', async () => {
        const { run, request } = fixture(
            [
                {
                    models: [
                        {
                            name: 'models/gemini-a',
                            displayName: 'Gemini A',
                            supportedGenerationMethods: ['generateContent'],
                        },
                        { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
                    ],
                    nextPageToken: 'next /+',
                },
                { models: [], nextPageToken: '' },
            ],
            'gemini',
        );
        expect(await run()).toEqual({
            items: [{ id: 'gemini-a', name: 'Gemini A' }],
            truncated: false,
        });
        const [url, options] = request.mock.calls[1]!;
        expect(new URL(url).searchParams.get('pageToken')).toBe('next /+');
        expect(url).not.toContain('fixture-secret');
        expect(options?.headers?.['x-goog-api-key']).toBe('fixture-secret');
    });
    it('分页达到边界明确标记截断，避免无限请求', async () => {
        const { run, request } = fixture(
            Array.from({ length: 5 }, (_, i) => ({
                data: [{ id: `claude-${i}` }],
                has_more: true,
                last_id: String(i),
            })),
            'anthropic_messages',
        );
        expect((await run()).truncated).toBe(true);
        expect(request).toHaveBeenCalledTimes(5);
    });
    it('目录最多1000项并明确标记截断', async () => {
        const { run } = fixture([
            { data: Array.from({ length: 1001 }, (_, i) => ({ id: `model-${i}` })) },
        ]);
        const result = await run();
        expect(result.items).toHaveLength(1000);
        expect(result.truncated).toBe(true);
    });
    it.each([null, {}, { data: null }, { data: [{}] }])(
        '拒绝结构不完整的上游响应：%j',
        async (data) => {
            await expect(fixture([data]).run()).rejects.toMatchObject({ code: 'invalid_response' });
        },
    );
    it('拒绝重复分页游标', async () => {
        const { run } = fixture(
            [
                { data: [], has_more: true, last_id: 'same' },
                { data: [], has_more: true, last_id: 'same' },
            ],
            'anthropic_messages',
        );
        await expect(run()).rejects.toMatchObject({ code: 'invalid_response' });
    });
    it('空目录合法且不会猜造模型', async () => {
        expect(await fixture([{ data: [] }]).run()).toEqual({ items: [], truncated: false });
    });
    it.each([401, 403, 404, 429, 503, 302])('HTTP%s不返回上游内容或重试', async (status) => {
        const { input } = fixture([]);
        const request = vi.fn(async () => ({
            url: input.baseUrl,
            status,
            headers: {},
            body: 'fixture-secret',
        }));
        await expect(listProviderModels(input, { request })).rejects.toMatchObject({
            code: 'http',
            status,
            message: '供应商未返回模型列表',
        });
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('DNS解析到私网时不发送凭据', async () => {
        const transport = vi.fn();
        const http = createSafeHttpClient({
            resolve: async () => [{ address: '127.0.0.1', family: 4 }],
            transport,
        });
        const { input } = fixture([]);
        await expect(listProviderModels(input, http)).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).not.toHaveBeenCalled();
    });
    it('上游超时/取消保留分类，已取消时不发请求', async () => {
        const { input, request } = fixture([]);
        const signal = AbortSignal.abort();
        await expect(listProviderModels({ ...input, signal }, { request })).rejects.toMatchObject({
            code: 'aborted',
        });
        expect(request).not.toHaveBeenCalled();
        request.mockRejectedValue(new ConnectorError('timeout', 'secret upstream'));
        await expect(listProviderModels(input, { request })).rejects.toMatchObject({
            code: 'timeout',
        });
    });
});
