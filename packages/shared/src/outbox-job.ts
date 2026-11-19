/** BullMQ job identity shared by the publisher and offline retention tools. */
export interface OutboxMessage {
    id: string;
    eventType: string;
    payload: unknown;
}

export function outboxJobId(item: OutboxMessage): string {
    const payload = item.payload as { runId?: unknown } | null;
    return item.eventType === 'run.enqueue' && typeof payload?.runId === 'string'
        ? `run-${payload.runId}`
        : `outbox-${item.eventType}-${item.id}`;
}

export function readRunQueueName(env: Record<string, string | undefined>) {
    const name = env.WORKER_QUEUE_NAME ?? 'scova-runs';
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(name))
        throw new Error('WORKER_QUEUE_NAME 仅允许 1 至 100 位字母、数字、下划线或连字符');
    return name;
}
