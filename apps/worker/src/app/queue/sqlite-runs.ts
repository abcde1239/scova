import { setTimeout as delay } from 'node:timers/promises';
import type { createExecutionClient } from '@/repo/execution.ts';
import { within } from '@/utils/timeout.ts';

export function createSqliteRunConsumer(
    queue: ReturnType<typeof createExecutionClient>['sqliteQueue'],
    handler: (name: string, data: unknown, signal: AbortSignal) => Promise<unknown>,
    concurrency: number,
) {
    const controller = new AbortController();
    const { signal } = controller;
    let running: Promise<void> | undefined;
    let closing: Promise<void> | undefined;

    async function consume() {
        while (!signal.aborted) {
            let job;
            try {
                job = await queue.claim();
            } catch {
                await delay(1000, undefined, { signal }).catch(() => undefined);
                continue;
            }
            if (!job) {
                await delay(250, undefined, { signal }).catch(() => undefined);
                continue;
            }
            const jobController = new AbortController();
            const renew = (async () => {
                while (!jobController.signal.aborted) {
                    await delay(10_000, undefined, { signal: jobController.signal }).catch(
                        () => undefined,
                    );
                    if (jobController.signal.aborted) return;
                    try {
                        if (!(await queue.renew(job))) jobController.abort();
                    } catch {
                        jobController.abort();
                    }
                }
            })();
            try {
                await handler(job.name, job.data, AbortSignal.any([signal, jobController.signal]));
            } catch {
                // Server scans PostgreSQL for recovery after the Run lease expires.
            } finally {
                jobController.abort();
                await renew;
                await queue.settle(job, signal.aborted).catch(() => undefined);
            }
        }
    }

    return {
        isReady: () => !!running && !signal.aborted,
        finished: () => running ?? Promise.resolve(),
        async start() {
            if (running || signal.aborted) return;
            running = Promise.all(Array.from({ length: concurrency }, consume)).then(
                () => undefined,
            );
            void running.catch(() => controller.abort());
        },
        stop() {
            controller.abort();
            return (closing ??= within(running ?? Promise.resolve(), 25_000));
        },
    };
}
