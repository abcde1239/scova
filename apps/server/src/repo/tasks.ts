import { Prisma } from '@scova/models';
import type { ApiServices } from '@/app/context.ts';

/** 绑定当前事务的任务持久化操作；不包含 HTTP、认证或产品决策。 */
export function createTaskStore(database: Prisma.TransactionClient) {
    return {
        lockTask(taskId: string, userId: string) {
            return database.$queryRaw<
                { id: string }[]
            >`SELECT id FROM tasks WHERE id = ${taskId}::uuid AND user_id = ${userId}::uuid FOR NO KEY UPDATE`;
        },
        async now() {
            const [result] = await database.$queryRaw<
                { now: Date }[]
            >`SELECT clock_timestamp() AS now`;
            return result!.now;
        },
        findTask(taskId: string, userId: string) {
            return database.task.findFirst({ where: { id: taskId, userId } });
        },
        async findTaskCursor(taskId: string, userId: string) {
            const [anchor] = await database.$queryRaw<{ id: string; cursorTime: string }[]>`
        SELECT id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
        FROM tasks WHERE id=${taskId}::uuid AND user_id=${userId}::uuid
      `;
            return anchor;
        },
        findVersion(versionId: string, userId: string, taskId: string) {
            return database.taskVersion.findFirst({ where: { id: versionId, userId, taskId } });
        },
        requireVersion(versionId: string, userId: string, taskId: string) {
            return database.taskVersion.findFirstOrThrow({
                where: { id: versionId, userId, taskId },
            });
        },
        async listTasks(userId: string, take: number, cursor?: { updatedAt: string; id: string }) {
            const boundary = cursor
                ? Prisma.sql`AND (updated_at,id)<(SELECT updated_at,id FROM tasks WHERE user_id=${userId}::uuid AND id=${cursor.id}::uuid)`
                : Prisma.empty;
            const ids = await database.$queryRaw<
                { id: string; cursorTime: string }[]
            >`SELECT id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime"
        FROM tasks WHERE user_id=${userId}::uuid ${boundary} ORDER BY updated_at DESC,id DESC LIMIT ${take}`;
            const tasks = await database.task.findMany({
                where: { userId, id: { in: ids.map((row) => row.id) } },
                orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            });
            const times = new Map(ids.map((row) => [row.id, row.cursorTime]));
            return tasks.map((task) => ({ task, cursorTime: times.get(task.id)! }));
        },
        createTask(data: Prisma.TaskUncheckedCreateInput) {
            return database.task.create({ data });
        },
        createVersion(data: Prisma.TaskVersionUncheckedCreateInput) {
            return database.taskVersion.create({ data });
        },
        setCurrentVersion(taskId: string, versionId: string) {
            return database.task.update({
                where: { id: taskId },
                data: { currentVersionId: versionId },
                include: { currentVersion: true },
            });
        },
        claimRevision(
            taskId: string,
            userId: string,
            revision: number,
            data: Prisma.TaskUpdateManyMutationInput,
        ) {
            return database.task.updateMany({ where: { id: taskId, userId, revision }, data });
        },
        async lockActiveRun(taskId: string, userId: string) {
            const [result] = await database.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs WHERE task_id = ${taskId}::uuid AND user_id = ${userId}::uuid
        AND status IN ('queued', 'running', 'recovering', 'cancel_requested') FOR UPDATE`;
            return result ? database.run.findFirst({ where: { id: result.id, userId } }) : null;
        },
        requestCancel(runId: string, requestedAt: Date) {
            return database.run.update({
                where: { id: runId },
                data: { status: 'cancel_requested', cancelRequestedAt: requestedAt },
            });
        },
        createCancelOutbox(userId: string, runId: string) {
            return database.outbox.create({
                data: {
                    userId,
                    aggregateId: runId,
                    eventType: 'run.cancel_requested',
                    dedupeKey: `run-${runId}-cancel`,
                    payload: { runId },
                },
            });
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
            return services.db().$transaction((database) => work(createTaskStore(database)), {
                isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
            });
        },
        transaction<T>(work: (store: TaskStore) => Promise<T>): Promise<T> {
            return services.db().$transaction((database) => work(createTaskStore(database)));
        },
        isUniqueConflict(error: unknown) {
            return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        },
    };
}
