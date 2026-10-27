import { describe, expect, it } from 'vite-plus/test';
import { readWorkerConfig } from '../src/app/config.ts';

const base = {
    DATABASE_URL: 'postgresql://worker:secret@localhost/scova',
    REDIS_URL: 'redis://:secret@localhost:6379',
};

describe('Worker 配置与脱敏校验', () => {
    it('使用有界默认参数，并保留连接与队列配置', () => {
        expect(readWorkerConfig(base)).toEqual({
            databaseUrl: base.DATABASE_URL,
            redisUrl: base.REDIS_URL,
            queueName: 'scova-runs',
            pollIntervalMs: 1000,
            failureDelayMs: 5000,
            batchSize: 50,
            leaseSeconds: 30,
            runLeaseSeconds: 30,
            runConcurrency: 2,
            schedulerIntervalMs: 30_000,
            schedulerConcurrency: 2,
            scheduledRunMode: 'demo',
        });
        expect(
            readWorkerConfig({
                DATABASE_URL: 'postgres://localhost/scova',
                REDIS_URL: 'rediss://localhost',
            }).redisUrl,
        ).toBe('rediss://localhost');
    });

    it.each([
        ['WORKER_POLL_INTERVAL_MS', 'pollIntervalMs', 300_000],
        ['WORKER_FAILURE_DELAY_MS', 'failureDelayMs', 300_000],
        ['WORKER_BATCH_SIZE', 'batchSize', 1000],
        ['WORKER_LEASE_SECONDS', 'leaseSeconds', 3600],
        ['WORKER_RUN_LEASE_SECONDS', 'runLeaseSeconds', 3600],
        ['WORKER_RUN_CONCURRENCY', 'runConcurrency', 32],
        ['WORKER_SCHEDULER_INTERVAL_MS', 'schedulerIntervalMs', 300_000],
        ['WORKER_SCHEDULER_CONCURRENCY', 'schedulerConcurrency', 8],
    ] as const)('%s 接受边界并拒绝非整数、越界和空值', (variable, field, maximum) => {
        for (const accepted of [1, maximum])
            expect(readWorkerConfig({ ...base, [variable]: String(accepted) })[field]).toBe(
                accepted,
            );
        for (const rejected of ['', '0', '-1', '1.5', 'NaN', 'Infinity', String(maximum + 1)])
            expect(() => readWorkerConfig({ ...base, [variable]: rejected })).toThrow(variable);
    });

    it.each(['DATABASE_URL', 'REDIS_URL'] as const)('%s 缺失或非法时仅指出变量名', (variable) => {
        for (const value of [
            undefined,
            '',
            'bad-connection-secret',
            'https://user:secret@private-host/db',
            'redis://user:secret@/db',
        ]) {
            expect(() => readWorkerConfig({ ...base, [variable]: value })).toThrow(
                new Error(`${variable} 缺失或连接地址无效`),
            );
        }
    });

    it('队列名允许约定字符及长度边界，拒绝 BullMQ 保留冒号', () => {
        for (const queueName of ['a', 'scova_RUNS-2', 'a'.repeat(100)])
            expect(readWorkerConfig({ ...base, WORKER_QUEUE_NAME: queueName }).queueName).toBe(
                queueName,
            );
        for (const queueName of ['', 'a'.repeat(101), 'scova:runs', '含中文', 'scova runs'])
            expect(() => readWorkerConfig({ ...base, WORKER_QUEUE_NAME: queueName })).toThrow(
                'WORKER_QUEUE_NAME',
            );
    });

    it('周期执行 mode 仅由显式部署配置决定，不随模型凭据自动切换', () => {
        expect(readWorkerConfig({ ...base, MODEL_API_KEY: 'secret' }).scheduledRunMode).toBe(
            'demo',
        );
        expect(
            readWorkerConfig({ ...base, WORKER_SCHEDULED_RUN_MODE: 'live' }).scheduledRunMode,
        ).toBe('live');
        for (const mode of ['', 'auto', 'LIVE'])
            expect(() => readWorkerConfig({ ...base, WORKER_SCHEDULED_RUN_MODE: mode })).toThrow(
                'WORKER_SCHEDULED_RUN_MODE',
            );
    });
});
