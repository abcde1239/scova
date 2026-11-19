import type { Queue } from 'bullmq';
import type { RecoverableRun } from '../recoverable-runs.ts';

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
