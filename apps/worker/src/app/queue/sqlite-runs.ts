import type { ExecutionQueueJob } from '@scova/execution/protocol';
import type { createExecutionClient } from '@/repo/execution.ts';
import { within } from '@/utils/timeout.ts';
import { waitForPoll } from '@/utils/wait.ts';

// One poller replaces staggered per-slot polls. Keep the maximum idle wait below the former interval.
const idlePollIntervalMs = 220;
const renewIntervalMs = 10_000;
const queueEvidenceMaxAgeMs = 2 * renewIntervalMs;

export function createSqliteRunConsumer(
    queue: ReturnType<typeof createExecutionClient>['sqliteQueue'],
    handler: (name: string, data: unknown, signal: AbortSignal) => Promise<unknown>,
    concurrency: number,
) {
    const controller = new AbortController();
    const { signal } = controller;
    const pending = new Set<Promise<void>>();
    let notifySlot: (() => void) | undefined;
    let lastSuccess = -Infinity;
    let running: Promise<void> | undefined;
    let closing: Promise<void> | undefined;

    async function execute(job: ExecutionQueueJob) {
        const jobController = new AbortController();
        const renew = (async () => {
            while (!jobController.signal.aborted) {
                await waitForPoll(renewIntervalMs, jobController.signal);
                if (jobController.signal.aborted) return;
                try {
                    if (await queue.renew(job)) lastSuccess = performance.now();
                    else jobController.abort();
                } catch {
                    lastSuccess = -Infinity;
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

    async function consume() {
        try {
            while (!signal.aborted) {
                if (pending.size >= concurrency) {
                    await new Promise<void>((resolve) => (notifySlot = resolve));
                    notifySlot = undefined;
                    continue;
                }
                let job;
                try {
                    job = await queue.claim();
                    lastSuccess = performance.now();
                } catch {
                    lastSuccess = -Infinity;
                    await waitForPoll(1000, signal);
                    continue;
                }
                if (signal.aborted) {
                    if (job) await queue.settle(job, true).catch(() => undefined);
                    break;
                }
                if (!job) {
                    await waitForPoll(idlePollIntervalMs, signal);
                    continue;
                }
                const task = execute(job).finally(() => {
                    pending.delete(task);
                    notifySlot?.();
                });
                pending.add(task);
            }
        } finally {
            controller.abort();
            await Promise.all(pending);
        }
    }

    return {
        isReady: () => !signal.aborted && performance.now() - lastSuccess < queueEvidenceMaxAgeMs,
        finished: () => running ?? Promise.resolve(),
        async start() {
            if (running || signal.aborted) return;
            running = consume();
            void running.catch(() => controller.abort());
        },
        stop() {
            controller.abort();
            notifySlot?.();
            return (closing ??= within(running ?? Promise.resolve(), 25_000));
        },
    };
}
