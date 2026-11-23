import { type DatabaseClient, workflowRuns } from '@scova/db';
import { isWorkflowCanvasGraph } from '@scova/models';
import { bindWorkflowResearch } from '@/repo/workflow-research.ts';
import { createWorkflowRepository } from '@/repo/workflows.ts';
import { insertWorkflowNotification } from '@/repo/workflow-notifications.ts';
import { advanceWorkflow } from '@/service/workflow-checkpoint.ts';
import {
    CanvasNodeError,
    executeCanvasNode,
    type WorkflowGenerator,
} from './canvas-node-execution.ts';
import { commitCanvasStep, planCanvasStep, type CanvasWork } from './workflow-canvas-run.ts';
import { createWorkflowGenerator } from './workflow-generation.ts';
import { ApiError } from '@/utils/errors.ts';

/** Server persists workflow state. Existing research jobs continue to run in Worker. */
export function createWorkflowBatch(
    database: DatabaseClient,
    options: {
        batchSize: number;
        intervalMs: number;
        clock?: () => Date;
        generator?: (userId: string, signal: AbortSignal) => WorkflowGenerator;
    },
) {
    const repository = createWorkflowRepository(() => database);
    const clock = options.clock ?? (() => new Date());
    const generator =
        options.generator ??
        ((userId, signal) => createWorkflowGenerator(database, userId, signal));

    async function execute(
        run: typeof workflowRuns.$inferSelect,
        work: CanvasWork,
        signal: AbortSignal,
    ) {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
        try {
            const output = await executeCanvasNode(
                work.node,
                run.inputJson ?? {},
                work.upstream,
                generator(run.userId, deadline),
            );
            return { output };
        } catch (error) {
            return {
                failureCode: deadline.aborted
                    ? 'WORKFLOW_NODE_TIMED_OUT'
                    : error instanceof CanvasNodeError || error instanceof ApiError
                      ? error.code
                      : 'WORKFLOW_NODE_FAILED',
            };
        }
    }

    return async (signal: AbortSignal) => {
        let processed = 0;
        while (!signal.aborted && processed < options.batchSize) {
            const claim = await repository.transaction(async (store, tx) => {
                const now = clock();
                const run = await store.claimDueRun(now);
                if (!run) return null;
                const version = run.versionId
                    ? await store.findVersion(run.userId, run.workflowId, run.versionId)
                    : null;
                const graph = run.draftPreviewJson?.graph ?? version?.graphJson;
                if (!graph) throw new Error('工作流运行缺少版本快照');
                const research = bindWorkflowResearch(tx, run, now);
                if (!isWorkflowCanvasGraph(graph)) {
                    await store.writeCheckpoint(
                        run,
                        await advanceWorkflow(run, now, options.intervalMs, research),
                    );
                    return { run };
                }
                const { checkpoint, work } = await planCanvasStep(
                    run,
                    graph,
                    now,
                    options.intervalMs,
                    research,
                );
                await store.writeCheckpoint(run, checkpoint);
                return { run, work };
            });
            if (!claim) break;
            processed += 1;
            const { run, work } = claim;
            if (!work || signal.aborted) continue;
            const result = await execute(run, work, signal);
            // On shutdown the lease is left for recovery. A cancellation or newer claim fences stale output.
            if (signal.aborted) break;
            await repository.transaction(async (store, tx) => {
                const current = await store.findRun(run.userId, run.id, true);
                if (!current) return;
                const now = clock();
                const checkpoint = commitCanvasStep(current, work, now, result);
                if (!checkpoint) return;
                if (!run.preview && result.output?.notification) {
                    const { title, body, artifactNodeId } = result.output.notification;
                    await insertWorkflowNotification(tx, {
                        userId: run.userId,
                        workflowRunId: run.id,
                        nodeId: work.node.id,
                        title,
                        body,
                        createdAt: now,
                        artifactNodeId,
                    });
                }
                await store.writeCheckpoint(run, checkpoint);
            });
        }
        return processed;
    };
}
