import { describe, expect, it, vi } from 'vite-plus/test';
import {
    readProviderBalance,
    createSafeHttpClient,
    ConnectorError,
    type SafeHttpClient,
    type ProviderBalanceInput,
} from '../src/index.ts';

function fixture(data: unknown, input: Partial<ProviderBalanceInput> = {}, status = 200) {
    const request = vi.fn<SafeHttpClient['request']>(async (url) => ({
        url,
        status,
        headers: {},
        body: JSON.stringify(data),
    }));
    const options = {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'fixture-balance-secret',
        ...input,
    };
    return { request, run: () => readProviderBalance(options, { request }) };
}
describe('供应商余额与额度读取', () => {
    it('中转站双斜线前缀仍然只向原供应商同源发送密钥', async () => {
        const { run, request } = fixture(
            { code: true, data: { unlimited_quota: true, total_used: 0 } },
            { baseUrl: 'https://relay.example.com//v1', template: 'new_api' },
        );
        await run();
        expect(new URL(request.mock.calls[0]![0]).origin).toBe('https://relay.example.com');
    });
    it('DeepSeek保留多币种、零额与欠额，不混淆余额不足和密钥失效', async () => {
        const { run, request } = fixture({
            is_available: false,
            balance_infos: [
                { currency: 'CNY', total_balance: '0.00' },
                { currency: 'USD', total_balance: '-0.12' },
            ],
        });
        expect(await run()).toEqual({
            adapter: 'deepseek',
            items: [
                { label: '账号余额', scope: 'account', unit: 'CNY', remaining: 0 },
                { label: '账号余额', scope: 'account', unit: 'USD', remaining: -0.12 },
            ],
        });
        expect(request).toHaveBeenCalledOnce();
        expect(request.mock.calls[0]).toMatchObject([
            'https://api.deepseek.com/user/balance',
            {
                method: 'GET',
                headers: { authorization: 'Bearer fixture-balance-secret' },
                maxRedirects: 0,
                maxBytes: 65536,
            },
        ]);
    });
    it('OpenRouter使用credits余额而不是Key消费上限', async () => {
        const { run, request } = fixture(
            { data: { total_credits: '10', total_usage: 2.5, limit_remaining: 100 } },
            { baseUrl: 'https://openrouter.ai/api/v1' },
        );
        expect((await run()).items[0]).toMatchObject({
            remaining: 7.5,
            total: 10,
            used: 2.5,
            unit: 'USD',
            scope: 'account',
        });
        expect(request.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/credits');
    });
    it.each([
        ['cn', 'CNY'],
        ['com', 'USD'],
    ])('SiliconFlow%s读取总余额与正确币种', async (domain, currency) => {
        const { run, request } = fixture(
            { code: 20000, data: { totalBalance: '1.23', balance: '0.5', chargeBalance: '0.73' } },
            { baseUrl: `https://api.siliconflow.${domain}/v1` },
        );
        expect((await run()).items[0]).toMatchObject({ remaining: 1.23, unit: currency });
        expect(request.mock.calls[0]?.[0]).toBe(`https://api.siliconflow.${domain}/v1/user/info`);
    });
    it('New API保留前缀与原始额度点，区分Key限额和可选账号额度', async () => {
        const { run, request } = fixture(
            {
                code: true,
                data: {
                    unlimited_quota: false,
                    total_available: 750000,
                    total_granted: 1000000,
                    total_used: 250000,
                    user_quota: { total_available: 50000, total_used: 80000 },
                },
            },
            { baseUrl: 'https://relay.example.com/gateway/v1/', template: 'new_api' },
        );
        const { items } = await run();
        expect(items).toHaveLength(2);
        expect(items[0]).toMatchObject({
            scope: 'key',
            remaining: 750000,
            unit: '额度点',
            total: 1000000,
        });
        expect(items[1]).toMatchObject({ scope: 'account', remaining: 50000, unit: '额度点' });
        expect(request.mock.calls[0]?.[0]).toBe(
            'https://relay.example.com/gateway/api/usage/token/',
        );
    });
    it('New API无限Key不显示有限剩余，也不推断无限账号余额', async () => {
        const { run } = fixture(
            {
                code: true,
                data: {
                    unlimited_quota: true,
                    total_available: 0,
                    total_granted: 4,
                    total_used: 4,
                },
            },
            { template: 'new_api' },
        );
        const { items } = await run();
        expect(items).toEqual([
            { label: 'API Key 额度', scope: 'key', unit: '额度点', unlimited: true, used: 4 },
        ]);
    });
    it('Sub2API读取已声明单位的额度，不默认把未知单位当美元', async () => {
        const { run, request } = fixture(
            { isValid: true, remaining: 4, unit: 'USD', quota: { used: 1, limit: 5 } },
            { baseUrl: 'https://relay.example.com/v1', template: 'sub2api' },
        );
        expect((await run()).items[0]).toMatchObject({
            remaining: 4,
            unit: 'USD',
            used: 1,
            total: 5,
        });
        expect(request.mock.calls[0]?.[0]).toBe('https://relay.example.com/v1/usage');
    });
    it.each([
        'https://api.deepseek.com.evil.example/v1',
        'https://api.deepseek.com/custom/v1',
        'https://relay.example.com/v1',
        'https://api.openai.com/v1',
    ])('未知官方接口不扫描或发送密钥：%s', async (baseUrl) => {
        const { run, request } = fixture({}, { baseUrl });
        await expect(run()).rejects.toMatchObject({ code: 'balance_unsupported' });
        expect(request).not.toHaveBeenCalled();
    });
    it.each([
        null,
        {},
        { balance_infos: [] },
        { balance_infos: [{ currency: 'CNY' }] },
        { balance_infos: [{ currency: 'CNY', total_balance: '' }] },
        { balance_infos: [{ currency: 'CNY', total_balance: null }] },
        { balance_infos: [{ currency: 'CNY', total_balance: true }] },
        { balance_infos: [{ currency: 'CNY', total_balance: 'NaN' }] },
        { balance_infos: [{ currency: 'CNY', total_balance: '1e999' }] },
    ])('缺失/非法额度不伪造为零：%j', async (body) => {
        await expect(fixture(body).run()).rejects.toMatchObject({ code: 'invalid_response' });
    });
    it.each([
        [{ data: { total_usage: 3 } }, 'https://openrouter.ai/api/v1', 'auto'],
        [{ code: 500, data: { totalBalance: 99 } }, 'https://api.siliconflow.cn/v1', 'auto'],
        [
            { code: false, data: { unlimited_quota: true, total_used: 0 } },
            'https://relay.example.com/v1',
            'new_api',
        ],
        [{ isValid: false, remaining: 4, unit: 'USD' }, 'https://relay.example.com/v1', 'sub2api'],
        [{ remaining: 4 }, 'https://relay.example.com/v1', 'sub2api'],
    ] as const)('拒绝不完整或业务失败响应', async (body, baseUrl, template) => {
        await expect(fixture(body, { baseUrl, template }).run()).rejects.toMatchObject({
            code: 'invalid_response',
        });
    });
    it.each([401, 403, 404, 429, 503, 302])('HTTP%s脱敏且不自动重试', async (status) => {
        const { run, request } = fixture({ secret: 'fixture-balance-secret' }, {}, status);
        await expect(run()).rejects.toMatchObject({
            code: 'http',
            status,
            message: '供应商未返回额度',
        });
        expect(request).toHaveBeenCalledOnce();
    });
    it('DNS私网和跳转不发送密钥到其他地址', async () => {
        const transport = vi.fn();
        const http = createSafeHttpClient({
            resolve: async () => [{ address: '127.0.0.1', family: 4 }],
            transport,
        });
        await expect(
            readProviderBalance(
                { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-balance-secret' },
                http,
            ),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).not.toHaveBeenCalled();
        const redirect = vi.fn(async () => ({
            status: 302,
            headers: { location: 'https://evil.example' },
            body: '',
        }));
        const pinned = createSafeHttpClient({
            resolve: async () => [{ address: '8.8.8.8', family: 4 }],
            transport: redirect,
        });
        await expect(
            readProviderBalance(
                { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-balance-secret' },
                pinned,
            ),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(redirect).toHaveBeenCalledOnce();
    });
    it('取消不发请求，连接错误保留类型', async () => {
        const request = vi.fn<SafeHttpClient['request']>(async () => {
            throw new ConnectorError('network', 'fixture-secret');
        });
        const input = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'fixture-balance-secret' };
        await expect(
            readProviderBalance({ ...input, signal: AbortSignal.abort() }, { request }),
        ).rejects.toMatchObject({ code: 'aborted' });
        expect(request).not.toHaveBeenCalled();
        await expect(readProviderBalance(input, { request })).rejects.toMatchObject({
            code: 'network',
        });
    });
});
