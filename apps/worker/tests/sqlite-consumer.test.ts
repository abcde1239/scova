import { mkdtemp, readFile, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vite-plus/test';
import { createWorkerApp } from '../src/app/index.ts';
import { readWorkerConfig } from '../src/app/config.ts';
import { createSqliteRunConsumer } from '../src/app/queue/sqlite-runs.ts';
import { waitForPoll } from '../src/utils/wait.ts';

it('SQLite 领取持续失败会撤下真实心跳，空队列恢复后重新就绪', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scova-sqlite-heartbeat-'));
    const path = join(directory, 'ready');
    vi.stubEnv('WORKER_HEARTBEAT_PATH', path);
    const claim = vi.fn<() => Promise<null>>().mockRejectedValue(new Error('offline'));
    const consumer = createSqliteRunConsumer(
        {
            claim,
            renew: async () => true,
            settle: async () => true,
        },
        async () => undefined,
        32,
    );
    const app = createWorkerApp({
        config: readWorkerConfig({ WORKER_EXECUTION_TOKEN: 'test'.repeat(8) }),
        resources: { ...consumer, connect: () => consumer.start(), close: async () => undefined },
        wait: (_ms, signal) => waitForPoll(10, signal),
        logger: { info() {} },
    });
    try {
        await app.start();
        await vi.waitFor(() => expect(claim).toHaveBeenCalledTimes(2), { timeout: 2000 });
        expect(consumer.isReady()).toBe(false);
        await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        claim.mockResolvedValue(null);
        await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('ready\n'), {
            timeout: 2000,
        });
        const before = claim.mock.calls.length;
        await vi.waitFor(() => expect(claim.mock.calls.length).toBeGreaterThan(before));
        expect(consumer.isReady()).toBe(true);
        claim.mockRejectedValue(new Error('disconnected'));
        await vi.waitFor(() => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }));
        expect(consumer.isReady()).toBe(false);
        claim.mockResolvedValue(null);
        await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('ready\n'), {
            timeout: 2000,
        });
    } finally {
        await app.stop();
        vi.unstubAllEnvs();
        await rmdir(directory);
    }
}, 10_000);

it('SQLite fills slots, pauses claiming while full, and drains jobs before stop', async () => {
    const jobs = ['a', 'b', 'c'].map((id) => ({
        id,
        owner: 'owner',
        name: 'run.enqueue',
        data: id,
    }));
    const active = new Map<unknown, { signal: AbortSignal; finish(): void }>();
    const claim = vi.fn(async () => jobs.shift() ?? null);
    const settle = vi.fn<Parameters<typeof createSqliteRunConsumer>[0]['settle']>(async () => true);
    const consumer = createSqliteRunConsumer(
        { claim, settle, renew: async () => true },
        (_name, id, signal) => new Promise<void>((finish) => active.set(id, { signal, finish })),
        2,
    );
    try {
        await consumer.start();
        await vi.waitFor(() => expect(active.size).toBe(2));
        expect(claim).toHaveBeenCalledTimes(2);
        active.get('a')!.finish();
        await vi.waitFor(() => expect(active.has('c')).toBe(true));
        expect(claim).toHaveBeenCalledTimes(3);
        const stopping = consumer.stop();
        expect(active.get('b')!.signal.aborted).toBe(true);
        expect(active.get('c')!.signal.aborted).toBe(true);
        expect(settle).toHaveBeenCalledTimes(1);
        active.get('b')!.finish();
        active.get('c')!.finish();
        await stopping;
        expect(settle.mock.calls.map(([, retry]) => retry)).toEqual([false, true, true]);
    } finally {
        for (const entry of active.values()) entry.finish();
        await consumer.stop();
    }
});
