import {
    queryRows,
    isUniqueConflict,
    sql as querySql,
    and,
    eq,
    inArray,
    desc,
    type DatabaseExecutor,
} from '@scova/db';
import * as tables from '@scova/db';
import type { ApiServices } from '@/app/services';
import { firstRow, requireRow } from '@/utils/database.ts';

/** 绑定当前事务的任务持久化操作；不包含 HTTP、认证或产品决策。 */
export function createTaskStore(database: DatabaseExecutor) {
    return {
        async removeTaskData(taskId: string, userId: string) {
            const taskScope = and(eq(tables.tasks.id, taskId), eq(tables.tasks.userId, userId));
            const runIds = database
                .select({ id: tables.runs.id })
                .from(tables.runs)
                .where(and(eq(tables.runs.taskId, taskId), eq(tables.runs.userId, userId)));
            const reportIds = database
                .select({ id: tables.reports.id })
                .from(tables.reports)
                .where(and(eq(tables.reports.taskId, taskId), eq(tables.reports.userId, userId)));
            const questionIds = database
                .select({ id: tables.reportQuestions.id })
                .from(tables.reportQuestions)
                .where(
                    and(
                        eq(tables.reportQuestions.userId, userId),
                        inArray(tables.reportQuestions.reportId, reportIds),
                    ),
                );
            const claimIds = database
                .select({ id: tables.claims.id })
                .from(tables.claims)
                .where(and(eq(tables.claims.userId, userId), eq(tables.claims.taskId, taskId)));
            const changeIds = database
                .select({ id: tables.changeRecords.id })
                .from(tables.changeRecords)
                .where(
                    and(
                        eq(tables.changeRecords.userId, userId),
                        inArray(tables.changeRecords.reportId, reportIds),
                    ),
                );
            // NO ACTION 外键按依赖反序清理；来源与快照是跨任务资料，不在此删除。
            await database
                .delete(tables.questionEvidence)
                .where(
                    and(
                        eq(tables.questionEvidence.userId, userId),
                        inArray(tables.questionEvidence.questionId, questionIds),
                    ),
                );
            await database
                .delete(tables.reportQuestions)
                .where(
                    and(
                        eq(tables.reportQuestions.userId, userId),
                        inArray(tables.reportQuestions.reportId, reportIds),
                    ),
                );
            await database
                .delete(tables.notes)
                .where(
                    and(eq(tables.notes.userId, userId), inArray(tables.notes.reportId, reportIds)),
                );
            await database
                .delete(tables.notifications)
                .where(
                    and(
                        eq(tables.notifications.userId, userId),
                        inArray(tables.notifications.runId, runIds),
                    ),
                );
            await database
                .delete(tables.inboxItems)
                .where(
                    and(
                        eq(tables.inboxItems.userId, userId),
                        inArray(tables.inboxItems.reportId, reportIds),
                    ),
                );
            await database
                .delete(tables.feedback)
                .where(and(eq(tables.feedback.userId, userId), eq(tables.feedback.taskId, taskId)));
            await database
                .delete(tables.changeEvidence)
                .where(
                    and(
                        eq(tables.changeEvidence.userId, userId),
                        inArray(tables.changeEvidence.changeRecordId, changeIds),
                    ),
                );
            await database
                .delete(tables.changeRecords)
                .where(
                    and(
                        eq(tables.changeRecords.userId, userId),
                        inArray(tables.changeRecords.reportId, reportIds),
                    ),
                );
            await database
                .delete(tables.claimEvidence)
                .where(
                    and(
                        eq(tables.claimEvidence.userId, userId),
                        inArray(tables.claimEvidence.claimId, claimIds),
                    ),
                );
            await database
                .delete(tables.claims)
                .where(and(eq(tables.claims.userId, userId), eq(tables.claims.taskId, taskId)));
            await database
                .delete(tables.reports)
                .where(and(eq(tables.reports.userId, userId), eq(tables.reports.taskId, taskId)));
            await database
                .delete(tables.evidence)
                .where(
                    and(eq(tables.evidence.userId, userId), inArray(tables.evidence.runId, runIds)),
                );
            await database
                .delete(tables.runSources)
                .where(
                    and(
                        eq(tables.runSources.userId, userId),
                        inArray(tables.runSources.runId, runIds),
                    ),
                );
            await database
                .delete(tables.toolCalls)
                .where(
                    and(
                        eq(tables.toolCalls.userId, userId),
                        inArray(tables.toolCalls.runId, runIds),
                    ),
                );
            await database
                .delete(tables.runEvents)
                .where(
                    and(
                        eq(tables.runEvents.userId, userId),
                        inArray(tables.runEvents.runId, runIds),
                    ),
                );
            await database
                .delete(tables.outbox)
                .where(
                    and(
                        eq(tables.outbox.userId, userId),
                        inArray(tables.outbox.aggregateId, runIds),
                    ),
                );
            await database
                .delete(tables.idempotencyRecords)
                .where(
                    and(
                        eq(tables.idempotencyRecords.userId, userId),
                        inArray(tables.idempotencyRecords.resourceId, runIds),
                    ),
                );
            await database
                .delete(tables.baselines)
                .where(
                    and(eq(tables.baselines.userId, userId), eq(tables.baselines.taskId, taskId)),
                );
            await database
                .update(tables.scheduleOccurrences)
                .set({ runId: null })
                .where(
                    and(
                        eq(tables.scheduleOccurrences.userId, userId),
                        eq(tables.scheduleOccurrences.taskId, taskId),
                    ),
                );
            await database
                .delete(tables.runs)
                .where(and(eq(tables.runs.userId, userId), eq(tables.runs.taskId, taskId)));
            await database
                .delete(tables.scheduleOccurrences)
                .where(
                    and(
                        eq(tables.scheduleOccurrences.userId, userId),
                        eq(tables.scheduleOccurrences.taskId, taskId),
                    ),
                );
            await database.update(tables.tasks).set({ currentVersionId: null }).where(taskScope);
            await database
                .delete(tables.taskVersions)
                .where(
                    and(
                        eq(tables.taskVersions.userId, userId),
                        eq(tables.taskVersions.taskId, taskId),
                    ),
                );
            await database.delete(tables.tasks).where(taskScope);
        },
        async findAgentProvider(userId: string, providerId: string) {
            return database.query.agentProviders.findFirst({
                where: and(
                    eq(tables.agentProviders.userId, userId),
                    eq(tables.agentProviders.id, providerId),
                ),
            });
        },
        lockTask(taskId: string, userId: string) {
            return queryRows<{ id: string }>(
                database,
                querySql`SELECT id FROM tasks WHERE id = ${taskId}::uuid AND user_id = ${userId}::uuid FOR NO KEY UPDATE`,
            );
        },
        async now() {
            const [result] = await queryRows<{ now: Date }>(
                database,
                querySql`SELECT clock_timestamp() AS now`,
            );
            return result!.now;
        },
        findTask(taskId: string, userId: string) {
            return database.query.tasks
                .findFirst({
                    where: and(eq(tables.tasks.id, taskId), eq(tables.tasks.userId, userId)),
                })
                .then((row) => row ?? null);
        },
        async findTaskCursor(taskId: string, userId: string) {
            const [anchor] = await queryRows<{ id: string; cursorTime: string }>(
                database,
                querySql`
        SELECT id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
        FROM tasks WHERE id=${taskId}::uuid AND user_id=${userId}::uuid
      `,
            );
            return anchor;
        },
        findInitialVersion(userId: string, taskId: string) {
            return database.query.taskVersions
                .findFirst({
                    where: and(
                        eq(tables.taskVersions.userId, userId),
                        eq(tables.taskVersions.taskId, taskId),
                        eq(tables.taskVersions.version, 1),
                    ),
                })
                .then((row) => row ?? null);
        },
        findVersion(versionId: string, userId: string, taskId: string) {
            return database.query.taskVersions
                .findFirst({
                    where: and(
                        eq(tables.taskVersions.id, versionId),
                        eq(tables.taskVersions.userId, userId),
                        eq(tables.taskVersions.taskId, taskId),
                    ),
                })
                .then((row) => row ?? null);
        },
        requireVersion(versionId: string, userId: string, taskId: string) {
            return database.query.taskVersions
                .findFirst({
                    where: and(
                        eq(tables.taskVersions.id, versionId),
                        eq(tables.taskVersions.userId, userId),
                        eq(tables.taskVersions.taskId, taskId),
                    ),
                })
                .then(requireRow);
        },
        async listTasks(userId: string, take: number, cursor?: { updatedAt: string; id: string }) {
            const boundary = cursor
                ? querySql`AND (updated_at,id)<(SELECT updated_at,id FROM tasks WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid)`
                : querySql.empty();
            const ids = await queryRows<{ id: string; cursorTime: string }>(
                database,
                querySql`SELECT id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
        FROM tasks WHERE user_id=${userId}::uuid ${boundary} ORDER BY updated_at DESC,id DESC LIMIT ${take}`,
            );
            const tasks = await database.query.tasks.findMany({
                where: and(
                    eq(tables.tasks.userId, userId),
                    inArray(
                        tables.tasks.id,
                        ids.map((row) => row.id),
                    ),
                ),
                orderBy: [desc(tables.tasks.updatedAt), desc(tables.tasks.id)],
            });
            const times = new Map(ids.map((row) => [row.id, row.cursorTime]));
            return tasks.map((task) => ({ task, cursorTime: times.get(task.id)! }));
        },
        createTask(data: typeof tables.tasks.$inferInsert) {
            return database.insert(tables.tasks).values(data).returning().then(firstRow);
        },
        createVersion(data: typeof tables.taskVersions.$inferInsert) {
            return database.insert(tables.taskVersions).values(data).returning().then(firstRow);
        },
        async setCurrentVersion(taskId: string, versionId: string) {
            await database
                .update(tables.tasks)
                .set({ currentVersionId: versionId })
                .where(eq(tables.tasks.id, taskId));
            return database.query.tasks
                .findFirst({ where: eq(tables.tasks.id, taskId), with: { currentVersion: true } })
                .then(requireRow);
        },
        claimRevision(
            taskId: string,
            userId: string,
            revision: number,
            data: Partial<typeof tables.tasks.$inferInsert>,
        ) {
            return database
                .update(tables.tasks)
                .set(data)
                .where(
                    and(
                        eq(tables.tasks.id, taskId),
                        eq(tables.tasks.userId, userId),
                        eq(tables.tasks.revision, revision),
                    ),
                )
                .returning()
                .then((rows) => ({ count: rows.length }));
        },
        async lockActiveRun(taskId: string, userId: string) {
            const [result] = await queryRows<{ id: string }>(
                database,
                querySql`
        SELECT id FROM runs WHERE task_id = ${taskId}::uuid AND user_id = ${userId}::uuid
        AND status IN ('queued', 'running', 'recovering', 'cancel_requested') FOR UPDATE`,
            );
            return result
                ? database.query.runs
                      .findFirst({
                          where: and(eq(tables.runs.id, result.id), eq(tables.runs.userId, userId)),
                      })
                      .then((row) => row ?? null)
                : null;
        },
        requestCancel(runId: string, requestedAt: Date) {
            return database
                .update(tables.runs)
                .set({ status: 'cancel_requested', cancelRequestedAt: requestedAt })
                .where(and(eq(tables.runs.id, runId)))
                .returning()
                .then(firstRow);
        },
        createCancelOutbox(userId: string, runId: string) {
            return database
                .insert(tables.outbox)
                .values({
                    userId: userId,
                    aggregateId: runId,
                    eventType: 'run.cancel_requested',
                    dedupeKey: `run-${runId}-cancel`,
                    payload: { runId },
                })
                .returning()
                .then(firstRow);
        },
    };
}

export type TaskStore = ReturnType<typeof createTaskStore>;

/** 惰性取得连接，事务回调只能使用绑定该事务的 store。 */
export function createTaskRepo(services: Pick<ApiServices, 'db'>) {
    return {
        findTask: (...args: Parameters<TaskStore['findTask']>) =>
            createTaskStore(services.db()).findTask(...args),
        findVersion: (...args: Parameters<TaskStore['findVersion']>) =>
            createTaskStore(services.db()).findVersion(...args),
        listTasks: (...args: Parameters<TaskStore['listTasks']>) =>
            createTaskStore(services.db()).listTasks(...args),
        readTransaction<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
            return services.db().transaction((database) => work(createTaskStore(database)), {
                isolationLevel: 'repeatable read',
            });
        },
        transaction<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
            return services.db().transaction((database) => work(createTaskStore(database)));
        },
        isUniqueConflict(error: unknown) {
            return isUniqueConflict(error);
        },
    };
}
