import type { DatabaseClient } from '@scova/db';
import { bindWorkflowResearch } from '@/repo/workflow-research.ts';
import { createWorkflowRepository } from '@/repo/workflows.ts';
import { advanceWorkflow } from '@/service/workflow-checkpoint.ts';

/** Runs on Server alongside other control batches. Worker consumes only the existing research jobs. */
export function createWorkflowBatch(
    database: DatabaseClient,
    options: { batchSize: number; intervalMs: number; clock?: () => Date },
) {
    const repository = createWorkflowRepository(() => database);
    const clock = options.clock ?? (() => new Date());
    return async (signal: AbortSignal) => {
        let processed = 0;
        while (!signal.aborted && processed < options.batchSize) {
            const advanced = await repository.transaction(async (store, tx) => {
                const now = clock();
                const run = await store.claimDueRun(now);
                if (!run) return false;
                const research = bindWorkflowResearch(tx, run, now);
                const checkpoint = await advanceWorkflow(run, now, options.intervalMs, research);
                await store.writeCheckpoint(run, checkpoint);
                return true;
            });
            if (!advanced) break;
            processed += 1;
        }
        return processed;
    };
}
