import {
    and,
    desc,
    asc,
    isNotNull,
    eq,
    projectTasks,
    projects,
    reports,
    runs,
    sql,
    tasks,
    type DatabaseExecutor,
    type SQLWrapper,
} from '@scova/db';

export interface ProjectCursor {
    time: string;
    id: string;
}

const cursorTime = (column: SQLWrapper) =>
    sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const before = (time: SQLWrapper, id: SQLWrapper, cursor: ProjectCursor | undefined) =>
    cursor && sql`(${time}, ${id}) < (${cursor.time}::timestamptz, ${cursor.id}::uuid)`;
const projectFields = { id: projects.id, name: projects.name, createdAt: projects.createdAt };

export function createProjectStore(db: DatabaseExecutor) {
    return {
        async create(userId: string, name: string) {
            const [row] = await db
                .insert(projects)
                .values({ userId, name })
                .returning(projectFields);
            return row!;
        },
        list(userId: string, limit: number, cursor: ProjectCursor | undefined) {
            return db
                .select({ ...projectFields, cursorTime: cursorTime(projects.createdAt) })
                .from(projects)
                .where(
                    and(
                        eq(projects.userId, userId),
                        before(projects.createdAt, projects.id, cursor),
                    ),
                )
                .orderBy(desc(projects.createdAt), desc(projects.id))
                .limit(limit);
        },
        async find(userId: string, projectId: string) {
            const [row] = await db
                .select(projectFields)
                .from(projects)
                .where(and(eq(projects.userId, userId), eq(projects.id, projectId)));
            return row;
        },
        async findTaskProject(userId: string, taskId: string) {
            const [row] = await db
                .select({ project: projectFields })
                .from(tasks)
                .leftJoin(
                    projectTasks,
                    and(eq(projectTasks.userId, tasks.userId), eq(projectTasks.taskId, tasks.id)),
                )
                .leftJoin(
                    projects,
                    and(
                        eq(projects.userId, projectTasks.userId),
                        eq(projects.id, projectTasks.projectId),
                    ),
                )
                .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)));
            return row;
        },
        async remove(userId: string, projectId: string) {
            const [row] = await db
                .delete(projects)
                .where(and(eq(projects.userId, userId), eq(projects.id, projectId)))
                .returning({ id: projects.id });
            return row;
        },
        async lockProject(userId: string, projectId: string) {
            const [row] = await db
                .select({ id: projects.id, name: projects.name })
                .from(projects)
                .where(and(eq(projects.userId, userId), eq(projects.id, projectId)))
                .for('key share');
            return row;
        },
        async lockTask(userId: string, taskId: string) {
            const [row] = await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
                .for('key share');
            return row;
        },
        async hasTask(userId: string, projectId: string, taskId: string) {
            const [row] = await db
                .select({ taskId: projectTasks.taskId })
                .from(projectTasks)
                .where(
                    and(
                        eq(projectTasks.userId, userId),
                        eq(projectTasks.projectId, projectId),
                        eq(projectTasks.taskId, taskId),
                    ),
                );
            return Boolean(row);
        },
        associate(userId: string, projectId: string, taskId: string) {
            return db
                .insert(projectTasks)
                .values({ userId, projectId, taskId })
                .onConflictDoUpdate({
                    target: [projectTasks.userId, projectTasks.taskId],
                    set: { projectId },
                    setWhere: sql`${projectTasks.projectId} <> ${projectId}`,
                });
        },
        async associateUnassigned(userId: string, projectId: string, taskId: string) {
            const [row] = await db
                .insert(projectTasks)
                .values({ userId, projectId, taskId })
                .onConflictDoNothing({ target: [projectTasks.userId, projectTasks.taskId] })
                .returning({ taskId: projectTasks.taskId });
            return Boolean(row);
        },
        unlink(userId: string, projectId: string, taskId: string) {
            // PostgreSQL rechecks this predicate after waiting for a concurrent move.
            return db
                .delete(projectTasks)
                .where(
                    and(
                        eq(projectTasks.userId, userId),
                        eq(projectTasks.projectId, projectId),
                        eq(projectTasks.taskId, taskId),
                    ),
                );
        },
        async nextRun(userId: string, projectId: string) {
            const [task] = await db
                .select({ id: tasks.id, title: tasks.title, at: tasks.nextRunAt })
                .from(projectTasks)
                .innerJoin(
                    tasks,
                    and(eq(tasks.userId, projectTasks.userId), eq(tasks.id, projectTasks.taskId)),
                )
                .where(
                    and(
                        eq(projectTasks.userId, userId),
                        eq(projectTasks.projectId, projectId),
                        eq(tasks.status, 'active'),
                        isNotNull(tasks.nextRunAt),
                    ),
                )
                .orderBy(asc(tasks.nextRunAt), asc(tasks.id))
                .limit(1);
            return task?.at
                ? { taskId: task.id, title: task.title, at: task.at.toISOString() }
                : null;
        },
        listTasks(
            userId: string,
            projectId: string,
            limit: number,
            cursor: ProjectCursor | undefined,
        ) {
            return db
                .select({
                    id: tasks.id,
                    title: tasks.title,
                    status: tasks.status,
                    nextRunAt: tasks.nextRunAt,
                    cursorTime: cursorTime(tasks.createdAt),
                })
                .from(projectTasks)
                .innerJoin(
                    tasks,
                    and(eq(tasks.userId, projectTasks.userId), eq(tasks.id, projectTasks.taskId)),
                )
                .where(
                    and(
                        eq(projectTasks.userId, userId),
                        eq(projectTasks.projectId, projectId),
                        before(tasks.createdAt, tasks.id, cursor),
                    ),
                )
                .orderBy(desc(tasks.createdAt), desc(tasks.id))
                .limit(limit);
        },
        recentRuns(userId: string, projectId: string, limit: number) {
            return db
                .select({
                    id: runs.id,
                    title: tasks.title,
                    taskId: runs.taskId,
                    status: runs.status,
                    queuedAt: runs.queuedAt,
                })
                .from(projectTasks)
                .innerJoin(
                    runs,
                    and(eq(runs.userId, projectTasks.userId), eq(runs.taskId, projectTasks.taskId)),
                )
                .innerJoin(tasks, and(eq(tasks.userId, runs.userId), eq(tasks.id, runs.taskId)))
                .where(and(eq(projectTasks.userId, userId), eq(projectTasks.projectId, projectId)))
                .orderBy(desc(runs.queuedAt), desc(runs.id))
                .limit(limit);
        },
        recentReports(userId: string, projectId: string, limit: number) {
            return db
                .select({
                    id: reports.id,
                    title: reports.title,
                    taskId: reports.taskId,
                    runId: reports.runId,
                    publishedAt: reports.publishedAt,
                })
                .from(projectTasks)
                .innerJoin(
                    reports,
                    and(
                        eq(reports.userId, projectTasks.userId),
                        eq(reports.taskId, projectTasks.taskId),
                    ),
                )
                .where(and(eq(projectTasks.userId, userId), eq(projectTasks.projectId, projectId)))
                .orderBy(desc(reports.publishedAt), desc(reports.id))
                .limit(limit);
        },
    };
}
