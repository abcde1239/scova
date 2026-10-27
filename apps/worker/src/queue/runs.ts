import { Worker, type Queue } from 'bullmq';
import { Redis } from 'ioredis';

export interface RecoverableRun {
    id: string;
    leaseEpoch: number;
}

/** 恢复使用独立 epoch jobId；清除已保留的终态 job，避免永久被 BullMQ 去重。 */
export async function enqueueRecoverableRuns(
    queue: Queue,
    runs: RecoverableRun[],
    signal?: AbortSignal,
) {
    let queued = 0;
    for (const run of runs) {
        if (signal?.aborted) break;
        const jobId = `run-recover-${run.id}-${run.leaseEpoch}`;
        const existing = await queue.getJob(jobId);
        if (existing) {
            const state = await existing.getState();
            if (state !== 'completed' && state !== 'failed') continue;
            // 若其他扫描者已删除或重新激活该 job，本次失败交由下一轮重试。
            await existing.remove();
        }
        await queue.add(
            'run.enqueue',
            { runId: run.id },
            {
                jobId,
                removeOnComplete: { age: 86400, count: 1000 },
                removeOnFail: { age: 604800, count: 1000 },
            },
        );
        queued += 1;
    }
    return queued;
}

/** consumer 拥有独立阻塞连接；PostgreSQL 租约是执行互斥的事实源。 */
export function createRunConsumer(
    redisUrl: string,
    queueName: string,
    handler: (name: string, data: unknown, signal: AbortSignal) => Promise<unknown>,
    concurrency = 2,
) {
    const controller = new AbortController();
    const pending = new Set<Promise<unknown>>();
    let resolveFinished!: () => void;
    let rejectFinished!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = resolve;
        rejectFinished = reject;
    });
    void finished.catch(() => undefined);
    const redis = new Redis(redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: null,
        connectTimeout: 5000,
        commandTimeout: 5000,
        retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });
    redis.on('error', () => undefined);
    const worker = new Worker(
        queueName,
        (job) => {
            if (controller.signal.aborted) return Promise.resolve();
            const task = Promise.resolve().then(() => {
                if (!controller.signal.aborted)
                    return handler(job.name, job.data, controller.signal);
            });
            pending.add(task);
            void task.then(
                () => pending.delete(task),
                () => pending.delete(task),
            );
            return task;
        },
        { connection: redis, autorun: false, concurrency, drainDelay: 1 },
    );
    worker.on('error', () => undefined);
    let running: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    async function within<T>(task: Promise<T>, milliseconds: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                task,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Run consumer 操作超时')),
                        milliseconds,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    return {
        worker,
        finished: () => finished,
        async start() {
            await within(worker.waitUntilReady(), 5000);
            if (controller.signal.aborted) return;
            if (running) return;
            running = worker.run();
            const fail = () => {
                if (!controller.signal.aborted) {
                    rejectFinished(new Error('Run consumer 循环意外停止'));
                    controller.abort();
                }
            };
            // 传输暂时故障由 BullMQ 重连；主循环退出必须传给应用生命周期。
            void running.then(fail, fail);
        },
        stop() {
            controller.abort();
            return (closing ??= (async () => {
                try {
                    // 先等领域处理和在途 DB 写入收敛，再释放队列；不依赖 Redis ACK 完成停止。
                    await Promise.allSettled(pending);
                    redis.disconnect();
                    await worker.close(true);
                    if (running)
                        await within(
                            running.catch(() => undefined),
                            5000,
                        );
                } finally {
                    redis.disconnect();
                    resolveFinished();
                }
            })());
        },
    };
}
