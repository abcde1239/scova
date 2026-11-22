import { mkdtemp, readFile, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createWorkerApp } from '../src/app/index.ts';
import { readWorkerConfig } from '../src/app/config.ts';
import type { WorkerResources } from '../src/app/resources.ts';
import { waitForPoll } from '../src/utils/wait.ts';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const config = readWorkerConfig({
    WORKER_EXECUTION_TOKEN: 'test'.repeat(8),
    REDIS_URL: 'redis://:secret@localhost:6379',
});

function harness(overrides: Partial<WorkerResources> = {}) {
    const consumer = deferred();
    const resources = {
        connect: vi.fn(async () => {}),
        stop: vi.fn(async () => consumer.resolve()),
        isReady: vi.fn(() => true),
        finished: () => consumer.promise,
        close: vi.fn(async () => {}),
        ...overrides,
    };
    const logger = { info: vi.fn() };
    const nextCheck = vi.fn((_milliseconds: number, signal: AbortSignal) => waitForPoll(5, signal));
    const app = createWorkerApp({ config, resources, logger, wait: nextCheck });
    return { app, resources, logger, nextCheck };
}

afterEach(() => vi.unstubAllEnvs());

describe('Worker consumer 生命周期', () => {
    it('就绪才刷新心跳，Redis 未就绪时撤下，恢复后重新写入，关停清除', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'scova-heartbeat-'));
        const path = join(dir, 'heartbeat');
        vi.stubEnv('WORKER_HEARTBEAT_PATH', path);
        await writeFile(path, 'stale');
        const ready = vi.fn(() => false);
        const { app } = harness({ isReady: ready });
        try {
            await app.start();
            await vi.waitFor(() => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }));
            ready.mockReturnValue(true);
            await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('ready\n'));
            ready.mockReturnValue(false);
            await vi.waitFor(() => expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }));
            ready.mockReturnValue(true);
            await vi.waitFor(async () => expect(await readFile(path, 'utf8')).toBe('ready\n'));
        } finally {
            await app.stop();
            await rmdir(dir);
        }
    });

    it('stop 等待在途消费完成后仅关闭资源一次', async () => {
        const draining = deferred();
        const stop = vi.fn(() => draining.promise);
        const { app, resources } = harness({ stop, finished: () => draining.promise });
        await app.start();
        const stopping = app.stop();
        expect(app.stop()).toBe(stopping);
        await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
        expect(resources.close).not.toHaveBeenCalled();
        draining.resolve();
        await stopping;
        await app.finished();
        expect(resources.close).toHaveBeenCalledOnce();
        await expect(app.start()).rejects.toThrow('已停止');
    });

    it('启动连接失败自动清理，重复停止不重复关闭且不发布就绪日志', async () => {
        const failure = new Error('connection failed');
        const connect = vi.fn(async () => {
            throw failure;
        });
        const { app, resources, logger } = harness({ connect });
        await expect(app.start()).rejects.toBe(failure);
        expect(logger.info).not.toHaveBeenCalled();
        expect(resources.close).toHaveBeenCalledOnce();
        await app.stop();
        expect(resources.close).toHaveBeenCalledOnce();
    });

    it('初始化尚未完成时停止，等待初始化后清理且不公布就绪', async () => {
        const connecting = deferred();
        const { app, resources, logger, nextCheck } = harness({
            connect: () => connecting.promise,
        });
        const starting = app.start();
        const stopping = app.stop();
        expect(resources.close).not.toHaveBeenCalled();
        connecting.resolve();
        await Promise.all([starting, stopping]);
        expect(nextCheck).not.toHaveBeenCalled();
        expect(logger.info).not.toHaveBeenCalled();
        expect(resources.close).toHaveBeenCalledOnce();
    });
});
