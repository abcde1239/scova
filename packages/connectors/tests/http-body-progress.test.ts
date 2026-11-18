import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vite-plus/test';
import { nodeHttpTransport, createSafeHttpClient } from '../src/http/index.ts';
import { createPageReader } from '../src/reader/browser.ts';

describe('Reader body inactivity budget over real sockets', () => {
    it('times out a stalled body and preserves a longer continuously progressing body', async () => {
        const timers = new Set<ReturnType<typeof setInterval>>();
        let retryCalls = 0;
        const server = createServer((request, response) => {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.write('<main>');
            if (request.url === '/stall' || (request.url === '/retry' && ++retryCalls === 1))
                return;
            let count = 0;
            const timer = setInterval(() => {
                response.write('progress ');
                if (++count === 10) {
                    clearInterval(timer);
                    timers.delete(timer);
                    response.end('COMPLETE-END</main>');
                }
            }, 10);
            timers.add(timer);
        });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fixture port');
        const send = (path: string) =>
            nodeHttpTransport(new URL(`http://fixture.example:${address.port}${path}`), {
                address: { address: '127.0.0.1', family: 4 },
                method: 'GET',
                headers: {},
                maxBytes: 1024,
                signal: AbortSignal.timeout(2000),
                bodyIdleTimeoutMs: 40,
                responseEncoding: 'web-text',
            });
        try {
            await expect(send('/stall')).rejects.toMatchObject({
                code: 'timeout',
                message: '来源响应体停止传输',
                retryable: true,
            });
            expect((await send('/flow')).body).toContain('COMPLETE-END');
            const reserve = vi.fn(async () => {});
            const reader = createPageReader({
                http: createSafeHttpClient({
                    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
                    maxAddressAttempts: 3,
                    bodyIdleTimeoutMs: 40,
                    transport: (url, options) =>
                        nodeHttpTransport(
                            new URL(`http://fixture.example:${address.port}${url.pathname}`),
                            {
                                ...options,
                                address: { address: '127.0.0.1', family: 4 },
                            },
                        ),
                }),
            });
            try {
                const page = await reader.read('http://fixture.example/retry', {
                    timeoutMs: 5000,
                    beforeAttempt: reserve,
                });
                expect(page.text).toContain('COMPLETE-END');
                expect(page.truncated).toBe(false);
                expect(reserve).toHaveBeenCalledTimes(2);
                expect(reserve.mock.calls[1]).toMatchObject(['read', { code: 'timeout' }]);
            } finally {
                await reader.close?.();
            }
        } finally {
            for (const timer of timers) clearInterval(timer);
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    });
});
