import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { outboxJobId, type OutboxMessage } from '@scova/shared/outbox-job';

export interface OutboxPublisher {
    publish(item: OutboxMessage): Promise<void>;
    readonly queue: Queue;
    close(): Promise<void>;
}

export type OutboxQueue = OutboxPublisher;

/** 使用调用方拥有的 Redis 连接，Queue 只负责发布，不拥有数据库或调度生命周期。 */
export function createOutboxQueue(redis: Redis, queueName = 'scova-runs'): OutboxQueue {
    if (redis.options.enableOfflineQueue !== false)
        throw new Error('Outbox Redis 连接必须配置 enableOfflineQueue: false');
    const queue = new Queue(queueName, { connection: redis, skipWaitingForReady: true });
    // BullMQ 的默认 error 回退会直接打印原始连接错误；操作仍通过 Promise 向上层报告失败。
    queue.on('error', () => undefined);
    return {
        queue,
        async publish(item) {
            await queue.add(item.eventType, item.payload, {
                jobId: outboxJobId(item),
                removeOnComplete: { age: 86400, count: 1000 },
                removeOnFail: { age: 604800, count: 1000 },
            });
        },
        close: () => queue.close(),
    };
}
