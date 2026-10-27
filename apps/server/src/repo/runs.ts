import { Prisma } from '@scova/db';
import { captureFeedbackSnapshot } from '@scova/db/feedback';
import type { ApiServices } from '@/app/context.ts';
import { createTaskStore } from '@/repo/tasks.ts';

/** Run、事件、幂等记录与 Outbox 共用同一个事务连接。 */
function createRunStore(database: Prisma.TransactionClient) {
    const tasks = createTaskStore(database);
    return {
        feedbackSnapshot(userId: string, taskId: string) {
            return captureFeedbackSnapshot(database, userId, taskId);
        },
        lockTask(taskId: string, userId: string) {
            return database.$queryRaw<{ id: string }[]>`
        SELECT id FROM tasks WHERE id = ${taskId}::uuid AND user_id = ${userId}::uuid FOR NO KEY UPDATE
      `;
        },
        lockRun(runId: string, userId: string) {
            return database.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs WHERE id = ${runId}::uuid AND user_id = ${userId}::uuid FOR UPDATE
      `;
        },
        async listRuns(userId: string, taskId: string, take: number, cursorId?: string) {
            const boundary = cursorId
                ? Prisma.sql`AND (queued_at,id)<(SELECT queued_at,id FROM runs WHERE user_id=${userId}::uuid AND task_id=${taskId}::uuid AND id=${cursorId}::uuid)`
                : Prisma.empty;
            const ids = await database.$queryRaw<
                { id: string }[]
            >`SELECT id FROM runs WHERE user_id=${userId}::uuid AND task_id=${taskId}::uuid ${boundary} ORDER BY queued_at DESC,id DESC LIMIT ${take}`;
            return database.run.findMany({
                where: { userId, taskId, id: { in: ids.map((row) => row.id) } },
                orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
            });
        },
        findQuestion(id: string, userId: string, reportRunId: string) {
            return database.reportQuestion.findFirst({
                where: { id, userId, report: { runId: reportRunId, userId } },
            });
        },
        linkQuestion(id: string, userId: string, runId: string) {
            return database.reportQuestion.updateMany({
                where: { id, userId, followupRunId: null },
                data: { followupRunId: runId },
            });
        },
        findActiveRun(taskId: string, userId: string) {
            return database.run.findFirst({
                where: {
                    taskId,
                    userId,
                    status: { in: ['queued', 'running', 'recovering', 'cancel_requested'] },
                },
            });
        },
        findTask: (...args: Parameters<typeof tasks.findTask>) => tasks.findTask(...args),
        findVersion: (...args: Parameters<typeof tasks.findVersion>) => tasks.findVersion(...args),
        findRun(runId: string, userId: string) {
            return database.run.findFirst({ where: { id: runId, userId } });
        },
        requireRun(runId: string, userId: string) {
            return database.run.findFirstOrThrow({ where: { id: runId, userId } });
        },
        findIdempotency(userId: string, scope: string, keyHash: string) {
            return database.idempotencyRecord.findUnique({
                where: { userId_scope_keyHash: { userId, scope, keyHash } },
            });
        },
        createIdempotency(data: Prisma.IdempotencyRecordUncheckedCreateInput) {
            return database.idempotencyRecord.create({ data });
        },
        completeIdempotency(id: string, resourceId: string) {
            return database.idempotencyRecord.update({
                where: { id },
                data: { status: 'completed', responseCode: 202, resourceId },
            });
        },
        createRun(data: Prisma.RunUncheckedCreateInput) {
            return database.run.create({ data });
        },
        createEvent(data: Prisma.RunEventUncheckedCreateInput) {
            return database.runEvent.create({ data });
        },
        createOutbox(data: Prisma.OutboxUncheckedCreateInput) {
            return database.outbox.create({ data });
        },
        requestCancel(runId: string, requestedAt: Date) {
            return database.run.update({
                where: { id: runId },
                data: { status: 'cancel_requested', cancelRequestedAt: requestedAt },
            });
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
            return services.db().$transaction((database) => work(createRunStore(database)));
        },
        isUniqueConflict(error: unknown) {
            return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        },
    };
}
