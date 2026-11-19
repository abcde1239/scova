import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { within } from '@/utils/timeout.ts';

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
    return {
        worker,
        isReady: () => !controller.signal.aborted && redis.status === 'ready' && worker.isRunning(),
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
                    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
                        within(Promise.allSettled(pending), 25_000),
                    ]);
                    redis.disconnect();
                    results.push(
                        ...(await Promise.allSettled([within(worker.close(true), 5_000)])),
                    );
                    const failed = results.find((result) => result.status === 'rejected');
                    if (failed?.status === 'rejected') throw failed.reason;
                    if (running)
                        await within(
                            running.catch(() => undefined),
                            5000,
                        );
                } catch (error) {
                    rejectFinished(
                        error instanceof Error ? error : new Error('Run consumer 停止失败'),
                    );
                    throw error;
                } finally {
                    redis.disconnect();
                    resolveFinished();
                }
            })());
        },
    };
}
