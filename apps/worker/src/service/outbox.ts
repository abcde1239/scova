import type { OutboxRepository } from '@/repo/outbox.ts';
import type { OutboxPublisher } from '@/queue/outbox.ts';
import { OutboxLeaseLostError, outboxRetryDelayMilliseconds } from '@/utils/outbox.ts';

export interface OutboxServiceOptions {
    repository: OutboxRepository;
    publisher: Pick<OutboxPublisher, 'publish'>;
    clock?: () => Date;
    leaseSeconds?: number;
}

/** 编排一次领取、发布与 fenced 回写；依赖资源由应用装配层关闭。 */
export class OutboxService {
    private readonly repository: OutboxRepository;
    private readonly publisher: Pick<OutboxPublisher, 'publish'>;
    private readonly clock: () => Date;
    private readonly leaseSeconds: number;

    constructor(options: OutboxServiceOptions) {
        this.repository = options.repository;
        this.publisher = options.publisher;
        this.clock = options.clock ?? (() => new Date());
        this.leaseSeconds = options.leaseSeconds ?? 30;
        if (!Number.isSafeInteger(this.leaseSeconds) || this.leaseSeconds < 1)
            throw new Error('Outbox 租约秒数必须为正安全整数');
    }

    async dispatchOnce(limit = 50, signal?: AbortSignal): Promise<number> {
        if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error('Outbox 投递上限必须为正整数');
        let delivered = 0;
        for (let index = 0; index < limit; index += 1) {
            if (signal?.aborted) break;
            const now = this.clock();
            const leaseExpiresAt = new Date(now.getTime() + this.leaseSeconds * 1000);
            if (!Number.isFinite(leaseExpiresAt.getTime())) throw new Error('Outbox 租约时刻无效');
            const item = await this.repository.claim(now, leaseExpiresAt);
            if (!item) break;
            try {
                await this.publisher.publish(item);
            } catch (error) {
                const failedAt = this.clock();
                const released = await this.repository.retry(
                    item,
                    failedAt,
                    new Date(failedAt.getTime() + outboxRetryDelayMilliseconds(item.attempts)),
                );
                if (!released) throw new OutboxLeaseLostError('retry');
                if (error instanceof Error) throw error;
                throw new Error('BullMQ 投递失败');
            }
            // 发布成功但数据库确认失败时保留原租约，不运行 release，以便到期后至少一次重投。
            const acknowledged = await this.repository.ack(item, this.clock());
            if (!acknowledged) throw new OutboxLeaseLostError('ack');
            delivered += 1;
        }
        return delivered;
    }
}
