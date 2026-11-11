import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    createSafeHttpClient,
    isPublicIp,
    type HttpTransport,
} from '../src/index.ts';

const addresses = ['93.184.216.34', '93.184.216.35', '93.184.216.36', '93.184.216.37'].map(
    (address) => ({ address, family: 4 }),
);
const ok = { status: 200, headers: {}, body: 'article' };
describe('bounded public address fallback', () => {
    it('bounds response headers even when only one public address exists', async () => {
        const transport = vi.fn<HttpTransport>(
            async (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                        once: true,
                    });
                }),
        );
        const http = createSafeHttpClient({
            resolve: async () => addresses.slice(0, 1),
            transport,
            addressTimeoutMs: 20,
            maxAddressAttempts: 3,
        });
        await expect(
            http.request('https://article.example', { timeoutMs: 200 }),
        ).rejects.toMatchObject({ code: 'timeout', message: '来源连接或响应头超时' });
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    });
    it('reserves time for a second verified address when the first route stalls', async () => {
        const transport = vi.fn<HttpTransport>(async (_url, options) => {
            if (options.address.address === addresses[0].address)
                return new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                        once: true,
                    });
                });
            return ok;
        });
        const http = createSafeHttpClient({
            resolve: async () => addresses.slice(0, 2),
            maxAddressAttempts: 2,
            addressTimeoutMs: 20,
            transport,
        });
        expect((await http.request('https://article.example', { timeoutMs: 200 })).body).toBe(
            'article',
        );
        expect(transport).toHaveBeenCalledTimes(2);
        expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    });

    it('allows public 192.0 networks without allowing protocol-assignment/documentation ranges', async () => {
        for (const address of ['192.0.66.161', '192.0.64.1', '192.0.67.1'])
            expect(isPublicIp(address)).toBe(true);
        for (const address of [
            '192.0.0.1',
            '192.0.0.170',
            '192.0.2.1',
            '192.88.99.1',
            '192.168.1.1',
        ])
            expect(isPublicIp(address)).toBe(false);
        const transport = vi.fn<HttpTransport>().mockResolvedValue(ok);
        const publicAddress = { address: '192.0.66.161', family: 4 };
        const http = createSafeHttpClient({ resolve: async () => [publicAddress], transport });
        expect((await http.request('https://science.example')).body).toBe('article');
        const mixed = createSafeHttpClient({
            resolve: async () => [publicAddress, { address: '192.0.0.170', family: 4 }],
            transport,
        });
        await expect(mixed.request('https://science.example')).rejects.toMatchObject({
            code: 'unsafe_url',
        });
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it('pins the next verified address after a connection failure and preserves hostname', async () => {
        const transport = vi
            .fn<HttpTransport>()
            .mockRejectedValueOnce(new ConnectorError('network', 'reset', true))
            .mockResolvedValue(ok);
        const http = createSafeHttpClient({
            resolve: async () => addresses,
            transport,
            maxAddressAttempts: 3,
        });
        expect((await http.request('https://article.example/path')).body).toBe('article');
        expect(
            transport.mock.calls.map(([url, opts]) => [url.hostname, opts.address.address]),
        ).toEqual([
            ['article.example', addresses[0].address],
            ['article.example', addresses[1].address],
        ]);
    });
    it('caps fallback, never replays POST, and does not retry access/size/security errors', async () => {
        const transport = vi.fn<HttpTransport>(async () => {
            throw new ConnectorError('network', 'reset', true);
        });
        const http = createSafeHttpClient({
            resolve: async () => addresses,
            transport,
            maxAddressAttempts: 3,
        });
        await expect(http.request('https://article.example')).rejects.toMatchObject({
            code: 'network',
        });
        expect(transport).toHaveBeenCalledTimes(3);
        transport.mockClear();
        await expect(
            http.request('https://article.example', { method: 'POST' }),
        ).rejects.toMatchObject({ code: 'network' });
        expect(transport).toHaveBeenCalledTimes(1);
        for (const code of ['response_too_large', 'unsafe_url', 'invalid_response'] as const) {
            transport.mockReset().mockRejectedValue(new ConnectorError(code, 'blocked'));
            await expect(http.request('https://article.example')).rejects.toMatchObject({ code });
            expect(transport).toHaveBeenCalledTimes(1);
        }
        transport.mockReset().mockResolvedValue({ status: 403, headers: {}, body: '' });
        expect((await http.request('https://article.example')).status).toBe(403);
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it.each([4, 6])(
        'tries the other address family before exhausting three IPv%s addresses',
        async (firstFamily) => {
            const ipv6 = [
                '2001:4860:4860::8888',
                '2001:4860:4860::8844',
                '2001:4860:4860::6464',
            ].map((address) => ({ address, family: 6 }));
            const first = firstFamily === 4 ? addresses.slice(0, 3) : ipv6;
            const other = firstFamily === 4 ? ipv6[0] : addresses[0];
            const transport = vi.fn<HttpTransport>(async (_url, options) => {
                if (options.address.family === firstFamily)
                    throw new ConnectorError('network', 'unreachable family', true);
                return ok;
            });
            const http = createSafeHttpClient({
                resolve: async () => [...first, other],
                transport,
                maxAddressAttempts: 3,
            });
            expect((await http.request('https://article.example/path')).body).toBe('article');
            expect(transport.mock.calls.map(([, options]) => options.address)).toEqual([
                first[0],
                other,
            ]);
        },
    );
    it('validates every DNS address before trying any and shares the original deadline', async () => {
        const transport = vi.fn<HttpTransport>();
        const bad = createSafeHttpClient({
            resolve: async () => [...addresses, { address: '127.0.0.1', family: 4 }],
            transport,
            maxAddressAttempts: 3,
        });
        await expect(bad.request('https://article.example')).rejects.toMatchObject({
            code: 'unsafe_url',
        });
        expect(transport).not.toHaveBeenCalled();
        transport.mockImplementation(
            async (_url, options) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener(
                        'abort',
                        () => reject(new ConnectorError('aborted', 'stopped')),
                        { once: true },
                    );
                }),
        );
        const http = createSafeHttpClient({
            resolve: async () => addresses,
            transport,
            maxAddressAttempts: 3,
        });
        await expect(
            http.request('https://article.example', { timeoutMs: 30 }),
        ).rejects.toMatchObject({ code: 'timeout' });
        expect(transport).toHaveBeenCalledTimes(1);
    });
});
