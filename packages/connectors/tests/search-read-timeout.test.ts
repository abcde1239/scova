import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ConnectorError,
    READ_CALL_TIMEOUT_MS,
    createSafeHttpClient,
    createSearchApi,
    type HttpTransport,
    type ReadDiagnostic,
} from '../src/index.ts';

function fixture(delay?: number) {
    let transportSignal: AbortSignal | undefined;
    const transport = vi.fn<HttpTransport>(async (_url, options) => {
        transportSignal = options.signal;
        await new Promise((resolve) => {
            if (delay !== undefined) setTimeout(resolve, delay);
        });
        return { status: 200, headers: {}, body: '{"title":"Page","content":"Original body"}' };
    });
    const http = createSafeHttpClient({
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
        maxTimeoutMs: READ_CALL_TIMEOUT_MS,
    });
    return {
        source: createSearchApi({ protocol: 'deepseek', apiKey: 'fixture-key', http }),
        transport,
        signal: () => transportSignal,
    };
}

describe('Search API read deadline', () => {
    it('allows remote extraction beyond15seconds without hidden provider or HTTP clipping', async () => {
        vi.useFakeTimers();
        try {
            const { source, transport } = fixture(20_000);
            const assertion = expect(
                source.read('https://source.example/article'),
            ).resolves.toMatchObject({ text: 'Original body' });
            await vi.advanceTimersByTimeAsync(20_001);
            await assertion;
            expect(transport).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([undefined, 120_000])(
        'caps remote reads at45seconds, including caller limit %s',
        async (timeoutMs) => {
            vi.useFakeTimers();
            try {
                const { source, transport, signal } = fixture();
                const assertion = expect(
                    source.read('https://source.example/article', { timeoutMs }),
                ).rejects.toMatchObject({ code: 'timeout' });
                await vi.advanceTimersByTimeAsync(READ_CALL_TIMEOUT_MS + 1);
                await assertion;
                expect(signal()?.aborted).toBe(true);
                expect(transport).toHaveBeenCalledTimes(1);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it('keeps a shorter caller deadline and cancels the transport', async () => {
        vi.useFakeTimers();
        try {
            const { source, signal } = fixture();
            const assertion = expect(
                source.read('https://source.example/article', { timeoutMs: 5000 }),
            ).rejects.toMatchObject({ code: 'timeout' });
            await vi.advanceTimersByTimeAsync(5001);
            await assertion;
            expect(signal()?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending remote read without waiting for its longer deadline', async () => {
        vi.useFakeTimers();
        try {
            const { source, signal } = fixture();
            const controller = new AbortController();
            const assertion = expect(
                source.read('https://source.example/article', { signal: controller.signal }),
            ).rejects.toMatchObject({ code: 'aborted' });
            await vi.advanceTimersByTimeAsync(1);
            controller.abort();
            await assertion;
            expect(signal()?.aborted).toBe(true);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not extend search calls to the read allowance', async () => {
        vi.useFakeTimers();
        try {
            const { source, signal } = fixture();
            const assertion = expect(source.search('query')).rejects.toMatchObject({
                code: 'timeout',
            });
            await vi.advanceTimersByTimeAsync(15_001);
            await assertion;
            expect(signal()?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('passes trusted guards and phase diagnostics to the actual HTTP dispatch', async () => {
        const { source, transport } = fixture(0);
        const diagnostics: ReadDiagnostic[] = [];
        const failure = new ConnectorError('budget_exceeded', 'guard refused');
        const beforeDispatch = vi.fn(async () => {
            throw failure;
        });
        await expect(
            source.read('https://source.example/article', {
                beforeDispatch,
                onReadDiagnostic: (event) => diagnostics.push(event),
            }),
        ).rejects.toBe(failure);
        expect(beforeDispatch).toHaveBeenCalledTimes(1);
        expect(transport).not.toHaveBeenCalled();
        expect(diagnostics).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ phase: 'dns', state: 'end' }),
                expect.objectContaining({
                    phase: 'dispatch',
                    state: 'error',
                    code: 'budget_exceeded',
                }),
            ]),
        );
    });
});
