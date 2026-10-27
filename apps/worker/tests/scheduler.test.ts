import { describe, expect, it, vi } from 'vite-plus/test';
import { SchedulerService } from '../src/service/scheduler.ts';
import { SchedulerTaskError } from '../src/utils/scheduler.ts';

describe('Scheduler 批次有界并发与故障隔离', () => {
    it('坏任务本批跳过，其他任务仍推进，随后报告失败以触发退避', async () => {
        const seen: string[][] = [];
        const repository = {
            scheduleNext: vi.fn(async (_mode: 'demo' | 'live', excluded: readonly string[]) => {
                seen.push([...excluded]);
                if (!excluded.includes('bad'))
                    throw new SchedulerTaskError('bad', new Error('private details'));
                if (!excluded.includes('good'))
                    return { taskId: 'good', status: 'created' as const };
                return null;
            }),
        };
        const service = new SchedulerService({ repository, mode: 'demo', concurrency: 1 });
        await expect(service.scheduleOnce(5)).rejects.toThrow('调度批次部分任务失败');
        expect(seen).toEqual([[], ['bad'], ['bad', 'good']]);
    });

    it('低并发与批次上限限制同时在途事务，abort 后不再领取', async () => {
        const controller = new AbortController();
        let active = 0;
        let maximum = 0;
        let calls = 0;
        const service = new SchedulerService({
            mode: 'live',
            concurrency: 2,
            repository: {
                async scheduleNext() {
                    active += 1;
                    maximum = Math.max(maximum, active);
                    const taskId = String(++calls);
                    await Promise.resolve();
                    active -= 1;
                    if (calls >= 3) controller.abort();
                    return { taskId, status: 'created' };
                },
            },
        });
        await service.scheduleOnce(10, controller.signal);
        expect(maximum).toBe(2);
        expect(calls).toBeLessThanOrEqual(4);
        expect(await service.scheduleOnce(10, controller.signal)).toBe(0);
    });
});
