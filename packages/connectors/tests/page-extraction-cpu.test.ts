import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const state = vi.hoisted(() => ({
    fixture: '',
    cpu: false,
    started: undefined as (() => void) | undefined,
    child: undefined as ChildProcessWithoutNullStreams | undefined,
}));
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        spawn: (...args: Parameters<typeof actual.spawn>) => {
            const [executable, parameters, options] = args;
            const child = actual.spawn(
                executable,
                state.cpu ? [...(parameters ?? []).slice(0, -1), state.fixture] : parameters,
                options,
            ) as ChildProcessWithoutNullStreams;
            if (state.cpu) {
                state.child = child;
                child.stderr.on('data', (chunk: Buffer) => {
                    if (chunk.toString().includes('CPU_READY')) state.started?.();
                });
            }
            return child;
        },
    };
});
import { extractPageIsolated } from '../src/reader/extraction/process.ts';

afterEach(() => {
    state.cpu = false;
    state.started = undefined;
    state.child?.kill();
    state.child = undefined;
});

describe('actual synchronous extraction CPU isolation', () => {
    it('keeps the caller responsive, enforces the deadline, reaps the CPU host and recovers', async () => {
        state.fixture = fileURLToPath(
            new URL('./fixtures/extraction-cpu-host.mjs', import.meta.url),
        );
        state.cpu = true;
        const entered = new Promise<void>((resolve) => {
            state.started = resolve;
        });
        const url = 'https://public.example/article';
        const response = {
            url,
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: '<article><p>The next article still works after a CPU deadline.</p></article>',
        };
        const before = performance.now();
        const result = extractPageIsolated(url, response, 1_000_000, undefined, false, {
            timeoutMs: 1200,
        }).then(
            () => null,
            (error) => error,
        );
        await Promise.race([
            entered,
            result.then(() => {
                throw new Error('CPU fixture never started before its deadline');
            }),
        ]);
        // This timer must fire while the host is synchronously busy.
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(state.child?.exitCode).toBeNull();
        expect(await result).toMatchObject({ code: 'timeout' });
        expect(performance.now() - before).toBeLessThan(3000);
        expect(state.child?.exitCode !== null || state.child?.signalCode !== null).toBe(true);
        state.cpu = false;
        const recovered = await extractPageIsolated(url, response, 1_000_000);
        expect(recovered.text).toContain('next article still works');
    });
});
