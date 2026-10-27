import type { OutboxService } from '@/service/outbox.ts';

/** 后台批次入口；不引入 HTTP router，也不直接执行 Agent。 */
export function createOutboxHandler(
    service: Pick<OutboxService, 'dispatchOnce'>,
    batchSize: number,
) {
    return (signal: AbortSignal) => service.dispatchOnce(batchSize, signal);
}
