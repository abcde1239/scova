import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createSafeHttpClient,
    type SafeHttpClient,
    type HttpTransport,
} from '../src/index.ts';
import { createModelDnsResolver } from '../src/model-http.ts';

const real = { address: '104.21.71.78', family: 4 };
const fake = { address: '198.18.0.126', family: 4 };
function dnsFixture(value: unknown = { Status: 0, Answer: [{ type: 1, data: real.address }] }) {
    const request = vi.fn<SafeHttpClient['request']>(async (url) => ({
        url,
        status: 200,
        headers: {},
        body: JSON.stringify(value),
    }));
    return { request };
}
describe('模型专用Fake-IP兼容解析', () => {
    it('正常公网解析不查询DoH，保留系统解析与IPv6', async () => {
        const dnsHttp = dnsFixture();
        const addresses = [real, { address: '2606:4700:4700::1111', family: 6 }];
        const resolve = createModelDnsResolver({
            mode: 'auto',
            lookup: async () => addresses,
            dnsHttp,
        });
        expect(await resolve('api.example.com')).toEqual(addresses);
        expect(dnsHttp.request).not.toHaveBeenCalled();
    });
    it.each(['198.18.0.126', '198.19.255.254'])(
        '全Fake-IP %s通过可信DoH重新解析并固定真实公网IP',
        async (address) => {
            const dnsHttp = dnsFixture();
            const resolve = createModelDnsResolver({
                mode: 'auto',
                lookup: async () => [{ address, family: 4 }],
                dnsHttp,
            });
            const transport = vi.fn<HttpTransport>(async () => ({
                status: 401,
                headers: {},
                body: '',
            }));
            const http = createSafeHttpClient({ resolve, transport });
            await http.request('https://api.example.com/v1/models', {
                headers: { authorization: 'Bearer fixture-secret' },
                maxRedirects: 0,
            });
            expect(transport.mock.calls[0]?.[1]).toMatchObject({
                address: real,
                headers: { authorization: 'Bearer fixture-secret' },
            });
            const [url, options] = dnsHttp.request.mock.calls[0]!;
            expect(new URL(url).hostname).toBe('dns.alidns.com');
            expect(new URL(url).searchParams.get('name')).toBe('api.example.com');
            expect(options).toMatchObject({
                method: 'GET',
                maxRedirects: 0,
                maxBytes: 65536,
                timeoutMs: 5000,
            });
            expect(JSON.stringify(options)).not.toContain('fixture-secret');
        },
    );
    it.each(
        [
            [{ address: '127.0.0.1', family: 4 }],
            [real, fake],
            [fake, { address: '10.0.0.1', family: 4 }],
            [real, { address: '192.168.1.2', family: 4 }],
            [],
        ].map((addresses) => ({ addresses })),
    )('私网/混合/空解析不尝试自动回退，也不连接：%j', async ({ addresses }) => {
        const dnsHttp = dnsFixture(),
            transport = vi.fn();
        const resolve = createModelDnsResolver({
            mode: 'auto',
            lookup: async () => addresses,
            dnsHttp,
        });
        await expect(
            createSafeHttpClient({ resolve, transport }).request('https://api.example.com'),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(dnsHttp.request).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
    });
    it.each(['127.0.0.1', '198.18.0.1', '198.19.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1'])(
        'DoH返回%s仍拒绝，不放开地址规则',
        async (address) => {
            const dnsHttp = dnsFixture({
                Status: 0,
                Answer: [{ type: address.includes(':') ? 28 : 1, data: address }],
            });
            const transport = vi.fn();
            const resolve = createModelDnsResolver({
                mode: 'auto',
                lookup: async () => [fake],
                dnsHttp,
            });
            await expect(
                createSafeHttpClient({ resolve, transport }).request('https://api.example.com'),
            ).rejects.toMatchObject({ code: 'unsafe_url' });
            expect(transport).not.toHaveBeenCalled();
        },
    );
    it('DoH混合公私地址整批拒绝，即使第一个为公网', async () => {
        const dnsHttp = dnsFixture({
            Status: 0,
            Answer: [
                { type: 1, data: real.address },
                { type: 1, data: '10.0.0.1' },
            ],
        });
        const resolve = createModelDnsResolver({
            mode: 'auto',
            lookup: async () => [fake],
            dnsHttp,
        });
        await expect(resolve('api.example.com')).rejects.toMatchObject({ code: 'unsafe_url' });
    });
    it('system模式保原Fake-IP拒绝行为，不查询外部DNS', async () => {
        const dnsHttp = dnsFixture();
        const resolve = createModelDnsResolver({
            mode: 'system',
            lookup: async () => [fake],
            dnsHttp,
        });
        await expect(
            createSafeHttpClient({ resolve }).request('https://api.example.com'),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(dnsHttp.request).not.toHaveBeenCalled();
    });
    it.each(['alidns', 'cloudflare', 'google'])(
        '可显式选择可信解析器%s，不使用系统Fake-IP',
        async (mode) => {
            const dnsHttp = dnsFixture(),
                lookup = vi.fn();
            const resolve = createModelDnsResolver({ mode, lookup, dnsHttp });
            expect(await resolve('api.example.com')).toEqual([real]);
            expect(lookup).not.toHaveBeenCalled();
            expect(dnsHttp.request.mock.calls[0]?.[0]).not.toContain('apiKey');
        },
    );
    it('不接受任意DNS服务地址作为运行参数', () => {
        expect(() => createModelDnsResolver({ mode: 'https://127.0.0.1/dns-query' })).toThrow(
            'MODEL_DNS_RESOLVER',
        );
    });
    it.each([
        null,
        {},
        { Status: 3 },
        { Status: 0, Answer: [] },
        { Status: 0, Answer: [{ type: 5, data: 'alias.example.com' }] },
    ])('上游异常或无A/AAAA解析失败：%j', async (value) => {
        const dnsHttp = dnsFixture(value);
        const resolve = createModelDnsResolver({
            mode: 'auto',
            lookup: async () => [fake],
            dnsHttp,
        });
        await expect(resolve('api.example.com')).rejects.toMatchObject({ code: 'network' });
    });
    it('DNS超时保留分类，不把网络错误误报为API根地址错误', async () => {
        const dnsHttp = dnsFixture();
        dnsHttp.request.mockRejectedValue(new ConnectorError('timeout', '调用超时'));
        const resolve = createModelDnsResolver({
            mode: 'auto',
            lookup: async () => [fake],
            dnsHttp,
        });
        await expect(
            createSafeHttpClient({ resolve }).request('https://api.example.com'),
        ).rejects.toMatchObject({ code: 'timeout' });
    });
    it('直接填写Fake-IP字面地址在解析前就被拒绝', async () => {
        const resolve = vi.fn(createModelDnsResolver({ mode: 'alidns', dnsHttp: dnsFixture() }));
        await expect(
            createSafeHttpClient({ resolve }).request('https://198.18.0.126/v1/models'),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(resolve).not.toHaveBeenCalled();
    });
    it('通用网页HTTP客户端保持拒绝Fake-IP，不隐式启用模型通道', async () => {
        const transport = vi.fn();
        await expect(
            createSafeHttpClient({ resolve: async () => [fake], transport }).request(
                'https://article.example.com',
            ),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).not.toHaveBeenCalled();
    });
});
