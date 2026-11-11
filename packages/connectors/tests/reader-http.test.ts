import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    createReaderDnsResolver,
    createSafeHttpClient,
    type HttpTransport,
    type SafeHttpClient,
} from '../src/index.ts';

afterEach(() => vi.unstubAllEnvs());
const fake = { address: '198.18.0.126', family: 4 };
const real = { address: '93.184.215.14', family: 4 };
function fixture(ip = real.address) {
    const dnsHttp = {
        request: vi.fn<SafeHttpClient['request']>(async (url) => ({
            url,
            status: 200,
            headers: {},
            body: JSON.stringify({ Status: 0, Answer: [{ type: 1, data: ip }] }),
        })),
    };
    return dnsHttp;
}
describe('Reader独立公网解析通道', () => {
    it('auto修复全Fake-IP；模型配置不会隐式改变网页读取', async () => {
        vi.stubEnv('MODEL_DNS_RESOLVER', 'system');
        vi.stubEnv('READER_DNS_RESOLVER', 'auto');
        const dnsHttp = fixture();
        const resolve = createReaderDnsResolver({ lookup: async () => [fake], dnsHttp });
        expect(await resolve('article.example.com')).toEqual([real]);
        expect(dnsHttp.request).toHaveBeenCalledTimes(1);
        expect(new URL(dnsHttp.request.mock.calls[0]![0]).hostname).toBe('cloudflare-dns.com');
    });
    it('auto keeps public system answers and explicit DNS provider choices', async () => {
        const dnsHttp = fixture();
        const lookup = vi.fn(async () => [real, { address: '2606:4700:4700::1111', family: 6 }]);
        const automatic = createReaderDnsResolver({ mode: 'auto', lookup, dnsHttp });
        expect(await automatic('article.example.com')).toEqual(await lookup());
        expect(dnsHttp.request).not.toHaveBeenCalled();
        for (const [mode, hostname] of [
            ['alidns', 'dns.alidns.com'],
            ['google', 'dns.google'],
            ['cloudflare', 'cloudflare-dns.com'],
        ]) {
            dnsHttp.request.mockClear();
            expect(
                await createReaderDnsResolver({ mode, lookup, dnsHttp })('article.example.com'),
            ).toEqual([real]);
            expect(new URL(dnsHttp.request.mock.calls[0]![0]).hostname).toBe(hostname);
        }
    });
    it('forwards cancellation to DoH and does not start DNS after cancellation', async () => {
        const dnsHttp = fixture();
        const resolve = createReaderDnsResolver({
            mode: 'auto',
            lookup: async () => [fake],
            dnsHttp,
        });
        const controller = new AbortController();
        await resolve('article.example.com', controller.signal);
        expect(dnsHttp.request.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
        controller.abort();
        dnsHttp.request.mockClear();
        await expect(resolve('article.example.com', controller.signal)).rejects.toMatchObject({
            code: 'aborted',
        });
        expect(dnsHttp.request).not.toHaveBeenCalled();
    });
    it('system保留拒绝；混合私网解析不能触发回退', async () => {
        const dnsHttp = fixture(),
            transport = vi.fn<HttpTransport>();
        for (const addresses of [[fake], [fake, { address: '127.0.0.1', family: 4 }]]) {
            const resolve = createReaderDnsResolver({
                mode: addresses.length === 1 ? 'system' : 'auto',
                lookup: async () => addresses,
                dnsHttp,
            });
            await expect(
                createSafeHttpClient({ resolve, transport }).request('https://article.example.com'),
            ).rejects.toMatchObject({ code: 'unsafe_url' });
        }
        expect(dnsHttp.request).not.toHaveBeenCalled();
        expect(transport).not.toHaveBeenCalled();
    });
    it('重定向的每一跳再次解析校验，DoH私网响应无法连接', async () => {
        const resolve = createReaderDnsResolver({
            mode: 'auto',
            lookup: async (host) =>
                host === 'article.example.com' ? [fake] : [{ address: '10.0.0.1', family: 4 }],
            dnsHttp: fixture(),
        });
        const transport = vi.fn<HttpTransport>(async () => ({
            status: 302,
            headers: { location: 'https://private.example.com/secret' },
            body: '',
        }));
        await expect(
            createSafeHttpClient({ resolve, transport }).request('https://article.example.com'),
        ).rejects.toMatchObject({ code: 'unsafe_url' });
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.calls[0]?.[1].address).toEqual(real);
        const bad = createReaderDnsResolver({
            mode: 'auto',
            lookup: async () => [fake],
            dnsHttp: fixture('127.0.0.1'),
        });
        await expect(bad('article.example.com')).rejects.toMatchObject({ code: 'unsafe_url' });
    });
});
