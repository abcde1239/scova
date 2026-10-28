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
import type { ApiServices } from '@/app/context.ts';
import { firstRow, requireRow } from '@/utils/database.ts';

/** 绑定当前事务的任务持久化操作；不包含 HTTP、认证或产品决策。 */
export function createTaskStore(database: DatabaseExecutor) {
    return {
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
