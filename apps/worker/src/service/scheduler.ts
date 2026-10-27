import type { SchedulerRepository } from '@/repo/scheduler.ts';
import { SchedulerTaskError } from '@/utils/scheduler.ts';

/** 每批有界并发；坏任务本批排除，其他到期任务仍能推进。 */
export class SchedulerService {
    constructor(
        private readonly options: {
            repository: SchedulerRepository;
            mode: 'demo' | 'live';
            concurrency: number;
        },
    ) {
        if (
            !Number.isSafeInteger(options.concurrency) ||
            options.concurrency < 1 ||
            options.concurrency > 8
        )
            throw new Error('调度并发必须为 1 至 8 的整数');
    }

    async scheduleOnce(limit: number, signal?: AbortSignal): Promise<number> {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('调度批次上限必须为正整数');
        const excluded = new Set<string>();
        const failures: unknown[] = [];
        let attempts = 0;
        let scheduled = 0;
        await Promise.all(
            Array.from({ length: Math.min(limit, this.options.concurrency) }, async () => {
                while (!signal?.aborted && attempts < limit) {
                    attempts += 1;
                    try {
                        const result = await this.options.repository.scheduleNext(
                            this.options.mode,
                            [...excluded],
                            signal,
                        );
                        if (!result) return;
                        excluded.add(result.taskId);
                        scheduled += 1;
                    } catch (error) {
                        failures.push(error);
                        if (!(error instanceof SchedulerTaskError)) return;
                        excluded.add(error.taskId);
                    }
                }
            }),
        );
        if (failures.length) throw new AggregateError(failures, '调度批次部分任务失败');
        return scheduled;
    }
}
