import { createReportQuestionStore } from '@/repo/report-questions.ts';
import {
    queryRows,
    isUniqueConflict,
    sql as querySql,
    and,
    eq,
    inArray,
    isNull,
    desc,
    type DatabaseExecutor,
    persistRunGraphEvent,
} from '@scova/db';
import { RunEventSchema, parseContract } from '@scova/models';
import * as tables from '@scova/db';
import { captureFeedbackSnapshot } from '@scova/db/feedback';
import type { ApiServices } from '@/app/services';
import { createTaskStore } from '@/repo/tasks.ts';
import { firstRow, requireRow } from '@/utils/database.ts';

/** Run、事件、幂等记录与 Outbox 共用同一个事务连接。 */
export function createRunStore(database: DatabaseExecutor) {
    const tasks = createTaskStore(database);
    return {
        reportQuestions: createReportQuestionStore(database),
        findSearchConfiguration(userId: string) {
            return database.query.searchConfigurations.findFirst({
                where: eq(tables.searchConfigurations.userId, userId),
            });
        },
        findAgentProvider: (userId: string, providerId: string) =>
            tasks.findAgentProvider(userId, providerId),
        feedbackSnapshot(userId: string, taskId: string) {
            if (!('rollback' in database)) throw new Error('反馈快照必须在事务中读取');
            return captureFeedbackSnapshot(database, userId, taskId);
        },
        lockTask(taskId: string, userId: string) {
            return queryRows<{ id: string }>(
                database,
                querySql`
        SELECT id FROM tasks WHERE id = ${taskId}::uuid AND user_id = ${userId}::uuid FOR NO KEY UPDATE
      `,
            );
        },
        lockRun(runId: string, userId: string) {
            return queryRows<{ id: string }>(
                database,
                querySql`
        SELECT id FROM runs WHERE id = ${runId}::uuid AND user_id = ${userId}::uuid FOR UPDATE
      `,
            );
        },
        async listRuns(userId: string, taskId: string, take: number, cursorId?: string) {
            const boundary = cursorId
                ? querySql`AND (queued_at,id)<(SELECT queued_at,id FROM runs WHERE user_id=${userId}::uuid AND task_id=${taskId}::uuid AND id=${cursorId}::uuid)`
                : querySql.empty();
            const ids = await queryRows<{ id: string }>(
                database,
                querySql`SELECT id FROM runs WHERE user_id=${userId}::uuid AND task_id=${taskId}::uuid ${boundary} ORDER BY queued_at DESC,id DESC LIMIT ${take}`,
            );
            return database.query.runs.findMany({
                where: and(
                    eq(tables.runs.userId, userId),
                    eq(tables.runs.taskId, taskId),
                    inArray(
                        tables.runs.id,
                        ids.map((row) => row.id),
                    ),
                ),
                orderBy: [desc(tables.runs.queuedAt), desc(tables.runs.id)],
            });
        },
        findQuestion(id: string, userId: string, reportRunId: string) {
            return database
                .select({ question: tables.reportQuestions })
                .from(tables.reportQuestions)
                .innerJoin(
                    tables.reports,
                    and(
                        eq(tables.reportQuestions.userId, tables.reports.userId),
                        eq(tables.reportQuestions.reportId, tables.reports.id),
                    ),
                )
                .where(
                    and(
                        eq(tables.reportQuestions.id, id),
                        eq(tables.reportQuestions.userId, userId),
                        eq(tables.reports.runId, reportRunId),
                        eq(tables.reports.userId, userId),
                    ),
                )
                .limit(1)
                .then((rows) => rows[0]?.question ?? null);
        },
        linkQuestion(
            id: string,
            userId: string,
            runId: string,
            operation: 'research' | 'revise' = 'research',
        ) {
            return database
                .update(tables.reportQuestions)
                .set(operation === 'revise' ? { revisionRunId: runId } : { followupRunId: runId })
                .where(
                    and(
                        eq(tables.reportQuestions.id, id),
                        eq(tables.reportQuestions.userId, userId),
                        isNull(
                            operation === 'revise'
                                ? tables.reportQuestions.revisionRunId
                                : tables.reportQuestions.followupRunId,
                        ),
                    ),
                )
                .returning()
                .then((rows) => ({ count: rows.length }));
        },
        findActiveRun(taskId: string, userId: string) {
            return database.query.runs
                .findFirst({
                    where: and(
                        eq(tables.runs.taskId, taskId),
                        eq(tables.runs.userId, userId),
                        inArray(tables.runs.status, [
                            'queued',
                            'running',
                            'recovering',
                            'cancel_requested',
                        ]),
                    ),
                })
                .then((row) => row ?? null);
        },
        findTask: (...args: Parameters<typeof tasks.findTask>) => tasks.findTask(...args),
        findVersion: (...args: Parameters<typeof tasks.findVersion>) => tasks.findVersion(...args),
        findRun(runId: string, userId: string) {
            return database.query.runs
                .findFirst({
                    where: and(eq(tables.runs.id, runId), eq(tables.runs.userId, userId)),
                })
                .then((row) => row ?? null);
        },
        requireRun(runId: string, userId: string) {
            return database.query.runs
                .findFirst({
                    where: and(eq(tables.runs.id, runId), eq(tables.runs.userId, userId)),
                })
                .then(requireRow);
        },
        findIdempotency(userId: string, scope: string, keyHash: string) {
            return database.query.idempotencyRecords
                .findFirst({
                    where: and(
                        and(
                            eq(tables.idempotencyRecords.userId, userId),
                            eq(tables.idempotencyRecords.scope, scope),
                            eq(tables.idempotencyRecords.keyHash, keyHash),
                        ),
                    ),
                })
                .then((row) => row ?? null);
        },
        createIdempotency(data: typeof tables.idempotencyRecords.$inferInsert) {
            return database
                .insert(tables.idempotencyRecords)
                .values(data)
                .returning()
                .then(firstRow);
        },
        completeIdempotency(id: string, resourceId: string) {
            return database
                .update(tables.idempotencyRecords)
                .set({ status: 'completed', responseCode: 202, resourceId: resourceId })
                .where(and(eq(tables.idempotencyRecords.id, id)))
                .returning()
                .then(firstRow);
        },
        createRun(data: typeof tables.runs.$inferInsert) {
            return database.insert(tables.runs).values(data).returning().then(firstRow);
        },
        async createEvent(data: typeof tables.runEvents.$inferInsert) {
            const event = await database
                .insert(tables.runEvents)
                .values(data)
                .returning()
                .then(firstRow);
            await persistRunGraphEvent(
                database,
                event.userId,
                parseContract(RunEventSchema, {
                    schemaVersion: event.schemaVersion,
                    eventId: event.id,
                    runId: event.runId,
                    seq: event.seq,
                    occurredAt: event.occurredAt.toISOString(),
                    type: event.type,
                    payload: event.payload,
                }),
            );
            return event;
        },
        createOutbox(data: typeof tables.outbox.$inferInsert) {
            return database.insert(tables.outbox).values(data).returning().then(firstRow);
        },
        requestCancel(runId: string, requestedAt: Date) {
            return database
                .update(tables.runs)
                .set({ status: 'cancel_requested', cancelRequestedAt: requestedAt })
                .where(and(eq(tables.runs.id, runId)))
                .returning()
                .then(firstRow);
        },
    };
}

export type RunStore = ReturnType<typeof createRunStore>;

export function createRunRepo(services: Pick<ApiServices, 'db'>) {
    return {
        findTask: (...args: Parameters<RunStore['findTask']>) =>
            createRunStore(services.db()).findTask(...args),
        listRuns: (...args: Parameters<RunStore['listRuns']>) =>
            createRunStore(services.db()).listRuns(...args),
        findRun: (...args: Parameters<RunStore['findRun']>) =>
            createRunStore(services.db()).findRun(...args),
        requireRun: (...args: Parameters<RunStore['requireRun']>) =>
            createRunStore(services.db()).requireRun(...args),
        findIdempotency: (...args: Parameters<RunStore['findIdempotency']>) =>
            createRunStore(services.db()).findIdempotency(...args),
        transaction<T>(work: (store: RunStore) => Promise<T>): Promise<T> {
            return services.db().transaction((database) => work(createRunStore(database)));
        },
        isUniqueConflict(error: unknown) {
            return isUniqueConflict(error);
        },
    };
}
