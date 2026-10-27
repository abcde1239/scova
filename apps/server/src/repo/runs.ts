import { Prisma } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';
import { createTaskStore } from '@/repo/tasks.ts';

/** Run、事件、幂等记录与 Outbox 共用同一个事务连接。 */
function createRunStore(database: Prisma.TransactionClient) {
    const tasks = createTaskStore(database);
    return {
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
        findEvent(eventId: string, runId: string, userId: string) {
            return database.runEvent.findFirst({ where: { id: eventId, runId, userId } });
        },
        listEvents(runId: string, userId: string, after: number) {
            return database.runEvent.findMany({
                where: { runId, userId, seq: { gt: after } },
                orderBy: { seq: 'asc' },
            });
        },
    };
}

export type RunStore = ReturnType<typeof createRunStore>;

export function createRunRepo(services: Pick<ApiServices, 'db'>) {
    return {
        findRun: (...args: Parameters<RunStore['findRun']>) =>
            createRunStore(services.db()).findRun(...args),
        requireRun: (...args: Parameters<RunStore['requireRun']>) =>
            createRunStore(services.db()).requireRun(...args),
        findIdempotency: (...args: Parameters<RunStore['findIdempotency']>) =>
            createRunStore(services.db()).findIdempotency(...args),
        findEvent: (...args: Parameters<RunStore['findEvent']>) =>
            createRunStore(services.db()).findEvent(...args),
        listEvents: (...args: Parameters<RunStore['listEvents']>) =>
            createRunStore(services.db()).listEvents(...args),
        transaction<T>(work: (store: RunStore) => Promise<T>): Promise<T> {
            return services.db().$transaction((database) => work(createRunStore(database)));
        },
        isUniqueConflict(error: unknown) {
            return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        },
    };
}
