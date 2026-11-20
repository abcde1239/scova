import { createHash } from 'node:crypto';
import type { DatabaseTransaction } from '@scova/db';
import { TaskConfigSchema, parseContract, ContractValidationError, type Mode } from '@scova/models';
import { createRunStore } from '@/repo/runs.ts';
import { runComparisonScopeHash } from '@/service/runs.ts';
import {
    childRunActive,
    type StartedStudyNode,
    type WorkflowResearch,
} from '@/service/workflow-checkpoint.ts';

function childId(workflowRunId: string, nodeId: string) {
    const bytes = createHash('sha256')
        .update(`scova-workflow-child-v1:${workflowRunId}:${nodeId}`)
        .digest();
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Authenticate a persisted workflow child against its workflow identity and frozen Task binding. */
export function bindWorkflowResearch(
    tx: DatabaseTransaction,
    identity: { id: string; userId: string; mode: Mode },
    now: Date,
): WorkflowResearch {
    const { id: workflowRunId, userId, mode } = identity;
    const runs = createRunStore(tx);
    async function read(node: StartedStudyNode) {
        if (node.childRunId !== childId(workflowRunId, node.id)) return null;
        const run = await runs.findRun(node.childRunId, userId);
        return run &&
            run.taskId === node.taskId &&
            run.taskVersionId === node.taskVersionId &&
            run.mode === mode &&
            run.trigger === 'manual'
            ? run
            : null;
    }
    return {
        read,
        async launch(node) {
            if (!(await runs.lockTask(node.taskId, userId)).length)
                return { failureCode: 'TASK_UNAVAILABLE' };
            const task = await runs.findTask(node.taskId, userId);
            if (!task || task.status === 'archived') return { failureCode: 'TASK_UNAVAILABLE' };
            const version = await runs.findVersion(node.taskVersionId, userId, node.taskId);
            if (!version) return { failureCode: 'TASK_VERSION_MISSING' };
            let config;
            try {
                config = parseContract(TaskConfigSchema, version.configJson);
            } catch (error) {
                if (!(error instanceof ContractValidationError)) throw error;
                return { failureCode: 'INVALID_RUN_CONFIGURATION' };
            }
            if (
                config.agentProviderId &&
                !(await runs.findAgentProvider(userId, config.agentProviderId))
            )
                return { failureCode: 'AGENT_PROVIDER_UNAVAILABLE' };
            if (await runs.findActiveRun(node.taskId, userId))
                return { failureCode: 'RUN_ALREADY_ACTIVE' };
            const run = await runs.createRun({
                id: childId(workflowRunId, node.id),
                userId,
                taskId: task.id,
                taskVersionId: version.id,
                comparisonScopeHash: runComparisonScopeHash(config, mode),
                mode,
                trigger: 'manual',
                queuedAt: now,
                budgetJson: config.budget,
                feedbackSnapshotJson: await runs.feedbackSnapshot(userId, task.id),
                usageJson: {
                    searches: 0,
                    pages: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    estimated: true,
                },
            });
            await runs.createEvent({
                userId,
                runId: run.id,
                seq: 1,
                type: 'run.queued',
                occurredAt: now,
                payload: { status: 'queued', taskVersionId: version.id },
            });
            await runs.createOutbox({
                userId,
                aggregateId: run.id,
                eventType: 'run.enqueue',
                dedupeKey: `run-${run.id}-enqueue`,
                availableAt: now,
                payload: { runId: run.id, taskId: task.id, taskVersionId: version.id, mode },
            });
            return { run };
        },
        async cancel(node) {
            if (node.childRunId !== childId(workflowRunId, node.id)) return null;
            await runs.lockRun(node.childRunId, userId);
            const child = await read(node);
            if (!child || !childRunActive(child.status) || child.status === 'cancel_requested')
                return child;
            const updated = await runs.requestCancel(child.id, now);
            await runs.createOutbox({
                userId,
                aggregateId: child.id,
                eventType: 'run.cancel_requested',
                dedupeKey: `run-${child.id}-cancel`,
                availableAt: now,
                payload: { runId: child.id },
            });
            return updated;
        },
    };
}
