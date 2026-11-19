import { Queue } from 'bullmq';
import { outboxJobId, type OutboxMessage } from '@scova/shared/outbox-job';
import { createRedisConnection } from '../redis.ts';

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
        async function removeJob(jobId: string) {
            const job = await jobs.getJob(jobId);
            if (job) await job.remove();
        }
        for (const item of outbox) await removeJob(outboxJobId(item));
        for (const run of runs) {
            await removeJob(`run-${run.id}`);
            for (let epoch = 0; epoch <= run.lease_epoch; epoch++) {
                await removeJob(`run-recover-${run.id}-${epoch}`);
            }
        }
    } finally {
        try {
            await queue?.close();
        } finally {
            redis.disconnect();
        }
    }
}
