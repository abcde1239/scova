import {
    and,
    eq,
    projectTasks,
    projectThreadItems,
    sql,
    tasks,
    type DatabaseTransaction,
} from '@scova/db';

export function createThreadScheduleStore(
    tx: DatabaseTransaction,
    userId: string,
    threadId: string,
) {
    const scope = and(
        eq(projectThreadItems.userId, userId),
        eq(projectThreadItems.threadId, threadId),
        eq(projectThreadItems.kind, 'schedule'),
    );
    return {
        async findProposal(id: string) {
            const [row] = await tx
                .select()
                .from(projectThreadItems)
                .where(and(scope, eq(projectThreadItems.id, id)));
            return row;
        },
        async findDecision(actionId: string, status: string) {
            const [row] = await tx
                .select()
                .from(projectThreadItems)
                .where(
                    and(
                        scope,
                        eq(projectThreadItems.status, status),
                        sql`${projectThreadItems.payload}->>'actionId' = ${actionId}`,
                    ),
                )
                .limit(1);
            return row;
        },
        async setStatus(actionId: string, status: string) {
            await tx
                .update(projectThreadItems)
                .set({ status })
                .where(and(scope, eq(projectThreadItems.id, actionId)));
        },
        async lockTaskInProject(projectId: string, taskId: string) {
            // Membership writes take KEY SHARE on the task before changing project_tasks.
            const [task] = await tx
                .select()
                .from(tasks)
                .where(and(eq(tasks.userId, userId), eq(tasks.id, taskId)))
                .for('update');
            if (!task) return undefined;
            const [member] = await tx
                .select({ taskId: projectTasks.taskId })
                .from(projectTasks)
                .where(
                    and(
                        eq(projectTasks.userId, userId),
                        eq(projectTasks.projectId, projectId),
                        eq(projectTasks.taskId, taskId),
                    ),
                );
            return member ? task : undefined;
        },
    };
}
