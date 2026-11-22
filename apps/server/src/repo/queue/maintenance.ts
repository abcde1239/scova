import { openSqliteRunQueue } from '@scova/db/sqlite-state';
import { Queue } from 'bullmq';
import { outboxJobId, type OutboxMessage } from '@scova/shared/outbox-job';
import { createRedisConnection } from '../redis.ts';

function* accountJobIds(
    runs: readonly { id: string; lease_epoch: number }[],
    outbox: readonly OutboxMessage[],
) {
    for (const item of outbox) yield outboxJobId(item);
    for (const run of runs) {
        yield `run-${run.id}`;
        for (let epoch = 0; epoch <= run.lease_epoch; epoch++)
            yield `run-recover-${run.id}-${epoch}`;
    }
}

export function removeLocalAccountJobs(
    path: string,
    queueName: string,
    runs: readonly { id: string; lease_epoch: number }[],
    outbox: readonly OutboxMessage[],
) {
    const queue = openSqliteRunQueue(path, queueName);
    try {
        queue.remove(accountJobIds(runs, outbox));
    } finally {
        queue.close();
    }
}

/** 离线维护：移除账号的 Outbox 作业和 Run 各租约 epoch 对应的作业。 */
export async function removeAccountJobs(
    redisUrl: string,
    queueName: string,
    runs: readonly { id: string; lease_epoch: number }[],
    outbox: readonly OutboxMessage[],
) {
    const redis = createRedisConnection(redisUrl, { retryStrategy: () => null });
    let queue: Queue | undefined;
    try {
        await redis.connect();
        const jobs = (queue = new Queue(queueName, { connection: redis }));
        jobs.on('error', () => undefined);
        for (const id of accountJobIds(runs, outbox)) {
            const job = await jobs.getJob(id);
            if (job) await job.remove();
        }
    } finally {
        try {
            await queue?.close();
        } finally {
            redis.disconnect();
        }
    }
}
