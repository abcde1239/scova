import {
    and,
    desc,
    eq,
    inArray,
    lt,
    notExists,
    lte,
    sql,
    type DatabaseClient,
    type DatabaseExecutor,
    type DatabaseTransaction,
} from '@scova/db';
import { workflows, workflowRuns, workflowVersions, type WorkflowRunRow } from '@scova/db';
import { workflowTemplateExecutions } from '@scova/db';
import { firstRow } from '@/utils/database.ts';

export const activeWorkflowStatuses = ['queued', 'running', 'cancel_requested'] as const;

export function createWorkflowStore(database: DatabaseExecutor) {
    return {
        async list(userId: string, take: number, cursor?: string) {
            const anchor = cursor ? await this.find(userId, cursor) : null;
            if (cursor && !anchor) return null;
            return database
                .select()
                .from(workflows)
                .where(
                    and(
                        eq(workflows.userId, userId),
                        notExists(
                            database
                                .select({ id: workflowTemplateExecutions.workflowId })
                                .from(workflowTemplateExecutions)
                                .where(
                                    and(
                                        eq(workflowTemplateExecutions.userId, userId),
                                        eq(workflowTemplateExecutions.workflowId, workflows.id),
                                    ),
                                ),
                        ),
                        anchor
                            ? sql`(${workflows.createdAt}, ${workflows.id}) < (
                    SELECT ${workflows.createdAt}, ${workflows.id} FROM ${workflows}
                    WHERE ${workflows.userId} = ${userId} AND ${workflows.id} = ${anchor.id}
                )`
                            : undefined,
                    ),
                )
                .orderBy(desc(workflows.createdAt), desc(workflows.id))
                .limit(take);
        },
        find(userId: string, workflowId: string, lock = false) {
            const query = database
                .select()
                .from(workflows)
                .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)))
                .limit(1);
            return (lock ? query.for('update') : query).then((rows) => rows[0] ?? null);
        },
        insert(data: typeof workflows.$inferInsert) {
            return database.insert(workflows).values(data).returning().then(firstRow);
        },
        updateDraft(
            userId: string,
            workflowId: string,
            data: Pick<
                typeof workflows.$inferInsert,
                'title' | 'draftJson' | 'revision' | 'updatedAt'
            >,
        ) {
            return database
                .update(workflows)
                .set(data)
                .where(and(eq(workflows.userId, userId), eq(workflows.id, workflowId)))
                .returning()
                .then(firstRow);
        },
        findVersion(userId: string, workflowId: string, versionId?: string) {
            return database
                .select()
                .from(workflowVersions)
                .where(
                    and(
                        eq(workflowVersions.userId, userId),
                        eq(workflowVersions.workflowId, workflowId),
                        versionId ? eq(workflowVersions.id, versionId) : undefined,
                    ),
                )
                .orderBy(desc(workflowVersions.version))
                .limit(1)
                .then((rows) => rows[0] ?? null);
        },
        async listVersions(userId: string, workflowId: string, take: number, cursor?: string) {
            const anchor = cursor ? await this.findVersion(userId, workflowId, cursor) : null;
            if (cursor && !anchor) return null;
            return database
                .select()
                .from(workflowVersions)
                .where(
                    and(
                        eq(workflowVersions.userId, userId),
                        eq(workflowVersions.workflowId, workflowId),
                        anchor ? lt(workflowVersions.version, anchor.version) : undefined,
                    ),
                )
                .orderBy(desc(workflowVersions.version))
                .limit(take);
        },
        publish(data: typeof workflowVersions.$inferInsert) {
            return database.insert(workflowVersions).values(data).returning().then(firstRow);
        },
        async listRuns(userId: string, workflowId: string, take: number, cursor?: string) {
            const anchor = cursor ? await this.findRun(userId, cursor) : null;
            if (cursor && (!anchor || anchor.workflowId !== workflowId)) return null;
            return database
                .select()
                .from(workflowRuns)
                .where(
                    and(
                        eq(workflowRuns.userId, userId),
                        eq(workflowRuns.workflowId, workflowId),
                        anchor
                            ? sql`(${workflowRuns.createdAt}, ${workflowRuns.id}) < (
                    SELECT ${workflowRuns.createdAt}, ${workflowRuns.id} FROM ${workflowRuns}
                    WHERE ${workflowRuns.userId} = ${userId} AND ${workflowRuns.id} = ${anchor.id}
                )`
                            : undefined,
                    ),
                )
                .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
                .limit(take);
        },
        findRun(userId: string, runId: string, lock = false) {
            const query = database
                .select()
                .from(workflowRuns)
                .where(and(eq(workflowRuns.id, runId), eq(workflowRuns.userId, userId)))
                .limit(1);
            return (lock ? query.for('update') : query).then((rows) => rows[0] ?? null);
        },
        findStartedRun(userId: string, workflowId: string, keyHash: string) {
            return database
                .select()
                .from(workflowRuns)
                .where(
                    and(
                        eq(workflowRuns.userId, userId),
                        eq(workflowRuns.workflowId, workflowId),
                        eq(workflowRuns.startKeyHash, keyHash),
                    ),
                )
                .limit(1)
                .then((rows) => rows[0] ?? null);
        },
        insertRun(data: typeof workflowRuns.$inferInsert) {
            return database.insert(workflowRuns).values(data).returning().then(firstRow);
        },
        claimDueRun(now: Date) {
            return database
                .select()
                .from(workflowRuns)
                .where(
                    and(
                        inArray(workflowRuns.status, activeWorkflowStatuses),
                        lte(workflowRuns.nextCheckAt, now),
                    ),
                )
                .orderBy(workflowRuns.nextCheckAt, workflowRuns.id)
                .limit(1)
                .for('update', { skipLocked: true })
                .then((rows) => rows[0] ?? null);
        },
        writeCheckpoint(
            run: Pick<WorkflowRunRow, 'id' | 'userId'>,
            checkpoint: WorkflowCheckpoint,
        ) {
            return database
                .update(workflowRuns)
                .set(checkpoint)
                .where(and(eq(workflowRuns.userId, run.userId), eq(workflowRuns.id, run.id)))
                .returning()
                .then(firstRow);
        },
    };
}

export type WorkflowCheckpoint = Pick<
    WorkflowRunRow,
    'status' | 'nodesJson' | 'nextCheckAt' | 'startedAt' | 'finishedAt' | 'failureCode'
>;

export type WorkflowStore = ReturnType<typeof createWorkflowStore>;

export function createWorkflowRepository(db: () => DatabaseClient) {
    return {
        read: () => createWorkflowStore(db()),
        transaction: <T>(work: (store: WorkflowStore, tx: DatabaseTransaction) => Promise<T>) =>
            db().transaction((tx) => work(createWorkflowStore(tx), tx)),
    };
}
