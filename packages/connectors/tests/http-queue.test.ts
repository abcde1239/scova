import { describe, expect, it, vi } from 'vite-plus/test';
import { createSafeHttpClient, type HttpTransport } from '../src/http.ts';
import { ConnectorError } from '../src/types.ts';

const addresses = [
    { address: '93.184.216.34', family: 4 },
    { address: '93.184.216.35', family: 4 },
];
const ok = { status: 200, headers: {}, body: 'bounded article' };
const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        const stop = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
        }, ms);
        signal.addEventListener('abort', stop, { once: true });
    });

describe('safe HTTP origin dispatch queue', () => {
    it('starts each address timeout after the origin turn rather than consuming it in the queue', async () => {
        vi.useFakeTimers();
        try {
            const transport = vi.fn<HttpTransport>(async (_url, options) => {
                await pause(40, options.signal);
                return ok;
            });
            const http = createSafeHttpClient({
                resolve: async () => addresses,
                transport,
                maxAddressAttempts: 2,
                addressTimeoutMs: 70,
            });
            const pending = Promise.allSettled(
                [0, 1, 2, 3].map((index) =>
                    http.request(`https://fixture.example/${index}`, { timeoutMs: 500 }),
                ),
            );
            await vi.runAllTimersAsync();
            const results = await pending;
            expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
            expect(transport).toHaveBeenCalledTimes(4);
            expect(
                transport.mock.calls.every(([, options]) => options.address === addresses[0]),
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
    it('keeps a slow successful response body on its original IP after headers arrive', async () => {
        vi.useFakeTimers();
        try {
            const transport = vi.fn<HttpTransport>(async (_url, options) => {
                options.onResponseStarted?.();
                await pause(100, options.signal);
                return ok;
            });
            const http = createSafeHttpClient({
                resolve: async () => addresses,
                transport,
                maxAddressAttempts: 2,
                addressTimeoutMs: 20,
            });
            const pending = http.request('https://fixture.example/slow-body', { timeoutMs: 500 });
            await vi.runAllTimersAsync();
            expect((await pending).body).toBe(ok.body);
            expect(transport).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
    it.each(['caller', 'deadline'] as const)(
        'still stops a body after headers on %s cancellation',
        async (source) => {
            const controller = new AbortController();
            let started!: () => void;
            const headers = new Promise<void>((resolve) => {
                started = resolve;
            });
            const transport = vi.fn<HttpTransport>(async (_url, options) => {
                options.onResponseStarted?.();
                started();
                await pause(500, options.signal);
                return ok;
            });
            const http = createSafeHttpClient({
                resolve: async () => addresses,
                transport,
                maxAddressAttempts: 2,
                addressTimeoutMs: 10,
            });
            const pending = http.request('https://fixture.example/slow-body', {
                signal: controller.signal,
                timeoutMs: source === 'deadline' ? 40 : 500,
            });
            const settled = pending.catch((error) => error);
            await headers;
            if (source === 'caller') controller.abort();
            expect(await settled).toMatchObject({
                code: source === 'caller' ? 'aborted' : 'timeout',
            });
            expect(transport).toHaveBeenCalledTimes(1);
            expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
        },
    );
    it('removes cancelled queued work while keeping later requests behind the active turn', async () => {
        let finish!: () => void;
        const busy = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const paths: string[] = [];
        const transport = vi.fn<HttpTransport>(async (url) => {
            paths.push(url.pathname);
            if (url.pathname === '/first') await busy;
            return ok;
        });
        const http = createSafeHttpClient({
            resolve: async () => addresses,
            transport,
            maxAddressAttempts: 2,
            addressTimeoutMs: 1000,
        });
        const first = http.request('https://fixture.example/first');
        await vi.waitFor(() => expect(paths).toEqual(['/first']));
        const controller = new AbortController();
        const second = http.request('https://fixture.example/cancelled', {
            signal: controller.signal,
        });
        const cancelled = second.catch((error) => error);
        controller.abort();
        expect(await cancelled).toBeInstanceOf(ConnectorError);
        expect(await cancelled).toMatchObject({ code: 'aborted' });
        const third = http.request('https://fixture.example/third');
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(paths).toEqual(['/first']);
        finish();
        await Promise.all([first, third]);
        expect(paths).toEqual(['/first', '/third']);
    });
});
