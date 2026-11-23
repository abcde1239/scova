import { and, eq, workflowNotifications, workflowRuns, type DatabaseTransaction } from '@scova/db';
import { requireRow } from '@/utils/database.ts';

export async function insertWorkflowNotification(
    tx: DatabaseTransaction,
    input: {
        userId: string;
        workflowRunId: string;
        nodeId: string;
        artifactNodeId?: string;
        title: string;
        body: string;
        createdAt: Date;
    },
): Promise<string> {
    const run = await tx
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
            and(
                eq(workflowRuns.userId, input.userId),
                eq(workflowRuns.id, input.workflowRunId),
                eq(workflowRuns.preview, false),
            ),
        );
    requireRow(run[0]);

    const inserted = await tx
        .insert(workflowNotifications)
        .values({ ...input, channel: 'in_app' })
        .onConflictDoNothing({
            target: [
                workflowNotifications.workflowRunId,
                workflowNotifications.nodeId,
                workflowNotifications.userId,
                workflowNotifications.channel,
            ],
        })
        .returning({ id: workflowNotifications.id });
    if (inserted[0]) return inserted[0].id;

    const existing = await tx
        .select({ id: workflowNotifications.id })
        .from(workflowNotifications)
        .where(
            and(
                eq(workflowNotifications.workflowRunId, input.workflowRunId),
                eq(workflowNotifications.nodeId, input.nodeId),
                eq(workflowNotifications.userId, input.userId),
                eq(workflowNotifications.channel, 'in_app'),
            ),
        );
    return requireRow(existing[0]).id;
}
