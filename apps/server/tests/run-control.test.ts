import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { createRunControl } from '../src/app/run-control.ts';
import { readRunControlConfig } from '../src/app/run-control-config.ts';

const mocks = vi.hoisted(() => ({
    publishBatch: vi.fn<() => Promise<number>>(),
    scheduleBatch: vi.fn<() => Promise<number>>(),
    findRecoverable: vi.fn<() => Promise<unknown[]>>(),
    enqueueRecovery: vi.fn<() => Promise<number>>(),
    closeQueue: vi.fn<() => Promise<void>>(),
    closeDatabase: vi.fn<() => Promise<void>>(),
    disconnect: vi.fn(),
}));
vi.mock('@scova/db', () => ({
    createDatabaseClient: () => ({}),
    closeDatabase: mocks.closeDatabase,
}));
vi.mock('../src/repo/redis.ts', () => ({
    createRedisConnection: () => ({
        status: 'ready',
        connect: async () => undefined,
        disconnect: mocks.disconnect,
    }),
}));
vi.mock('../src/repo/queue/outbox.ts', () => ({
    createOutboxQueue: () => ({ queue: {}, close: mocks.closeQueue }),
}));
vi.mock('../src/repo/outbox.ts', () => ({ createOutboxRepository: () => ({}) }));
vi.mock('../src/repo/scheduler.ts', () => ({ createSchedulerRepository: () => ({}) }));
vi.mock('../src/repo/recoverable-runs.ts', () => ({ listRecoverableRuns: mocks.findRecoverable }));
vi.mock('../src/repo/queue/recoverable-runs.ts', () => ({
    enqueueRecoverableRuns: mocks.enqueueRecovery,
}));
vi.mock('../src/service/outbox.ts', () => ({
    OutboxService: class {
        dispatchOnce = mocks.publishBatch;
    },
}));
vi.mock('../src/service/scheduler.ts', () => ({
    SchedulerService: class {
        scheduleOnce = mocks.scheduleBatch;
    },
}));

const env = {
    DATABASE_URL: 'postgresql://localhost/scova',
    REDIS_URL: 'redis://localhost',
    WORKER_POLL_INTERVAL_MS: '1',
    WORKER_FAILURE_DELAY_MS: '100',
    WORKER_SCHEDULER_INTERVAL_MS: '1',
};

beforeEach(() => {
    vi.resetAllMocks();
    mocks.publishBatch.mockResolvedValue(0);
    mocks.scheduleBatch.mockResolvedValue(0);
    mocks.findRecoverable.mockResolvedValue([]);
    mocks.enqueueRecovery.mockResolvedValue(0);
});
afterEach(() => vi.restoreAllMocks());

describe('Server Run 控制面', () => {
    it('每类批次串行；停止先禁用回补并等待在途投递，再释放资源', async () => {
        let release!: (count: number) => void;
        mocks.publishBatch.mockReturnValue(
            new Promise((resolve) => {
                release = resolve;
            }),
        );
        const control = createRunControl(readRunControlConfig(env));
        expect(mocks.publishBatch).not.toHaveBeenCalled();
        try {
            control.start();
            control.start();
            await vi.waitFor(() =>
                expect(mocks.scheduleBatch.mock.calls.length).toBeGreaterThan(1),
            );
            expect(mocks.publishBatch).toHaveBeenCalledOnce();
            const stop = control.stop();
            expect(control.stop()).toBe(stop);
            expect(mocks.closeQueue).not.toHaveBeenCalled();
            release(1);
            await stop;
            expect(mocks.findRecoverable).not.toHaveBeenCalled();
            expect(mocks.closeQueue).toHaveBeenCalledOnce();
            expect(mocks.disconnect).toHaveBeenCalledOnce();
            expect(mocks.closeDatabase).toHaveBeenCalledOnce();
        } finally {
            release(1);
            await control.stop();
        }
    });

    it('投递失败仅记录脱敏信息，独立调度仍继续，退避后恢复扫描', async () => {
        const logs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.publishBatch.mockRejectedValueOnce(new Error('redis://user:secret@private-host'));
        const control = createRunControl(readRunControlConfig(env));
        try {
            control.start();
            await vi.waitFor(() => expect(mocks.enqueueRecovery).toHaveBeenCalled(), {
                timeout: 1000,
            });
            expect(mocks.scheduleBatch.mock.calls.length).toBeGreaterThan(1);
            expect(logs.mock.calls).toEqual([['Server Run 投递/回补批次失败，将退避后重试']]);
        } finally {
            await control.stop();
        }
    });

    it('历史 WORKER_* 批次参数由 Server 继续校验并生效', () => {
        expect(
            readRunControlConfig({
                ...env,
                WORKER_BATCH_SIZE: '12',
                WORKER_SCHEDULER_CONCURRENCY: '4',
            }),
        ).toMatchObject({
            batchSize: 12,
            schedulerConcurrency: 4,
            pollIntervalMs: 1,
        });
        expect(() => readRunControlConfig({ ...env, WORKER_BATCH_SIZE: '0' })).toThrow(
            'WORKER_BATCH_SIZE',
        );
    });
});
