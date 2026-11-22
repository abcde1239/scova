import { readSqliteStatePath } from '@scova/db/sqlite-state';
import { readRunQueueName } from '@scova/shared/outbox-job';

function integerSetting(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number) {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`${name} 必须为 1 至 ${maximum} 的整数`);
    return value;
}

/** 兼容原 WORKER_* 环境变量，但这些批次参数现在仅由 Server 读取。 */
export function readRunControlConfig(env: NodeJS.ProcessEnv = process.env) {
    return {
        databaseUrl: env.DATABASE_URL,
        redisUrl: env.REDIS_URL,
        sqliteStatePath: readSqliteStatePath(env),
        queueName: readRunQueueName(env),
        pollIntervalMs: integerSetting(env, 'WORKER_POLL_INTERVAL_MS', 1000, 300_000),
        failureDelayMs: integerSetting(env, 'WORKER_FAILURE_DELAY_MS', 5000, 300_000),
        batchSize: integerSetting(env, 'WORKER_BATCH_SIZE', 50, 1000),
        leaseSeconds: integerSetting(env, 'WORKER_LEASE_SECONDS', 30, 3600),
        schedulerIntervalMs: integerSetting(env, 'WORKER_SCHEDULER_INTERVAL_MS', 30_000, 300_000),
        schedulerConcurrency: integerSetting(env, 'WORKER_SCHEDULER_CONCURRENCY', 2, 8),
    };
}

export type RunControlConfig = ReturnType<typeof readRunControlConfig>;
